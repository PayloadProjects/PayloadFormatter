import {
  EditorState,
  Compartment,
  Prec,
  RangeSetBuilder,
  EditorView,
  ViewPlugin,
  Decoration,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  defaultKeymap,
  history,
  historyKeymap,
  syntaxHighlighting,
  HighlightStyle,
  bracketMatching,
  syntaxTree,
  json,
  xml,
  search,
  highlightSelectionMatches,
  SearchQuery,
  setSearchQuery,
  getSearchQuery,
  findNext,
  findPrevious,
  tags,
} from './vendor/codemirror/codemirror.js';

// The text view is a CodeMirror 6 editor. Unlike a native textarea, which
// lays out every line of the payload on every change (seconds per keystroke
// at 8MB), CodeMirror only renders the lines in view, so multi-megabyte
// payloads stay editable, highlighted and searchable. Search is driven by
// the text-view search box in the editor strip (text-search.js).
//
// The host element (#payloadInput) keeps the textarea-shaped contract the
// rest of the app relies on: value, selectionStart/End, setSelectionRange,
// select, focus, readOnly, wrap, scrollTop/Left, and an 'input' event after
// every user edit. Setting `value` replaces the document wholesale (fresh
// undo history, no 'input' event), like assigning a textarea's value.

// Token colors come from the theme's --syntax-* variables (text-editor.css).
const highlightStyle = HighlightStyle.define([
  { tag: tags.propertyName, class: 'syntax-key' },
  { tag: [tags.string, tags.attributeValue], class: 'syntax-string' },
  { tag: tags.number, class: 'syntax-number' },
  { tag: tags.null, class: 'syntax-null' },
  { tag: [tags.bool, tags.keyword], class: 'syntax-boolean' },
  { tag: [tags.tagName, tags.standard(tags.tagName)], class: 'syntax-tag' },
  { tag: tags.attributeName, class: 'syntax-attribute' },
  { tag: tags.character, class: 'syntax-entity' },
  { tag: [tags.comment, tags.processingInstruction, tags.documentMeta], class: 'syntax-comment' },
  {
    tag: [tags.punctuation, tags.separator, tags.bracket, tags.squareBracket, tags.brace, tags.angleBracket, tags.operator],
    class: 'syntax-muted',
  },
]);

const editorTheme = EditorView.theme({
  '&': { height: '100%', color: 'var(--editor-text)', backgroundColor: 'var(--editor-bg)' },
  '&.cm-focused': { outline: 'none', boxShadow: 'inset 0 0 0 1px var(--editor-focus)' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: 'inherit' },
  '.cm-content': { padding: '12px 0', caretColor: 'var(--editor-caret)' },
  '.cm-line': { padding: '0 12px' },
  '.cm-lineWrapping .cm-line': {
    paddingLeft: 'calc(12px + var(--hang, 0ch))',
    textIndent: 'calc(-1 * var(--hang, 0ch))',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--editor-caret)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    { backgroundColor: 'var(--code-selection-bg)' },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-gutters': {
    backgroundColor: 'var(--editor-bg)',
    color: 'var(--syntax-muted)',
    borderRight: '0',
  },
  '.cm-activeLineGutter': { backgroundColor: 'var(--active-line)', color: 'var(--editor-text)' },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '44px', padding: '0 12px 0 12px' },
  '.cm-selectionMatch': { backgroundColor: 'var(--tree-match-bg)' },
  '.cm-searchMatch': { backgroundColor: 'var(--tree-match-bg)', borderRadius: '3px' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--tree-hit-bg)', outline: '1px solid var(--tree-hit-border)' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--tree-match-bg)', outline: '1px solid var(--guide)' },
});

// Counting stops here: past this many matches the label shows "N+".
const MAX_COUNTED_MATCHES = 10_000;

const matchMark = Decoration.mark({ class: 'cm-searchMatch' });
const selectedMatchMark = Decoration.mark({ class: 'cm-searchMatch cm-searchMatch-selected' });

// Marks the current query's matches in the visible lines only (cheap at any
// document size). CodeMirror's built-in highlighter only runs while its own
// search panel is open; the app uses the strip search box instead.
const searchMatchHighlighter = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = this.build(view);
  }

  update(update) {
    if (update.docChanged || update.viewportChanged || update.selectionSet
        || getSearchQuery(update.state) !== getSearchQuery(update.startState)) {
      this.decorations = this.build(update.view);
    }
  }

  build(view) {
    const query = getSearchQuery(view.state);
    if (!query.search || !query.valid) return Decoration.none;
    const builder = new RangeSetBuilder();
    const { main } = view.state.selection;
    for (const { from, to } of view.visibleRanges) {
      const cursor = query.getCursor(view.state, from, to);
      for (let match = cursor.next(); !match.done; match = cursor.next()) {
        const { from: start, to: end } = match.value;
        builder.add(start, end, start === main.from && end === main.to ? selectedMatchMark : matchMark);
      }
    }
    return builder.finish();
  }
}, { decorations: (plugin) => plugin.decorations });

// Wrap mode: continuation rows of a wrapped line line up under the start of
// its value, so a long `"about": "Proident …"` continues under the "P"
// rather than at the left edge. Other lines (array items, XML, plain text)
// hang under their own indentation plus two columns, so they read as a
// continuation. Each visible line carries the width as --hang; the theme
// turns that into a padding-left / negative text-indent pair, which leaves
// the first row where it was.
const HANG_EXTRA_COLUMNS = 2;
// Very deep indentation would squeeze continuation rows into a sliver.
const MAX_HANG_COLUMNS = 40;
// Aligning under a value may go further right, up to this column; past it
// (a very long key) the line falls back to the indentation rule.
const MAX_VALUE_HANG_COLUMNS = 60;
// `"key": ` plus the opening quote of a string value.
const JSON_KEY_PREFIX = /^"(?:[^"\\]|\\.)*"\s*:\s*"?/;
const hangDecorations = new Map();

function hangDecoration(columns) {
  let decoration = hangDecorations.get(columns);
  if (!decoration) {
    decoration = Decoration.line({ attributes: { style: `--hang: ${columns}ch` } });
    hangDecorations.set(columns, decoration);
  }
  return decoration;
}

function indentColumns(text, tabSize) {
  let columns = 0;
  for (const char of text) {
    if (char === ' ') columns += 1;
    else if (char === '\t') columns += tabSize - (columns % tabSize);
    else break;
  }
  return columns;
}

const hangingIndent = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = this.build(view);
  }

  update(update) {
    if (update.docChanged || update.viewportChanged) this.decorations = this.build(update.view);
  }

  build(view) {
    const builder = new RangeSetBuilder();
    const { doc, tabSize } = view.state;
    for (const { from, to } of view.visibleRanges) {
      for (let pos = from; pos <= to;) {
        const line = doc.lineAt(pos);
        const head = line.text.slice(0, MAX_VALUE_HANG_COLUMNS * tabSize);
        const indent = indentColumns(head, tabSize);
        const key = head.trimStart().match(JSON_KEY_PREFIX);
        const valueColumn = key ? indent + key[0].length : Infinity;
        const hang = valueColumn <= MAX_VALUE_HANG_COLUMNS
          ? valueColumn
          : Math.min(indent, MAX_HANG_COLUMNS) + HANG_EXTRA_COLUMNS;
        builder.add(line.from, line.from, hangDecoration(hang));
        pos = line.to + 1;
      }
    }
    return builder.finish();
  }
}, { decorations: (plugin) => plugin.decorations });

const wrapExtension = [EditorView.lineWrapping, hangingIndent];

// What the cursor sits on, read from the parser's syntax tree (only the
// part already parsed, so this never parses the whole document):
// { kind, segments, node } where segments are { key } / { index } for JSON
// and { tag } for XML, outermost first. Feeds the path bar and inspector.
const JSON_VALUES = new Set(['Object', 'Array', 'String', 'Number', 'True', 'False', 'Null']);
const JSON_TYPES = { Object: 'object', Array: 'array', String: 'string', Number: 'number', True: 'boolean', False: 'boolean', Null: 'null' };

function decodeKey(text) {
  try { return String(JSON.parse(text)); } catch (_) { return text.replace(/^"|"$/g, ''); }
}

function jsonValueChildren(node, limit = Infinity) {
  let count = 0;
  for (let child = node.firstChild; child && count < limit; child = child.nextSibling) {
    if (JSON_VALUES.has(child.name) || child.name === 'Property') count += 1;
  }
  return count;
}

function jsonSelection(state, pos) {
  let inner = syntaxTree(state).resolveInner(pos, -1);
  // Between tokens: prefer the value the cursor touches on the right.
  if (!JSON_VALUES.has(inner.name) && inner.name !== 'PropertyName') {
    const right = syntaxTree(state).resolveInner(pos, 1);
    if (JSON_VALUES.has(right.name) || right.name === 'PropertyName') inner = right;
  }
  const segments = [];
  let target = null;
  let prev = null;
  for (let node = inner; node; prev = node, node = node.parent) {
    if (node.name === 'Property') {
      const name = node.getChild('PropertyName');
      if (name) segments.push({ key: decodeKey(state.sliceDoc(name.from, name.to)) });
      if (!target) {
        for (let child = node.lastChild; child; child = child.prevSibling) {
          if (JSON_VALUES.has(child.name)) { target = child; break; }
        }
      }
    } else if (node.name === 'Array' && prev && JSON_VALUES.has(prev.name)) {
      let index = 0;
      for (let child = node.firstChild; child && child.from < prev.from; child = child.nextSibling) {
        if (JSON_VALUES.has(child.name)) index += 1;
      }
      segments.push({ index });
      if (!target) target = prev;
    }
  }
  if (!target && JSON_VALUES.has(inner.name)) target = inner;
  segments.reverse();
  if (!target) return { kind: 'json', segments, type: null };
  const type = JSON_TYPES[target.name];
  const raw = type === 'object' || type === 'array' ? null : state.sliceDoc(target.from, target.to);
  return {
    kind: 'json',
    segments,
    type,
    count: raw === null ? jsonValueChildren(target) : 0,
    raw,
    // Full source of the value (containers too), read only when copied.
    source: () => state.sliceDoc(target.from, target.to),
  };
}

function xmlSelection(state, pos) {
  const segments = [];
  let element = null;
  for (let node = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (node.name !== 'Element') continue;
    const open = node.getChild('OpenTag') || node.getChild('SelfClosingTag');
    const name = open?.getChild('TagName');
    if (name) segments.push({ tag: state.sliceDoc(name.from, name.to) });
    if (!element) element = node;
  }
  segments.reverse();
  return {
    kind: 'xml',
    segments,
    type: element ? 'element' : null,
    count: 0,
    raw: null,
    source: () => (element ? state.sliceDoc(element.from, element.to) : ''),
  };
}

function languageFor(mode) {
  if (mode === 'json') return json();
  if (mode === 'xml') return xml();
  return [];
}

export function createSyntaxEditor(host) {
  if (!host) return { refresh() {} };
  const root = document.documentElement;
  const language = new Compartment();
  const wrapping = new Compartment();
  const readOnly = new Compartment();
  let mode = null;
  let wrapOn = root.dataset.wrap === 'on';
  let readOnlyOn = false;
  // doc.toString() on a multi-megabyte document is not free and the app
  // reads `value` several times per edit: cache it per (immutable) doc.
  let cachedDoc = null;
  let cachedText = '';
  // The strip search box's query; re-applied whenever the document is
  // replaced (a new payload gets a fresh editor state).
  let searchText = '';
  const changeListeners = new Set();
  const findListeners = new Set();
  const cursorListeners = new Set();
  const notifyChange = () => { for (const listener of changeListeners) listener(); };

  function extensions() {
    return [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      highlightActiveLine(),
      bracketMatching(),
      highlightSelectionMatches(),
      search(),
      searchMatchHighlighter,
      syntaxHighlighting(highlightStyle),
      Prec.highest(keymap.of([
        // Ctrl/Cmd+Enter formats (the app listens for it on the host); stop
        // the default keymap from also inserting a blank line.
        { key: 'Mod-Enter', run: () => true },
        // Find goes to the strip search box; F3 / Mod-g step through hits.
        { key: 'Mod-f', run: () => { for (const listener of findListeners) listener(); return true; } },
        { key: 'F3', run: findNext, shift: findPrevious },
        { key: 'Mod-g', run: findNext, shift: findPrevious },
      ])),
      keymap.of([...historyKeymap, ...defaultKeymap]),
      language.of(languageFor(mode)),
      wrapping.of(wrapOn ? wrapExtension : []),
      // Tabs render 2 columns wide (text-editor.css); measure them the same.
      EditorState.tabSize.of(2),
      readOnly.of(EditorState.readOnly.of(readOnlyOn)),
      editorTheme,
      EditorView.contentAttributes.of({
        'aria-label': 'JSON or XML payload',
        'aria-describedby': 'editorHelp',
        spellcheck: 'false',
        autocorrect: 'off',
        autocapitalize: 'off',
      }),
      EditorView.updateListener.of((update) => {
        // The parser works in slices; a finished slice can change what the
        // cursor sits on, so it counts as a cursor update too.
        if (update.selectionSet || update.docChanged
            || syntaxTree(update.state) !== syntaxTree(update.startState)) {
          for (const listener of cursorListeners) listener();
        }
        if (!update.docChanged) return;
        syncEmpty();
        host.dispatchEvent(new Event('input', { bubbles: true }));
        notifyChange();
      }),
    ];
  }

  const view = new EditorView({
    parent: host,
    state: EditorState.create({ doc: '', extensions: extensions() }),
  });

  function text() {
    const doc = view.state.doc;
    if (doc !== cachedDoc) {
      cachedDoc = doc;
      cachedText = doc.toString();
    }
    return cachedText;
  }

  function syncEmpty() {
    host.classList.toggle('is-empty', view.state.doc.length === 0);
  }

  function clamp(offset) {
    const length = view.state.doc.length;
    const value = Number(offset);
    return Number.isFinite(value) ? Math.min(Math.max(0, Math.trunc(value)), length) : length;
  }

  function reconfigure(compartment, extension) {
    view.dispatch({ effects: compartment.reconfigure(extension) });
  }

  function applySearchQuery() {
    const query = new SearchQuery({ search: searchText, caseSensitive: false, literal: true });
    view.dispatch({ effects: setSearchQuery.of(query) });
  }

  Object.defineProperties(host, {
    value: {
      configurable: true,
      get: text,
      set(next) {
        const doc = String(next ?? '');
        view.setState(EditorState.create({ doc, extensions: extensions() }));
        cachedDoc = view.state.doc;
        cachedText = doc.includes('\r') ? cachedDoc.toString() : doc;
        syncEmpty();
        if (searchText) applySearchQuery();
        notifyChange();
      },
    },
    selectionStart: {
      configurable: true,
      get: () => view.state.selection.main.from,
      set(next) { host.setSelectionRange(next, Math.max(clamp(next), view.state.selection.main.to)); },
    },
    selectionEnd: {
      configurable: true,
      get: () => view.state.selection.main.to,
      set(next) { host.setSelectionRange(Math.min(view.state.selection.main.from, clamp(next)), next); },
    },
    readOnly: {
      configurable: true,
      get: () => readOnlyOn,
      set(next) {
        readOnlyOn = !!next;
        reconfigure(readOnly, EditorState.readOnly.of(readOnlyOn));
      },
    },
    wrap: {
      configurable: true,
      get: () => (wrapOn ? 'soft' : 'off'),
      set(next) {
        const on = next === 'soft' || next === 'hard';
        if (on === wrapOn) return;
        wrapOn = on;
        reconfigure(wrapping, wrapOn ? wrapExtension : []);
      },
    },
    scrollTop: {
      configurable: true,
      get: () => view.scrollDOM.scrollTop,
      set(next) { view.scrollDOM.scrollTop = next; },
    },
    scrollLeft: {
      configurable: true,
      get: () => view.scrollDOM.scrollLeft,
      set(next) { view.scrollDOM.scrollLeft = next; },
    },
    setSelectionRange: {
      configurable: true,
      value(start, end = start) {
        const anchor = clamp(start);
        view.dispatch({ selection: { anchor, head: Math.max(anchor, clamp(end)) } });
      },
    },
    select: {
      configurable: true,
      value() { view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }); },
    },
    focus: {
      configurable: true,
      value() { view.focus(); },
    },
  });
  syncEmpty();

  return {
    view,
    // { line, col } of the main cursor (1-based), for the status bar.
    cursor() {
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      return { line: line.number, col: head - line.from + 1 };
    },
    // Called after the cursor moves or the document changes.
    onCursor(listener) { cursorListeners.add(listener); },
    // Scroll position as the editor understands it (anchored to a document
    // position, not raw pixels), and its restore. Setting scrollTop right
    // after replacing the document is clamped by the browser to the height
    // laid out so far; the editor applies a snapshot once layout is ready.
    scrollSnapshot: () => view.scrollSnapshot(),
    restoreScroll(snapshot) {
      if (snapshot) view.dispatch({ effects: snapshot });
    },
    // The path and value under the cursor, or null without a known mode.
    selection() {
      const pos = view.state.selection.main.head;
      if (mode === 'json') return jsonSelection(view.state, pos);
      if (mode === 'xml') return xmlSelection(view.state, pos);
      return null;
    },
    // Switches the grammar when the detected payload type changes. Called on
    // every UI refresh, so an unchanged mode is a no-op.
    refresh(nextMode = mode) {
      if (nextMode === mode) return;
      mode = nextMode;
      reconfigure(language, languageFor(mode));
    },
    search: {
      // Case-insensitive literal search, highlighted in the visible lines.
      setQuery(text) {
        searchText = String(text ?? '');
        applySearchQuery();
      },
      // Select and scroll to the next/previous match (wrapping around).
      // Returns false when there is no match.
      next: () => !!searchText && findNext(view),
      previous: () => !!searchText && findPrevious(view),
      // { total, index, truncated }: index is the selected match, or -1.
      stats() {
        const query = getSearchQuery(view.state);
        if (!searchText || !query.valid) return { total: 0, index: -1, truncated: false };
        const { main } = view.state.selection;
        const cursor = query.getCursor(view.state);
        let total = 0;
        let index = -1;
        for (let match = cursor.next(); !match.done; match = cursor.next()) {
          if (match.value.from === main.from && match.value.to === main.to) index = total;
          total += 1;
          if (total >= MAX_COUNTED_MATCHES) return { total, index, truncated: true };
        }
        return { total, index, truncated: false };
      },
      // Short single-line selection, to seed the search box on Ctrl/Cmd+F.
      selectedText() {
        const { main } = view.state.selection;
        if (main.empty || main.to - main.from > 200) return '';
        const text = view.state.sliceDoc(main.from, main.to);
        return text.includes('\n') ? '' : text;
      },
      // Called after every document change (user edit or new payload).
      onChange(listener) { changeListeners.add(listener); },
      // Called when Ctrl/Cmd+F is pressed inside the editor.
      onFind(listener) { findListeners.add(listener); },
    },
  };
}
