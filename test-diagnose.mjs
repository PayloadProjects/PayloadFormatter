import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { diagnose, applyFix, lineColumn, guessMode } from './payload-diagnose.js';

const { DOMParser } = new JSDOM('').window;
const xmlValid = (text) => new DOMParser().parseFromString(text, 'application/xml')
  .getElementsByTagName('parsererror').length === 0;

// Each case: the input, what the issue bar says, where it points (line,
// column, highlighted text), the fix label, and whether that fix alone
// leaves a valid payload.
function check(mode, text, { message, line, col, marked, fix, fixedValid = true }) {
  const issue = diagnose(text, mode);
  assert.ok(issue, `${mode}: finds a problem in ${JSON.stringify(text)}`);
  assert.equal(issue.message, message, `${mode}: plain message for ${JSON.stringify(text)}`);
  assert.equal(issue.line, line, `${message}: line`);
  assert.equal(issue.col, col, `${message}: column`);
  if (marked !== undefined) assert.equal(text.slice(issue.from, issue.to), marked, `${message}: marks the spot`);
  assert.ok(issue.hint, `${message}: says what to do`);
  assert.ok(issue.to > issue.from, `${message}: highlight is never empty`);
  if (fix === null) {
    assert.equal(issue.fix, undefined, `${message}: no guess when the fix is ambiguous`);
    return issue;
  }
  assert.equal(issue.fix?.label, fix, `${message}: fix label`);
  const fixed = applyFix(text, issue.fix);
  if (fixedValid) {
    if (mode === 'json') assert.doesNotThrow(() => JSON.parse(fixed), `${message}: fix makes it valid`);
    else assert.ok(xmlValid(fixed), `${message}: fix makes it valid`);
    assert.equal(diagnose(fixed, mode), null, `${message}: nothing left to report after the fix`);
  } else {
    assert.ok(diagnose(fixed, mode), `${message}: the next problem shows after this fix`);
  }
  return issue;
}

// --- JSON ---------------------------------------------------------------------
check('json', '{\n  "name": "Mira",\n  "age": 31\n  "city": "Oslo"\n}',
  { message: 'Missing comma after 31', line: 3, col: 10, marked: '31', fix: 'Add the comma' });
check('json', '{"tags": ["a", "b",]}',
  { message: 'Extra comma before ]', line: 1, col: 19, marked: ',', fix: 'Remove the comma' });
check('json', '{"a": 1, "b": 2,}',
  { message: 'Extra comma before }', line: 1, col: 16, marked: ',', fix: 'Remove the comma' });
check('json', "{'name': 'Mira'}",
  { message: 'JSON text needs double quotes', line: 1, col: 2, marked: "'name'", fix: 'Use double quotes', fixedValid: false });
check('json', "{\"say\": 'it\\'s \"ok\"'}",
  { message: 'JSON text needs double quotes', line: 1, col: 9, fix: 'Use double quotes' });
check('json', '{name: "Mira"}',
  { message: 'Property names need double quotes', line: 1, col: 2, marked: 'name', fix: 'Add the quotes' });
check('json', '{"a": 1, "b": 2',
  { message: 'The { opened on line 1 is never closed', line: 1, col: 1, fix: 'Add }' });
check('json', '{"a": [1, {"b": 2',
  { message: '3 brackets are never closed', line: 1, col: 11, fix: 'Add }]}' });
check('json', '[{"a":1]',
  { message: 'Missing } to close the { opened on line 1', line: 1, col: 8, marked: ']', fix: 'Add }' });
check('json', '{"a": [1, 2}',
  { message: 'Missing ] to close the [ opened on line 1', line: 1, col: 12, fix: 'Add ]' });
check('json', '[1, 2}',
  { message: 'This } doesn\'t match the [ opened on line 1', line: 1, col: 6, fix: 'Change it to ]' });
check('json', '{"a": 1}}',
  { message: 'Extra } with nothing to close', line: 1, col: 9, fix: 'Remove the }' });
check('json', '{"a": True}', { message: 'True isn\'t valid in JSON', line: 1, col: 7, marked: 'True', fix: 'Use true' });
check('json', '{"a": None}', { message: 'None isn\'t valid in JSON', line: 1, col: 7, fix: 'Use null' });
check('json', '{"a": undefined}', { message: 'undefined isn\'t valid in JSON', line: 1, col: 7, fix: 'Use null' });
check('json', '{"a": NaN}', { message: 'NaN isn\'t valid in JSON', line: 1, col: 7, fix: 'Use null' });
check('json', '{"a": 01}', { message: '01 isn\'t a valid JSON number', line: 1, col: 7, fix: 'Use 1' });
check('json', '{"a": .5}', { message: '.5 isn\'t a valid JSON number', line: 1, col: 7, fix: 'Use 0.5' });
check('json', '{"a": +3}', { message: '+3 isn\'t a valid JSON number', line: 1, col: 7, fix: 'Use 3' });
check('json', '{"a": 0x1F}', { message: '0x1F isn\'t a valid JSON number', line: 1, col: 7, fix: 'Use 31' });
check('json', '{"a": 1} // note',
  { message: 'JSON doesn\'t allow comments', line: 1, col: 10, marked: '// note', fix: 'Remove the comment' });
check('json', '{\n  /* why */ "a": 1\n}',
  { message: 'JSON doesn\'t allow comments', line: 2, col: 3, marked: '/* why */', fix: 'Remove the comment' });
check('json', '{"a": "x\\qy"}',
  { message: '\\q isn\'t a valid escape in JSON', line: 1, col: 9, marked: '\\q', fix: 'Escape the backslash' });
check('json', '{"a": "it\\\'s"}',
  { message: '\\\' isn\'t a valid escape in JSON', line: 1, col: 10, fix: 'Remove the backslash' });
check('json', '{"a" 1}', { message: 'Missing colon after "a"', line: 1, col: 6, fix: 'Add the colon' });
check('json', '{"a": }', { message: 'Missing value after "a"', line: 1, col: 7, fix: 'Use null' });
check('json', '{"a": "never closed,\n "b": 2}',
  { message: 'This text is never closed', line: 1, col: 7, fix: 'Add the closing "' });
check('json', '{"a": hello}', { message: 'Text values need double quotes', line: 1, col: 7, fix: 'Add the quotes' });
check('json', '{"a": [1, 2,, 3]}', { message: 'Two commas in a row', line: 1, col: 13, fix: 'Remove the comma' });
check('json', '{"a": "tab\there"}', { message: 'A tab character inside text', line: 1, col: 11, fix: 'Replace it with \\t' });
check('json', '{"a": [1,\n', { message: 'The text ends after a comma', line: 1, col: 9, fix: 'Remove the comma and close' });
check('json', '{"a":1}{"b":2}', { message: 'Extra content after the end of the JSON', line: 1, col: 8, fix: null });
check('json', '{"a": @}', { message: 'Unexpected character "@"', line: 1, col: 7, fix: null });
check('json', '[1 2]', { message: 'Missing comma after 1', line: 1, col: 2, fix: 'Add the comma' });

// Stray text before the payload (a ":" left from copying a key, a log
// prefix): strict detection can't tell JSON from XML, so the guess and the
// diagnosis must still find it and offer to remove the prefix.
assert.equal(guessMode(':[\n  {"a": 1}\n]'), 'json', 'a leading ":" still reads as JSON');
assert.equal(guessMode('Response: {"a":1}'), 'json');
assert.equal(guessMode('log: <a/>'), 'xml');
assert.equal(guessMode('just words'), null, 'plain text is neither');
check('json', ':[\n  {\n    "_id": "6add467b",\n    "index": 0\n  }\n]',
  { message: 'Stray text ":" before the JSON starts', line: 1, col: 1, marked: ':', fix: 'Remove it' });
check('json', 'Response: {"a": 1}',
  { message: 'Stray text "Response:" before the JSON starts', line: 1, col: 1, marked: 'Response: ', fix: 'Remove it' });
// A double-encoded payload (JSON inside a quoted string) keeps its opening
// quote: only the stray ":" goes.
check('json', ':"[{\\"a\\":1}]"', { message: 'Stray text ":" before the JSON starts', line: 1, col: 1, marked: ':', fix: 'Remove it' });
check('json', 'body: "{\\"a\\":1}"', { message: 'Stray text "body:" before the JSON starts', line: 1, col: 1, fix: 'Remove it' });
check('json', 'data = [1, 2]', { message: 'Stray text "data =" before the JSON starts', line: 1, col: 1, fix: 'Remove it' });
check('json', '  \n  :{"a": 1}', { message: 'Stray text ":" before the JSON starts', line: 2, col: 3, fix: 'Remove it' });
check('xml', 'xml: <a><b/></a>', { message: 'Stray text "xml:" before the XML starts', line: 1, col: 1, marked: 'xml:', fix: 'Remove it' });
check('xml', '<a/>\ntrailing', { message: 'Text after the closing root tag', line: 2, col: 1, fix: 'Remove it' });

for (const valid of ['{"ok": true}', '[]', '{}', '"just a string"', '42', '  {"a": [1, 2.5e3, -0.1, "\\u00e9\\n"]}\n',
  '{"nested": {"deep": [{"x": null}]}}']) {
  assert.equal(diagnose(valid, 'json'), null, `valid JSON reports nothing: ${valid}`);
}

// --- XML ----------------------------------------------------------------------
check('xml', '<order><id>1</id><item>book</order>',
  { message: '<item> on line 1 is never closed', line: 1, col: 28, marked: '</order>', fix: 'Add </item>' });
check('xml', '<a></b>', { message: '</b> doesn\'t match <a> opened on line 1', line: 1, col: 4, fix: 'Change it to </a>' });
check('xml', '<a>t</a></a>', { message: '</a> has no matching opening tag', line: 1, col: 9, fix: 'Remove </a>' });
check('xml', '<a>\n  <b>t</b>\n', { message: '<a> on line 1 is never closed', line: 1, col: 1, fix: 'Add </a>' });
check('xml', '<a>Tom & Jerry</a>', { message: 'A bare & in text', line: 1, col: 8, marked: '&', fix: 'Use &amp;' });
check('xml', '<a>1 < 2</a>', { message: 'A bare < in text', line: 1, col: 6, fix: 'Use &lt;' });
check('xml', '<a x=1>t</a>', { message: 'The value of x needs quotes', line: 1, col: 6, fix: 'Add the quotes' });
check('xml', '<a checked>t</a>', { message: 'Attribute checked has no value', line: 1, col: 4, fix: 'Add an empty value' });
check('xml', '<a q="x & y"/>', { message: 'A bare & in the value of q', line: 1, col: 9, fix: 'Use &amp;' });
check('xml', '<a x="1" x="2"/>', { message: 'Attribute x appears twice in <a>', line: 1, col: 10, fix: null });
check('xml', '<a>1</a><b>2</b>', { message: 'XML allows only one top-level element', line: 1, col: 9, fix: null });
check('xml', '<a><!-- c </a>', { message: 'This comment is never closed', line: 1, col: 4, fix: 'Close the comment', fixedValid: false });

for (const valid of ['<a/>', '<?xml version="1.0"?>\n<a b="c"><d/>&amp;&#169;<![CDATA[ < & ]]><!-- ok --></a>',
  '<!DOCTYPE a [<!ENTITY e "x">]><a>&e;</a>', '<ns:a xmlns:ns="u"><ns:b/></ns:a>']) {
  assert.equal(diagnose(valid, 'xml'), null, `valid XML reports nothing: ${valid}`);
}

assert.equal(diagnose('', 'json'), null, 'empty input: nothing to report');
assert.equal(diagnose('anything', null), null, 'unknown mode: nothing to report');
assert.deepEqual(lineColumn('a\nbc\nd', 4), { line: 2, col: 3 });

// --- Issue bar (issue-helper.js) with a stand-in editor -------------------------
{
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html);
  globalThis.document = dom.window.document;
  const { createIssueHelper } = await import('./issue-helper.js');
  let text = '{"a": 1 "b": 2}';
  const calls = [];
  const syntaxEditor = {
    showIssue: (range) => calls.push(['show', range && [range.from, range.to]]),
    reveal: (pos) => calls.push(['reveal', pos]),
    applyChanges(changes) {
      text = applyFix(text, { changes });
      calls.push(['apply', changes]);
    },
  };
  let fixed = 0;
  let nextShown = null;
  let view = 'tree';
  const issues = createIssueHelper({
    syntaxEditor,
    getText: () => text,
    getMode: () => 'json',
    isPreview: () => false,
    isTree: () => view === 'tree',
    showText: () => { view = 'text'; },
    onFixed: () => { fixed += 1; },
    onNext: (next) => { nextShown = next; },
  });
  const q = (sel) => dom.window.document.querySelector(sel);
  const shown = issues.check();
  assert.equal(shown.message, 'Missing comma after 1');
  assert.equal(q('#issueBar').hidden, false, 'bar shows the problem');
  assert.equal(q('#issueTitle').textContent, 'Missing comma after 1');
  assert.equal(q('#issueWhere').textContent, 'Line 1, column 7');
  assert.equal(q('#issueGoBtn').textContent, 'Go to line 1');
  assert.equal(q('#issueFixBtn').hidden, false);
  assert.equal(q('#issueFixBtn').textContent, 'Add the comma');
  assert.deepEqual(calls.at(-1), ['show', [6, 7]], 'the editor underlines the spot');

  q('#issueGoBtn').click();
  assert.equal(view, 'text', 'Go switches tree view back to text');
  assert.deepEqual(calls.at(-1), ['reveal', 6], 'Go moves to the spot');

  q('#issueFixBtn').click();
  assert.equal(text, '{"a": 1, "b": 2}', 'Apply fix edits the payload');
  assert.equal(q('#issueBar').hidden, true, 'bar hides once the payload is valid');
  assert.equal(fixed, 1, 'a successful fix hands over to formatting');

  text = "{'a': 'b'}";
  issues.check();
  q('#issueFixBtn').click();
  assert.equal(q('#issueBar').hidden, false, 'the next problem shows straight away');
  assert.equal(q('#issueWhere').textContent, 'Line 1, column 7');
  assert.deepEqual(calls.at(-1), ['reveal', 6], 'and the editor moves to it');
  assert.equal(fixed, 1, 'no formatting while problems remain');
  assert.equal(nextShown?.message, 'JSON text needs double quotes', 'the app is told about the next problem');

  text = '{"a": 1, "b": }';
  issues.check();
  assert.equal(q('#issueFixBtn').textContent, 'Use null');
  q('#issueCloseBtn').click();
  assert.equal(q('#issueBar').hidden, true, '× dismisses the bar');
  assert.deepEqual(calls.at(-1), ['show', null], 'and clears the underline');

  text = '{"a": 1}{"b": 2}';
  issues.check();
  assert.equal(q('#issueFixBtn').hidden, true, 'no fix button when the fix would be a guess');

  // Fixing it by hand: once an edit makes the payload valid, the bar hides
  // and formatting runs, just as after the fix button.
  text = ':[1, 2]';
  issues.check();
  text = '[1, 2]';
  issues.edited();
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(q('#issueBar').hidden, true, 'a manual fix clears the bar after a pause');
  assert.equal(fixed, 2, 'and formats the now-valid payload');
  text = '{"a": 1 "b": 2}';
  issues.check();
  text = '{"a": 1 "b": 2, "c": 3}';
  issues.edited();
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(q('#issueBar').hidden, false, 'an edit that leaves it broken keeps the bar');
  assert.equal(fixed, 2, 'and does not format');
  issues.hide();

  // The app's strict detection returns null for ':[ … ]'; the bar must
  // still explain it (this is what the formatter's "Could not detect JSON
  // or XML" case hands over).
  const strict = createIssueHelper({
    syntaxEditor,
    getText: () => text,
    getMode: () => null,
    isPreview: () => false,
    isTree: () => false,
    showText() {},
    onFixed: () => { fixed += 1; },
  });
  text = ':[\n  {"a": 1}\n]';
  assert.equal(strict.check()?.message, 'Stray text ":" before the JSON starts', 'undetected payloads still get explained');
  q('#issueFixBtn').click();
  assert.equal(text, '[\n  {"a": 1}\n]', 'Remove it leaves the JSON');
  assert.equal(q('#issueBar').hidden, true);
  assert.equal(fixed, 3, 'and hands over to formatting');
  delete globalThis.document;
}

// --- Wiring ---------------------------------------------------------------------
{
  const [app, html, build, editorJs, pkg] = await Promise.all(
    ['app.js', 'index.html', 'build.mjs', 'text-editor.js', 'package.json']
      .map((file) => readFile(new URL(file, import.meta.url), 'utf8')),
  );
  assert.ok(html.indexOf('id="largeNotice"') < html.indexOf('id="issueBar"')
    && html.indexOf('id="issueBar"') < html.indexOf('class="editor-body"'), 'issue bar sits under the toolbar');
  assert.match(app, /const issue = issues\.check\(\);/, 'a best-effort format runs the diagnosis');
  assert.match(app, /issues\.edited\(\)/, 'edits re-check while the bar is showing');
  assert.match(app, /function setPayloadText[^]*?issues\.hide\(\)/, 'a new payload clears the bar');
  assert.match(editorJs, /showIssue\(range\)/, 'the editor can underline the spot');
  assert.match(editorJs, /EditorView\.scrollIntoView\(anchor, \{ y: 'center' \}\)/, 'Go centres the spot');
  for (const file of ['payload-diagnose.js', 'issue-helper.js']) {
    assert.ok(build.includes(`'${file}'`), `production build copies ${file}`);
  }
  assert.ok(JSON.parse(pkg).scripts.test.includes('test-diagnose.mjs'), 'npm test runs these tests');
}

console.log('All payload diagnosis and issue bar tests passed.');
