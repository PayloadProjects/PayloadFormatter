import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { shimLayout } from './test-support.mjs';
import { canonicalNumber, compareTexts, inlineDiff, splitLines, KIND } from '../src/compare/compare-diff.js';
import { detectMode, normalizePayload, sameJsonContent, sameXmlContent } from '../src/compare/compare-normalize.js';
import { jsonPathAt, xmlPathAt } from '../src/compare/compare-path.js';
import { unifiedDiff } from '../src/compare/compare-export.js';
import { formatXmlBestEffort } from '../src/format/resilient-format.js';
import { PAYLOAD_COMPARE } from '../src/feature-flags.js';

// --- The flag --------------------------------------------------------------
assert.ok(['Y', 'N'].includes(PAYLOAD_COMPARE), 'the flag is Y or N');
const appSource = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const pageSource = await readFile(new URL('../index.html', import.meta.url), 'utf8');
assert.match(appSource, /if \(PAYLOAD_COMPARE === 'Y'\) \{\s+loadCompare\(\)/, 'compare loads only behind the flag');
assert.equal((appSource.match(/compare-feature\.js/g) || []).length, 1, 'one dynamic import, no static one');
assert.doesNotMatch(appSource, /^import .*compare\//m, 'app.js has no static compare import');
assert.doesNotMatch(pageSource, /compare/i, 'index.html knows nothing about compare');

// --- Lines ------------------------------------------------------------------
assert.deepEqual(splitLines(''), []);
assert.deepEqual(splitLines('a\r\nb\rc\nd'), ['a', 'b', 'c', 'd'], 'all line endings split like the editor');

// Every line of both sides appears exactly once, in order.
function assertCovers(result, leftText, rightText) {
  let l = 0;
  let r = 0;
  for (const op of result.ops) {
    if (op.lc) assert.equal(op.l, l, 'left lines stay in order');
    if (op.rc) assert.equal(op.r, r, 'right lines stay in order');
    l += op.lc;
    r += op.rc;
  }
  assert.equal(l, splitLines(leftText).length, 'all left lines covered');
  assert.equal(r, splitLines(rightText).length, 'all right lines covered');
}
const check = (leftText, rightText, options) => {
  const result = compareTexts(leftText, rightText, options);
  assertCovers(result, leftText, rightText);
  return result;
};
const kinds = (result) => result.ops.map((op) => op.kind);

// --- Comparing --------------------------------------------------------------
assert.equal(check('a\nb', 'a\nb').identical, true);
assert.equal(check('', '').identical, true);
assert.deepEqual(check('', 'a\nb').counts, { added: 2, removed: 0, changed: 0, moved: 0 });
assert.deepEqual(check('a\nb', '').counts, { added: 0, removed: 2, changed: 0, moved: 0 });
assert.equal(check('a\r\nb', 'a\nb').identical, true, 'line endings alone are no difference');

const changed = check('one\ntwo total 5\nthree', 'one\ntwo total 6\nthree');
assert.equal(changed.counts.changed, 1, 'an edited line pairs up as changed');
assert.deepEqual(kinds(changed), [KIND.SAME, KIND.CHANGED, KIND.SAME]);

const inserted = check('a\nb\nc', 'a\nb\nnew line\nc');
assert.equal(inserted.counts.added, 1);
assert.equal(inserted.differences.length, 1);

const base = Array.from({ length: 100 }, (_, i) => `row number ${i}`);
const shifted = [...base.slice(0, 20), ...base.slice(30, 70), ...base.slice(20, 30), ...base.slice(70)];
const moved = check(base.join('\n'), shifted.join('\n'));
assert.equal(moved.counts.moved, 1, 'a relocated block is one move');
assert.equal(moved.counts.added + moved.counts.removed, 0, 'not an add plus a remove');
assert.equal(moved.differences.length, 2, 'both ends of the move can be stepped to');

// --- Ignore options ----------------------------------------------------------
assert.equal(check('A b', 'a b', { ignoreCase: true }).identical, true);
assert.equal(check('a  b', 'ab', { ignoreWhitespace: true }).identical, true);
assert.equal(check('a\n\nb', 'a\nb', { ignoreEmptyLines: true }).identical, true);
assert.equal(check('a\n\nb', 'a\nb').identical, false, 'blank lines count unless ignored');

// --- Inside a line ------------------------------------------------------------
const inline = inlineDiff('"total": 129.5,', '"total": 130.5,');
assert.equal('"total": 129.5,'.slice(...inline.left[0]), '129', 'only the part that differs is marked, as whole digits');
assert.equal('"total": 130.5,'.slice(...inline.right[0]), '130');
assert.deepEqual(inlineDiff('same', 'same'), { left: [], right: [] });

// --- Large and awkward input stays quick ---------------------------------------
const started = Date.now();
const big = Array.from({ length: 100000 }, (_, i) => `"key${i}": ${i},`);
const reversed = [...big].reverse();
assertCovers(compareTexts(big.join('\n'), reversed.join('\n')), big.join('\n'), reversed.join('\n'));
assert.ok(Date.now() - started < 20000, 'reversing every line does not hang');

// --- Normalizing keeps values exact ----------------------------------------------
assert.equal(detectMode('{"a":1}'), 'json');
assert.equal(detectMode('<a/>'), 'xml');
assert.equal(detectMode('&lt;a&gt;&lt;b&gt;1&lt;/b&gt;&lt;/a&gt;'), 'xml', 'entity-encoded XML is recognised');
assert.equal(detectMode('&lt;3 you'), null, 'but ordinary text with an entity is not');
const exact = normalizePayload('{"big":12345678901234567890,"price":1.10,"e":1E5,"s":"\\u00e9"}');
assert.equal(exact.mode, 'json');
for (const piece of ['12345678901234567890', '1.10', '1E5', '\\u00e9']) {
  assert.ok(exact.text.includes(piece), `${piece} is kept exactly`);
}
const sorted = normalizePayload('{"b":1.10,"a":{"d":1,"c":2}}', { sortKeys: true });
assert.ok(sorted.text.indexOf('"a"') < sorted.text.indexOf('"b"'), 'keys sort');
assert.ok(sorted.text.indexOf('"c"') < sorted.text.indexOf('"d"'), 'nested keys sort');
assert.ok(sorted.text.includes('1.10'), 'sorting keeps exact values');
assert.equal(
  compareTexts(
    normalizePayload('{"a":1,"b":2}', { sortKeys: true }).text,
    normalizePayload('{"b":2,"a":1}', { sortKeys: true }).text,
  ).identical,
  true,
  'key order is ignored when sorting',
);
assert.equal(normalizePayload('not a payload').text, 'not a payload', 'other text passes through');
assert.equal(normalizePayload('{"a":1}', { format: false }).text, '{"a":1}', 'format off leaves text alone');

// --- The data is never changed --------------------------------------------------
// Anything formatting would alter stays exactly as pasted.
for (const text of ['{"a":1,}', '"{\\"a\\":1}"', '<a><b> </b></a>', 'Response: {"a":1}']) {
  assert.equal(normalizePayload(text).text, text, `${text} stays as pasted`);
}
// Layout may change, data may not.
const layoutOnly = [
  ['{"a":1,"a":2}', 'json'], ['{"s":"a  b","n":1.0E+2,"u":"\\u00e9","e":""}', 'json'], ['\ufeff{"a":1}', 'json'], ['{"a":1,', 'json'],
  ['{"a":1}garbage', 'json'], ['[1 2]', 'json'], ['<a><b></b><c/></a>', 'xml'], ['<a>  text  </a>', 'xml'], ['<a x="1  2"><![CDATA[ x ]]><!-- c -->&amp;&#38;</a>', 'xml'],
  ['<a>one <b>two</b> three</a>', 'xml'], ['<a><b>1</a>', 'xml'],
];
for (const [text, mode] of layoutOnly) {
  const out = normalizePayload(text).text;
  assert.ok((mode === 'json' ? sameJsonContent : sameXmlContent)(text, out), `${text} only changes layout: ${out}`);
  if (text.startsWith('\ufeff')) assert.ok(out.startsWith('\ufeff'), 'a byte order mark stays');
}
assert.ok(normalizePayload('<a><b></b></a>').text.includes('<b></b>'), 'an empty element is not shortened');
assert.ok(formatXmlBestEffort('<a><b></b></a>').formatted.includes('<b/>'), 'the main formatter behaves as before');
const decodedXml = formatXmlBestEffort('&lt;a x=&quot;1&quot;&gt;&lt;b&gt;1 &amp;amp; 2&lt;/b&gt;&lt;/a&gt;');
assert.equal(decodedXml.valid, true, 'the main formatter decodes entity-encoded XML');
assert.ok(decodedXml.formatted.includes('<b>1 &amp; 2</b>'), 'one layer, so real entities survive');
assert.ok(decodedXml.repairNote, 'and says it did');
const encodedText = '&lt;a&gt;&lt;b&gt;1&lt;/b&gt;&lt;/a&gt;';
assert.equal(normalizePayload(encodedText).text, encodedText, 'Compare keeps it exactly as pasted');
assert.equal(normalizePayload(encodedText).status, 'kept');

// The checks themselves catch real changes.
assert.equal(sameJsonContent('{"a":1,}', '{"a":1}'), false);
assert.equal(sameJsonContent('{"a":"x y"}', '{"a":"xy"}'), false, 'space inside a string is data');
assert.equal(sameJsonContent('[1 2]', '[12]'), false, 'space between bare values is data');
assert.equal(sameJsonContent('{"a":"\\u00e9"}', '{"a":"é"}'), false);
assert.equal(sameJsonContent('{ "a" : 1 }', '{"a":1}'), true);
assert.equal(sameXmlContent('<a></a>', '<a/>'), false);
assert.equal(sameXmlContent('<a> </a>', '<a></a>'), false, 'space as a value is data');
assert.equal(sameXmlContent('<a> x</a>', '<a>x</a>'), false);
assert.equal(sameXmlContent('<a x="1 2"/>', '<a x="12"/>'), false);
assert.equal(sameXmlContent('<a><!-- c --></a>', '<a><!--c--></a>'), false);
assert.equal(sameXmlContent('<a  x = "1" ><b/>\n</a>', '<a x="1">\n\t<b/></a>'), true);

// Sort keys keeps every key and value as written.
const sortedDup = normalizePayload('{"b":1,"a":1,"a":2}', { sortKeys: true });
assert.equal(sortedDup.status, 'sorted');
assert.equal(sortedDup.text, '{\n  "a": 1,\n  "a": 2,\n  "b": 1\n}', 'duplicates stay, in their own order');
assert.equal(compareTexts(sortedDup.text, normalizePayload('{"a":2,"b":1}', { sortKeys: true }).text).identical, false, 'a dropped duplicate shows up');
const spelled = normalizePayload('{"z":"\\u00e9","\\u0041":1E5,"m":{"y":1.10,"x":[{"d":null,"c":true}]},"e":{},"f":[]}', { sortKeys: true }).text;
for (const piece of ['"\\u00e9"', '"\\u0041"', '1E5', '1.10', 'null', 'true']) assert.ok(spelled.includes(piece), `${piece} keeps its spelling`);
assert.ok(spelled.indexOf('"c"') < spelled.indexOf('"d"'), 'objects inside arrays sort too');
assert.equal(normalizePayload('[3,1,2]', { sortKeys: true }).text, '[\n  3,\n  1,\n  2\n]', 'array order is data');

// Status says what the pane shows, and Format off means exactly as pasted.
assert.equal(normalizePayload('{"a":1}').status, 'layout');
assert.equal(normalizePayload('{"a":1,}').status, 'kept');
assert.equal(normalizePayload('{"a":1,').status, 'invalid-layout');
assert.equal(normalizePayload('hello').status, 'pasted');
assert.equal(normalizePayload('<a/>', { sortKeys: true }).status, 'layout-no-sort');
for (const text of ['{"b": 1,\r\n  "a":2 }  ', '<a> <b></b></a>\n', '\ufeff{"a":1,}', '{"a":1,']) {
  for (const options of [{ format: false }, { format: false, sortKeys: text.includes('<') }]) {
    const result = normalizePayload(text, options);
    assert.equal(result.text, text, 'Format off returns the exact text');
    assert.equal(result.status, 'pasted');
  }
}
assert.equal(normalizePayload('<a/>', { format: false, sortKeys: true }).text, '<a/>', 'Sort keys does not format XML behind your back');

// --- Accuracy of the comparison -----------------------------------------------------
const pretty = (value) => JSON.stringify(value, null, 2);
const editNotMove = check(
  pretty({ items: [{ qty: 2, sku: 'A1' }, { qty: 1, sku: 'B2' }] }),
  pretty({ items: [{ qty: 2, sku: 'A1' }, { qty: 3, sku: 'B2' }, { qty: 1, sku: 'C3' }] }),
);
assert.equal(editNotMove.counts.moved, 0, 'an edited value is not a move');
assert.equal(editNotMove.counts.changed, 1, '"qty": 1 to "qty": 3 is one changed line');
assert.equal(check('<r>\n\t<b>1</b>\n\t<a>2</a>\n</r>', '<r>\n\t<a>2</a>\n\t<b>1</b>\n</r>').counts.moved, 1, 'a clear single-line move still counts');
const commaOnly = check('[\n  1\n],\n"x"', '[\n  1\n]\n"x"');
assert.equal(commaOnly.counts.changed, 1, '], and ] pair up as one changed line');
assert.equal(commaOnly.counts.added + commaOnly.counts.removed, 0);

// --- Choosing what to ignore --------------------------------------------------------
assert.equal(canonicalNumber('1.0'), canonicalNumber('1'));
assert.equal(canonicalNumber('1e2'), canonicalNumber('100'));
assert.equal(canonicalNumber('10e-1'), canonicalNumber('1'));
assert.notEqual(canonicalNumber('1.5'), canonicalNumber('1.50001'));
assert.notEqual(canonicalNumber('12345678901234567890'), canonicalNumber('12345678901234567891'), 'big numbers stay exact');
const spelling = { equivalentValues: true };
const equal = check('{\n  "n": 1.0,\n  "m": 1e2,\n  "s": "\\u00e9",\n  "u": "\\/x"\n}', '{\n  "n": 1,\n  "m": 100,\n  "s": "é",\n  "u": "/x"\n}', spelling);
assert.equal(equal.identical, true, 'same values spelled differently match on request');
assert.equal(equal.ignoredRows, 4, 'and the rows treated as equal are counted');
assert.equal(check('{\n  "n": 1.5\n}', '{\n  "n": 1.6\n}', spelling).identical, false, 'real value changes still show');
assert.equal(check('{\n  "n": 1.0\n}', '{\n  "n": 1\n}').identical, false, 'exact by default');

const ignoring = { ignoreFields: ['trace', 'createdAt', 'meta'] };
const fields = check(pretty({ id: 1, trace: 'a', createdAt: 'x', meta: { a: 1, b: [1, 2] }, z: 1 }), pretty({ id: 1, trace: 'b', createdAt: 'y', meta: { q: 9 }, z: 1 }), ignoring);
assert.equal(fields.identical, true, 'named fields are left out, including whole objects');
assert.ok(fields.ignoredRows > 0, 'and what was left out is counted');
assert.equal(check(pretty({ id: 1, trace: 'a' }), pretty({ id: 2, trace: 'b' }), ignoring).counts.changed, 1, 'other fields still compare');
const xmlFields = check(
  '<r t="1" k="a">\n\t<trace>a</trace>\n\t<o>\n\t\t<x>1</x>\n\t</o>\n\t<v>1</v>\n</r>',
  '<r t="2" k="a">\n\t<trace>b</trace>\n\t<o>\n\t\t<y>2</y>\n\t\t<z/>\n\t</o>\n\t<v>1</v>\n</r>',
  { ignoreFields: ['trace', 't', 'o'] },
);
assert.equal(xmlFields.identical, true, 'XML tags and attributes can be ignored too');
assert.equal(check('<r k="a"/>', '<r k="b"/>', { ignoreFields: ['t'] }).identical, false);

const arrays = (text) => normalizePayload(text, { sortArrays: true });
assert.equal(arrays('[3,1,{"y":1,"x":2}]').status, 'sorted-arrays');
assert.equal(arrays('[3,1,{"y":1.10,"x":2}]').text, arrays('[{"x":2,"y":1.10},3,1]').text, 'array order can be ignored');
assert.notEqual(arrays('[1,1,2]').text, arrays('[1,2]').text, 'repeated items still count');
assert.ok(arrays('[1.10,1E5]').text.includes('1.10') && arrays('[1.10,1E5]').text.includes('1E5'), 'values keep their spelling');

// --- Where the caret is --------------------------------------------------------------
const pathLines = pretty({ order: { id: 1, items: [{ sku: 'A' }, { sku: 'B', tags: ['x', 'y'] }], note: 'n' }, z: [1] }).split('\n');
const pathOf = (needle) => jsonPathAt((i) => pathLines[i], pathLines.findIndex((line) => line.includes(needle)));
assert.equal(pathOf('"id"'), '$.order.id');
assert.equal(pathOf('"A"'), '$.order.items[0].sku');
assert.equal(pathOf('"B"'), '$.order.items[1].sku');
assert.equal(pathOf('"y"'), '$.order.items[1].tags[1]');
assert.equal(pathOf('"note"'), '$.order.note');
assert.equal(jsonPathAt((i) => pathLines[i], 0), '$');
assert.equal(jsonPathAt((i) => pathLines[i], pathLines.findIndex((line) => line.trim() === ']')), '$.order.items[1].tags', 'a closing bracket belongs to what it closes');
const oddKey = pretty({ 'a-b c': { x: 1 } }).split('\n');
assert.equal(jsonPathAt((i) => oddKey[i], 2), '$["a-b c"].x', 'keys that need quoting match the Text view\'s format');
const longArray = pretty(Array.from({ length: 30000 }, (_, i) => ({ id: i, name: 'n' }))).split('\n');
const lastId = longArray.lastIndexOf('    "id": 29999,');
const walkStart = Date.now();
assert.equal(jsonPathAt((i) => longArray[i], lastId), '$[29999].id', 'works at the bottom of a long array');
assert.ok(Date.now() - walkStart < 500, 'and quickly enough for a caret move');
const xmlLines = '<a>\n\t<b>\n\t\t<c>1</c>\n\t</b>\n</a>'.split('\n');
assert.equal(xmlPathAt((i) => xmlLines[i], 2), '/a/b/c');

// --- Exporting ----------------------------------------------------------------------
const exportLeft = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten'.split('\n');
const exportRight = 'one\ntwo\nthree\nFOUR\nfive\nsix\nseven\neight\nnine\nten\neleven'.split('\n');
const exported = unifiedDiff(compareTexts(exportLeft.join('\n'), exportRight.join('\n')), (name, i) => (name === 'left' ? exportLeft : exportRight)[i], 'Prod', 'UAT');
assert.ok(exported.startsWith('--- Prod\n+++ UAT\n'), 'uses the side names');
assert.ok(exported.includes('-four\n+FOUR\n'), 'shows the edit');
assert.ok(exported.includes('+eleven\n'), 'shows the addition');
assert.match(exported, /@@ -1,10 \+1,11 @@/, 'with correct line numbers');

// --- The screen --------------------------------------------------------------------
const dom = new JSDOM(`<!doctype html><div id="editorFrame" class="editor-frame">
  <div class="editor-strip"><div class="view-toggle"><button id="text" aria-pressed="true">Text</button><button id="tree">Tree</button></div></div>
  <div class="editor-body"></div></div>`, { url: 'http://localhost/', pretendToBeVisual: true });
shimLayout(dom.window);
for (const key of ['window', 'Window', 'document', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle',
  'Node', 'Element', 'HTMLElement', 'CustomEvent', 'Event', 'KeyboardEvent', 'MutationObserver', 'DOMRect']) {
  if (dom.window[key] !== undefined) globalThis[key] = dom.window[key];
}
try { Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true }); } catch (_) {}

const { initCompare, describeResult } = await import('../src/compare/compare-feature.js');
const payloads = { w1: '{"id":1,"name":"a","x":1}', w2: '{"id":1,"name":"b","x":1,"y":2}', w3: '' };
const statuses = [];
const host = document.querySelector('#editorFrame');
const wait = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const compare = initCompare({
  host,
  windows: () => Object.keys(payloads).map((id) => ({ id, name: `Window ${id}` })),
  activeWindowId: () => 'w1',
  readWindow: async (id) => payloads[id] ?? '',
  setStatus: (message) => statuses.push(message),
});
const root = document.documentElement;
const toggle = host.querySelector('.compare-toggle');
assert.equal(toggle.textContent, 'Compare', 'adds a third view button');
assert.equal(root.dataset.compare, undefined, 'stays closed until asked');

toggle.click();
await wait(120);
assert.equal(root.dataset.compare, 'on');
assert.equal(toggle.getAttribute('aria-pressed'), 'true');
assert.equal(host.querySelector('#text').getAttribute('aria-pressed'), 'false', 'only one view reads as active');
const { left, right } = compare.sides;
assert.equal(left.select.value, 'w1', 'left starts on the active window');
assert.equal(right.select.value, 'edited', 'and the right starts open for you to fill');
assert.equal(right.raw, '', 'nothing from another window appears on its own');
right.select.value = 'w2';
right.raw = payloads.w2;
compare.compare({ normalize: true });
await wait(60);
assert.ok(left.view.state.doc.toString().includes('\n'), 'both sides are formatted');
assert.ok(compare.result() && !compare.result().identical, 'a comparison ran');
const summary = host.querySelector('.compare-summary');
assert.equal(summary.textContent, describeResult(compare.result()));
assert.ok(host.querySelector('.compare-position').textContent.endsWith(`/ ${compare.result().differences.length}`));

// Rows match: spacers make both sides the same number of rows.
const rows = (side) => {
  let count = side.view.state.doc.lines;
  for (const widget of side.view.dom.querySelectorAll('.compare-spacer')) count += parseInt(widget.style.height, 10) / 24;
  return count;
};
assert.equal(rows(left), rows(right), 'the two sides line up row for row');

// The pane says what it is showing.
assert.equal(left.status.textContent, 'Layout only');

// The shortcuts move once and never edit the text.
const key = (init) => left.view.contentDOM.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
const textBefore = left.view.state.doc.toString();
const stepsBefore = host.querySelector('.compare-position').textContent;
assert.match(stepsBefore, /^– \//);
key({ key: 'F8', keyCode: 119 });
assert.match(host.querySelector('.compare-position').textContent, /^1 \//, 'F8 in a pane moves one difference');
key({ key: 'Enter', keyCode: 13, ctrlKey: true });
await wait(60);
assert.equal(left.view.state.doc.toString(), textBefore, 'Ctrl+Enter adds nothing to the text');
compare.compare();
await wait(60);

// Stepping wraps and reports position.
const total = compare.result().differences.length;
compare.step(1);
assert.match(host.querySelector('.compare-position').textContent, new RegExp(`^1 / ${total}$`));
compare.step(-1);
assert.match(host.querySelector('.compare-position').textContent, new RegExp(`^${total} / ${total}$`), 'previous wraps round');

// Typing re-compares without reformatting under the caret.
const before = left.view.state.doc.toString();
left.view.dispatch({ changes: { from: left.view.state.doc.length, insert: ' ' }, userEvent: 'input.type' });
assert.equal(left.select.value, 'edited', 'an edited side is no longer the window');
await wait(420);
assert.equal(left.view.state.doc.toString(), `${before} `, 'typing never reformats');
assert.equal(payloads.w1, '{"id":1,"name":"a","x":1}', 'windows are not written to');

assert.equal(left.status.textContent, 'Edited', 'an edited side says so');

// Line endings the panes can't show are still reported.
left.raw = 'a\r\nb';
right.raw = 'a\nb';
compare.compare({ normalize: true });
await wait(60);
assert.match(left.meta.textContent, /CRLF/);
assert.match(summary.textContent, /line endings differ \(CRLF vs LF\)/);

// Identical sides.
left.raw = payloads.w2;
right.raw = payloads.w2;
compare.compare({ normalize: true });
await wait(60);
assert.equal(compare.result().identical, true);
assert.equal(summary.textContent, 'No differences');
assert.equal(host.querySelector('.compare-position').textContent, '');
assert.equal(host.querySelector('.compare-nav button').disabled, true, 'nothing to step through');

// One edited value is one changed line.
right.raw = payloads.w2.replace('"y":2', '"y":3');
compare.compare({ normalize: true });
await wait(60);
assert.equal(compare.result().counts.changed, 1);

// Too large is refused with a message, not a freeze.
left.raw = 'x'.repeat(30 * 1024 * 1024 + 1);
compare.compare({ normalize: true });
assert.match(summary.textContent, /Too large/);
left.raw = payloads.w1;
compare.compare({ normalize: true });
await wait(60);

// A saved side follows its window when Compare reopens.
left.select.value = 'w1';
compare.close();
assert.equal(root.dataset.compare, undefined, 'closing restores the page');
payloads.w1 = '{"id":9}';
toggle.click();
await wait(120);
assert.ok(left.view.state.doc.toString().includes('9'), 'reopening picks up the current window');

// Renaming a side.
const rename = (side, value, key) => {
  side.nameBtn.click();
  const input = host.querySelector('.compare-rename');
  assert.ok(input, 'clicking the name opens a box');
  assert.equal(input.value, side.name, 'the box starts with the current name');
  input.value = value;
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
  assert.equal(host.querySelector('.compare-rename'), null, 'the box closes');
  assert.ok(host.contains(side.nameBtn), 'the name is back');
};
rename(left, '  Prod  ', 'Enter');
assert.equal(left.nameText.textContent, 'Prod', 'a new name is trimmed and shown');
assert.equal(left.select.getAttribute('aria-label'), 'Prod payload', 'its labels follow');
assert.match(left.empty.textContent, /Prod payload/);
assert.equal(left.view.contentDOM.getAttribute('aria-label'), 'Prod payload', 'the editor label follows');
rename(left, 'Nope', 'Escape');
assert.equal(left.name, 'Prod', 'Esc cancels');
rename(right, 'UAT', 'Enter');
host.querySelector('.compare-swap').click();
assert.deepEqual([left.name, right.name], ['UAT', 'Prod'], 'names move with their payloads on swap');
rename(left, '   ', 'Enter');
assert.equal(left.name, 'Left', 'a blank name goes back to the standard one');
assert.match(left.pasteBtn.title, /the left side/);
left.nameBtn.click();
const blurred = host.querySelector('.compare-rename');
blurred.value = 'QA';
blurred.dispatchEvent(new dom.window.Event('blur'));
assert.equal(left.name, 'QA', 'clicking away saves, like window tabs');
await wait(60);

// The app's page-wide shortcuts cannot reach the hidden main editor.
let reachedApp = 0;
const appShortcut = () => { reachedApp += 1; };
document.addEventListener('paste', appShortcut);
document.addEventListener('keydown', appShortcut);
const fromButton = host.querySelector('.compare-toggle');
fromButton.dispatchEvent(new dom.window.Event('paste', { bubbles: true, cancelable: true }));
fromButton.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
assert.equal(reachedApp, 0, 'paste and format stay inside Compare');
await wait(60);

// --- Honest messages ---
const summaryNow = () => host.querySelector('.compare-summary').textContent;
const setRaws = async (l, r) => {
  left.raw = l;
  right.raw = r;
  compare.compare({ normalize: true });
  await wait(60);
};
await setRaws('', '');
assert.equal(summaryNow(), 'Paste two payloads to compare', 'two empty sides are not "No differences"');
await setRaws('{"a":1}', '');
assert.match(summaryNow(), /Waiting for the .* payload/);
assert.equal(host.querySelector('.compare-position').textContent, '', 'nothing to step through yet');
assert.equal(host.querySelector('.compare-nav button').disabled, true);
await setRaws('{"a":1}', '<a>1</a>');
assert.match(summaryNow(), /^JSON vs XML/, 'mixed payload types are called out');

// A paste replaces the payload, keeping exact text, and undo brings the old one back.
await setRaws('{"keep":1}', '{"right":1}');
const pasteInto = (side, text) => {
  const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
  event.clipboardData = { getData: () => text };
  side.view.contentDOM.dispatchEvent(event);
  return event;
};
const before2 = left.view.state.doc.toString();
assert.equal(pasteInto(left, '{"new":1,\r\n"b":2}').defaultPrevented, true, 'pasting over a payload replaces it');
await wait(60);
assert.equal(left.raw, '{"new":1,\r\n"b":2}', 'the exact text is kept, line endings included');
assert.ok(left.view.state.doc.toString().includes('"new"'));
assert.ok(!left.view.state.doc.toString().includes('"keep"'), 'nothing is merged');
assert.equal(compare.restorePrevious(left), true);
await wait(60);
assert.equal(left.view.state.doc.toString(), before2, 'undo brings the previous payload back');

// While editing, a paste works like any editor's.
left.view.dispatch({ changes: { from: 0, insert: ' ' }, userEvent: 'input.type' });
const whileEditing = left.view.state.doc.toString();
pasteInto(left, 'x');
await wait(20);
assert.equal(left.view.state.doc.length, whileEditing.length + 1, 'pasting into text being edited inserts, like any editor');
await wait(420);

// Status and ignored rows.
const ignoreBox = (label) => [...host.querySelectorAll('.compare-check')].find((row) => row.textContent === label).querySelector('input');
await setRaws('{"Flag":"YES"}', '{"flag":"yes"}');
assert.equal(compare.result().identical, false);
ignoreBox('Upper and lower case').click();
await wait(60);
assert.match(summaryNow(), /No differences · 1 line ignored/, 'says that something was ignored');
assert.match(host.querySelector('.compare-menu summary').textContent, /Ignore · 1/);
ignoreBox('Upper and lower case').click();
await wait(60);

// XML can't be sorted, and the status says so.
const sortBtn = [...host.querySelectorAll('.compare-options button')].find((button) => button.textContent === 'Sort keys');
sortBtn.click();
await setRaws('<a><b/></a>', '<a><c/></a>');
assert.match(left.status.textContent, /not sorted/);
sortBtn.click();

// Find, across both sides, top to bottom.
await setRaws(pretty({ a: 'needle', b: 1, c: 'NEEDLE' }), pretty({ a: 'hay', b: 'needle' }));
compare.openSearch();
const input = host.querySelector('.compare-search-input');
input.value = 'needle';
input.dispatchEvent(new dom.window.Event('input'));
await wait(260);
assert.equal(compare.search.all.length, 3, 'finds on both sides, ignoring case');
assert.deepEqual(compare.search.all.map((match) => match.side.key), ['left', 'right', 'left'], 'in row order');
compare.stepSearch(1);
assert.match(host.querySelector('.compare-search-count').textContent, /^1 of 3/);
host.querySelector('.compare-search [title="Match case"]').click();
assert.equal(compare.search.all.length, 2, 'match case narrows it');
input.value = ':3';
input.dispatchEvent(new dom.window.Event('input'));
input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
assert.match(host.querySelector('.compare-search-count').textContent, /^Line 3/, ':3 goes to a line');
input.value = ':abc';
input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
assert.match(host.querySelector('.compare-search-count').textContent, /line number/, 'a bad line number says what to type');
input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
assert.equal(host.querySelector('.compare-search').hidden, true, 'Esc closes find');
assert.equal(root.dataset.compare, 'on', 'without leaving Compare');
input.value = '';

// Hidden sections open, and filters narrow what you step through.
const many = Array.from({ length: 60 }, (_, i) => `row ${i}`);
const manyEdited = [...many];
manyEdited[30] = 'row CHANGED';
manyEdited.push('row added');
await setRaws(many.join('\n'), manyEdited.join('\n'));
const onlyBox = ignoreBox('Only differences');
onlyBox.click();
await wait(20);
const folds = () => left.view.dom.querySelectorAll('.compare-fold');
assert.ok(folds().length > 0, 'matching rows collapse');
const before3 = folds().length;
folds()[0].click();
await wait(20);
assert.equal(folds().length, before3 - 1, 'clicking a hidden section opens it');
onlyBox.click();
await wait(20);
assert.equal(compare.navigable().length, 2);
ignoreBox('Added').click();
assert.equal(compare.navigable().length, 1, 'turning off Added skips it when stepping');
ignoreBox('Added').click();

// Caret position, and line detail.
const showBox = ignoreBox('Line detail');
showBox.click();
assert.equal(host.querySelector('.compare-detail').hidden, false);
assert.match(host.querySelector('.compare-foot .compare-caret').textContent, /^Ln 1, Col 1/);
showBox.click();
assert.equal(host.querySelector('.compare-detail').hidden, true);

// Each pane has a path bar that follows its own cursor and the current difference.
await setRaws(pretty({ a: { b: [1, 2] }, c: 1 }), pretty({ a: { b: [1, 3] }, c: 1 }));
const crumbText = (side) => side.crumbs.textContent;
const place = (side, needle) => {
  const line = side.view.state.doc.toString().split('\n').findIndex((text) => text.includes(needle));
  side.view.dispatch({ selection: { anchor: side.view.state.doc.line(line + 1).from } });
};
assert.equal(host.querySelectorAll('.compare-path').length, 2, 'one path bar per pane');
place(left, '"c"');
await wait(180);
assert.equal(crumbText(left), '$›c');
assert.equal(left.pathText, '$.c');
assert.equal(left.copyPathBtn.disabled, false);
assert.equal(crumbText(right), '$', 'each follows its own cursor');
compare.step(1);
assert.equal(left.pathText, '$.a.b[1]', 'and the current difference');
assert.equal(right.pathText, '$.a.b[1]', 'on both sides');
await setRaws('', '<r>\n\t<a>\n\t\t<b>1</b>\n\t</a>\n</r>');
assert.equal(left.pathText, '');
assert.equal(left.copyPathBtn.disabled, true, 'nothing to copy without a payload');
assert.match(crumbText(left), /No payload/);
place(right, '<b>');
await wait(180);
assert.equal(right.pathText, '/r/a/b', 'XML paths work too');
await setRaws('plain text', 'plain text');
assert.match(crumbText(left), /JSON and XML/);
const formatToggle = [...host.querySelectorAll('.compare-options button')].find((button) => button.textContent === 'Format');
formatToggle.click();
await setRaws('{"a":{"b":1}}', '{"a":{"b":1}}');
assert.match(crumbText(left), /Format this side/, 'a single unformatted line says what would help');
assert.equal(left.pathText, '');
formatToggle.click();
await setRaws('{"a":1}', '{"a":2}');

// Files open like a paste, and refuse what isn't text.
const fileInput = host.querySelector('.compare-file');
assert.equal(fileInput.type, 'file');
const openFile = async (name, text) => {
  Object.defineProperty(fileInput, 'files', { configurable: true, value: [{ name, size: text.length, text: async () => text }] });
  fileInput.dispatchEvent(new dom.window.Event('change'));
  await wait(60);
};
await setRaws('{"keep":1}', '{"keep":2}');
await openFile('photo.png', 'PNG\u0000\u0001data');
assert.match(statuses.at(-1), /binary/, 'a binary file is refused with a reason');
assert.ok(left.raw.includes('keep'), 'and what was there stays');
await openFile('data.json', '{"opened":true}');
assert.equal(left.raw, '{"opened":true}', 'a text file opens');
Object.defineProperty(fileInput, 'files', { configurable: true, value: [] });

// Too large leaves nothing stale.
left.raw = 'x'.repeat(30 * 1024 * 1024 + 1);
compare.compare({ normalize: true });
assert.equal(host.querySelector('.compare-position').textContent, '', 'no old counter after refusing');
assert.equal(host.querySelector('.compare-nav button').disabled, true);
assert.match(left.meta.textContent, /^1 line/, 'and the line count is current');
assert.doesNotMatch(left.crumbs.textContent, /No payload/, 'and the path bar is too');
await setRaws('{"a":1}', '{"a":2}');

// Each window has its own comparison.
payloads.w1 = '{"own":"w1"}';
payloads.w2 = '{"own":"w2"}';
payloads.w3 = '{"own":"w3"}';
await setRaws('{"pasted":"for w1 left"}', '{"pasted":"for w1 right"}');
left.select.value = 'edited';
right.select.value = 'edited';
left.nameBtn.click();
const firstName = host.querySelector('.compare-rename');
firstName.value = 'Prod';
firstName.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
compare.step(1);
const stepped = host.querySelector('.compare-position').textContent;
compare.windowChanged('w2');
await wait(80);
assert.equal(root.dataset.compare, 'on', 'a window tab keeps you in Compare');
assert.equal(compare.currentWindow(), 'w2');
assert.ok(left.view.state.doc.toString().includes('"w2"'), 'a new window starts from its own payload');
assert.equal(right.view.state.doc.length, 0, 'with the right side open');
assert.ok(!right.raw && !left.raw.includes('w1'), 'nothing carries over from the other window');
assert.equal(left.name, 'Left', 'and its sides have their own names');
assert.equal(left.select.value, 'w2');
await setRaws('{"pasted":"for w2 left"}', '{"pasted":"for w2 right"}');
left.select.value = 'edited';
right.select.value = 'edited';

compare.windowChanged('w1');
await wait(80);
assert.ok(left.view.state.doc.toString().includes('for w1 left'), 'coming back shows that window\'s comparison');
assert.ok(right.view.state.doc.toString().includes('for w1 right'));
assert.equal(left.name, 'Prod', 'with its names');
assert.equal(host.querySelector('.compare-position').textContent, stepped, 'and the difference you were on');

// Quick switching ends on the window you chose last.
compare.windowChanged('w2');
compare.windowChanged('w3');
compare.windowChanged('w2');
await wait(100);
assert.ok(left.view.state.doc.toString().includes('for w2 left'), 'the last switch wins');
compare.windowChanged('w3');
await wait(80);
assert.ok(left.view.state.doc.toString().includes('"w3"'), 'a window passed through keeps its own payload, not another window\'s');
assert.ok(!right.raw, 'and nothing leaks into its right side');
compare.windowChanged('w2');
await wait(80);
assert.ok(left.view.state.doc.toString().includes('for w2 left'));

// A side linked to a window follows it, and closing that window leaves no error.
compare.windowChanged('w3');
await wait(80);
assert.equal(left.select.value, 'w3');
payloads.w3 = '{"own":"w3 changed"}';
compare.windowChanged('w1');
await wait(80);
compare.windowChanged('w3');
await wait(80);
assert.ok(left.view.state.doc.toString().includes('w3 changed'), 'a linked side reads the window again');
compare.windowClosed('w3');
compare.windowChanged('w1');
await wait(80);
assert.ok(left.view.state.doc.toString().includes('for w1 left'), 'closing another window leaves this comparison alone');

document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
assert.equal(root.dataset.compare, undefined, 'Esc leaves Compare');
toggle.click();
await wait(60);

// Text or Tree leaves Compare.
host.querySelector('#text').click();
assert.equal(root.dataset.compare, undefined, 'Text leaves Compare');
assert.equal(toggle.getAttribute('aria-pressed'), 'false');
assert.equal(host.querySelector('#text').getAttribute('aria-pressed'), 'true', 'the previous view reads as active again');
const reachedBefore = reachedApp;
fromButton.dispatchEvent(new dom.window.Event('paste', { bubbles: true, cancelable: true }));
assert.equal(reachedApp, reachedBefore + 1, 'after leaving Compare the app gets its shortcuts back');

console.log('compare tests passed');
process.exit(0);
