// Collapsible JSON / XML tree.
//
// Nodes are created lazily and rendered in chunks, so multi-megabyte payloads
// open instantly and the DOM stays small. The model half (parseTree/childAt)
// has no DOM dependency beyond DOMParser for XML, which keeps it unit-testable.

export const TREE_MAX_CHARS = { json: 20_000_000, xml: 8_000_000 };

const CHUNK_SIZE = 200;
const AUTO_OPEN_MAX_CHILDREN = 25;
const EXPAND_ALL_ROW_BUDGET = 6000;
const MAX_MATCHES = 1000;
const SEARCH_VISIT_BUDGET = 400_000;
// reveal() materializes rows to reach a search match: cap contiguous
// rendering at the same scale as expand-all, and render a bounded window
// around farther matches instead of every row from 0..index (a 130k-row
// list would otherwise freeze the tab building ~1.3M DOM nodes).
const REVEAL_ROW_BUDGET = 6000;
const REVEAL_WINDOW_ROWS = 400;
const STRING_PREVIEW_CHARS = 240;
const SIMPLE_KEY = /^[A-Za-z_$][\w$]*$/;

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

function jsonNode(key, value, path, inArray) {
  let type;
  if (value === null) type = 'null';
  else if (Array.isArray(value)) type = 'array';
  else type = typeof value;

  const node = { kind: 'json', type, key, value, path, inArray, count: 0, keys: null };
  if (type === 'array') {
    node.count = value.length;
  } else if (type === 'object') {
    node.keys = Object.keys(value);
    node.count = node.keys.length;
  }
  node.container = node.count > 0;
  return node;
}

function jsonChild(node, index) {
  if (node.type === 'array') {
    return jsonNode(index, node.value[index], `${node.path}[${index}]`, true);
  }
  const key = node.keys[index];
  const path = SIMPLE_KEY.test(key)
    ? `${node.path}.${key}`
    : `${node.path}[${JSON.stringify(key)}]`;
  return jsonNode(key, node.value[key], path, false);
}

function xmlLeaf(type, path, props) {
  return { kind: 'xml', type, path, count: 0, container: false, ...props };
}

function xmlNode(dom, path) {
  switch (dom.nodeType) {
    case 1: return xmlElement(dom, path);
    case 3: return xmlLeaf('text', path, { text: dom.nodeValue.trim() });
    case 4: return xmlLeaf('cdata', path, { text: dom.nodeValue });
    case 8: return xmlLeaf('comment', path, { text: dom.nodeValue.trim() });
    default: return xmlLeaf('pi', path, { key: dom.target, text: dom.data });
  }
}

function xmlElement(element, path) {
  const attrs = Array.from(element.attributes || [], (attr) => [attr.name, attr.value]);
  const kids = [];
  const ordinals = [];
  const totals = new Map();

  for (let child = element.firstChild; child; child = child.nextSibling) {
    const type = child.nodeType;
    if (type === 1) {
      const total = (totals.get(child.nodeName) || 0) + 1;
      totals.set(child.nodeName, total);
      kids.push(child);
      ordinals.push(total);
    } else if (type === 3) {
      if (child.nodeValue.trim()) {
        kids.push(child);
        ordinals.push(0);
      }
    } else if (type === 4 || type === 7 || type === 8) {
      kids.push(child);
      ordinals.push(0);
    }
  }

  const base = { kind: 'xml', type: 'element', key: element.nodeName, attrs, path };

  // <name>text</name> reads better as one row than as a parent with one child.
  if (kids.length === 1 && (kids[0].nodeType === 3 || kids[0].nodeType === 4)) {
    const cdata = kids[0].nodeType === 4;
    const raw = kids[0].nodeValue;
    return { ...base, count: 0, container: false, text: cdata ? raw : raw.trim(), cdata };
  }

  return { ...base, kids, ordinals, totals, count: kids.length, container: kids.length > 0 };
}

function xmlChild(node, index) {
  const dom = node.kids[index];
  if (dom.nodeType === 1) {
    const name = dom.nodeName;
    const segment = node.totals.get(name) > 1 ? `${name}[${node.ordinals[index]}]` : name;
    return xmlElement(dom, `${node.path}/${segment}`);
  }
  const suffix = dom.nodeType === 8
    ? 'comment()'
    : dom.nodeType === 7 ? 'processing-instruction()' : 'text()';
  return xmlNode(dom, `${node.path}/${suffix}`);
}

export function childAt(node, index) {
  return node.kind === 'json' ? jsonChild(node, index) : xmlChild(node, index);
}

// Users routinely paste values copied from formatted JSON/XML, quotes included
// ("email": "user1@example.com" copies as "user1@example.com" — or as a
// fragment like `"housecash` when they grab it mid-typing). Keep the literal
// query and add the de-quoted variant as an extra candidate: stripping only
// ever widens the search, never narrows it. Quotes are stripped from either
// end independently, so lone leading/trailing quotes work, not just pairs.
export function searchNeedles(query) {
  const base = String(query || '').trim().toLowerCase();
  if (!base) return [];
  const inner = base.replace(/^['"]+|['"]+$/g, '').trim();
  return inner && inner !== base ? [base, inner] : [base];
}

export function nodeMatches(node, needles) {
  return needles.some((query) => nodeMatchesOne(node, query));
}

function nodeMatchesOne(node, query) {
  if (node.kind === 'json') {
    if (node.key !== null && String(node.key).toLowerCase().includes(query)) return true;
    if (node.type === 'array' || node.type === 'object') return false;
    return String(node.value).toLowerCase().includes(query);
  }
  if (node.key && node.key.toLowerCase().includes(query)) return true;
  if (node.text && node.text.toLowerCase().includes(query)) return true;
  if (node.attrs) {
    for (const [name, value] of node.attrs) {
      if (name.toLowerCase().includes(query) || value.toLowerCase().includes(query)) return true;
    }
  }
  return false;
}

export function parseTree(text, mode, { DOMParserImpl } = {}) {
  const limit = TREE_MAX_CHARS[mode];
  if (!limit) {
    return { error: 'Could not detect JSON or XML, so there is no tree to show.', hint: 'Check the payload in Text view.' };
  }
  if (text.length > limit) {
    return {
      error: `Tree view supports ${mode.toUpperCase()} up to ${(limit / 1_000_000).toFixed(0)}M characters. This payload has ${(text.length / 1_000_000).toFixed(1)}M.`,
      hint: 'Use Text view for payloads this large.',
    };
  }

  const source = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  const repairHint = 'Press Ctrl/Cmd + Enter to format and repair the payload; the tree refreshes afterwards.';

  if (mode === 'json') {
    try {
      return { mode, root: jsonNode(null, JSON.parse(source), '$', false) };
    } catch (error) {
      return { error: error?.message || 'Invalid JSON.', hint: repairHint };
    }
  }

  const Parser = DOMParserImpl || globalThis.DOMParser;
  if (!Parser) return { error: 'This browser cannot parse XML for the tree view.', hint: 'Use Text view.' };

  const doc = new Parser().parseFromString(source, 'application/xml');
  const failure = doc.getElementsByTagName('parsererror')[0];
  if (failure || !doc.documentElement) {
    const message = (failure?.textContent || 'Invalid XML.')
      .replace(/\s+/g, ' ')
      .replace(/^This page contains the following errors:\s*/i, '')
      .replace(/Below is a rendering of the page up to the first error\.?/i, '')
      .trim()
      .slice(0, 300);
    return { error: message || 'Invalid XML.', hint: repairHint };
  }
  return { mode, root: xmlElement(doc.documentElement, `/${doc.documentElement.nodeName}`) };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function span(className, text) {
  const element = document.createElement('span');
  element.className = className;
  element.textContent = text;
  return element;
}

const showJsonString = (value, cut) => (
  cut ? `${JSON.stringify(value).slice(0, -1)}…"` : JSON.stringify(value)
);
const showPlain = (value, cut) => (cut ? `${value}…` : value);

// Long strings render as a short preview; clicking toggles the full text.
function longText(className, full, show) {
  const long = full.length > STRING_PREVIEW_CHARS;
  const element = span(className, show(long ? full.slice(0, STRING_PREVIEW_CHARS) : full, long));
  if (long) {
    element.classList.add('tree-long');
    element.title = `${full.length.toLocaleString()} characters · click to expand`;
    element._full = full;
    element._show = show;
    element._open = false;
  }
  return element;
}

function toggleLong(element) {
  element._open = !element._open;
  element.textContent = element._open
    ? element._show(element._full, false)
    : element._show(element._full.slice(0, STRING_PREVIEW_CHARS), true);
  element.classList.toggle('expanded', element._open);
}

function jsonLabel(node) {
  const parts = [];
  if (node.key !== null) {
    parts.push(
      node.inArray ? span('tree-index', String(node.key)) : span('tree-key', JSON.stringify(node.key)),
      span('tree-punct', ':\u00a0'),
    );
  }
  switch (node.type) {
    case 'array': parts.push(span('tree-count', node.count ? `[${node.count.toLocaleString()}]` : '[]')); break;
    case 'object': parts.push(span('tree-count', node.count ? `{${node.count.toLocaleString()}}` : '{}')); break;
    case 'string': parts.push(longText('tree-string', node.value, showJsonString)); break;
    case 'number': parts.push(span('tree-number', String(node.value))); break;
    case 'boolean': parts.push(span('tree-bool', String(node.value))); break;
    default: parts.push(span('tree-null', 'null'));
  }
  return parts;
}

function xmlLabel(node) {
  switch (node.type) {
    case 'element': {
      const parts = [span('tree-punct', '<'), span('tree-tag', node.key)];
      for (const [name, value] of node.attrs) {
        parts.push(
          span('tree-punct', '\u00a0'),
          span('tree-attr', name),
          span('tree-punct', '="'),
          longText('tree-attrval', value, showPlain),
          span('tree-punct', '"'),
        );
      }
      if (node.container) {
        parts.push(span('tree-punct', '>'), span('tree-count', `\u00a0(${node.count.toLocaleString()})`));
      } else if (node.text !== undefined) {
        parts.push(
          span('tree-punct', '>'),
          node.cdata
            ? span('tree-punct', '<![CDATA[')
            : span('tree-punct', ''),
          longText('tree-text', node.text, showPlain),
          node.cdata ? span('tree-punct', ']]>') : span('tree-punct', ''),
          span('tree-punct', '</'),
          span('tree-tag', node.key),
          span('tree-punct', '>'),
        );
      } else {
        parts.push(span('tree-punct', '/>'));
      }
      return parts;
    }
    case 'cdata':
      return [span('tree-punct', '<![CDATA['), longText('tree-text', node.text, showPlain), span('tree-punct', ']]>')];
    case 'comment':
      return [span('tree-comment', `<!-- ${node.text} -->`)];
    case 'pi':
      return [span('tree-comment', `<?${node.key} ${node.text}?>`)];
    default:
      return [longText('tree-text', node.text, showPlain)];
  }
}

// Case-insensitive match ranges for every needle, merged so overlapping
// candidates (e.g. a quoted and a de-quoted needle) paint one span.
export function highlightRanges(text, needles) {
  const lower = String(text).toLowerCase();
  const ranges = [];
  for (const needle of needles || []) {
    if (!needle) continue;
    let from = 0;
    for (;;) {
      const at = lower.indexOf(needle, from);
      if (at === -1) break;
      ranges.push([at, at + needle.length]);
      from = at + needle.length;
    }
  }
  if (!ranges.length) return null;
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const [start, end] of ranges) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

export function createTreeView(container, { onCopyPath } = {}) {
  let root = null;
  let rootLi = null;
  let rowCount = 0;
  let focusedRow = null;
  let matches = [];
  let current = -1;
  let hitLi = null;
  let matchPaths = new Set();
  let needles = [];

  container.addEventListener('click', onClick);
  container.addEventListener('keydown', onKeydown);

  function reset() {
    container.replaceChildren();
    root = null;
    rootLi = null;
    rowCount = 0;
    focusedRow = null;
    matches = [];
    current = -1;
    hitLi = null;
    matchPaths.clear();
    needles = [];
  }

  function showMessage(title, detail, tone = '') {
    reset();
    container.setAttribute('role', 'region');
    const box = document.createElement('div');
    box.className = `tree-message ${tone}`.trim();
    const heading = document.createElement('strong');
    heading.textContent = title;
    box.appendChild(heading);
    if (detail) {
      const paragraph = document.createElement('p');
      paragraph.textContent = detail;
      box.appendChild(paragraph);
    }
    container.appendChild(box);
  }

  function renderNode(node, depth, open, searchPath = '') {
    const li = document.createElement('li');
    li.className = 'tree-node';
    li._searchPath = searchPath;
    li.setAttribute('role', 'treeitem');
    li.setAttribute('aria-level', String(depth + 1));
    li._node = node;
    li._depth = depth;
    li._rendered = 0;
    li._group = null;
    li._more = null;
    rowCount += 1;

    const row = document.createElement('div');
    row.className = 'tree-row';
    row.tabIndex = -1;
    row.style.paddingLeft = `${depth * 16 + 6}px`;

    const toggle = span('tree-toggle', node.container ? '▸' : '');
    toggle.setAttribute('aria-hidden', 'true');
    row.appendChild(toggle);
    for (const part of node.kind === 'json' ? jsonLabel(node) : xmlLabel(node)) row.appendChild(part);

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'tree-copy';
    copy.tabIndex = -1;
    copy.textContent = 'Copy path';
    copy.title = `Copy path ${node.path}`;
    row.appendChild(copy);

    li.appendChild(row);
    if (node.container) li.setAttribute('aria-expanded', 'false');
    if (open && node.container) setOpen(li, true);
    paintRowHits(li);
    return li;
  }

  // Search hits highlight the found text itself, never the whole row.
  // Unwrapping first keeps repainting (new search, stepped hit, re-render)
  // from ever nesting highlight spans.
  function paintRowHits(li) {
    const row = li.firstElementChild;
    if (!row) return;
    for (const mark of row.querySelectorAll('.tree-hit-text')) {
      mark.replaceWith(document.createTextNode(mark.textContent));
    }
    row.normalize();
    if (!needles.length || !matchPaths.has(li._searchPath)) return;
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    const texts = [];
    let textNode;
    while ((textNode = walker.nextNode())) texts.push(textNode);
    for (const node of texts) {
      const ranges = highlightRanges(node.nodeValue, needles);
      if (!ranges) continue;
      const value = node.nodeValue;
      const frag = document.createDocumentFragment();
      let cursor = 0;
      for (const [start, end] of ranges) {
        if (start > cursor) frag.append(document.createTextNode(value.slice(cursor, start)));
        const mark = document.createElement('span');
        mark.className = 'tree-hit-text';
        mark.textContent = value.slice(start, end);
        frag.append(mark);
        cursor = end;
      }
      if (cursor < value.length) frag.append(document.createTextNode(value.slice(cursor)));
      node.replaceWith(frag);
    }
  }

  function renderChunk(li, upTo) {
    const node = li._node;
    let group = li._group;
    if (!group) {
      group = document.createElement('ul');
      group.className = 'tree-children';
      group.setAttribute('role', 'group');
      li.appendChild(group);
      li._group = group;
    }
    if (li._more) {
      li._more.remove();
      li._more = null;
    }

    const end = Math.min(node.count, upTo);
    const openKids = li._depth === 0 && node.count <= AUTO_OPEN_MAX_CHILDREN;
    const fragment = document.createDocumentFragment();
    for (let index = li._rendered; index < end; index += 1) {
      fragment.appendChild(renderNode(childAt(node, index), li._depth + 1, openKids,
        li._searchPath ? `${li._searchPath}/${index}` : String(index)));
    }
    group.appendChild(fragment);
    li._rendered = end;

    if (end < node.count) {
      const remaining = node.count - end;
      const more = document.createElement('li');
      more.className = 'tree-more';
      more.setAttribute('role', 'none');
      more.style.paddingLeft = `${(li._depth + 1) * 16 + 22}px`;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tree-more-btn';
      button.textContent = `Show ${Math.min(CHUNK_SIZE, remaining).toLocaleString()} more · ${remaining.toLocaleString()} remaining`;
      button._owner = li;
      more.appendChild(button);
      group.appendChild(more);
      li._more = more;
    }
  }

  // Drops a windowed view back to contiguous-from-zero rendering.
  function resetContiguous(li) {
    li._group.replaceChildren();
    li._more = null;
    li._windowStart = 0;
    li._rendered = 0;
  }

  // The rendered <li> for a model child index, or null when that row is
  // currently windowed out of the DOM. Rows stay contiguous from
  // _windowStart, so the DOM position is the model offset plus one slot for
  // the "earlier rows" gap button when the window does not start at zero.
  function childLiAt(li, index) {
    const start = li._windowStart || 0;
    const child = li._group?.children[(start > 0 ? 1 : 0) + (index - start)];
    return child && child._node ? child : null;
  }

  // Materializes a bounded window of rows around a far-away child index.
  // Rows stay contiguous from _windowStart, so renderChunk's "Show more"
  // appending and remaining-count math keep working unchanged.
  function renderWindow(li, index) {
    const node = li._node;
    resetContiguous(li);
    const start = Math.max(0, index - Math.floor(REVEAL_WINDOW_ROWS / 2));
    const end = Math.min(node.count, start + REVEAL_WINDOW_ROWS);
    li._windowStart = start;
    li._rendered = start;
    if (start > 0) {
      const gap = document.createElement('li');
      gap.className = 'tree-gap';
      gap.setAttribute('role', 'none');
      gap.style.paddingLeft = `${(li._depth + 1) * 16 + 22}px`;
      const jump = document.createElement('button');
      jump.type = 'button';
      jump.className = 'tree-gap-btn';
      jump.textContent = `\u2191 ${start.toLocaleString()} earlier rows \u2014 show from the top`;
      jump.addEventListener('click', () => renderWindow(li, 0));
      gap.appendChild(jump);
      li._group.appendChild(gap);
    }
    renderChunk(li, end);
  }

  function setOpen(li, open) {
    if (!li._node.container) return;
    if (open && !li._group) renderChunk(li, CHUNK_SIZE);
    li.classList.toggle('open', open);
    li.setAttribute('aria-expanded', String(open));
    if (li._group) li._group.hidden = !open;
  }

  function visibleRows() {
    return Array.from(container.querySelectorAll('.tree-row')).filter((row) => row.offsetParent !== null);
  }

  function focusRow(row, scroll = true) {
    if (focusedRow && focusedRow !== row) focusedRow.tabIndex = -1;
    row.tabIndex = 0;
    focusedRow = row;
    row.focus({ preventScroll: !scroll });
    if (scroll) row.scrollIntoView({ block: 'nearest' });
  }

  function onClick(event) {
    const target = event.target;
    const copy = target.closest('.tree-copy');
    if (copy) {
      onCopyPath?.(copy.closest('.tree-node')._node.path);
      return;
    }
    const more = target.closest('.tree-more-btn');
    if (more) {
      renderChunk(more._owner, more._owner._rendered + CHUNK_SIZE);
      return;
    }
    const row = target.closest('.tree-row');
    if (!row) return;
    focusRow(row, false);
    const long = target.closest('.tree-long');
    if (long) {
      toggleLong(long);
      return;
    }
    const li = row.parentElement;
    if (li._node.container) setOpen(li, !li.classList.contains('open'));
  }

  function onKeydown(event) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target.tagName === 'BUTTON') return;
    const row = event.target.closest('.tree-row');
    if (!row) return;
    const li = row.parentElement;
    const open = li.classList.contains('open');

    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        const rows = visibleRows();
        const next = rows[rows.indexOf(row) + (event.key === 'ArrowDown' ? 1 : -1)];
        if (next) focusRow(next);
        break;
      }
      case 'Home': {
        const rows = visibleRows();
        if (rows.length) focusRow(rows[0]);
        break;
      }
      case 'End': {
        const rows = visibleRows();
        if (rows.length) focusRow(rows[rows.length - 1]);
        break;
      }
      case 'ArrowRight':
        if (li._node.container) {
          if (!open) setOpen(li, true);
          else {
            const child = li._group.querySelector(':scope > .tree-node > .tree-row');
            if (child) focusRow(child);
          }
        }
        break;
      case 'ArrowLeft':
        if (open) setOpen(li, false);
        else {
          const parent = li.parentElement.closest('.tree-node');
          if (parent) focusRow(parent.firstElementChild);
        }
        break;
      case 'Enter':
      case ' ':
        if (li._node.container) setOpen(li, !open);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  function clearHit() {
    if (hitLi) {
      hitLi.classList.remove('tree-hit');
      hitLi.removeAttribute('aria-current');
    }
    hitLi = null;
  }

  function reveal(path) {
    let li = rootLi;
    for (const index of path) {
      setOpen(li, true);
      const start = li._windowStart || 0;
      const visible = index >= start && index < (li._rendered || 0);
      if (!visible) {
        if (index + 1 > REVEAL_ROW_BUDGET) {
          renderWindow(li, index);
        } else {
          // The match is within budget but outside the current window:
          // go back to contiguous rendering, then extend to the match.
          if (start > 0) resetContiguous(li);
          renderChunk(li, Math.ceil((index + 1) / CHUNK_SIZE) * CHUNK_SIZE);
        }
      }
      li = childLiAt(li, index);
      if (!li) return;
    }
    clearHit();
    hitLi = li;
    li.classList.add('tree-hit');
    li.setAttribute('aria-current', 'true');
    li.firstElementChild.scrollIntoView({ block: 'center' });
  }

  function summary(truncated = false) {
    return { total: matches.length, index: current, truncated };
  }

  let lastTruncated = false;

  function go(index) {
    current = ((index % matches.length) + matches.length) % matches.length;
    reveal(matches[current]);
    return summary(lastTruncated);
  }

  return {
    show(text, mode) {
      let result;
      try {
        result = parseTree(text, mode);
      } catch (error) {
        result = { error: error?.message || 'Could not parse the payload.' };
      }
      if (result.error) {
        showMessage('Can’t build a tree', [result.error, result.hint].filter(Boolean).join('\n'), 'error');
        return { ok: false, error: result.error };
      }
      try {
        reset();
        container.setAttribute('role', 'tree');
        root = result.root;
        const list = document.createElement('ul');
        list.className = 'tree-root';
        list.setAttribute('role', 'none');
        rootLi = renderNode(root, 0, true);
        list.appendChild(rootLi);
        container.appendChild(list);
        focusedRow = rootLi.firstElementChild;
        focusedRow.tabIndex = 0;
        return { ok: true, mode: result.mode, rows: rowCount };
      } catch (error) {
        showMessage('Can’t render the tree', error?.message || 'Unexpected error.', 'error');
        return { ok: false, error: error?.message || 'Render failed.' };
      }
    },

    clear(message) {
      showMessage(message || 'Nothing to show yet.', '');
    },

    expandAll() {
      if (!rootLi) return { limited: false };
      const queue = [rootLi];
      let head = 0;
      while (head < queue.length) {
        if (rowCount >= EXPAND_ALL_ROW_BUDGET) return { limited: true };
        const li = queue[head];
        head += 1;
        setOpen(li, true);
        for (const child of li._group.children) {
          if (child._node?.container) queue.push(child);
        }
      }
      return { limited: container.querySelector('.tree-more') !== null };
    },

    collapseAll() {
      if (!rootLi) return;
      for (const li of container.querySelectorAll('.tree-node.open')) setOpen(li, false);
      setOpen(rootLi, true);
    },

    find(query) {
      clearHit();
      matches = [];
      current = -1;
      lastTruncated = false;
      matchPaths.clear();
      needles = searchNeedles(query);
      if (needles.length && root) {
        if (nodeMatches(root, needles)) matches.push([]);
        const stack = [{ node: root, next: 0, path: [] }];
        let visits = 0;
        while (stack.length) {
          if (visits >= SEARCH_VISIT_BUDGET || matches.length >= MAX_MATCHES) break;
          const frame = stack[stack.length - 1];
          if (frame.next >= frame.node.count) {
            stack.pop();
            continue;
          }
          const index = frame.next;
          frame.next += 1;
          visits += 1;
          const child = childAt(frame.node, index);
          const path = frame.path.concat(index);
          if (nodeMatches(child, needles)) matches.push(path);
          if (child.container) stack.push({ node: child, next: 0, path });
        }
        lastTruncated = stack.length > 0;
        matchPaths = new Set(matches.map(path => path.join('/')));
      }
      // Single repaint pass over existing rows; never expand/materialize the
      // tree to mark hits. With empty needles paintRowHits unwraps, so clearing
      // the query cannot leave stale highlight spans behind.
      for (const li of container.querySelectorAll('.tree-node')) paintRowHits(li);
      return matches.length ? go(0) : summary(lastTruncated);
    },

    step(direction) {
      if (!matches.length) return summary(lastTruncated);
      return go(current + direction);
    },
  };
}
