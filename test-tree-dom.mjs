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

assert.ok(!(pkg.dependencies && pkg.dependencies.jsdom), 'jsdom stays a dev-only dependency');

console.log('All tree search DOM lifecycle tests passed.');
