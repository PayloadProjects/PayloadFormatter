import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { formatJsonBestEffort, formatValidJson } from '../src/format/resilient-format.js';
import { parseTree, childAt, nodeMatches, searchNeedles } from '../src/tree/tree-view.js';
import { selectionFromTreeNode } from '../src/panels/inspector.js';

// A formatter must never change data. JSON.parse + stringify silently rounded
// big integers, respelled numbers and dropped duplicate keys while reporting
// success, so formatting works on the payload's text instead.
const read = (file) => readFile(new URL(file, import.meta.url), 'utf8');

// --- Numbers, strings and duplicate keys survive formatting exactly ---------
{
  const big = formatJsonBestEffort('{"id":12345678901234567890,"neg":-98765432109876543210}');
  assert.ok(big.formatted.includes('12345678901234567890'), 'big integers keep every digit');
  assert.ok(big.formatted.includes('-98765432109876543210'));
  assert.equal(big.warning, '', 'exact numbers need no warning');

  const spelled = formatJsonBestEffort('{"p":1.50,"q":1e3,"r":1.0,"s":-0,"t":1E+2,"u":0.10}').formatted;
  for (const text of ['1.50', '1e3', '1.0', '-0', '1E+2', '0.10']) {
    assert.ok(spelled.includes(`: ${text}`), `${text} keeps its spelling`);
  }

  const strings = formatJsonBestEffort(String.raw`{"e":"caf\u00e9","s":"a\/b","q":"say \"hi\" \\","n":"line\nbreak"}`).formatted;
  for (const text of [String.raw`caf\u00e9`, String.raw`a\/b`, String.raw`say \"hi\" \\`, String.raw`line\nbreak`]) {
    assert.ok(strings.includes(text), `string escapes are kept: ${text}`);
  }
}
{
  const dup = formatJsonBestEffort('{"a":1,"b":2,"a":3}');
  assert.equal(dup.valid, true);
  assert.equal((dup.formatted.match(/"a":/g) || []).length, 2, 'duplicate keys are kept');
  assert.match(dup.warning, /duplicate key \("a"\)/, 'and reported');

  const many = formatJsonBestEffort('[{"x":1,"x":2},{"y":1,"y":2,"y":3}]');
  assert.match(many.warning, /3 duplicate keys \(first: "x"\)/);

  assert.equal(formatJsonBestEffort('[{"x":1},{"x":2},{"o":{"x":3}}]').warning, '',
    'the same key in different objects is not a duplicate');
  assert.match(formatJsonBestEffort(String.raw`{"a":1,"\u0061":2}`).warning, /duplicate key/,
    'escaped spellings of the same key count as duplicates');
}

// --- Decoded and repaired payloads keep their numbers too -------------------
{
  const quoted = formatJsonBestEffort(JSON.stringify('{"id":12345678901234567890,"p":1.50}')).formatted;
  assert.ok(quoted.includes('12345678901234567890') && quoted.includes('1.50'), 'inside a JSON string wrapper');
  const escaped = formatJsonBestEffort(String.raw`{\"id\":12345678901234567890}`).formatted;
  assert.ok(escaped.includes('12345678901234567890'), 'inside an escape layer');
  const trailing = formatJsonBestEffort('{"id":12345678901234567890,"p":1.50,}').formatted;
  assert.ok(trailing.includes('12345678901234567890') && trailing.includes('1.50'), 'after a repair');
}

// --- The layout still matches JSON.stringify(value, null, 2) -----------------
for (const value of [
  { a: 1, b: [1, 2, { c: null }], d: true, e: {}, f: [], g: 'x, y: {z} "q" [w]', h: [[], {}], i: { j: { k: [0] } } },
  [], {}, [[[]]], 'text', 12, null, false,
]) {
  const compact = JSON.stringify(value);
  const spaced = JSON.stringify(value, null, 1).replace(/\n\s*/g, '\n \t ');
  assert.equal(formatValidJson(compact).text, JSON.stringify(value, null, 2), `layout of ${compact}`);
  assert.equal(formatValidJson(spaced).text, JSON.stringify(value, null, 2), `input whitespace is ignored: ${compact}`);
}
assert.throws(() => formatValidJson('['.repeat(5000) + ']'.repeat(5000)), { code: 'JSON_TOO_DEEP' });
assert.equal(formatValidJson('['.repeat(200) + ']'.repeat(200)).duplicates.count, 0);

// --- Large payloads stay fast ------------------------------------------------
{
  const records = JSON.stringify(Array.from({ length: 37000 }, (_, i) => ({ id: i, name: `user${i}`, tags: ['a', 'b'], addr: { city: 'X' } })));
  const started = Date.now();
  const output = formatValidJson(records).text;
  assert.equal(output.length, JSON.stringify(JSON.parse(records), null, 2).length);
  assert.ok(Date.now() - started < 2000, `formatting ${(records.length / 1e6).toFixed(1)}M chars stays fast`);
}

// --- Tree view shows, searches and copies the payload's own numbers ----------
{
  const tree = parseTree('{"id":12345678901234567890,"p":1.50,"plain":7,"list":[1e3],"s":"1.0.0","n":null}', 'json');
  const row = (index) => childAt(tree.root, index);
  const id = row(0);
  assert.equal(id.type, 'number');
  assert.equal(id.container, false, 'an exact number is a leaf, not a container');
  assert.equal(String(id.value), '12345678901234567890');
  assert.equal(String(row(1).value), '1.50');
  assert.equal(row(2).value, 7, 'numbers a JS number can spell stay plain numbers');
  assert.equal(String(childAt(row(3), 0).value), '1e3');
  assert.equal(row(4).value, '1.0.0', 'strings are untouched');

  assert.ok(nodeMatches(id, searchNeedles('12345678901234567890')), 'search finds the exact digits');
  assert.ok(nodeMatches(row(1), searchNeedles('1.50')), 'search finds the exact spelling');
  assert.ok(nodeMatches(row(1), searchNeedles('"p": 1.50')), 'and it as a displayed row');

  const selected = selectionFromTreeNode(id);
  assert.equal(selected.raw, '12345678901234567890', 'the inspector shows the exact digits');
  assert.equal(selected.source(), '12345678901234567890', 'Copy value copies the exact digits');
  assert.match(selectionFromTreeNode(tree.root).source(), /"id": 12345678901234567890/,
    'copying a parent keeps exact numbers inside it');
}

// --- Tree DOM: exact numbers render, and search does not treat them as parents
{
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  globalThis.document = dom.window.document;
  globalThis.NodeFilter = dom.window.NodeFilter;
  globalThis.Node = dom.window.Node;
  dom.window.Element.prototype.scrollIntoView = function () {};
  const { createTreeView } = await import('../src/tree/tree-view.js');
  const box = document.createElement('div');
  document.body.appendChild(box);
  const view = createTreeView(box, { onCopyPath() {} });
  assert.ok(view.show('{"a":{"id":12345678901234567890,"created":1.729781234e9},"b":1.50}', 'json').ok);
  assert.ok(box.textContent.includes('1.50'), 'collapsed and open rows show the exact spelling');
  assert.equal(view.find('12345678901234567890').total, 1);
  assert.equal(box.querySelector('.tree-hit .tree-hit-text')?.textContent, '12345678901234567890');
  assert.equal(view.find('source').total, 0, 'the wrapper is never searched as if it had keys');
}

// --- Wiring: status line, narrow tabs, one-row toolbar ------------------------
{
  const [app, css, editorCss, html, editorJs] = await Promise.all(
    ['../src/app.js', '../src/styles/style.css', '../src/styles/text-editor.css', '../index.html', '../src/editor/text-editor.js'].map(read),
  );
  assert.match(app, /else if \(result\.warning\) \{[\s\S]*?'warning'\)/, 'duplicate keys show as a warning, not plain success');
  assert.match(css, /@media \(max-width: 820px\) \{[\s\S]*?\.window-bar \{ grid-row: 2; grid-column: 1 \/ -1; \}/,
    'on narrow screens the window tabs get their own row');
  assert.match(css, /\.window-tab \{ flex: 0 1 auto; min-width: 112px;/, 'crowded tabs scroll instead of shrinking to a letter');
  assert.match(app, /is-active'\)\?\.scrollIntoView/, 'the active tab stays in view');
  assert.match(css, /\.editor-frame \{ container: editor-frame \/ inline-size; \}/, 'the toolbar adapts to the card, not the window');
  assert.match(css, /@container editor-frame \(max-width: 1100px\)/);
  assert.match(editorCss, /\.strip-search \{\s*min-width: 120px;\s*flex: 1 1 120px;/, 'the search box shrinks before the toolbar wraps');
  for (const id of ['treeExpandAll', 'treeCollapseAll', 'copyBtn']) {
    assert.match(html, new RegExp(`id="${id}"[^>]*aria-label=`), `${id} keeps its name when only its icon shows`);
  }
  const ui = await read('../src/ui-controls.js');
  assert.match(ui, /label\.replaceChildren\(\.\.\.idleLabel\)/, 'the busy label restores the shortenable label');
  assert.match(editorJs, /scrollDOM\.scrollLeft = 0;\s*view\.scrollDOM\.scrollTop = 0;/, 'a new document starts at its top left');
  assert.doesNotMatch(editorJs, /findNext\(view\)|cursor\.next[\s\S]{0,40}MAX_COUNTED/, 'search counts with indexOf, not two cursor passes');
}

console.log('All exact-value and layout regression tests passed.');
