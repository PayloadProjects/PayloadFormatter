import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

// DOM-level coverage for the tree search highlight lifecycle. Node-only tests
// cannot see paintRowHits(), and this file already caught a real bug: clearing
// the search used to leave stale highlight spans behind.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.document = dom.window.document;
globalThis.NodeFilter = dom.window.NodeFilter;
globalThis.Node = dom.window.Node;
dom.window.Element.prototype.scrollIntoView = function () {};

const { createTreeView } = await import('./tree-view.js');

const PAYLOAD = JSON.stringify([
  { id: 1, name: 'User_1', email: 'user1@example.com', active: true },
  { id: 2, name: 'User_2', email: 'user2@example.com', active: false },
  { id: 3, name: 'User_3', email: 'user3@example.com', active: true },
]);

const container = document.createElement('div');
document.body.appendChild(container);
const view = createTreeView(container, { onCopyPath() {} });

assert.ok(view.show(PAYLOAD, 'json').ok, 'tree renders in the DOM');

const marks = () => [...container.querySelectorAll('.tree-hit-text')];
const nested = () => [...container.querySelectorAll('.tree-hit-text .tree-hit-text')];

// Quoted query (the reported bug) finds the node and highlights the matched text.
let result = view.find('"user2@example.com"');
assert.equal(result.total, 1, 'quoted query finds 1 match');
assert.equal(marks().length, 1, 'exactly one highlight span is painted');
assert.equal(marks()[0].textContent, '"user2@example.com"', 'highlight covers the matched text only');
assert.equal(marks()[0].closest('.tree-hit')?.tagName, 'LI',
  'the current hit carries .tree-hit for the stronger tint');
assert.equal(nested().length, 0, 'highlight spans never nest');

// A new search repaints instead of duplicating spans.
result = view.find('"user1@example.com"');
assert.equal(result.total, 1);
assert.equal(marks().length, 1, 'repaint replaces highlight spans');
assert.equal(marks()[0].textContent, '"user1@example.com"');
assert.equal(nested().length, 0);

// Clearing the query must unwrap every highlight span.
result = view.find('');
assert.equal(result.total, 0);
assert.equal(marks().length, 0, 'clearing the search removes all highlight spans');

// A query with no matches leaves nothing behind either.
result = view.find('nobody-here-xyz');
assert.equal(result.total, 0);
assert.equal(marks().length, 0);

// Plain queries keep working and highlight only the query text.
result = view.find('user3');
assert.equal(result.total, 1);
assert.equal(marks()[0].textContent, 'user3');

// Highlights survive collapse/expand re-renders without nesting.
const firstUser = [...container.querySelectorAll('.tree-node')].find((li) => li._depth === 1);
assert.ok(firstUser, 'a depth-1 node exists for the expand check');
const toggle = firstUser.querySelector('.tree-toggle');
toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
assert.ok(marks().length >= 1, 'highlights survive re-render');
assert.equal(nested().length, 0, 'still no nested spans after re-render');

// The new test file is wired into the suite.
const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
assert.ok(pkg.scripts.test.includes('test-tree-dom.mjs'), 'npm test runs the DOM tests');
// --- Expansion snapshot: openPaths() captures, restoreOpen() brings back ---
{
  const box = document.createElement('div');
  document.body.appendChild(box);
  const tree = createTreeView(box, { onCopyPath() {} });
  const nested = JSON.stringify({ a: { b: { c: 1 } }, d: [1, 2, 3] });
  assert.ok(tree.show(nested, 'json').ok, 'nested tree renders');

  const openCount = () => box.querySelectorAll('.tree-node.open').length;
  const clickRow = (row) => row.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  // Small trees auto-open the root's children (AUTO_OPEN_MAX_CHILDREN).
  assert.equal(openCount(), 3, 'root and its two children start open');

  // Expand a.b: rows render in DOM order root, a, b, d.
  const rows = [...box.querySelectorAll('.tree-row')];
  clickRow(rows[2]); // b
  assert.equal(openCount(), 4, 'a.b is now open too');

  const paths = tree.openPaths();
  assert.deepEqual(paths, [[], [0], [0, 0], [1]], 'openPaths captures index-paths from the root');

  // Rebuild collapses to the auto-open state (the window-switch case); restore brings it back.
  assert.ok(tree.show(nested, 'json').ok, 'rebuild succeeds');
  assert.equal(openCount(), 3, 'rebuild returns to the auto-open state');
  tree.restoreOpen(paths);
  assert.equal(openCount(), 4, 'restoreOpen re-expands the captured nodes');
  assert.equal(box.querySelectorAll('.tree-row').length, 8, 'restored children render again');

  // Garbage paths fail soft: unknown branches stop, the rest still restore.
  tree.show(nested, 'json');
  tree.restoreOpen([[99], [0, 0], 'nope', null]);
  assert.equal(openCount(), 4, 'valid path [0,0] (a.b) restores despite bad siblings');
  tree.restoreOpen('nope');
  assert.equal(openCount(), 4, 'non-array snapshot is a no-op');
}

// --- Whole-payload search: every match is found and reachable --------------
// Regression: search stopped after 400k visited nodes (~28k of 37k records
// in a 5MB payload) and kept only 1000 matches, so later data was unfindable.
{
  const box = document.createElement('div');
  document.body.appendChild(box);
  const tree = createTreeView(box, { onCopyPath() {} });
  const records = Array.from({ length: 37000 }, (_, i) => ({
    id: i, name: `user${i}`, email: `u${i}@x.com`, tags: ['a', 'b'], addr: { city: 'X', zip: '12345' },
  }));
  assert.ok(tree.show(JSON.stringify(records), 'json').ok, '37k-record tree renders');

  let started = Date.now();
  let found = tree.find('user36999');
  const elapsed = Date.now() - started;
  assert.equal(found.total, 1, 'the last record is found');
  assert.equal(found.truncated, false, 'the search covered the whole payload');
  assert.ok(elapsed < 3000, `whole-payload search took ${elapsed}ms`);
  assert.equal(box.querySelector('.tree-hit .tree-hit-text')?.textContent, 'user36999', 'and revealed + highlighted');

  found = tree.find('email');
  assert.equal(found.total, 37000, 'every match is counted, not just the first 1000');
  found = tree.step(-1);
  assert.equal(found.index, 36999, 'stepping back from the first match wraps to the very last one');
  assert.ok(box.querySelector('.tree-hit').textContent.includes('u36999@x.com'), 'the last match is revealed');

  started = Date.now();
  found = tree.find('"email": "u36999@x.com"');
  assert.equal(found.total, 1, 'a whole `"key": "value"` line copied from text view is found');
  assert.ok(Date.now() - started < 5000, 'display-text search stays fast on a large payload');
  const marks = [...box.querySelectorAll('.tree-hit .tree-hit-text')].map((mark) => mark.textContent).join('');
  assert.equal(marks.replace(/\u00a0/g, ' '), '"email": "u36999@x.com"', 'the whole line is highlighted across its spans');

  // Array positions are tree numbering, not data.
  tree.show(JSON.stringify({ list: [10, 20, 30], other: 'none' }), 'json');
  found = tree.find('1');
  assert.equal(found.total, 1, 'only the value 10 matches "1", not array position 1');
  assert.ok(box.querySelector('.tree-hit').textContent.includes('10'));
  assert.equal(box.querySelector('.tree-index .tree-hit-text'), null, 'array positions are never highlighted');

  // The match list is capped; the count says so.
  tree.show(JSON.stringify(Array.from({ length: 100_005 }, () => 'x')), 'json');
  found = tree.find('x');
  assert.equal(found.total, 100_000);
  assert.equal(found.truncated, true, 'past 100,000 matches the count shows "+"');
}

// --- Matching and highlighting what the tree displays ----------------------
{
  const box = document.createElement('div');
  document.body.appendChild(box);
  const tree = createTreeView(box, { onCopyPath() {} });
  const hitMarks = () => [...box.querySelectorAll('.tree-hit .tree-hit-text')].map((mark) => mark.textContent).join('');
  tree.show(JSON.stringify({ note: 'say "hi"', path: 'C:\\temp\\file', long: `${'x'.repeat(300)}needle-at-end` }), 'json');

  assert.equal(tree.find('say "hi"').total, 1, 'the raw value (quotes unescaped) matches');
  assert.equal(hitMarks(), 'say \\"hi\\"', 'and is highlighted in its escaped, displayed form');
  assert.equal(tree.find('say \\"hi\\"').total, 1, 'the displayed (escaped) text matches too');
  assert.equal(hitMarks(), 'say \\"hi\\"');
  assert.equal(tree.find('C:\\temp').total, 1, 'a raw backslash path matches');
  assert.equal(hitMarks(), 'C:\\\\temp', 'and is highlighted as displayed');
  assert.equal(tree.find('C:\\\\temp').total, 1, 'the displayed, escaped path matches too');

  const before = box.querySelector('.tree-long');
  assert.ok(!before.classList.contains('expanded'), 'long strings start as a preview');
  assert.equal(tree.find('needle-at-end').total, 1);
  assert.ok(box.querySelector('.tree-hit .tree-long').classList.contains('expanded'),
    'a hit past the preview expands the string');
  assert.equal(hitMarks(), 'needle-at-end', 'so the match is visible and highlighted');

  // Rows ruled out by the fast pre-check must still match their display text
  // where JSON escaping adds characters, or the row shows counts/markers.
  tree.show(JSON.stringify({ text: 'line1\nline2', tags: ['a', 'b'] }), 'json');
  assert.equal(tree.find('line1\\nline2').total, 1, 'an escaped newline as displayed (line1\\nline2) matches');
  assert.equal(tree.find('"tags": [2]').total, 1, 'a container row as displayed ("tags": [2]) matches');

  globalThis.DOMParser = dom.window.DOMParser;
  tree.show('<root><item id="a1">Tom &amp; Jerry</item><item id="a2"><![CDATA[x < y]]></item></root>', 'xml');
  assert.equal(tree.find('id="a1"').total, 1, 'an attr="value" pair matches');
  assert.equal(hitMarks(), 'id="a1"', 'and is highlighted across the attribute spans');
  assert.equal(tree.find('Tom & Jerry').total, 1, 'decoded XML text matches');
  assert.equal(tree.find('Tom &amp; Jerry').total, 1, 'entity-escaped text copied from the raw XML matches');
  assert.equal(hitMarks(), 'Tom & Jerry', 'and highlights the decoded text shown in the tree');
  assert.equal(tree.find('<item id="a2">').total, 1, 'a start tag copied from the XML matches');
  assert.equal(tree.find('<![CDATA[x').total, 1, 'CDATA markup as displayed matches');
  assert.equal(tree.find('&quot;nope&quot;').total, 0, 'an entity-only query with no data match finds nothing');
}

assert.ok(!(pkg.dependencies && pkg.dependencies.jsdom), 'jsdom stays a dev-only dependency');

console.log('All tree search DOM lifecycle tests passed.');
