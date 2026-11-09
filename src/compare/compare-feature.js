// The Compare view: two payloads side by side, lined up row by row, in the
// spirit of Notepad++'s Compare plugin. Loaded only when the PAYLOAD_COMPARE
// flag is 'Y' (see feature-flags.js and app.js), and it adds all of its markup
// and styles itself, so with the flag off the page is untouched.
//
// Each pane is a CodeMirror editor. Where one side has lines the other lacks,
// the shorter side gets a hatched spacer of the same height, so both documents
// have the same total height and the panes scroll as one. The comparison itself
// runs in a worker; only what is on screen is decorated, which keeps this cheap
// at any size.
import {
  EditorState,
  Compartment,
  Prec,
  StateField,
  StateEffect,
  EditorView,
  ViewPlugin,
  Decoration,
  WidgetType,
  gutter,
  GutterMarker,
  keymap,
  lineNumbers,
  drawSelection,
  defaultKeymap,
  history,
  historyKeymap,
  syntaxHighlighting,
  json,
  xml,
} from '../../vendor/codemirror/codemirror.js';
import { editorTheme, highlightStyle, wrapExtension } from '../editor/text-editor.js';
import { compareTexts, inlineDiff, KIND } from './compare-diff.js';
import { detectMode, normalizePayload } from './compare-normalize.js';
import { jsonPathSegments, xmlPathSegments } from './compare-path.js';
import { pathString } from '../panels/inspector.js';
import { unifiedDiff } from './compare-export.js';
import { deleteSession, loadSession, saveSession } from './compare-session.js';

const OPTIONS_KEY = 'payload-formatter:compare-options:v1';
const LINE_HEIGHT = 24;
const FOLD_HEIGHT = 28;
const FOLD_CONTEXT_LINES = 3;
const RECOMPARE_DELAY_MS = 300;
const SEARCH_DELAY_MS = 200;
const CARET_DELAY_MS = 120;
const SAVE_DELAY_MS = 800;
// Comparisons saved by browser tabs that are gone are dropped after this long.
const STALE_SESSION_MS = 24 * 3600 * 1000;
const MAX_COMPARE_CHARS = 30 * 1024 * 1024;
const MAX_MATCHES_PER_SIDE = 50000;
const MAX_DETAIL_CHARS = 20000;
const MAX_HISTORY_CHOICES = 20;
// Past about 7 million pixels the editor compresses its scroll height, and the
// same scroll position no longer means the same row in both panes.
const COMPRESSED_HEIGHT = 6_900_000;
const ALIGN_SEARCH_ROWS = 120;
// What each pane shows, against what was pasted.
const STATUS = {
  pasted: { label: 'As pasted', title: 'Exactly the text you pasted.' },
  layout: { label: 'Layout only', title: 'Only line breaks and indentation changed. Every key, value and character is as pasted.' },
  'layout-no-sort': { label: 'Layout only · not sorted', title: 'Only line breaks and indentation changed. Sorting applies to valid JSON only, so nothing was reordered.' },
  sorted: { label: 'Keys sorted', title: 'Keys reordered and layout changed. Every key and value is written as pasted, including duplicates.' },
  'sorted-arrays': { label: 'Keys and arrays sorted', title: 'Keys and array items reordered, and layout changed. Every key and value is written as pasted, including duplicates.' },
  'invalid-layout': { label: 'Not valid · layout only', title: 'This is not valid, so look at the original closely. Only line breaks and indentation changed; nothing was repaired.', warn: true },
  kept: { label: 'Not formatted', title: 'Formatting would have changed the data, so this is exactly the text you pasted.', warn: true },
  edited: { label: 'Edited', title: 'You edited this side, so it may differ from what was pasted.' },
};
const DEFAULT_NAMES = { left: 'Left', right: 'Right' };
const MAX_NAME_LENGTH = 40;
const DEFAULT_OPTIONS = {
  format: true,
  wrap: false,
  sortKeys: false,
  sortArrays: false,
  ignoreWhitespace: false,
  ignoreCase: false,
  ignoreEmptyLines: false,
  equivalentValues: false,
  ignoreFieldsText: '',
  onlyDifferences: false,
  showDetail: false,
  showChanged: true,
  showAdded: true,
  showRemoved: true,
  showMoved: true,
};
const KIND_OPTION = {
  [KIND.CHANGED]: 'showChanged', [KIND.ADDED]: 'showAdded', [KIND.REMOVED]: 'showRemoved', [KIND.MOVED]: 'showMoved',
};
const IGNORED_ROW = 'ignored-row';
const MARKERS = {
  [KIND.ADDED]: '+', [KIND.REMOVED]: '−', [KIND.CHANGED]: '~', [KIND.MOVED]: '⇄', [IGNORED_ROW]: '≈',
};
const undoBinding = historyKeymap.find((binding) => binding.key === 'Mod-z');

// Fills the height of rows only the other side has. With wrapping on, it also
// tops up a line that takes fewer screen rows than its partner.
class SpacerWidget extends WidgetType {
  constructor(height) {
    super();
    this.height = height;
  }

  eq(other) { return other.height === this.height; }

  toDOM() {
    const element = document.createElement('div');
    element.className = 'compare-spacer';
    element.style.height = `${this.height}px`;
    element.setAttribute('aria-hidden', 'true');
    return element;
  }

  get estimatedHeight() { return this.height; }
  ignoreEvent() { return true; }
}

class FoldWidget extends WidgetType {
  constructor(lines, index, onExpand) {
    super();
    this.lines = lines;
    this.index = index;
    this.onExpand = onExpand;
  }

  eq(other) { return other.lines === this.lines && other.index === this.index; }

  toDOM() {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'compare-fold';
    element.style.height = `${FOLD_HEIGHT}px`;
    element.textContent = `⋯ ${this.lines.toLocaleString()} matching ${this.lines === 1 ? 'line' : 'lines'} hidden · show`;
    element.addEventListener('click', () => this.onExpand(this.index));
    return element;
  }

  get estimatedHeight() { return FOLD_HEIGHT; }
  ignoreEvent() { return true; }
}

class KindMarker extends GutterMarker {
  constructor(kind) {
    super();
    this.kind = kind;
    this.elementClass = `compare-mark compare-mark-${kind}`;
  }

  eq(other) { return other.kind === this.kind; }
  toDOM() { return document.createTextNode(MARKERS[this.kind] || ''); }
}

const setLayout = StateEffect.define();
const repaint = StateEffect.define();

// Block decorations (spacers, folds) change layout, so they live in a state field.
const layoutField = StateField.define({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes);
    for (const effect of transaction.effects) if (effect.is(setLayout)) next = effect.value;
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function el(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (name === 'class') element.className = value;
    else if (name === 'text') element.textContent = value;
    else element.setAttribute(name, value);
  }
  element.append(...children);
  return element;
}

function lineEndingOf(text) {
  if (!text || !/[\r\n]/.test(text)) return '';
  return /\r/.test(text) ? 'CRLF' : 'LF';
}

function formatSize(chars) {
  if (chars < 1024) return `${chars} B`;
  if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(0)} KB`;
  return `${(chars / (1024 * 1024)).toFixed(1)} MB`;
}

// Plain-language summary of a comparison.
export function describeResult({ counts, identical }) {
  if (identical) return 'No differences';
  const parts = [];
  if (counts.changed) parts.push(`${counts.changed.toLocaleString()} changed`);
  if (counts.added) parts.push(`${counts.added.toLocaleString()} added`);
  if (counts.removed) parts.push(`${counts.removed.toLocaleString()} removed`);
  if (counts.moved) parts.push(`${counts.moved.toLocaleString()} ${counts.moved === 1 ? 'block' : 'blocks'} moved`);
  return parts.join(' · ');
}

export function initCompare({ host, storageScope = 'tab', windows, activeWindowId, readWindow, windowHistory, readHistoryEntry, setStatus, nextPaint, windowComparing, onViewChange }) {
  const root = document.documentElement;
  const viewToggle = host.querySelector('.view-toggle');
  const strip = host.querySelector('.editor-strip');
  if (!viewToggle || !strip) return null;

  const options = readOptions();
  let active = false;
  let result = null;
  let currentDifference = -1;
  let navigable = [];
  let rowStarts = null;
  let requestId = 0;
  let worker = null;
  let recompareTimer = 0;
  let searchTimer = 0;
  let saveTimer = 0;
  let aligning = false;
  // The pane being used leads and the other follows, never the reverse, so a
  // pane with short lines cannot hold back sideways scrolling in the other.
  let leader = null;
  const inlineCache = new Map();
  const expandedFolds = new Set();
  // One comparison per window. Only one is on screen; the others are kept as
  // what is needed to rebuild them, not as editors.
  const windowStates = new Map();
  let currentWindow = null;
  // The window whose comparison the panes hold right now. It differs from
  // currentWindow while a switch is loading, and only this one may be saved:
  // otherwise one window's text could be stored under another's name.
  let panesWindow = null;
  let switchToken = 0;
  let pendingRestore = null;
  const search = { query: '', caseSensitive: false, left: [], right: [], all: [], index: -1 };

  function readOptions() {
    try {
      return { ...DEFAULT_OPTIONS, ...JSON.parse(localStorage.getItem(OPTIONS_KEY) || '{}') };
    } catch (_) {
      return { ...DEFAULT_OPTIONS };
    }
  }

  function saveOptions() {
    try { localStorage.setItem(OPTIONS_KEY, JSON.stringify(options)); } catch (_) {}
  }

  const ignoreFields = () => options.ignoreFieldsText.split(',').map((name) => name.trim()).filter(Boolean);
  const comparisonOptions = () => ({ ...options, ignoreFields: ignoreFields() });
  const isIgnoring = () => options.ignoreWhitespace || options.ignoreCase || options.ignoreEmptyLines
    || options.equivalentValues || ignoreFields().length > 0;
  const kindShown = (kind) => options[KIND_OPTION[kind]] !== false;

  // --- Markup --------------------------------------------------------------

  const toggleBtn = el('button', { type: 'button', class: 'compare-toggle', 'aria-pressed': 'false', title: 'Compare two payloads side by side', text: 'Compare' });
  viewToggle.append(toggleBtn);

  const prevBtn = el('button', { type: 'button', class: 'strip-btn', title: 'Previous difference (Shift+F8)', 'aria-label': 'Previous difference', text: '↑' });
  const nextBtn = el('button', { type: 'button', class: 'strip-btn', title: 'Next difference (F8)', 'aria-label': 'Next difference', text: '↓' });
  const summary = el('span', { class: 'compare-summary', role: 'status', 'aria-live': 'polite' });
  const position = el('span', { class: 'compare-position', 'aria-live': 'polite' });
  const swapBtn = el('button', { type: 'button', class: 'strip-btn compare-swap', title: 'Swap left and right', text: 'Swap' });
  const findBtn = el('button', { type: 'button', class: 'strip-btn', title: 'Find in both sides (Ctrl/Cmd+F)', text: 'Find' });

  const wrapBtn = el('button', { type: 'button', class: 'strip-btn', 'aria-pressed': String(!!options.wrap), title: 'Wrap long lines. Rows stay lined up across both sides.', text: 'Wrap' });
  wrapBtn.addEventListener('click', () => {
    options.wrap = !options.wrap;
    saveOptions();
    applyWrap();
  });

  const optionButton = (key, label, title) => {
    const button = el('button', { type: 'button', class: 'strip-btn', 'aria-pressed': String(!!options[key]), title, text: label });
    button.addEventListener('click', () => {
      options[key] = !options[key];
      button.setAttribute('aria-pressed', String(options[key]));
      saveOptions();
      compare({ normalize: true });
    });
    return button;
  };

  const menus = [];
  const makeMenu = (label, title, ...content) => {
    const button = el('summary', { class: 'strip-btn', title, text: label });
    const menu = el('details', { class: 'compare-menu' }, button, el('div', { class: 'compare-menu-body' }, ...content));
    menu.addEventListener('toggle', () => {
      if (!menu.open) return;
      for (const other of menus) if (other !== menu) other.open = false;
      // Keep the whole menu on screen, wherever its button sits.
      const body = menu.querySelector('.compare-menu-body');
      body.style.transform = '';
      const { left: start, right: end } = body.getBoundingClientRect();
      const margin = 8;
      const shift = start < margin ? margin - start : Math.min(0, window.innerWidth - margin - end);
      if (shift) body.style.transform = `translateX(${shift}px)`;
    });
    menus.push(menu);
    return menu;
  };
  const checkRow = (key, label, title, onChange) => {
    const input = el('input', { type: 'checkbox' });
    input.checked = !!options[key];
    input.addEventListener('change', () => {
      options[key] = input.checked;
      saveOptions();
      onChange();
    });
    return el('label', { class: 'compare-check', title }, input, el('span', { text: label }));
  };

  const ignoreLabel = () => {
    const count = ['ignoreWhitespace', 'ignoreCase', 'ignoreEmptyLines', 'equivalentValues', 'sortArrays'].filter((key) => options[key]).length
      + (ignoreFields().length ? 1 : 0);
    return { text: count ? `Ignore · ${count}` : 'Ignore', on: count > 0 };
  };
  const updateIgnoreLabel = () => {
    const { text, on } = ignoreLabel();
    const button = ignoreMenu.querySelector('summary');
    button.textContent = text;
    button.classList.toggle('is-on', on);
  };
  const ignoreChanged = () => {
    updateIgnoreLabel();
    compare();
  };
  const fieldsInput = el('input', { type: 'text', class: 'compare-fields', placeholder: 'createdAt, traceId', 'aria-label': 'Field names to ignore', spellcheck: 'false' });
  fieldsInput.value = options.ignoreFieldsText;
  let fieldsTimer = 0;
  fieldsInput.addEventListener('input', () => {
    options.ignoreFieldsText = fieldsInput.value;
    saveOptions();
    clearTimeout(fieldsTimer);
    fieldsTimer = setTimeout(ignoreChanged, RECOMPARE_DELAY_MS);
  });
  const ignoreMenu = makeMenu('Ignore', 'Choose differences to leave out. Your text is not changed, and ignored lines are marked ≈.',
    checkRow('ignoreWhitespace', 'Spaces and tabs', 'Treat lines as equal when only whitespace differs, including inside values', ignoreChanged),
    checkRow('ignoreCase', 'Upper and lower case', 'Treat lines as equal when only case differs', ignoreChanged),
    checkRow('ignoreEmptyLines', 'Blank lines', 'Leave blank lines out of the comparison', ignoreChanged),
    checkRow('equivalentValues', 'Same value, different spelling', 'Treat 1.0 and 1, 1e2 and 100, \\u00e9 and é, and a trailing comma as equal', ignoreChanged),
    checkRow('sortArrays', 'Array order', 'Sort JSON array items and keys before comparing. Every value stays as written.', () => {
      updateIgnoreLabel();
      compare({ normalize: true });
    }),
    el('label', { class: 'compare-field-row' }, el('span', { text: 'Fields' }), fieldsInput),
    el('p', { class: 'compare-menu-hint', text: 'Comma-separated names, JSON keys or XML tags and attributes, such as timestamps and trace IDs. Works on formatted text.' }));

  const kindsChanged = () => {
    refreshNavigable();
    drawMap();
    repaintLines();
  };
  const showMenu = makeMenu('Show', 'Choose what to show',
    checkRow('onlyDifferences', 'Only differences', 'Hide matching lines; click a hidden section to show it', () => {
      expandedFolds.clear();
      paintLayout();
    }),
    checkRow('showDetail', 'Line detail', 'Show the selected line from both sides in full, wrapped, below the panes', () => updateDetail()),
    el('p', { class: 'compare-menu-title', text: 'Highlight and step through' }),
    checkRow('showChanged', 'Changed', 'Include changed lines', kindsChanged),
    checkRow('showAdded', 'Added', 'Include added lines', kindsChanged),
    checkRow('showRemoved', 'Removed', 'Include removed lines', kindsChanged),
    checkRow('showMoved', 'Moved', 'Include moved blocks', kindsChanged));

  const copyAction = (label, action) => {
    const button = el('button', { type: 'button', class: 'compare-menu-item', text: label });
    button.addEventListener('click', () => {
      action();
      copyMenu.open = false;
    });
    return button;
  };
  const copyMenu = makeMenu('Copy', 'Copy a side or the differences',
    copyAction('Copy left, as pasted', () => copyText(left.raw, `Copied ${left.name}.`)),
    copyAction('Copy right, as pasted', () => copyText(right.raw, `Copied ${right.name}.`)),
    copyAction('Copy differences', () => copyText(diffText(), 'Copied the differences as a unified diff.')));
    // Parked for now: download the differences as a .diff file.
    // copyAction('Download differences (.diff)', () => downloadText(diffText(), 'comparison.diff')));

  const optionsGroup = el('div', { class: 'compare-options', role: 'group', 'aria-label': 'Compare options' },
    optionButton('format', 'Format', 'Add line breaks and indentation before comparing. Your data is never changed; turn off to see exactly what was pasted.'),
    optionButton('sortKeys', 'Sort keys', 'Reorder JSON keys before comparing. Every key and value stays as pasted.'),
    ignoreMenu,
    showMenu);
  const bar = el('div', { class: 'compare-bar', role: 'group', 'aria-label': 'Compare' },
    el('div', { class: 'compare-nav' }, prevBtn, nextBtn), position, summary, el('span', { class: 'compare-grow' }), findBtn, wrapBtn, optionsGroup, swapBtn, copyMenu);
  strip.append(bar);
  updateIgnoreLabel();

  const searchInput = el('input', { type: 'text', class: 'compare-search-input', placeholder: 'Find in both sides, or :120 to go to a line', 'aria-label': 'Find in both sides', spellcheck: 'false' });
  const searchCase = el('button', { type: 'button', class: 'strip-btn', 'aria-pressed': 'false', title: 'Match case', 'aria-label': 'Match case', text: 'Aa' });
  const searchPrev = el('button', { type: 'button', class: 'strip-btn', title: 'Previous match (Shift+Enter)', 'aria-label': 'Previous match', text: '↑' });
  const searchNext = el('button', { type: 'button', class: 'strip-btn', title: 'Next match (Enter)', 'aria-label': 'Next match', text: '↓' });
  const searchCount = el('span', { class: 'compare-search-count', 'aria-live': 'polite' });
  const searchClose = el('button', { type: 'button', class: 'strip-btn', title: 'Close (Esc)', 'aria-label': 'Close find', text: '×' });
  const searchBar = el('div', { class: 'compare-search', role: 'search' }, searchInput, searchCase, searchPrev, searchNext, searchCount, searchClose);
  searchBar.hidden = true;
  host.append(searchBar);

  const makePane = (key) => {
    const select = el('select', { class: 'compare-source' });
    const meta = el('span', { class: 'compare-meta' });
    const status = el('span', { class: 'compare-status' });
    const caret = el('span', { class: 'compare-caret' });
    const crumbs = el('span', { class: 'path-crumbs', role: 'note' });
    const copyPathBtn = el('button', { type: 'button', class: 'path-copy', text: 'Copy path' });
    const pasteBtn = el('button', { type: 'button', class: 'strip-btn', text: 'Paste' });
    const fileInput = el('input', { type: 'file', class: 'compare-file', tabindex: '-1', 'aria-hidden': 'true' });
    const openBtn = el('button', { type: 'button', class: 'strip-btn', text: 'Open' });
    const clearBtn = el('button', { type: 'button', class: 'strip-btn danger', text: 'Clear' });
    const editorHost = el('div', { class: 'compare-editor' });
    const empty = el('div', { class: 'compare-empty', 'aria-hidden': 'true' });
    const nameText = el('span', { class: 'compare-side-name' });
    const nameBtn = el('button', { type: 'button', class: 'compare-side' }, nameText);
    const pane = el('section', { class: 'compare-pane' },
      el('div', { class: 'compare-head' }, nameBtn, select, el('span', { class: 'compare-grow' }), pasteBtn, openBtn, fileInput, clearBtn),
      el('div', { class: 'path-bar compare-path' }, crumbs, copyPathBtn),
      el('div', { class: 'compare-body' }, editorHost, empty),
      el('div', { class: 'compare-foot' }, caret, el('span', { class: 'compare-grow' }), meta, status));
    return {
      key, name: '', nameBtn, nameText, pane, select, meta, status, statusKey: '', caret, caretTimer: 0, crumbs, copyPathBtn, pathText: '', pasteBtn, openBtn, fileInput, clearBtn, editorHost, empty,
      raw: '', savedRaw: '', previous: null, mode: null, view: null, language: new Compartment(), wrapping: new Compartment(), layoutKey: '', startPad: 0,
    };
  };
  function showStatus(side, key) {
    const shown = STATUS[key];
    side.statusKey = key;
    side.status.textContent = shown?.label ?? '';
    side.status.title = shown?.title ?? '';
    side.status.classList.toggle('is-warning', !!shown?.warn);
  }

  const left = makePane('left');
  const right = makePane('right');
  const sides = [left, right];
  const otherSide = (side) => (side === left ? right : left);

  // --- Naming the sides ---------------------------------------------------------

  function applyName(side, name) {
    const fallback = DEFAULT_NAMES[side.key];
    side.name = name;
    // Read naturally: "the left side", but "the Prod side" as the user wrote it.
    const label = name === fallback ? name.toLowerCase() : name;
    side.nameText.textContent = name;
    side.nameBtn.title = `${name}: click to rename`;
    side.nameBtn.setAttribute('aria-label', `${name}, rename this side`);
    side.select.setAttribute('aria-label', `${name} payload`);
    side.pane.setAttribute('aria-label', `${name} payload`);
    side.pasteBtn.title = `Replace the ${label} side with the clipboard`;
    side.openBtn.title = `Open a file on the ${label} side (or drop one on it)`;
    side.clearBtn.title = `Clear the ${label} side`;
    side.empty.textContent = `Paste the ${label} payload here, or drop a file`;
    // The editor's own label follows on its next update.
    side.view?.dispatch({ effects: repaint.of(null) });
  }

  function startRename(side) {
    const input = el('input', { type: 'text', class: 'compare-rename', maxlength: String(MAX_NAME_LENGTH), 'aria-label': `Rename the ${side.name} side` });
    input.value = side.name;
    side.nameBtn.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save, refocus) => {
      if (done) return;
      done = true;
      // Leaving the box blank goes back to the standard name.
      if (save) {
        applyName(side, input.value.trim() || DEFAULT_NAMES[side.key]);
        scheduleSave();
      }
      input.replaceWith(side.nameBtn);
      if (refocus) side.nameBtn.focus();
    };
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key !== 'Enter' && event.key !== 'Escape') return;
      // Focus returns to the name button: this same key press must not click it.
      event.preventDefault();
      finish(event.key === 'Enter', true);
    });
    input.addEventListener('blur', () => finish(true, false));
  }

  for (const side of sides) {
    side.nameBtn.addEventListener('click', () => startRename(side));
    applyName(side, DEFAULT_NAMES[side.key]);
  }

  const mapCanvas = el('canvas', { class: 'compare-map-canvas' });
  const mapViewport = el('div', { class: 'compare-map-viewport', 'aria-hidden': 'true' });
  const map = el('div', {
    class: 'compare-map', title: 'Click to jump. Arrow keys scroll when focused.', role: 'slider', tabindex: '0', 'aria-label': 'Position in the comparison', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0',
  }, mapCanvas, mapViewport);
  const panel = el('div', { class: 'compare-panel' }, left.pane, right.pane, map);
  host.append(panel);
  const detailLeft = el('div', { class: 'compare-detail-text' });
  const detailRight = el('div', { class: 'compare-detail-text' });
  const detailLeftName = el('span', { class: 'compare-detail-name' });
  const detailRightName = el('span', { class: 'compare-detail-name' });
  const detail = el('div', { class: 'compare-detail', 'aria-label': 'Selected line from both sides' },
    el('div', { class: 'compare-detail-row' }, detailLeftName, detailLeft),
    el('div', { class: 'compare-detail-row' }, detailRightName, detailRight));
  detail.hidden = true;
  host.append(detail);

  // --- Line lookups -----------------------------------------------------------

  // Which op covers a line on one side. Ops are sorted, so binary search.
  function opAt(isLeft, line) {
    if (!result) return null;
    const { ops } = result;
    const start = isLeft ? 'l' : 'r';
    const count = isLeft ? 'lc' : 'rc';
    let lo = 0;
    let hi = ops.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const op = ops[mid];
      if (op[count] && line >= op[start] && line < op[start] + op[count]) return { op, index: mid };
      if (op[start] + op[count] <= line) lo = mid + 1;
      else hi = mid - 1;
    }
    return null;
  }

  function differenceOf(opIndex) {
    if (!result) return -1;
    const { differences } = result;
    let lo = 0;
    let hi = differences.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (opIndex < differences[mid].first) hi = mid - 1;
      else if (opIndex > differences[mid].last) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  const rowsOf = (op) => Math.max(op.lc, op.rc);

  function buildRows() {
    rowStarts = new Float64Array(result ? result.ops.length + 1 : 1);
    if (!result) return;
    result.ops.forEach((op, index) => { rowStarts[index + 1] = rowStarts[index] + rowsOf(op); });
  }

  function rowOfLine(side, line) {
    const isLeft = side === left;
    const found = opAt(isLeft, line);
    if (!found) return line;
    return rowStarts[found.index] + line - (isLeft ? found.op.l : found.op.r);
  }

  // The line on the other side that shares a row with this one, if any.
  function partnerLine(isLeft, found, line) {
    const { op } = found;
    if (op.lc !== op.rc) return -1;
    return (isLeft ? op.r : op.l) + line - (isLeft ? op.l : op.r);
  }

  // How a row reads on screen: its kind, or null for a plain matching row. A row
  // the ignore options made equal is still marked, so nothing is hidden silently.
  function rowKind(side, found, lineText, line) {
    if (!found) return null;
    const { kind } = found.op;
    if (kind === KIND.IGNORED) return IGNORED_ROW;
    if (kind !== KIND.SAME) return kindShown(kind) ? kind : null;
    if (!isIgnoring()) return null;
    const otherDoc = otherSide(side).view.state.doc;
    const partner = partnerLine(side === left, found, line) + 1;
    if (partner < 1 || partner > otherDoc.lines) return null;
    return otherDoc.line(partner).text === lineText ? null : IGNORED_ROW;
  }

  // --- Painting what is on screen ----------------------------------------------

  const lineMarks = new Map();
  const lineMark = (kind, current) => {
    const key = `${kind}:${current}`;
    if (!lineMarks.has(key)) lineMarks.set(key, Decoration.line({ class: `compare-line compare-line-${kind}${current ? ' is-current' : ''}` }));
    return lineMarks.get(key);
  };
  const inlineMark = Decoration.mark({ class: 'compare-inline' });
  const matchMark = Decoration.mark({ class: 'compare-match' });
  const currentMatchMark = Decoration.mark({ class: 'compare-match is-current' });
  const markers = new Map();

  function inlineFor(found, line, isLeft, side) {
    const { op, index } = found;
    const offset = line.number - 1 - (isLeft ? op.l : op.r);
    const other = otherSide(side).view.state.doc;
    const otherNumber = (isLeft ? op.r : op.l) + offset + 1;
    if (otherNumber > other.lines) return null;
    const key = `${index}:${offset}`;
    let diff = inlineCache.get(key);
    if (!diff) {
      const otherText = other.line(otherNumber).text;
      diff = isLeft ? inlineDiff(line.text, otherText, options) : inlineDiff(otherText, line.text, options);
      inlineCache.set(key, diff);
    }
    return isLeft ? diff.left : diff.right;
  }

  const painter = (side) => {
    const isLeft = side === left;
    return ViewPlugin.fromClass(class {
      constructor(view) {
        this.decorations = this.build(view);
      }

      update(update) {
        if (update.docChanged || update.viewportChanged || update.transactions.some((tr) => tr.effects.some((effect) => effect.is(repaint)))) {
          this.decorations = this.build(update.view);
        }
      }

      build(view) {
        if (!leader) return Decoration.none;
        const marks = [];
        const { doc } = view.state;
        const matches = search[side.key];
        const currentMatch = search.all[search.index];
        for (const { from, to } of view.visibleRanges) {
          for (let pos = from; pos <= to;) {
            const line = doc.lineAt(pos);
            if (result) {
              const found = opAt(isLeft, line.number - 1);
              const kind = rowKind(side, found, line.text, line.number - 1);
              if (kind) {
                const current = kind !== IGNORED_ROW && differenceOf(found.index) === currentDifference;
                marks.push(lineMark(kind, current).range(line.from));
                if (kind === KIND.CHANGED) {
                  for (const [start, end] of inlineFor(found, line, isLeft, side) || []) {
                    if (end > start && line.from + end <= line.to) marks.push(inlineMark.range(line.from + start, line.from + end));
                  }
                }
              }
            }
            pos = line.to + 1;
          }
          // Matches on screen, found by binary search in the sorted list.
          let lo = 0;
          let hi = matches.length;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (matches[mid].to <= from) lo = mid + 1;
            else hi = mid;
          }
          for (let i = lo; i < matches.length && matches[i].from < to; i += 1) {
            const match = matches[i];
            if (match.to <= doc.length) marks.push((currentMatch === match ? currentMatchMark : matchMark).range(match.from, match.to));
          }
        }
        return Decoration.set(marks, true);
      }
    }, { decorations: (plugin) => plugin.decorations });
  };

  const markerGutter = (side) => gutter({
    class: 'compare-gutter',
    lineMarker(view, line) {
      const { doc } = view.state;
      const docLine = doc.lineAt(line.from);
      const found = opAt(side === left, docLine.number - 1);
      const kind = rowKind(side, found, docLine.text, docLine.number - 1);
      if (!kind) return null;
      if (!markers.has(kind)) markers.set(kind, new KindMarker(kind));
      return markers.get(kind);
    },
    lineMarkerChange: (update) => update.transactions.some((tr) => tr.effects.some((effect) => effect.is(repaint))),
    initialSpacer: () => new KindMarker(KIND.ADDED),
    domEventHandlers: {
      // Clicking ⇄ goes to the other end of a moved block.
      click(view, line) {
        const number = view.state.doc.lineAt(line.from).number - 1;
        const found = opAt(side === left, number);
        if (found?.op.kind !== KIND.MOVED) return false;
        const target = otherSide(side);
        const targetLine = found.op.target + number - (side === left ? found.op.l : found.op.r);
        revealLine(target, targetLine);
        showPath(side, number);
        showPath(target, targetLine);
        setStatus(`Moved block: now at line ${(targetLine + 1).toLocaleString()} on ${target.name}.`);
        return true;
      },
    },
  });

  function expandFold(index) {
    expandedFolds.add(index);
    paintLayout();
  }

  // The hidden range of a matching run under "Only differences", or null.
  function foldRange(op, index) {
    if (!options.onlyDifferences || op.kind !== KIND.SAME || expandedFolds.has(index) || op.lc <= FOLD_CONTEXT_LINES * 2) return null;
    const first = index === 0 ? 0 : FOLD_CONTEXT_LINES;
    const last = index === result.ops.length - 1 ? 0 : FOLD_CONTEXT_LINES;
    const hidden = op.lc - first - last;
    return hidden > 0 ? { first, hidden } : null;
  }

  // How tall a line's own text is on screen, leaving out spacers next to it.
  // A line the editor has drawn is measured. Any other is guessed from its
  // length, a guess that stays put: the editor's own guesses shift as spacers
  // come and go, which would keep changing the layout.
  function rowsPerLine(view) {
    const width = view.contentDOM.getBoundingClientRect().width - 24;
    return Math.max(20, Math.floor(width / (view.defaultCharacterWidth || 8)));
  }

  function textHeight(view, index, columns) {
    const { doc } = view.state;
    if (index >= doc.lines) return 0;
    const line = doc.line(index + 1);
    const { viewport } = view;
    if (line.to < viewport.from || line.from > viewport.to) return Math.max(1, Math.ceil(line.length / columns)) * LINE_HEIGHT;
    const block = view.lineBlockAt(line.from);
    if (!Array.isArray(block.type)) return block.height;
    let height = 0;
    for (const part of block.type) if (!part.widget) height += part.height;
    return height;
  }

  // Spacers for lines only the other side has, and folds for "Only differences".
  // With wrapping, a line can take several screen rows, so spacers are sized
  // from the real heights, and the shorter line of each pair is topped up.
  function layoutFor(side) {
    const isLeft = side === left;
    const { doc } = side.view.state;
    const ranges = [];
    const keys = [];
    side.layoutKey = '';
    if (!result) return Decoration.none;
    const wrap = !!options.wrap;
    const other = otherSide(side);
    const otherDoc = other.view.state.doc;
    const empty = doc.length === 0;
    const ownColumns = wrap ? rowsPerLine(side.view) : 0;
    const otherColumns = wrap ? rowsPerLine(other.view) : 0;
    const ownHeight = (index) => textHeight(side.view, index, ownColumns);
    const otherHeight = (index) => textHeight(other.view, index, otherColumns);
    const lineStart = (index) => (index < doc.lines ? doc.line(index + 1).from : doc.length);
    const block = (height, pos, after) => {
      const px = Math.round(height);
      if (px <= 0) return;
      ranges.push(Decoration.widget({ widget: new SpacerWidget(px), block: true, side: after ? 1 : -1 }).range(pos));
      keys.push(`${pos}${after ? '+' : '-'}${px}`);
    };
    const spacer = (index, height) => {
      const atEnd = empty || index >= doc.lines;
      block(height, atEnd ? doc.length : lineStart(index), atEnd);
    };
    const { ops } = result;
    ops.forEach((op, index) => {
      const count = isLeft ? op.lc : op.rc;
      const otherCount = isLeft ? op.rc : op.lc;
      const start = isLeft ? op.l : op.r;
      const otherStart = isLeft ? op.r : op.l;
      const fold = foldRange(op, index);
      if (count < otherCount) {
        // An empty document still occupies one (empty) line in the editor.
        const ownEmptyLine = empty && index === 0;
        if (wrap) {
          let height = ownEmptyLine ? -ownHeight(0) : 0;
          for (let row = count; row < otherCount; row += 1) height += otherHeight(otherStart + row);
          spacer(start + count, height);
        } else {
          spacer(start + count, (otherCount - count - (ownEmptyLine ? 1 : 0)) * LINE_HEIGHT);
        }
      }
      if (wrap) {
        const paired = Math.min(count, otherCount);
        for (let row = 0; row < paired; row += 1) {
          if (fold && row >= fold.first && row < fold.first + fold.hidden) continue;
          // Text edited since the comparison ran can have fewer lines.
          if (start + row >= doc.lines || otherStart + row >= otherDoc.lines) break;
          const own = doc.line(start + row + 1);
          // The same text wraps the same way, as both panes are the same width.
          if (own.text === otherDoc.line(otherStart + row + 1).text) continue;
          block(otherHeight(otherStart + row) - ownHeight(start + row), own.to, true);
        }
      }
      if (fold) {
        const from = doc.line(start + fold.first + 1).from;
        const to = doc.line(start + fold.first + fold.hidden).to;
        ranges.push(Decoration.replace({ widget: new FoldWidget(fold.hidden, index, expandFold), block: true }).range(from, to));
        keys.push(`f${from}`);
      }
    });
    // Heights of lines not drawn yet are guesses, so the rows above the screen
    // may add up differently on each side. Room at the very top evens them up,
    // so the rows on screen sit at the same height in both panes.
    if (wrap && side.startPad > 0) block(side.startPad, 0, false);
    side.layoutKey = keys.join(',');
    return Decoration.set(ranges, true);
  }

  // Line numbers take more room with more digits. With wrapping, both panes
  // must be the same width so the same text wraps the same way.
  function matchGutters() {
    const gutters = sides.map((side) => side.view.dom.querySelector('.cm-gutters')).filter(Boolean);
    for (const gutter of gutters) gutter.style.minWidth = '';
    if (!options.wrap || gutters.length < 2) return;
    const widest = Math.max(...gutters.map((gutter) => gutter.getBoundingClientRect().width));
    if (widest > 0) for (const gutter of gutters) gutter.style.minWidth = `${widest}px`;
  }

  // Lines measured as they come into view can change how tall a row is. The
  // layout follows, and a changed layout is only applied when it differs.
  let wrapTimer = 0;
  function scheduleWrapLayout() {
    if (wrapTimer || !options.wrap || !result) return;
    wrapTimer = setTimeout(() => {
      wrapTimer = 0;
      if (!options.wrap || !result || !active) return;
      if (sides.some((side, index) => side.view.state.doc !== paintedDocs[index])) return;
      matchGutters();
      let changed = false;
      const relayout = (side) => {
        const before = side.layoutKey;
        const layout = layoutFor(side);
        if (side.layoutKey === before) return;
        changed = true;
        side.view.dispatch({ effects: setLayout.of(layout) });
      };
      for (const side of sides) relayout(side);
      const offset = rowsAboveOffset();
      if (offset !== null) {
        const pads = offset > 0 ? [0, offset] : [-offset, 0];
        sides.forEach((side, index) => {
          if (Math.abs(pads[index] - side.startPad) <= 1) return;
          side.startPad = pads[index];
          relayout(side);
        });
      }
      if (changed) {
        drawMap();
        syncScroll();
      }
    }, 30);
  }

  // Where a line's text starts, below any spacer in front of it.
  function textTop(view, index) {
    const block = view.lineBlockAt(view.state.doc.line(index + 1).from);
    if (!Array.isArray(block.type)) return block.top;
    return (block.type.find((part) => !part.widget) ?? block).top;
  }

  // How much lower a row near the top of the screen sits on the left than on
  // the right, not counting the room already added at the top.
  function rowsAboveOffset() {
    const { view } = left;
    const { doc } = view.state;
    let block = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
    for (let tries = 0; tries < ALIGN_SEARCH_ROWS; tries += 1) {
      const line = doc.lineAt(block.from).number - 1;
      const found = opAt(true, line);
      if (found && found.op.lc && found.op.rc && line - found.op.l < found.op.rc) {
        const other = found.op.r + (line - found.op.l);
        if (other >= right.view.state.doc.lines) return null;
        return Math.round((textTop(view, line) - left.startPad) - (textTop(right.view, other) - right.startPad));
      }
      if (block.to >= doc.length) return null;
      block = view.lineBlockAt(block.to + 1);
    }
    return null;
  }

  function applyWrap() {
    wrapBtn.setAttribute('aria-pressed', String(!!options.wrap));
    panel.dataset.wrap = options.wrap ? 'on' : 'off';
    for (const side of sides) side.startPad = 0;
    for (const side of sides) side.view.dispatch({ effects: side.wrapping.reconfigure(options.wrap ? wrapExtension : []) });
    matchGutters();
    // Right after an edit the comparison is about to run again and lays out then.
    if (sides.every((side, index) => side.view.state.doc === paintedDocs[index])) paintLayout();
    scheduleWrapLayout();
  }

  // The texts the current layout was made for. The comparison describes those,
  // so after an edit nothing may re-measure from it until it has run again.
  let paintedDocs = [];
  function paintLayout() {
    paintedDocs = sides.map((side) => side.view.state.doc);
    for (const side of sides) {
      side.view.dispatch({ effects: [setLayout.of(layoutFor(side)), repaint.of(null)] });
    }
    drawMap();
  }

  function repaintLines() {
    for (const side of sides) side.view.dispatch({ effects: repaint.of(null) });
  }

  // --- Overview map (colored marks for the whole comparison) ---------------------

  function placeMapViewport() {
    const { scrollTop, scrollHeight, clientHeight } = left.view.scrollDOM;
    const scrollable = scrollHeight - clientHeight;
    map.setAttribute('aria-valuenow', String(scrollable > 0 ? Math.round((scrollTop / scrollable) * 100) : 0));
    // Folded rows are not to scale with the map, so no position box then.
    const visible = scrollable > 0 && !options.onlyDifferences;
    mapViewport.hidden = !visible;
    if (!visible) return;
    mapViewport.style.top = `${(scrollTop / scrollHeight) * 100}%`;
    mapViewport.style.height = `${Math.max((clientHeight / scrollHeight) * 100, 1)}%`;
  }

  function drawMap() {
    placeMapViewport();
    const ratio = window.devicePixelRatio || 1;
    const { width, height } = map.getBoundingClientRect();
    if (!width || !height || !mapCanvas.getContext) return;
    mapCanvas.width = Math.round(width * ratio);
    mapCanvas.height = Math.round(height * ratio);
    const context = mapCanvas.getContext('2d');
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    if (!result) return;
    const place = mapPlacement();
    const styles = getComputedStyle(root);
    const colors = {
      [KIND.ADDED]: styles.getPropertyValue('--compare-added-map'),
      [KIND.REMOVED]: styles.getPropertyValue('--compare-removed-map'),
      [KIND.CHANGED]: styles.getPropertyValue('--compare-changed-map'),
      [KIND.MOVED]: styles.getPropertyValue('--compare-moved-map'),
    };
    result.ops.forEach((op, index) => {
      if (!colors[op.kind] || !kindShown(op.kind)) return;
      context.fillStyle = colors[op.kind];
      const { top, size } = place(index);
      context.fillRect(2, top * height, width - 4, Math.max(2, size * height));
    });
  }

  // Where each block of rows sits in the map, as fractions of the whole.
  function mapPlacement() {
    const total = rowStarts[result.ops.length] || 1;
    const byRows = (index) => ({ top: rowStarts[index] / total, size: rowsOf(result.ops[index]) / total });
    if (!options.wrap || options.onlyDifferences) return byRows;
    // A row's top, read from whichever side has a line there.
    const topOf = (index) => {
      const op = result.ops[index];
      if (!op) return null;
      const side = op.lc ? left : right;
      const line = op.lc ? op.l : op.r;
      if (line >= side.view.state.doc.lines) return null;
      return textTop(side.view, line);
    };
    const height = left.view.contentHeight || 1;
    return (index) => {
      const top = topOf(index);
      if (top === null) return byRows(index);
      const next = topOf(index + 1) ?? height;
      return { top: top / height, size: Math.max(0, next - top) / height };
    };
  }

  map.addEventListener('click', (event) => {
    if (!result) return;
    const { top, height } = map.getBoundingClientRect();
    const fraction = (event.clientY - top) / height;
    if (options.onlyDifferences && navigable.length) {
      // Rows aren't to scale when folded: go to the nearest difference instead.
      const row = fraction * rowStarts[result.ops.length];
      let best = navigable[0];
      for (const index of navigable) {
        if (Math.abs(rowStarts[result.differences[index].first] - row) < Math.abs(rowStarts[result.differences[best].first] - row)) best = index;
      }
      goToDifference(best);
      return;
    }
    leader = left;
    const scroller = left.view.scrollDOM;
    scroller.scrollTop = fraction * (scroller.scrollHeight - scroller.clientHeight);
    left.view.requestMeasure();
  });
  map.addEventListener('keydown', (event) => {
    const scroller = left.view.scrollDOM;
    const page = scroller.clientHeight;
    const moves = {
      ArrowUp: -page / 4, ArrowDown: page / 4, PageUp: -page, PageDown: page, Home: -scroller.scrollTop, End: scroller.scrollHeight,
    };
    if (moves[event.key] === undefined) return;
    event.preventDefault();
    leader = left;
    scroller.scrollTop += moves[event.key];
  });

  // --- Comparing ---------------------------------------------------------------------

  function getWorker() {
    if (worker || worker === false) return worker;
    try {
      worker = new Worker(new URL('./compare-worker.js', import.meta.url), { type: 'module' });
      worker.addEventListener('message', ({ data }) => finish(data));
      worker.addEventListener('error', () => {
        worker = false;
        setStatus('Comparison stopped unexpectedly. Try again.', 'error');
      });
    } catch (_) {
      worker = false;
    }
    return worker;
  }

  function compare({ normalize = false } = {}) {
    clearTimeout(recompareTimer);
    const id = ++requestId;
    const sources = normalize ? sides.map((side) => side.raw) : sides.map((side) => side.view.state.doc.toString());
    if (sources.some((text) => text.length > MAX_COMPARE_CHARS)) {
      result = null;
      buildRows();
      if (normalize) {
        for (const side of sides) {
          setDocument(side, side.raw);
          showStatus(side, side.raw ? 'pasted' : '');
        }
      }
      summary.textContent = 'Too large to compare (limit 30 MB per side)';
      summary.title = summary.textContent;
      summary.dataset.tone = 'different';
      setStatus('Each side can be up to 30 MB in Compare.', 'warning');
      refreshNavigable();
      updateMeta();
      paintLayout();
      for (const side of sides) updateCaret(side);
      return;
    }
    summary.textContent = 'Comparing…';
    const settings = comparisonOptions();
    const thread = getWorker();
    if (thread) thread.postMessage({ id, left: sources[0], right: sources[1], options: settings, normalize });
    else {
      // No worker available: same work on this thread.
      setTimeout(() => {
        const normalized = normalize ? [normalizePayload(sources[0], settings), normalizePayload(sources[1], settings)] : null;
        finish({
          id,
          ok: true,
          sides: normalized,
          result: compareTexts(normalized ? normalized[0].text : sources[0], normalized ? normalized[1].text : sources[1], settings),
        });
      }, 0);
    }
  }

  function updateMeta() {
    for (const side of sides) {
      const text = side.view.state.doc;
      const lineEnding = lineEndingOf(side.raw);
      side.meta.textContent = text.length
        ? `${text.lines.toLocaleString()} ${text.lines === 1 ? 'line' : 'lines'}${lineEnding === 'CRLF' ? ' · CRLF' : ''}`
        : '';
    }
  }

  function summaryText(next) {
    const filled = sides.filter((side) => side.view.state.doc.length > 0);
    if (filled.length === 0) return 'Paste two payloads to compare';
    if (filled.length === 1) {
      const waiting = otherSide(filled[0]);
      return `Waiting for the ${waiting.name} payload`;
    }
    let text = describeResult(next);
    const [leftEnding, rightEnding] = sides.map((side) => lineEndingOf(side.raw));
    if (next.identical && leftEnding && rightEnding && leftEnding !== rightEnding) {
      text = `No content differences · line endings differ (${leftEnding} vs ${rightEnding})`;
    }
    if (left.mode && right.mode && left.mode !== right.mode) {
      text = `${left.mode.toUpperCase()} vs ${right.mode.toUpperCase()} · ${text}`;
    }
    if (next.ignoredRows) {
      const lines = `${next.ignoredRows.toLocaleString()} ${next.ignoredRows === 1 ? 'line' : 'lines'} ignored`;
      text = `${text} · ${lines}`;
    }
    return text;
  }

  function finish({ id, ok, sides: normalized, result: next, error }) {
    if (id !== requestId) return;
    if (!ok) {
      summary.textContent = 'Comparison failed';
      setStatus(error || 'Comparison failed.', 'error');
      return;
    }
    if (normalized) {
      normalized.forEach((entry, index) => {
        setDocument(sides[index], entry.text, entry.mode);
        // Text you edited stays marked as edited when you come back to it.
        showStatus(sides[index], pendingRestore?.edited[sides[index].key] ? 'edited' : entry.status);
      });
    }
    const restore = pendingRestore;
    pendingRestore = null;
    result = next;
    buildRows();
    inlineCache.clear();
    expandedFolds.clear();
    currentDifference = restore && restore.difference < next.differences.length ? restore.difference : -1;
    summary.textContent = summaryText(next);
    summary.title = summary.textContent;
    summary.dataset.tone = next.identical && sides.every((side) => side.view.state.doc.length) ? 'same' : 'different';
    refreshNavigable();
    updateMeta();
    runSearch();
    paintLayout();
    syncScroll();
    if (restore?.topLine > 1) {
      // Back where you left this window. A line number holds at any file size,
      // and the editor places it once the new text has been measured.
      const side = sides.find((candidate) => candidate.key === restore.leader) || left;
      const { doc } = side.view.state;
      leader = side;
      side.view.dispatch({ effects: EditorView.scrollIntoView(doc.line(Math.min(restore.topLine, doc.lines)).from, { y: 'start' }) });
      side.view.requestMeasure({ read: () => null, write: () => queueMicrotask(syncScroll) });
    }
    updateDetail();
    for (const side of sides) updateCaret(side);
    scheduleSave();
  }

  // Differences the Show menu keeps, in order.
  function refreshNavigable() {
    navigable = [];
    // With a side still empty there is nothing to step between yet.
    if (result && sides.every((side) => side.view.state.doc.length)) {
      const { differences, ops } = result;
      differences.forEach((difference, index) => {
        for (let at = difference.first; at <= difference.last; at += 1) {
          if (kindShown(ops[at].kind)) {
            navigable.push(index);
            break;
          }
        }
      });
    }
    if (!navigable.includes(currentDifference)) currentDifference = -1;
    const none = navigable.length === 0;
    prevBtn.disabled = none;
    nextBtn.disabled = none;
    const at = navigable.indexOf(currentDifference);
    position.textContent = none ? '' : `${at >= 0 ? (at + 1).toLocaleString() : '–'} / ${navigable.length.toLocaleString()}`;
  }

  function languageFor(mode) {
    return mode === 'json' ? json() : mode === 'xml' ? xml() : [];
  }

  function setDocument(side, text, mode = detectMode(text)) {
    side.mode = mode;
    side.view.setState(EditorState.create({ doc: text, extensions: extensionsFor(side) }));
    side.empty.hidden = text.length > 0;
  }

  // New content for a side. The previous content is kept so Ctrl/Cmd+Z can bring
  // it back, since a whole new payload starts a fresh undo history.
  function replaceRaw(side, raw, source = 'edited') {
    setStatus('');
    side.previous = { raw: side.raw, source: side.select.value };
    side.raw = raw;
    side.select.value = source;
    compare({ normalize: true });
  }

  function restorePrevious(side) {
    if (!side.previous) return false;
    const { raw, source } = side.previous;
    replaceRaw(side, raw, source);
    setStatus(`Restored the previous ${side.name} payload.`);
    return true;
  }

  // Typing just re-compares, and never reformats under the caret.
  function onUserEdit(side, update) {
    const text = update.state.doc;
    side.empty.hidden = text.length > 0;
    side.select.value = 'edited';
    // A comparison still running describes the old text; drop it.
    requestId += 1;
    inlineCache.clear();
    clearTimeout(recompareTimer);
    side.raw = text.toString();
    showStatus(side, 'edited');
    recompareTimer = setTimeout(() => compare(), RECOMPARE_DELAY_MS);
  }

  function extensionsFor(side) {
    return [
      lineNumbers(),
      markerGutter(side),
      history(),
      drawSelection(),
      syntaxHighlighting(highlightStyle),
      EditorState.tabSize.of(2),
      side.language.of(languageFor(side.mode)),
      side.wrapping.of(options.wrap ? wrapExtension : []),
      layoutField,
      painter(side),
      editorTheme,
      Prec.highest(keymap.of([
        { key: 'F8', stopPropagation: true, run: () => { step(1); return true; }, shift: () => { step(-1); return true; } },
        // Re-runs format and compare. Without this the editor would insert a line.
        { key: 'Mod-Enter', stopPropagation: true, run: () => { compare({ normalize: true }); return true; } },
        { key: 'Alt-ArrowDown', stopPropagation: true, run: () => { step(1); return true; } },
        { key: 'Alt-ArrowUp', stopPropagation: true, run: () => { step(-1); return true; } },
        { key: 'Mod-z', run: (view) => undoBinding.run(view) || restorePrevious(side) },
      ])),
      keymap.of([...historyKeymap, ...defaultKeymap]),
      EditorView.domEventHandlers({
        // Pasting over a whole payload replaces it, keeping the exact text (the
        // editor would rewrite line endings). Pasting into text you are editing
        // works as in any editor.
        paste(event, view) {
          const text = event.clipboardData?.getData('text/plain');
          if (!text) return false;
          const { doc, selection } = view.state;
          const { from, to } = selection.main;
          const whole = from === 0 && to === doc.length;
          if (side.statusKey === 'edited' && doc.length && !whole) return false;
          event.preventDefault();
          const hadText = doc.length > 0;
          replaceRaw(side, text);
          if (hadText) setStatus(`Replaced the ${side.name} payload. Ctrl/Cmd+Z brings it back.`);
          return true;
        },
      }),
      EditorView.contentAttributes.of(() => ({
        'aria-label': `${side.name} payload`, spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off',
      })),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onUserEdit(side, update);
        if (update.selectionSet || update.docChanged) {
          clearTimeout(side.caretTimer);
          side.caretTimer = setTimeout(() => {
            updateCaret(side);
            if (side.view.hasFocus) updateDetail(side);
          }, CARET_DELAY_MS);
        }
        if ((update.viewportChanged || update.geometryChanged) && leader && (options.wrap || update.view.scrollDOM.scrollHeight >= COMPRESSED_HEIGHT)) syncScroll();
        if (update.heightChanged || update.geometryChanged || update.viewportChanged) scheduleWrapLayout();
      }),
    ];
  }

  for (const side of sides) {
    side.view = new EditorView({ parent: side.editorHost, state: EditorState.create({ doc: '', extensions: extensionsFor(side) }) });
  }

  // --- Caret position and path -------------------------------------------------------

  function updateCaret(side) {
    const { state } = side.view;
    if (!state.doc.length) {
      side.caret.textContent = '';
      pathNote(side, 'No payload');
      return;
    }
    const { head } = state.selection.main;
    const line = state.doc.lineAt(head);
    side.caret.textContent = `Ln ${line.number.toLocaleString()}, Col ${(head - line.from + 1).toLocaleString()}`;
    showPath(side, line.number - 1);
  }

  // The path bar: the same look and path format as the Text view's. Both panes
  // always show the bar, so their rows stay level with each other.
  function pathNote(side, text) {
    side.pathText = '';
    side.crumbs.replaceChildren(el('span', { class: 'compare-path-note', text }));
    side.crumbs.removeAttribute('aria-label');
    side.copyPathBtn.disabled = true;
  }

  function showPath(side, lineIndex) {
    const { doc } = side.view.state;
    if (!doc.length) return pathNote(side, 'No payload');
    if (side.mode !== 'json' && side.mode !== 'xml') return pathNote(side, 'Path is for JSON and XML');
    // On one long line, indentation says nothing about where the caret is.
    if (doc.lines === 1 && doc.length > 1 && !['layout', 'sorted', 'sorted-arrays', 'layout-no-sort'].includes(side.statusKey)) {
      return pathNote(side, 'Format this side to see the path');
    }
    const getLine = (index) => doc.line(index + 1).text;
    const line = Math.min(lineIndex, doc.lines - 1);
    const segments = side.mode === 'json' ? jsonPathSegments(getLine, line) : xmlPathSegments(getLine, line);
    if (!segments) return pathNote(side, 'Path not available for this line');
    side.pathText = pathString(side.mode, segments);
    const labels = [side.mode === 'xml' ? '/' : '$', ...segments.map((part) => ('index' in part ? `[${part.index}]` : part.tag ?? part.key))];
    const nodes = [];
    labels.forEach((label, index) => {
      if (index) nodes.push(el('span', { class: 'path-sep', 'aria-hidden': 'true', text: '›' }));
      nodes.push(el('span', { class: index === labels.length - 1 ? 'path-crumb is-current' : 'path-crumb', text: label }));
    });
    side.crumbs.replaceChildren(...nodes);
    side.crumbs.setAttribute('aria-label', `Path ${side.pathText}`);
    side.copyPathBtn.disabled = false;
    return undefined;
  }

  for (const side of sides) {
    side.copyPathBtn.addEventListener('click', () => copyText(side.pathText, `Copied ${side.pathText}`));
    pathNote(side, 'No payload');
  }

  // --- Line detail: the whole line from both sides, wrapped -----------------------------

  function writeDetail(element, text, ranges) {
    element.textContent = '';
    if (text === null) {
      element.append(el('em', { text: 'No matching line' }));
      return;
    }
    let shown = text;
    let offset = 0;
    let clipped = false;
    if (text.length > MAX_DETAIL_CHARS) {
      offset = Math.max(0, (ranges?.[0]?.[0] ?? 0) - 200);
      shown = text.slice(offset, offset + MAX_DETAIL_CHARS);
      clipped = true;
    }
    let cursor = 0;
    for (const [from, to] of ranges || []) {
      const start = from - offset;
      const end = Math.min(to - offset, shown.length);
      if (start < cursor || start >= shown.length) continue;
      element.append(shown.slice(cursor, start), el('mark', { class: 'compare-inline', text: shown.slice(start, end) }));
      cursor = end;
    }
    element.append(shown.slice(cursor));
    if (clipped) element.append(el('em', { text: ` … showing ${MAX_DETAIL_CHARS.toLocaleString()} of ${text.length.toLocaleString()} characters` }));
  }

  let detailSide = null;
  let detailLine = 0;

  function updateDetail(from = null) {
    detail.hidden = !options.showDetail;
    detailLeftName.textContent = left.name;
    detailRightName.textContent = right.name;
    if (!options.showDetail) return;
    if (from) {
      detailSide = from;
      detailLine = from.view.state.doc.lineAt(from.view.state.selection.main.head).number - 1;
    }
    const side = detailSide || left;
    const { doc } = side.view.state;
    if (detailLine >= doc.lines) detailLine = doc.lines - 1;
    const text = doc.line(detailLine + 1).text;
    const isLeft = side === left;
    const found = opAt(isLeft, detailLine);
    let partner = -1;
    if (found) partner = found.op.kind === KIND.MOVED ? found.op.target + detailLine - (isLeft ? found.op.l : found.op.r) : partnerLine(isLeft, found, detailLine);
    const otherDoc = otherSide(side).view.state.doc;
    const otherText = partner >= 0 && partner < otherDoc.lines ? otherDoc.line(partner + 1).text : null;
    const diff = found?.op.kind === KIND.CHANGED && otherText !== null
      ? (isLeft ? inlineDiff(text, otherText, options) : inlineDiff(otherText, text, options))
      : { left: [], right: [] };
    writeDetail(isLeft ? detailLeft : detailRight, text, isLeft ? diff.left : diff.right);
    writeDetail(isLeft ? detailRight : detailLeft, otherText, isLeft ? diff.right : diff.left);
  }

  // --- Scrolling as one -------------------------------------------------------------

  leader = left;

  // What the follower must do so the row at the top of the leader lines up:
  // { offset } to move a little, { scrollTo } when that row isn't rendered yet,
  // or null if no row near the top exists on both sides.
  function rowAlignment(follower) {
    const isLeft = leader === left;
    const { view } = leader;
    const { doc } = view.state;
    const scrollTop = view.scrollDOM.scrollTop;
    let block = view.lineBlockAtHeight(scrollTop);
    for (let tries = 0; tries < ALIGN_SEARCH_ROWS; tries += 1) {
      const line = doc.lineAt(block.from).number - 1;
      const found = opAt(isLeft, line);
      if (found && found.op.lc === found.op.rc) {
        const otherLine = partnerLine(isLeft, found, line) + 1;
        const otherDoc = follower.view.state.doc;
        if (otherLine > otherDoc.lines) return null;
        const from = otherDoc.line(otherLine).from;
        const { viewport } = follower.view;
        if (from < viewport.from || from > viewport.to) return { scrollTo: from };
        // A row's text sits at the bottom of its block, after any spacer.
        const target = follower.view.lineBlockAt(from).bottom - follower.view.scrollDOM.scrollTop;
        return { offset: target - (block.bottom - scrollTop) };
      }
      if (block.to >= doc.length) return null;
      block = view.lineBlockAt(block.to + 1);
    }
    return null;
  }

  function syncScroll() {
    placeMapViewport();
    const follower = otherSide(leader);
    const source = leader.view.scrollDOM;
    const target = follower.view.scrollDOM;
    target.scrollLeft = source.scrollLeft;
    // With wrapping, heights of rows not drawn yet are estimates, so the same
    // scroll position isn't the same row: line up the row at the top instead.
    const alignment = result && (options.wrap || source.scrollHeight >= COMPRESSED_HEIGHT) ? rowAlignment(follower) : null;
    if (!alignment) {
      target.scrollTop = source.scrollTop;
    } else if (alignment.scrollTo !== undefined) {
      // The row must be rendered before it can be lined up exactly; the update
      // this causes brings us back here.
      if (aligning) return;
      aligning = true;
      queueMicrotask(() => {
        aligning = false;
        follower.view.dispatch({ effects: EditorView.scrollIntoView(alignment.scrollTo, { y: 'start' }) });
      });
    } else if (Math.abs(alignment.offset) >= 1) {
      target.scrollTop += alignment.offset;
    }
  }
  for (const side of sides) {
    for (const type of ['pointerenter', 'pointerdown', 'wheel', 'focusin']) {
      side.pane.addEventListener(type, () => { leader = side; }, { passive: true });
    }
    side.view.scrollDOM.addEventListener('scroll', () => { if (side === leader) syncScroll(); }, { passive: true });
  }

  // Scrolls a line into the middle, opening a hidden section first if it's in one.
  function revealLine(side, line) {
    const found = opAt(side === left, line);
    if (found) {
      const fold = foldRange(found.op, found.index);
      const offset = line - (side === left ? found.op.l : found.op.r);
      if (fold && offset >= fold.first && offset < fold.first + fold.hidden) expandFold(found.index);
    }
    const { doc } = side.view.state;
    const from = doc.line(Math.min(line + 1, doc.lines)).from;
    leader = side;
    // Wrapped rows not drawn yet only have estimated heights: let the editor
    // measure as it scrolls.
    if (options.wrap || side.view.scrollDOM.scrollHeight >= COMPRESSED_HEIGHT) {
      side.view.dispatch({ effects: EditorView.scrollIntoView(from, { y: 'center' }) });
      return;
    }
    // Rows have a fixed height, so both panes can be placed at once and exactly.
    side.view.scrollDOM.scrollTop = Math.max(0, side.view.lineBlockAt(from).bottom - side.view.scrollDOM.clientHeight / 2);
    syncScroll();
  }

  // --- Moving between differences -------------------------------------------------------

  // The difference at or after the current scroll position, for the first press.
  function differenceFromScroll(direction) {
    const { differences, ops } = result;
    const { view } = left;
    const topLine = view.state.doc.lineAt(view.lineBlockAtHeight(view.scrollDOM.scrollTop).from).number - 1;
    let at = 0;
    while (at < navigable.length) {
      const op = ops[differences[navigable[at]].first];
      if (op.l + op.lc > topLine) break;
      at += 1;
    }
    if (direction > 0) return Math.min(at, navigable.length - 1);
    return at > 0 ? at - 1 : navigable.length - 1;
  }

  function goToDifference(index) {
    const { differences, ops } = result;
    currentDifference = index;
    const { first, last } = differences[index];
    let opIndex = first;
    while (opIndex < last && !kindShown(ops[opIndex].kind)) opIndex += 1;
    const op = ops[opIndex];
    position.textContent = `${(navigable.indexOf(index) + 1).toLocaleString()} / ${navigable.length.toLocaleString()}`;
    const side = op.lc || !op.rc ? left : right;
    const line = side === left ? op.l : op.r;
    repaintLines();
    revealLine(side, line);
    // Both path bars follow the difference, where the other side has that row.
    showPath(side, line);
    const found = opAt(side === left, line);
    let other = found ? partnerLine(side === left, found, line) : -1;
    if (other < 0) {
      // No row of its own: use where this difference starts on the other side.
      for (let at = first; at <= last && other < 0; at += 1) {
        if (side === left ? ops[at].rc : ops[at].lc) other = side === left ? ops[at].r : ops[at].l;
      }
    }
    if (other >= 0) showPath(otherSide(side), other);
    detailSide = side;
    detailLine = line;
    updateDetail();
  }

  function step(direction) {
    if (!result || !navigable.length) return;
    const at = navigable.indexOf(currentDifference);
    const next = at < 0
      ? differenceFromScroll(direction)
      : (at + direction + navigable.length) % navigable.length;
    goToDifference(navigable[next]);
  }
  prevBtn.addEventListener('click', () => step(-1));
  nextBtn.addEventListener('click', () => step(1));

  // --- Find and go to line ------------------------------------------------------------------

  function findIn(side, query, caseSensitive) {
    const found = [];
    const text = side.view.state.doc.toString();
    const haystack = caseSensitive ? text : text.toLowerCase();
    // Lowercasing can change the length of unusual characters; offsets must hold.
    const source = haystack.length === text.length ? haystack : text;
    const needle = caseSensitive || source === text ? query : query.toLowerCase();
    let at = source.indexOf(needle);
    while (at >= 0 && found.length < MAX_MATCHES_PER_SIDE) {
      found.push({ side, from: at, to: at + needle.length });
      at = source.indexOf(needle, at + needle.length);
    }
    return found;
  }

  function showSearchCount() {
    const total = search.all.length;
    if (!search.query) searchCount.textContent = '';
    else if (!total) searchCount.textContent = 'No matches';
    else {
      const capped = search.left.length >= MAX_MATCHES_PER_SIDE || search.right.length >= MAX_MATCHES_PER_SIDE ? '+' : '';
      const where = `${left.name} ${search.left.length.toLocaleString()} · ${right.name} ${search.right.length.toLocaleString()}`;
      searchCount.textContent = `${search.index >= 0 ? (search.index + 1).toLocaleString() : '–'} of ${total.toLocaleString()}${capped} (${where})`;
    }
    searchPrev.disabled = !total;
    searchNext.disabled = !total;
  }

  function runSearch() {
    const query = searchBar.hidden || searchInput.value.startsWith(':') ? '' : searchInput.value;
    search.query = query;
    search.caseSensitive = searchCase.getAttribute('aria-pressed') === 'true';
    search.left = query ? findIn(left, query, search.caseSensitive) : [];
    search.right = query ? findIn(right, query, search.caseSensitive) : [];
    // Top to bottom across both sides, by the row each match sits on.
    const withRows = (side, list) => list.map((match) => {
      match.row = rowStarts ? rowOfLine(side, side.view.state.doc.lineAt(match.from).number - 1) : 0;
      return match;
    });
    search.all = [...withRows(left, search.left), ...withRows(right, search.right)]
      .sort((a, b) => a.row - b.row || (a.side === left ? -1 : 1) - (b.side === left ? -1 : 1) || a.from - b.from);
    search.index = -1;
    showSearchCount();
    repaintLines();
  }

  function stepSearch(direction) {
    if (!search.all.length) return;
    search.index = search.index < 0
      ? (direction > 0 ? 0 : search.all.length - 1)
      : (search.index + direction + search.all.length) % search.all.length;
    const match = search.all[search.index];
    showSearchCount();
    revealLine(match.side, match.side.view.state.doc.lineAt(match.from).number - 1);
    repaintLines();
  }

  function goToTypedLine() {
    const line = Number.parseInt(searchInput.value.slice(1), 10);
    if (!Number.isInteger(line) || line < 1) {
      searchCount.textContent = 'Type a line number, such as :120';
      return;
    }
    const side = leader;
    const { doc } = side.view.state;
    const target = Math.min(line, doc.lines);
    side.view.dispatch({ selection: { anchor: doc.line(target).from } });
    revealLine(side, target - 1);
    searchCount.textContent = `Line ${target.toLocaleString()} on ${side.name}`;
    updateCaret(side);
  }

  function openSearch() {
    searchBar.hidden = false;
    searchInput.focus();
    searchInput.select();
    if (searchInput.value) runSearch();
  }

  function closeSearch() {
    searchBar.hidden = true;
    runSearch();
    leader.view.focus();
  }

  findBtn.addEventListener('click', openSearch);
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, SEARCH_DELAY_MS);
  });
  searchInput.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSearch();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (searchInput.value.startsWith(':')) {
        goToTypedLine();
        return;
      }
      clearTimeout(searchTimer);
      if (search.query !== searchInput.value) runSearch();
      stepSearch(event.shiftKey ? -1 : 1);
    }
  });
  searchCase.addEventListener('click', () => {
    searchCase.setAttribute('aria-pressed', String(searchCase.getAttribute('aria-pressed') !== 'true'));
    runSearch();
  });
  searchPrev.addEventListener('click', () => stepSearch(-1));
  searchNext.addEventListener('click', () => stepSearch(1));
  searchClose.addEventListener('click', closeSearch);

  // --- Copy and download -----------------------------------------------------------------------

  function diffText() {
    const getLine = (name, index) => (name === 'left' ? left : right).view.state.doc.line(index + 1).text;
    return unifiedDiff(result, getLine, left.name, right.name);
  }

  async function copyText(text, done) {
    try {
      await navigator.clipboard.writeText(text);
      setStatus(done, 'success');
    } catch (_) {
      setStatus('The browser blocked copying. Select the text and press Ctrl/Cmd+C.', 'warning');
    }
  }

  // Parked for now, along with its menu item above.
  // function downloadText(text, name) {
  //   const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  //   const link = el('a', { href: url, download: name });
  //   document.body.append(link);
  //   link.click();
  //   link.remove();
  //   setTimeout(() => URL.revokeObjectURL(url), 1000);
  //   setStatus(`Downloaded ${name}.`, 'success');
  // }

  // --- Choosing what to compare ----------------------------------------------------------

  function fillSources() {
    const list = windows();
    for (const side of sides) {
      const keep = side.select.value;
      const choices = [el('option', { value: 'edited', text: 'Pasted or edited' })];
      for (const win of list) {
        choices.push(el('option', { value: win.id, text: win.name }));
        const past = windowHistory?.(win.id) || [];
        if (past.length) {
          choices.push(el('optgroup', { label: `${win.name} history` },
            ...past.slice(-MAX_HISTORY_CHOICES).reverse().map((entry, index) => el('option', {
              value: `history|${win.id}|${entry.id}`,
              text: `${index + 1} back · ${formatSize(entry.chars)} · ${entry.preview.slice(0, 32)}`,
            }))));
        }
      }
      side.select.replaceChildren(...choices);
      side.select.value = keep;
      if (side.select.selectedIndex < 0) side.select.value = 'edited';
    }
  }

  async function readSource(value) {
    if (value.startsWith('history|')) {
      const [, windowId, entryId] = value.split('|');
      return readHistoryEntry(windowId, entryId);
    }
    return readWindow(value);
  }

  async function loadFile(side, file) {
    if (file.size > MAX_COMPARE_CHARS) {
      setStatus(`${file.name} is larger than the 30 MB limit in Compare.`, 'warning');
      return;
    }
    try {
      const text = await file.text();
      // A control character no text format uses: this is not a text file.
      if (text.slice(0, 8192).includes('\u0000')) {
        setStatus(`${file.name} looks like a binary file, so it wasn't opened.`, 'warning');
        return;
      }
      replaceRaw(side, text);
      setStatus(`Opened ${file.name} on ${side.name}. Ctrl/Cmd+Z brings back what was there.`);
    } catch (_) {
      setStatus(`Could not read ${file.name}.`, 'error');
    }
  }

  for (const side of sides) {
    side.select.addEventListener('pointerdown', fillSources);
    side.select.addEventListener('focus', fillSources);
    side.select.addEventListener('change', async () => {
      const { value } = side.select;
      if (value === 'edited') return;
      replaceRaw(side, await readSource(value), value);
    });
    side.pasteBtn.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (!text) return setStatus('The clipboard has no text.', 'warning');
        replaceRaw(side, text);
      } catch (_) {
        side.view.focus();
        setStatus('The browser blocked reading the clipboard. Click the pane and press Ctrl+V or Cmd+V.', 'warning');
      }
      return undefined;
    });
    side.openBtn.addEventListener('click', () => side.fileInput.click());
    side.fileInput.addEventListener('change', () => {
      const [file] = side.fileInput.files;
      side.fileInput.value = '';
      if (file) loadFile(side, file);
    });
    side.clearBtn.addEventListener('click', () => {
      if (!side.raw) return;
      replaceRaw(side, '');
      side.view.focus();
      setStatus(`Cleared the ${side.name} side. Ctrl/Cmd+Z brings it back.`);
    });
    side.empty.addEventListener('click', () => side.view.focus());
    // Capture, so the editor doesn't paste the file's name as text.
    side.pane.addEventListener('dragover', (event) => {
      if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
      event.preventDefault();
      side.pane.classList.add('is-dropping');
    }, true);
    side.pane.addEventListener('dragleave', (event) => {
      if (!side.pane.contains(event.relatedTarget)) side.pane.classList.remove('is-dropping');
    });
    side.pane.addEventListener('drop', (event) => {
      side.pane.classList.remove('is-dropping');
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      event.preventDefault();
      event.stopPropagation();
      loadFile(side, file);
    }, true);
  }

  swapBtn.addEventListener('click', () => {
    const [leftRaw, rightRaw] = [left.raw, right.raw];
    const [leftSource, rightSource] = [left.select.value, right.select.value];
    const [leftPrevious, rightPrevious] = [left.previous, right.previous];
    left.raw = rightRaw;
    right.raw = leftRaw;
    left.select.value = rightSource;
    right.select.value = leftSource;
    left.previous = rightPrevious;
    right.previous = leftPrevious;
    // A name belongs to its payload, so it moves with it.
    const [leftName, rightName] = [left.name, right.name];
    applyName(left, rightName);
    applyName(right, leftName);
    compare({ normalize: true });
  });

  // --- One comparison per window ----------------------------------------------------------------

  // What it takes to rebuild the panes. A side showing a window or a history
  // entry keeps only that link, since the text already lives there; pasted or
  // edited text has nowhere else to live, so it is kept.
  const captureSide = (side) => ({
    raw: side.select.value === 'edited' ? side.raw : null,
    source: side.select.value,
    name: side.name,
    edited: side.statusKey === 'edited',
  });
  const captureState = () => ({
    left: captureSide(left),
    right: captureSide(right),
    difference: currentDifference,
    topLine: leader.view.state.doc.lineAt(leader.view.lineBlockAtHeight(leader.view.scrollDOM.scrollTop).from).number,
    leader: leader.key,
  });

  const stateKey = (id) => `${storageScope}:window:${id}`;
  const openKey = `${storageScope}:state`;

  function saveNow() {
    clearTimeout(saveTimer);
    saveSession(openKey, { open: active, savedAt: Date.now() });
    if (!panesWindow) return;
    const state = captureState();
    const saved = windowStates.get(panesWindow);
    windowStates.set(panesWindow, state);
    // Rewriting a large payload is wasted work unless something in it changed.
    const sameSide = (a, b) => a && a.raw === b.raw && a.source === b.source && a.name === b.name && a.edited === b.edited;
    if (saved?.written && sameSide(saved.left, state.left) && sameSide(saved.right, state.right)) {
      state.written = true;
      return;
    }
    state.written = true;
    saveSession(stateKey(panesWindow), { ...state, written: undefined, savedAt: Date.now() });
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
  }

  async function switchTo(id) {
    const token = ++switchToken;
    if (panesWindow && panesWindow !== id) saveNow();
    panesWindow = null;
    currentWindow = id;
    // Anything still running describes the window being left.
    requestId += 1;
    fillSources();
    const state = windowStates.get(id);
    const loaded = [];
    const lost = [];
    if (state) {
      for (const side of sides) {
        const saved = state[side.key];
        let { raw, source } = saved;
        if (raw === null || raw === undefined) {
          side.select.value = source;
          // The window it pointed at may have been closed since.
          const stillThere = side.select.selectedIndex >= 0;
          // eslint-disable-next-line no-await-in-loop
          raw = stillThere ? await readSource(source) : '';
          if (!stillThere) {
            source = 'edited';
            lost.push(saved.name);
          }
        }
        loaded.push({ side, raw, source, name: saved.name, edited: !!saved.edited });
      }
    } else {
      // A window starts with its own payload on the left and the right open.
      const own = await readWindow(id);
      loaded.push({ side: left, raw: own, source: id, name: DEFAULT_NAMES.left, edited: false });
      loaded.push({ side: right, raw: '', source: 'edited', name: DEFAULT_NAMES.right, edited: false });
    }
    if (token !== switchToken) return;
    panesWindow = id;
    const edited = {};
    for (const { side, raw, source, name, edited: wasEdited } of loaded) {
      side.raw = raw;
      side.select.value = source;
      if (side.select.selectedIndex < 0) side.select.value = 'edited';
      side.previous = null;
      applyName(side, name);
      edited[side.key] = wasEdited;
    }
    pendingRestore = {
      edited,
      difference: state?.difference ?? -1,
      topLine: state?.topLine ?? 1,
      leader: state?.leader ?? 'left',
    };
    compare({ normalize: true });
    if (lost.length) setStatus(`The ${lost.join(' and ')} side is empty because the window it showed was closed.`, 'warning');
    scheduleSave();
  }

  // Each window remembers whether it was in Compare. Left out, the view stays.
  function windowChanged(id, comparing = active) {
    if (!comparing) {
      close();
    } else if (!active) {
      open();
    } else {
      takeOverViewButtons();
      if (id !== currentWindow) switchTo(id);
    }
  }

  function windowClosed(id) {
    windowStates.delete(id);
    deleteSession(stateKey(id));
    if (currentWindow === id) currentWindow = null;
    if (panesWindow === id) panesWindow = null;
    // A pane showing that window keeps its text, now as its own.
    fillSources();
  }

  const restoring = loadSession().then((session) => {
    const now = Date.now();
    const prefix = `${storageScope}:window:`;
    const legacy = session.left || session.right;
    for (const [key, value] of Object.entries(session)) {
      if (key.startsWith(prefix)) {
        windowStates.set(key.slice(prefix.length), { ...value, written: true });
      } else if (key !== openKey && (key === 'left' || key === 'right' || key === 'state' || now - (value?.savedAt ?? 0) > STALE_SESSION_MS)) {
        deleteSession(key);
      }
    }
    // Saved before comparisons were per window: it belongs to the current one.
    if (legacy && !windowStates.size) {
      const side = (key) => ({
        raw: session[key]?.raw ?? '',
        source: session[key]?.source === 'edited' ? 'edited' : (session[key]?.source ?? 'edited'),
        name: options[`${key}Name`] || DEFAULT_NAMES[key],
        edited: false,
      });
      windowStates.set(activeWindowId(), { left: side('left'), right: side('right'), difference: -1, topLine: 1, leader: 'left' });
    }
    return !!(session[openKey]?.open ?? session.state?.open);
  });

  // --- Entering and leaving ------------------------------------------------------------------

  let previousView = null;
  const otherViewButtons = () => [...viewToggle.querySelectorAll('button')].filter((button) => button !== toggleBtn);

  // Only one view reads as active; the one left behind comes back on close.
  function takeOverViewButtons() {
    previousView = otherViewButtons().find((button) => button.getAttribute('aria-pressed') === 'true') || previousView;
    for (const button of otherViewButtons()) button.setAttribute('aria-pressed', 'false');
    toggleBtn.setAttribute('aria-pressed', 'true');
  }

  async function open() {
    if (active) return;
    // Told before Compare covers the view, so what's under it can be noted.
    onViewChange?.(true);
    active = true;
    root.dataset.compare = 'on';
    host.dataset.compare = 'on';
    previousView = null;
    takeOverViewButtons();
    // A message about the view being left doesn't apply here.
    setStatus('');
    await restoring;
    if (!active) return;
    fillSources();
    const current = activeWindowId();
    if (current !== currentWindow) {
      await switchTo(current);
    } else {
      // A side showing a window follows what that window holds now.
      let changed = !result;
      for (const side of sides) {
        const { value } = side.select;
        if (value === 'edited' || value.startsWith('history|')) continue;
        // eslint-disable-next-line no-await-in-loop
        const text = await readWindow(value);
        if (text !== side.raw) {
          side.raw = text;
          changed = true;
        }
      }
      if (changed) compare({ normalize: true });
    }
    await nextPaint?.();
    for (const side of sides) side.view.requestMeasure();
    drawMap();
    scheduleSave();
  }

  function close() {
    if (!active) return;
    active = false;
    delete root.dataset.compare;
    delete host.dataset.compare;
    toggleBtn.setAttribute('aria-pressed', 'false');
    if (!otherViewButtons().some((button) => button.getAttribute('aria-pressed') === 'true')) previousView?.setAttribute('aria-pressed', 'true');
    for (const menu of menus) menu.open = false;
    scheduleSave();
    onViewChange?.(false);
  }

  toggleBtn.addEventListener('click', () => { if (active) close(); else open(); });
  // Choosing Text or Tree leaves Compare.
  viewToggle.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (button && button !== toggleBtn) close();
  });
  document.addEventListener('click', (event) => {
    for (const menu of menus) if (menu.open && !menu.contains(event.target)) menu.open = false;
  }, true);
  const windowTabs = document.querySelector('#windowTabs');
  if (windowTabs) new MutationObserver(() => { if (active) fillSources(); }).observe(windowTabs, { childList: true, subtree: true });

  // The main editor is hidden while comparing, and the app's page-wide paste and
  // format shortcuts must not change it from here. The panes handle their own.
  const inTextField = (target) => target?.isContentEditable || target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || !!target?.closest?.('.cm-content');
  window.addEventListener('paste', (event) => {
    if (active && !inTextField(event.target)) event.stopPropagation();
  }, true);
  window.addEventListener('keydown', (event) => {
    if (!active) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && !event.altKey && key === 'f') {
      event.preventDefault();
      event.stopPropagation();
      openSearch();
    } else if ((mod && key === 'g') || event.key === 'F3') {
      event.preventDefault();
      event.stopPropagation();
      if (searchBar.hidden) openSearch();
      else stepSearch(event.shiftKey ? -1 : 1);
    } else if (mod && event.key === 'Enter' && !inTextField(event.target)) {
      event.preventDefault();
      event.stopPropagation();
      compare({ normalize: true });
    } else if (event.key === 'Escape') {
      const openMenu = menus.find((menu) => menu.open);
      if (openMenu) {
        event.stopPropagation();
        openMenu.open = false;
        openMenu.querySelector('summary').focus();
      } else if (!inTextField(event.target)) {
        close();
        toggleBtn.focus();
      }
    }
  }, true);
  document.addEventListener('keydown', (event) => {
    if (!active) return;
    if (event.key === 'F8') {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    } else if (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      step(event.key === 'ArrowDown' ? 1 : -1);
    }
  });
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (active) drawMap(); }) : null;
  resize?.observe(map);
  new MutationObserver(() => { if (active) drawMap(); }).observe(root, { attributes: true, attributeFilter: ['data-theme'] });

  // Came back from a reload with Compare open: open it again.
  restoring.then((reopen) => { if (windowComparing?.(activeWindowId()) ?? reopen) open(); });

  return {
    open,
    close,
    isOpen: () => active,
    compare,
    step,
    restorePrevious,
    windowChanged,
    windowClosed,
    currentWindow: () => currentWindow,
    openSearch,
    stepSearch,
    search,
    sides: { left, right },
    result: () => result,
    navigable: () => navigable,
  };
}
