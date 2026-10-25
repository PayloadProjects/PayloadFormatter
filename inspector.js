// Path bar and Inspector panel. The path bar (under the toolbar) shows where
// the cursor or selected tree row sits, e.g. `$ › orders › [3] › sku`; the
// Inspector (right panel, toggled only by the toolbar button) shows payload
// stats, the current selection with Copy value / Copy as jq, and the
// window's paste history. Presentation only: app.js supplies the payload,
// the selection and the history actions.
const INSPECTOR_STORAGE_KEY = 'payload-formatter:inspector:v1';
// Stats need a full parse; above this the panel shows the size only.
const MAX_STATS_CHARS = 10 * 1024 * 1024;
const STATS_DEBOUNCE_MS = 400;
const HISTORY_ROWS = 20;
const SIMPLE_KEY = /^[A-Za-z_$][\w$]*$/;
const VALUE_PREVIEW_CHARS = 80;

// Selections from the text view (segments) and the tree view (a path string
// like `$.orders[3]["a b"]` or `/root/item[2]`) share one shape.
export function segmentsFromPath(kind, path) {
  if (kind === 'xml') return String(path).split('/').filter(Boolean).map((tag) => ({ tag }));
  const segments = [];
  const pattern = /\.([A-Za-z_$][\w$]*)|\[(\d+)\]|\[("(?:[^"\\]|\\.)*")\]/g;
  let match;
  while ((match = pattern.exec(path))) {
    if (match[1] !== undefined) segments.push({ key: match[1] });
    else if (match[2] !== undefined) segments.push({ index: Number(match[2]) });
    else segments.push({ key: JSON.parse(match[3]) });
  }
  return segments;
}

// A tree row's model node as a selection.
export function selectionFromTreeNode(node) {
  if (!node) return null;
  if (node.kind === 'json') {
    const primitive = node.value === null || typeof node.value !== 'object';
    return {
      kind: 'json',
      segments: segmentsFromPath('json', node.path),
      type: node.type,
      count: node.count,
      raw: primitive ? JSON.stringify(node.value) : null,
      source: () => JSON.stringify(node.value, null, 2),
    };
  }
  return {
    kind: 'xml',
    segments: segmentsFromPath('xml', node.path),
    type: node.type,
    count: 0,
    raw: node.text ?? null,
    source: () => node.text ?? '',
  };
}

export function pathString(kind, segments) {
  if (kind === 'xml') return `/${segments.map((s) => s.tag).join('/')}`;
  return `$${segments.map((s) => ('index' in s
    ? `[${s.index}]`
    : SIMPLE_KEY.test(s.key) ? `.${s.key}` : `[${JSON.stringify(s.key)}]`)).join('')}`;
}

export function jqPath(segments) {
  const path = segments.map((s) => ('index' in s
    ? `[${s.index}]`
    : SIMPLE_KEY.test(s.key) ? `.${s.key}` : `.[${JSON.stringify(s.key)}]`)).join('');
  if (!path) return '.';
  return path.startsWith('[') ? `.${path}` : path;
}

function crumbLabel(segment) {
  if ('index' in segment) return `[${segment.index}]`;
  return 'tag' in segment ? segment.tag : segment.key;
}

function plural(count, one, many) {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

function describeType(selection) {
  const { type, count, raw } = selection;
  if (type === 'object') return plural(count, 'key', 'keys');
  if (type === 'array') return plural(count, 'item', 'items');
  if (type === 'string') {
    let length = 0;
    try { length = JSON.parse(raw).length; } catch (_) { length = Math.max(0, raw.length - 2); }
    return `string · ${plural(length, 'char', 'chars')}`;
  }
  return type || '—';
}

function displayValue(selection) {
  const { type, count, raw } = selection;
  if (type === 'object') return count ? `{${count.toLocaleString()}}` : '{}';
  if (type === 'array') return count ? `[${count.toLocaleString()}]` : '[]';
  if (raw === null || raw === undefined) return '—';
  return raw.length > VALUE_PREVIEW_CHARS ? `${raw.slice(0, VALUE_PREVIEW_CHARS - 1)}…` : raw;
}

// Strings copy as their content; everything else as JSON / XML source.
function copyableValue(selection) {
  if (selection.type === 'string') {
    try { return JSON.parse(selection.raw); } catch (_) { return selection.raw; }
  }
  return selection.source();
}

function computeJsonStats(text) {
  const root = JSON.parse(text);
  let keys = 0;
  let maxDepth = 0;
  const stack = [[root, 1]];
  while (stack.length) {
    const [value, depth] = stack.pop();
    if (value === null || typeof value !== 'object') continue;
    if (depth > maxDepth) maxDepth = depth;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) stack.push([value[i], depth + 1]);
    } else {
      for (const key in value) {
        keys += 1;
        stack.push([value[key], depth + 1]);
      }
    }
  }
  // Records: the root array, else the largest array directly under the root.
  let records = 0;
  if (Array.isArray(root)) records = root.length;
  else if (root && typeof root === 'object') {
    for (const key in root) {
      if (Array.isArray(root[key])) records = Math.max(records, root[key].length);
    }
  }
  return [
    { label: 'Records', value: records.toLocaleString() },
    { label: 'Keys', value: keys.toLocaleString() },
    { label: 'Max depth', value: maxDepth.toLocaleString() },
  ];
}

function computeXmlStats(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Invalid XML');
  let elements = 0;
  let attributes = 0;
  let maxDepth = 0;
  const stack = [[doc.documentElement, 1]];
  while (stack.length) {
    const [element, depth] = stack.pop();
    if (!element) continue;
    elements += 1;
    attributes += element.attributes.length;
    if (depth > maxDepth) maxDepth = depth;
    for (let child = element.firstElementChild; child; child = child.nextElementSibling) stack.push([child, depth + 1]);
  }
  return [
    { label: 'Elements', value: elements.toLocaleString() },
    { label: 'Attributes', value: attributes.toLocaleString() },
    { label: 'Max depth', value: maxDepth.toLocaleString() },
  ];
}

export function createInspector({ getText, getMode, getSize, isPreview, copyText, history }) {
  const root = document.documentElement;
  const toggle = document.querySelector('#inspectorToggleBtn');
  const panel = document.querySelector('#inspector');
  const pathBar = document.querySelector('#pathBar');
  const crumbs = document.querySelector('#pathCrumbs');
  const copyPathBtn = document.querySelector('#copyPathBtn');
  const statusEl = document.querySelector('#inspectorStatus');
  const statsEl = document.querySelector('#inspectorStats');
  const selPath = document.querySelector('#selectionPath');
  const selType = document.querySelector('#selectionType');
  const selValue = document.querySelector('#selectionValue');
  const copyValueBtn = document.querySelector('#copyValueBtn');
  const copyJqBtn = document.querySelector('#copyJqBtn');
  const historyList = document.querySelector('#inspectorHistory');

  let selection = null;
  let statsTimer = 0;
  let statsToken = 0;

  toggle?.addEventListener('click', () => setOpen(!isOpen(), { persist: true }));
  copyPathBtn?.addEventListener('click', () => {
    if (selection) copyText(pathString(selection.kind, selection.segments), 'Path copied.');
  });
  copyValueBtn?.addEventListener('click', () => {
    if (selection?.type) copyText(copyableValue(selection), 'Value copied.');
  });
  copyJqBtn?.addEventListener('click', () => {
    if (selection?.kind === 'json') copyText(jqPath(selection.segments), 'jq path copied.');
  });
  historyList?.addEventListener('click', (event) => {
    const item = event.target.closest('[data-position]');
    if (item) history.jump(Number(item.dataset.position));
  });

  setOpen(root.dataset.inspector === 'open');

  function isOpen() {
    return root.dataset.inspector === 'open';
  }

  function setOpen(open, { persist = false } = {}) {
    root.dataset.inspector = open ? 'open' : 'closed';
    toggle?.setAttribute('aria-pressed', String(open));
    if (persist) {
      try { localStorage.setItem(INSPECTOR_STORAGE_KEY, open ? 'open' : 'closed'); } catch (_) {}
    }
    if (open) {
      refreshPayload();
      renderSelection();
      refreshHistory();
    }
  }

  // ---- Path bar + Selection card -----------------------------------------
  function setSelection(next) {
    selection = next && next.kind ? next : null;
    renderPath();
    if (isOpen()) renderSelection();
  }

  function renderPath() {
    if (!pathBar) return;
    if (!selection || !getText()) {
      pathBar.hidden = true;
      return;
    }
    pathBar.hidden = false;
    const parts = [selection.kind === 'xml' ? '/' : '$', ...selection.segments.map(crumbLabel)];
    const nodes = [];
    parts.forEach((label, i) => {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'path-sep';
        sep.setAttribute('aria-hidden', 'true');
        sep.textContent = '›';
        nodes.push(sep);
      }
      const crumb = document.createElement('span');
      crumb.className = i === parts.length - 1 ? 'path-crumb is-current' : 'path-crumb';
      crumb.textContent = label;
      nodes.push(crumb);
    });
    crumbs.replaceChildren(...nodes);
    crumbs.setAttribute('aria-label', `Path ${pathString(selection.kind, selection.segments)}`);
  }

  function renderSelection() {
    if (!selPath) return;
    const has = !!selection && !!getText();
    selPath.textContent = has ? pathString(selection.kind, selection.segments) : 'Nothing selected';
    selType.textContent = has ? describeType(selection) : '—';
    selValue.textContent = has ? displayValue(selection) : '—';
    selValue.dataset.type = has && selection.type ? selection.type : '';
    copyValueBtn.disabled = !has || !selection.type;
    copyJqBtn.disabled = !has || selection.kind !== 'json';
    copyJqBtn.hidden = has && selection.kind === 'xml';
  }

  // ---- Payload card --------------------------------------------------------
  function refreshPayload() {
    if (!isOpen() || !statsEl) return;
    clearTimeout(statsTimer);
    statsTimer = setTimeout(computeStats, STATS_DEBOUNCE_MS);
  }

  function renderStats(status, tone, rows) {
    statusEl.textContent = status;
    statusEl.dataset.tone = tone;
    statsEl.replaceChildren(...rows.map(({ label, value }) => {
      const cell = document.createElement('div');
      cell.className = 'inspector-stat';
      const name = document.createElement('span');
      name.textContent = label;
      const number = document.createElement('strong');
      number.textContent = value;
      cell.append(name, number);
      return cell;
    }));
  }

  function computeStats() {
    const token = ++statsToken;
    const text = getText();
    const mode = getMode();
    const size = { label: 'Size', value: getSize() || '—' };
    if (!text) return renderStats('No payload', '', [size]);
    if (!mode) return renderStats('Not JSON or XML', 'error', [size]);
    const name = mode.toUpperCase();
    if (isPreview() || text.length > MAX_STATS_CHARS) {
      return renderStats(`${name} · large payload`, 'warning', [size]);
    }
    let rows;
    try {
      rows = mode === 'json' ? computeJsonStats(text) : computeXmlStats(text);
    } catch (_) {
      if (token === statsToken) renderStats(`Not valid ${name} yet`, 'error', [size]);
      return;
    }
    if (token !== statsToken) return;
    renderStats(`Valid ${name}`, 'ok', [rows[0], size, rows[1], rows[2]]);
  }

  // ---- History card --------------------------------------------------------
  function refreshHistory() {
    if (!isOpen() || !historyList) return;
    const { entries, index } = history.list();
    const rows = [];
    for (let i = entries.length - 1; i >= 0 && rows.length < HISTORY_ROWS; i -= 1) {
      const entry = entries[i];
      if (!entry.chars) continue;
      const item = document.createElement('button');
      item.type = 'button';
      item.className = i === index ? 'inspector-history-item is-current' : 'inspector-history-item';
      item.dataset.position = String(i);
      if (i === index) item.setAttribute('aria-current', 'true');
      const dot = document.createElement('span');
      dot.className = 'inspector-history-dot';
      dot.setAttribute('aria-hidden', 'true');
      const body = document.createElement('span');
      body.className = 'inspector-history-body';
      const title = document.createElement('span');
      title.className = 'inspector-history-title';
      const text = entry.text ?? (i === index ? getText() : null);
      title.textContent = entry.preview
        || (text ? text.slice(0, 120).replace(/\s+/g, ' ').trim() : 'Stored payload');
      const meta = document.createElement('span');
      meta.className = 'inspector-history-meta';
      meta.textContent = `${i === index ? 'current · ' : ''}${plural(entry.chars, 'char', 'chars')}`;
      body.append(title, meta);
      item.append(dot, body);
      rows.push(item);
    }
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'inspector-empty';
      empty.textContent = 'Pasted payloads in this window show up here.';
      rows.push(empty);
    }
    historyList.replaceChildren(...rows);
  }

  return { setSelection, refreshPayload, refreshHistory, isOpen };
}
