import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseTree, childAt, TREE_MAX_CHARS, searchNeedles, nodeMatches } from './tree-view.js';

const [app, html, css, controller, build, pkg] = await Promise.all([
  readFile(new URL('./app.js', import.meta.url), 'utf8'),
  readFile(new URL('./index.html', import.meta.url), 'utf8'),
  readFile(new URL('./tree-view.css', import.meta.url), 'utf8'),
  readFile(new URL('./tree-controller.js', import.meta.url), 'utf8'),
  readFile(new URL('./build.mjs', import.meta.url), 'utf8'),
  readFile(new URL('./package.json', import.meta.url), 'utf8'),
]);

// --- Wiring: the tree must sit on top of the existing formatter, not replace it.
assert.ok(html.includes('id="viewTextBtn"') && html.includes('id="viewTreeBtn"'),
  'Text/Tree toggle must exist');
assert.ok(html.includes('id="editorFrame"') && html.includes('data-view="text"'),
  'Text must remain the default view');
assert.ok(html.includes('id="treeView"') && html.includes('id="treeSearch"'),
  'tree pane and search must exist');
assert.ok(html.indexOf('id="payloadInput"') < html.indexOf('id="treePanel"'),
  'tree pane lives inside the editor frame, after the textarea');
assert.ok(html.includes('id="pasteFormatBtn"') && !html.includes('id="pasteBtn"') && !html.includes('id="formatBtn"'),
  'tree view must keep the combined Paste & Format action');
assert.match(html, /tree-view\.css\?v=[A-Za-z0-9._-]+/, 'tree stylesheet must be cache-busted');
assert.match(html, /app\.js\?v=[A-Za-z0-9._-]+/, 'app.js must stay cache-busted');

assert.ok(app.includes("import { createTreeController } from './tree-controller.js'"));
assert.ok(app.includes('getText: getPayloadText'),
  'tree must read the full payload so large-payload preview mode keeps working');
assert.ok(app.includes('await treeController.refresh();'),
  'tree must refresh after formatting');
assert.ok(app.includes('function resetEditorForReplace()'),
  'pasting in tree view must replace the payload, not append to a hidden caret');
assert.ok(app.includes('let largeText = null') && app.includes('async function pasteAndFormatPayload()'),
  'existing large-mode and Paste & Format code must be preserved');

assert.ok(controller.includes("from './tree-view.js'"));
assert.ok(controller.includes("payload-formatter:view:v1"));
assert.ok(!controller.includes('#payloadInput'),
  'controller must never read the editor directly');

assert.ok(css.includes('.editor-frame[data-view="tree"] .editor'), 'view switch must hide the textarea');
assert.ok(css.includes('.tree-hit') && css.includes('.tree-more-btn'), 'search hit and chunk button must be styled');
assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(css.replace(/#ffffff/g, '')),
  'tree colors must come from theme tokens so light and dark both work');

for (const file of ['tree-view.js', 'tree-view.css', 'tree-controller.js']) {
  assert.ok(build.includes(`'${file}'`), `production build must copy ${file}`);
}
assert.ok(JSON.parse(pkg).scripts.test.includes('test-tree-view.mjs'), 'npm test must run the tree tests');

// --- JSON model.
const parsed = parseTree(JSON.stringify({
  name: 'Ada', n: 1, tags: ['a', 'b'], 'odd key': { deep: [{ y: 'z' }] }, empty: {}, none: [], nil: null,
}), 'json');
assert.ok(!parsed.error);
const root = parsed.root;
assert.equal(root.type, 'object');
assert.equal(root.count, 7);
assert.equal(root.path, '$');
const byKey = (node, key) => {
  for (let i = 0; i < node.count; i += 1) {
    const child = childAt(node, i);
    if (child.key === key) return child;
  }
  throw new Error(`missing ${key}`);
};
assert.equal(byKey(root, 'name').type, 'string');
assert.equal(byKey(root, 'empty').container, false, 'empty containers are leaves');
assert.equal(byKey(root, 'nil').type, 'null');
assert.equal(childAt(byKey(root, 'tags'), 0).path, '$.tags[0]');
assert.equal(childAt(byKey(root, 'tags'), 1).path, '$.tags[1]');
const odd = byKey(root, 'odd key');
assert.equal(odd.path, '$["odd key"]');
assert.equal(childAt(childAt(byKey(odd, 'deep'), 0), 0).path, '$["odd key"].deep[0].y');

// Top-level arrays and scalars, BOM tolerance.
assert.equal(parseTree('[1,2,3]', 'json').root.count, 3);
assert.equal(parseTree('"hi"', 'json').root.type, 'string');
assert.equal(parseTree('\uFEFF{"a":1}', 'json').root.count, 1);

// Errors never throw and always explain what to do next.
const bad = parseTree('{"a": 1,, }', 'json');
assert.ok(bad.error && bad.hint && /Ctrl\/Cmd \+ Enter/.test(bad.hint));
assert.ok(parseTree('hello', 'text').error, 'unknown mode must not build a tree');
const tooBig = parseTree(' '.repeat(TREE_MAX_CHARS.json + 1), 'json');
assert.ok(tooBig.error && /Text view/.test(tooBig.hint), 'oversized payloads fall back to Text view');

// XML model coverage without adding a production dependency. The stub provides
// a small DOM-shaped document so xmlElement/xmlChild/path handling are tested
// in Node as well as JSON.
function linkChildren(parent, children) {
  parent.firstChild = children[0] || null;
  for (let i = 0; i < children.length; i += 1) {
    children[i].nextSibling = children[i + 1] || null;
  }
  return parent;
}

function element(name, attrs = [], children = []) {
  return linkChildren({
    nodeType: 1,
    nodeName: name,
    attributes: attrs.map(([attrName, value]) => ({ name: attrName, value })),
  }, children);
}
const textNode = (value) => ({ nodeType: 3, nodeValue: value, nextSibling: null });
const cdataNode = (value) => ({ nodeType: 4, nodeValue: value, nextSibling: null });
const commentNode = (value) => ({ nodeType: 8, nodeValue: value, nextSibling: null });

class StubDOMParser {
  parseFromString() {
    const firstItem = element('item', [['id', '1']], [textNode('Alpha')]);
    const secondItem = element('item', [['id', '2']], [cdataNode('Beta <raw>')]);
    const rootElement = element('root', [], [firstItem, secondItem, commentNode('note')]);
    return {
      documentElement: rootElement,
      getElementsByTagName: () => [],
    };
  }
}

const xmlParsed = parseTree('<root><item id="1">Alpha</item><item id="2"><![CDATA[Beta <raw>]]></item><!--note--></root>', 'xml', { DOMParserImpl: StubDOMParser });
assert.ok(!xmlParsed.error);
assert.equal(xmlParsed.root.kind, 'xml');
assert.equal(xmlParsed.root.path, '/root');
assert.equal(xmlParsed.root.count, 3);
const xmlFirst = childAt(xmlParsed.root, 0);
const xmlSecond = childAt(xmlParsed.root, 1);
const xmlComment = childAt(xmlParsed.root, 2);
assert.equal(xmlFirst.path, '/root/item[1]');
assert.equal(xmlFirst.text, 'Alpha');
assert.deepEqual(xmlFirst.attrs, [['id', '1']]);
assert.equal(xmlSecond.path, '/root/item[2]');
assert.equal(xmlSecond.cdata, true);
assert.equal(xmlSecond.text, 'Beta <raw>');
assert.equal(xmlComment.type, 'comment');
assert.equal(xmlComment.path, '/root/comment()');

assert.ok(controller.includes('target.isContentEditable'),
  'tree-view paste must not replace the payload while the user is editing another control');

// XML needs a DOM; without one the model must degrade gracefully, not throw.
const noDom = parseTree('<a/>', 'xml', { DOMParserImpl: null });
if (typeof globalThis.DOMParser === 'undefined') {
  assert.ok(noDom.error, 'XML without DOMParser reports a clear error');
}

// --- Search tolerates quotes copied from formatted payloads.
// Regression: searching for "user1@example.com" (quotes included, as copied
// from formatted JSON) reported "No matches" even though the value was there.
assert.deepEqual(searchNeedles('"user1@example.com"'),
  ['"user1@example.com"', 'user1@example.com'],
  'double-quoted query also tries the de-quoted value');
assert.deepEqual(searchNeedles("'abc'"), ["'abc'", 'abc'],
  'single-quoted query also tries the de-quoted value');
assert.deepEqual(searchNeedles('abc'), ['abc'],
  'unquoted query is unchanged');
assert.deepEqual(searchNeedles('  '), [], 'blank query finds nothing');
assert.deepEqual(searchNeedles('""'), ['""'], 'empty quotes stay literal');
assert.deepEqual(searchNeedles('"A@B.c"'), ['"a@b.c"', 'a@b.c'],
  'needles are lowercased like the indexed text');

const people = parseTree(JSON.stringify([{ email: 'user1@example.com', id: 2 }]), 'json');
const person = childAt(people.root, 0);
const emailNode = childAt(person, 0);
assert.equal(emailNode.key, 'email');
assert.ok(nodeMatches(emailNode, searchNeedles('"user1@example.com"')),
  'quoted value pasted from formatted JSON matches the tree node');
assert.ok(nodeMatches(emailNode, searchNeedles('user1@example.com')),
  'plain value still matches');
const idNode = childAt(person, 1);
assert.equal(idNode.key, 'id');
assert.ok(!nodeMatches(emailNode, searchNeedles('"2"')),
  'quoted "2" does not match the email node');
assert.ok(nodeMatches(idNode, searchNeedles('"2"')),
  'quoted "2" matches the numeric id node');
assert.ok(!nodeMatches(emailNode, searchNeedles('nobody@example.com')),
  'non-matching value still reports no match');

// XML parity: attribute values are quoted in markup, unquoted in the model.
assert.ok(nodeMatches(xmlFirst, searchNeedles('"1"')),
  'quoted XML attribute value matches');
assert.ok(!nodeMatches(xmlFirst, searchNeedles('"2"')),
  'wrong quoted XML attribute value does not match');
assert.ok(nodeMatches(xmlFirst, searchNeedles('Alpha')),
  'XML text content still matches unquoted');

console.log('All tree view regression tests passed.');
