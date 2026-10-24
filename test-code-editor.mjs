import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { shimLayout } from './test-support.mjs';

// The text view is CodeMirror 6 (text-editor.js). These tests drive the
// real editor in jsdom: the textarea-shaped host contract the app relies
// on, highlighting, wrap, the Ctrl/Cmd+Enter and search keymaps, a
// multi-megabyte document, and the app's paste interception.
const read = (file) => readFile(new URL(file, import.meta.url), 'utf8');
const [html, editorJs, editorCss, build, pkg, bundle, license] = await Promise.all(
  ['index.html', 'text-editor.js', 'text-editor.css', 'build.mjs', 'package.json',
    'vendor/codemirror/codemirror.js', 'vendor/codemirror/LICENSE'].map(read),
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function installGlobals(dom) {
  shimLayout(dom.window);
  for (const key of ['window', 'Window', 'document', 'sessionStorage', 'localStorage',
    'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia', 'getComputedStyle',
    'Node', 'Element', 'HTMLElement', 'CustomEvent', 'Event', 'KeyboardEvent',
    'MutationObserver', 'DOMParser']) {
    if (dom.window[key] !== undefined) {
      try { globalThis[key] = dom.window[key]; } catch (_) {}
    }
  }
  try { Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true }); } catch (_) {}
  globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
  globalThis.removeEventListener = dom.window.removeEventListener.bind(dom.window);
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  globalThis.Worker = class { constructor() { throw new Error('no workers in this test'); } };
}

// --- Static: shipping, licensing, safety ------------------------------------
{
  assert.match(html, /<div id="payloadInput" class="editor is-empty"><\/div>/, 'the editor host replaces the textarea');
  assert.ok(!html.includes('<textarea'), 'no native textarea is left in the text view');
  assert.ok(!html.includes('syntaxMirror'), 'the old highlight overlay is gone');
  assert.match(editorJs, /from '\.\/vendor\/codemirror\/codemirror\.js'/, 'the editor loads the vendored bundle');
  assert.ok(build.includes("'vendor/codemirror/codemirror.js'") && build.includes("'vendor/codemirror/LICENSE'"),
    'the deploy bundle ships CodeMirror and its license');
  assert.ok(!/syntax-(?:model|shared|worker)|prism/.test(build), 'the deploy bundle no longer ships the overlay');
  assert.equal(JSON.parse(pkg).scripts['vendor:codemirror'], 'node vendor/codemirror/build-bundle.mjs',
    'the bundle can be rebuilt from the pinned packages');
  assert.match(bundle, /^\/\* CodeMirror 6 bundle \(MIT\)\. Built from: @codemirror\/state@/, 'the bundle records its versions');
  assert.ok(license.includes('MIT') && license.includes('@codemirror/view@'), 'the license lists the bundled packages');
  assert.doesNotMatch(editorJs, /innerHTML/, 'payload text never becomes HTML');
  for (const token of ['--syntax-key', '--syntax-string', '--syntax-number', '--syntax-boolean', '--syntax-attribute', '--syntax-muted']) {
    assert.ok(editorCss.includes(`var(${token})`), `${token} colors the editor tokens`);
  }
}

// --- Live editor: the host contract -----------------------------------------
const dom = new JSDOM('<!doctype html><html data-wrap="off"><body><span id="editorHelp"></span><div id="payloadInput" class="editor is-empty"></div></body></html>', {
  url: 'http://localhost/', pretendToBeVisual: true,
});
installGlobals(dom);
const { createSyntaxEditor } = await import('./text-editor.js');
const host = dom.window.document.querySelector('#payloadInput');
const editor = createSyntaxEditor(host);
const { view } = editor;
const content = () => host.querySelector('.cm-content');
let inputs = 0;
host.addEventListener('input', () => { inputs += 1; });

{
  assert.ok(host.querySelector('.cm-editor'), 'CodeMirror mounts inside the host');
  assert.equal(content().getAttribute('aria-label'), 'JSON or XML payload', 'the editable area keeps its accessible name');
  assert.equal(content().getAttribute('aria-describedby'), 'editorHelp');
  assert.equal(host.value, '');
  assert.ok(host.classList.contains('is-empty'), 'an empty editor shows the empty state');

  host.value = '{"a":1}';
  assert.equal(host.value, '{"a":1}', 'value round-trips');
  assert.equal(inputs, 0, 'setting value programmatically fires no input event (like a textarea)');
  assert.ok(!host.classList.contains('is-empty'), 'a filled editor hides the empty state');

  view.dispatch({ changes: { from: 7, insert: ' ' }, userEvent: 'input.type' });
  assert.equal(inputs, 1, 'a user edit fires an input event on the host');
  assert.equal(host.value, '{"a":1} ', 'value reflects user edits');

  host.value = 'abcdef';
  host.setSelectionRange(2, 4);
  assert.deepEqual([host.selectionStart, host.selectionEnd], [2, 4], 'selection API matches a textarea');
  host.setSelectionRange(99, 120);
  assert.deepEqual([host.selectionStart, host.selectionEnd], [6, 6], 'out-of-range selection clamps to the end');
  host.selectionStart = host.selectionEnd = 1;
  assert.deepEqual([host.selectionStart, host.selectionEnd], [1, 1], 'selectionStart/End are settable');
  host.select();
  assert.deepEqual([host.selectionStart, host.selectionEnd], [0, 6], 'select() selects everything');

  host.readOnly = true;
  assert.equal(view.state.readOnly, true, 'readOnly blocks user edits (large-payload preview)');
  host.readOnly = false;
  assert.equal(view.state.readOnly, false);

  host.value = 'line one\nline two';
  host.scrollTop = 0;
  assert.equal(host.scrollTop, view.scrollDOM.scrollTop, 'scroll position maps to the editor scroller');
}

// --- Wrap, highlighting, safety ----------------------------------------------
{
  host.wrap = 'soft';
  assert.ok(content().classList.contains('cm-lineWrapping'), 'wrap on enables line wrapping');
  assert.equal(host.wrap, 'soft');
  host.value = 'still wraps after a new payload';
  assert.ok(content().classList.contains('cm-lineWrapping'), 'wrap survives a value replacement');
  host.wrap = 'off';
  assert.ok(!content().classList.contains('cm-lineWrapping'), 'wrap off disables it');

  editor.refresh('json');
  host.value = '{"name":"A","n":-1.5,"ok":true,"nil":null}';
  await sleep(50);
  const classesOf = (text) => [...host.querySelectorAll('.cm-line span')]
    .filter((span) => span.textContent === text).map((span) => span.className);
  assert.ok(classesOf('"name"').includes('syntax-key'), 'JSON keys are highlighted');
  assert.ok(classesOf('"A"').includes('syntax-string'), 'JSON strings are highlighted');
  assert.ok(classesOf('-1.5').includes('syntax-number'), 'JSON numbers are highlighted');
  assert.ok(classesOf('true').includes('syntax-boolean') && classesOf('null').includes('syntax-boolean'),
    'JSON literals are highlighted');

  editor.refresh('xml');
  host.value = '<root id="1"><!-- c --><name>x &amp; y</name></root>';
  await sleep(50);
  const xmlClasses = [...host.querySelectorAll('.cm-line span')].map((span) => span.className);
  for (const cls of ['syntax-tag', 'syntax-attribute', 'syntax-string', 'syntax-comment', 'syntax-entity']) {
    assert.ok(xmlClasses.includes(cls), `XML ${cls} is highlighted`);
  }

  host.value = '<img src=x onerror="globalThis.__pwned=1">';
  await sleep(20);
  assert.equal(host.querySelector('img'), null, 'markup in a payload renders as text, never as elements');
  assert.equal(globalThis.__pwned, undefined);
}

// --- Keymaps: Ctrl/Cmd+Enter belongs to the app; Ctrl/Cmd+F searches ---------
{
  host.value = '{"a":1}';
  let seen = 0;
  host.addEventListener('keydown', (event) => { if (event.ctrlKey && event.key === 'Enter') seen += 1; });
  view.focus();
  content().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
  assert.equal(host.value, '{"a":1}', 'Ctrl+Enter does not insert a line (the app formats instead)');
  assert.equal(seen, 1, 'Ctrl+Enter still reaches the app on the host');

  let finds = 0;
  editor.search.onFind(() => { finds += 1; });
  const find = new dom.window.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true });
  content().dispatchEvent(find);
  await sleep(20);
  assert.equal(finds, 1, 'Ctrl+F inside the editor asks the app to open its search box');
  assert.equal(find.defaultPrevented, true, "the browser's find bar does not open over the editor");
  assert.equal(host.querySelector('.cm-search'), null, "CodeMirror's own search panel is not used");
}

// --- Search API: query, highlight, step, count --------------------------------
{
  const api = editor.search;
  let changes = 0;
  api.onChange(() => { changes += 1; });
  host.value = 'alpha beta ALPHA gamma alpha';
  assert.equal(changes, 1, 'a new payload notifies search listeners');
  host.setSelectionRange(0, 0);
  api.setQuery('alpha');
  assert.deepEqual(api.stats(), { total: 3, index: -1, truncated: false }, 'matches are counted case-insensitively');
  assert.equal(api.next(), true);
  assert.deepEqual([host.selectionStart, host.selectionEnd], [0, 5], 'next selects the first match');
  assert.equal(api.stats().index, 0);
  api.next();
  assert.deepEqual([host.selectionStart, host.selectionEnd], [11, 16], 'next steps to the second match');
  api.previous();
  assert.equal(api.stats().index, 0, 'previous steps back');
  api.previous();
  assert.equal(api.stats().index, 2, 'previous wraps to the last match');
  await sleep(20);
  assert.equal(host.querySelectorAll('.cm-searchMatch').length, 3, 'visible matches are highlighted');
  assert.equal(host.querySelectorAll('.cm-searchMatch-selected').length, 1, 'the current match stands out');

  host.value = 'alpha again, alpha';
  assert.equal(api.stats().total, 2, 'the query survives a new payload');
  view.dispatch({ changes: { from: 0, insert: 'alpha ' }, userEvent: 'input.type' });
  assert.equal(api.stats().total, 3, 'counts follow user edits');
  assert.ok(changes >= 3, 'user edits notify search listeners');

  host.setSelectionRange(6, 11);
  assert.equal(api.selectedText(), 'alpha', 'the selection can seed the search box');
  host.value = 'multi\nline';
  host.select();
  assert.equal(api.selectedText(), '', 'multi-line selections do not seed the search box');

  api.setQuery('');
  assert.equal(api.next(), false, 'an empty query finds nothing');
  assert.equal(host.querySelectorAll('.cm-searchMatch').length, 0, 'clearing the query clears highlights');

  host.value = Array.from({ length: 12_000 }, () => 'x').join('\n');
  api.setQuery('x');
  assert.deepEqual(api.stats(), { total: 10_000, index: -1, truncated: true }, 'counting stops at 10,000 (shown as 10000+)');
  api.setQuery('');
}

// --- Large document: only the visible lines are rendered ---------------------
{
  const big = JSON.stringify(Array.from({ length: 37000 }, (_, i) => ({ id: i, name: `user${i}`, tags: ['a', 'b'] })), null, 2);
  const started = Date.now();
  host.value = big;
  const elapsed = Date.now() - started;
  assert.equal(host.value.length, big.length, 'a multi-megabyte payload round-trips');
  assert.ok(view.state.doc.lines > 250_000, `${view.state.doc.lines} lines loaded`);
  const rendered = host.querySelectorAll('.cm-line').length;
  assert.ok(rendered < 2000, `only visible lines are in the DOM (${rendered} of ${view.state.doc.lines})`);
  assert.ok(elapsed < 3000, `loading ${(big.length / 1e6).toFixed(1)}M chars took ${elapsed}ms`);
  const editStarted = Date.now();
  view.dispatch({ changes: { from: 5, insert: ' ' }, userEvent: 'input.type' });
  assert.ok(Date.now() - editStarted < 500, 'an edit in a large document stays fast');
  assert.equal(host.value.length, big.length + 1, 'value reflects the edit (cached per document)');
}

// --- App: paste interception runs before the editor ---------------------------
{
  const appDom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
  installGlobals(appDom);
  const app = await import('./app.js?code-editor=1');
  await app.__historyHydrated();
  const doc = appDom.window.document;
  const appHost = doc.querySelector('#payloadInput');
  const appContent = appHost.querySelector('.cm-content');
  const paste = (target, text) => {
    const event = new appDom.window.Event('paste', { bubbles: true, cancelable: true });
    event.clipboardData = { getData: () => text, types: ['text/plain'] };
    target.dispatchEvent(event);
    return event;
  };

  const large = `{"pad":"${'x'.repeat(10 * 1024 * 1024)}"}`;
  const event = paste(appContent, large);
  await sleep(100);
  assert.equal(event.defaultPrevented, true, 'a large paste is taken over by the app');
  assert.equal(appHost.readOnly, true, 'a large paste opens the read-only preview');
  assert.ok(appHost.value.length < 200_000, 'the editor shows the preview, not the pasted text twice');
  assert.ok(doc.querySelector('#largeNotice').textContent.includes('read-only'));

  doc.querySelector('#clearBtn').click();
  await sleep(50);
  assert.equal(appHost.value, '');
  assert.equal(appHost.readOnly, false, 'clearing leaves the preview');

  paste(appContent, '{"small":1}');
  await sleep(450);
  assert.equal(appHost.value, '{"small":1}', 'a small paste is inserted by the editor');
  const back = doc.querySelector('#historyBackBtn');
  assert.equal(back.disabled, false, 'the editor paste is recorded as its own history entry');
  back.click();
  await sleep(100);
  assert.equal(appHost.readOnly, true, 'Back returns to the large payload (as its read-only preview)');
  assert.ok(appHost.value.startsWith('{"pad":"xxx') && appHost.value.includes('more chars not shown'),
    'the preview shows the start of the large payload');
}

// --- App: the strip search box ------------------------------------------------
{
  const appDom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
  installGlobals(appDom);
  const app = await import('./app.js?code-editor=2');
  await app.__historyHydrated();
  const doc = appDom.window.document;
  const appHost = doc.querySelector('#payloadInput');
  const box = doc.querySelector('#textSearch');
  const count = doc.querySelector('#textMatchCount');
  const strip = html.match(/<div class="editor-strip"[^>]*>([\s\S]*?)<\/div>\s*<div class="editor-body"/)?.[1];
  assert.match(strip, /<div class="text-strip-search" data-view-scope="text"/, 'the text search box lives in the strip, text view only');
  assert.equal(doc.querySelector('#textPrev').disabled, true, 'arrows start disabled');

  appHost.value = '{"name":"user1","friend":"user2","note":"USER3"}';
  appHost.dispatchEvent(new appDom.window.Event('input', { bubbles: true }));
  const type = async (text) => {
    box.value = text;
    box.dispatchEvent(new appDom.window.Event('input', { bubbles: true }));
    await sleep(250);
  };
  const key = (name, extra = {}) => box.dispatchEvent(new appDom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...extra }));

  await type('user');
  assert.equal(count.textContent, '1 / 3', 'typing finds and counts matches, selecting the first');
  assert.equal(appHost.value.slice(appHost.selectionStart, appHost.selectionEnd), 'user');
  assert.equal(doc.querySelector('#textNext').disabled, false);
  key('Enter');
  assert.equal(count.textContent, '2 / 3', 'Enter steps to the next match');
  key('Enter', { shiftKey: true });
  assert.equal(count.textContent, '1 / 3', 'Shift+Enter steps back');
  doc.querySelector('#textPrev').click();
  assert.equal(count.textContent, '3 / 3', 'the arrows step too, wrapping around');

  await type('nothing-here');
  assert.equal(count.textContent, 'No matches');

  await type('user');
  appHost.value = '{"a":"user"}';
  await sleep(300);
  assert.equal(count.textContent, '1 match', 'the count follows a new payload');

  key('Escape');
  assert.equal(box.value, '', 'Escape clears the search');
  assert.equal(count.textContent, '');

  const find = new appDom.window.KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true });
  doc.querySelector('#clearBtn').dispatchEvent(find);
  assert.equal(find.defaultPrevented, true, 'Cmd/Ctrl+F anywhere in text view is taken over');
  assert.equal(doc.activeElement, box, 'Cmd/Ctrl+F focuses the search box');

  doc.querySelector('#viewTreeBtn').click();
  const treeFind = new appDom.window.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true });
  doc.body.dispatchEvent(treeFind);
  assert.equal(treeFind.defaultPrevented, false, 'tree view keeps the browser shortcut');
  doc.querySelector('#viewTextBtn').click();
}

console.log('All CodeMirror text editor tests passed.');
