import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import {
  formatJsonBestEffort,
  formatXmlBestEffort,
  prettyJsonLoose,
  isTooDeepError,
} from './resilient-format.js';
import { convertTimestamp } from './epoch-converter.js';
import { createWindowManager } from './window-manager.js';

// Regression tests for the adversarial SDET session (2026-10-04): deep
// nesting, XML root validation, epoch precision, rename surrogates, the
// inactive-window history race, the pagehide draft flush, and windowed
// tree reveal.

// --- Deep JSON nesting: a clear error, never a syntax lie ----------------
// V8's JSON.parse is iterative (handles 10k nesting), but JSON.stringify is
// recursive and throws RangeError. That must surface as "valid but too
// deep", never as "your JSON has a syntax issue" with a 200MB blob.
{
  const deep = '{"a":'.repeat(10000) + '1' + '}'.repeat(10000);
  const started = Date.now();
  assert.throws(() => formatJsonBestEffort(deep), (error) => {
    assert.equal(error.code, 'JSON_TOO_DEEP');
    assert.match(error.message, /valid/i, 'says the JSON is valid');
    assert.match(error.message, /deeply/i);
    return true;
  }, '10k-deep valid JSON throws the marked too-deep error');
  assert.ok(Date.now() - started < 5000, 'fails fast instead of building garbage');

  // Shallow payloads are untouched by the new guards.
  const ok = formatJsonBestEffort('{"a":[1,2,{"b":null}]}');
  assert.equal(ok.valid, true);
  assert.equal(ok.bestEffort, false);

  // The loose pretty-printer (malformed input) bails on absurd depth too,
  // instead of turning indentation into a quadratic blob.
  assert.throws(() => prettyJsonLoose('{"a":'.repeat(5000)), (error) => {
    assert.ok(isTooDeepError(error));
    return true;
  }, 'loose path refuses 5000-deep input');
  assert.equal(isTooDeepError(new RangeError('x')), true, 'plain RangeError counts as too-deep');
  assert.equal(isTooDeepError(new Error('nope')), false, 'ordinary errors are not too-deep');
}

// --- XML: exactly one root element ---------------------------------------
{
  const cases = [
    ['<a/><b/>', false, 'two roots are invalid'],
    ['<a></a><b></b>', false, 'two roots (paired tags) are invalid'],
    ['<a/>hello', false, 'text after the root is invalid'],
    ['hello<a/>', false, 'text before the root is invalid'],
    ['<a/>   ', true, 'whitespace after the root is fine'],
    ['<!--c--><a/><!--d-->', true, 'comments outside the root stay legal'],
    ['<?xml version="1.0"?><a/>', true, 'prolog before the root stays legal'],
    ['<a/>', true, 'single root stays valid'],
    ['<a><b/></a>', true, 'nested elements stay valid'],
    ['<a>text</a>', true, 'text inside the root stays valid'],
  ];
  for (const [xml, wantValid, label] of cases) {
    const result = formatXmlBestEffort(xml);
    assert.equal(result.valid, wantValid, `${label}: ${xml}`);
  }
}

// --- Epoch converter: 19-digit timestamps keep full precision -------------
// The per-unit rows used to round-trip through float milliseconds, so
// 9999999999999999999 ns displayed (and copied) as 10000000000000000000.
{
  const units = convertTimestamp('9999999999999999999', 'ns').units;
  assert.equal(units.ns, '9999999999999999999', 'ns row is exact');
  assert.equal(units.us, '9999999999999999', 'us row is exact');
  assert.equal(units.ms, '9999999999999', 'ms row is exact');
  assert.equal(units.s, '9999999999', 's row is exact');

  const frac = convertTimestamp('1.5', 's').units;
  assert.deepEqual(
    frac,
    { s: '1', ms: '1500', us: '1500000', ns: '1500000000' },
    'fractional seconds stay exact',
  );

  const neg = convertTimestamp('-5', 's').units;
  assert.equal(neg.ns, '-5000000000', 'negative timestamps keep their sign');

  // The human-readable outputs still work off the millisecond date.
  const full = convertTimestamp('9999999999999999999', 'ns');
  assert.ok(full.date instanceof Date, 'date still produced');
  assert.match(full.utc, /2286/, 'UTC row sane for far-future ns');
}

// --- Window rename: truncation never splits an emoji ----------------------
{
  const manager = createWindowManager();
  const win = manager.newWindow('a'.repeat(39) + '🚀');
  assert.ok(win, 'window created');
  assert.equal([...win.name].length <= 40, true, 'still capped at 40 code points');
  assert.ok(
    !/[\ud800-\udbff](?![\udc00-\udfff])/.test(win.name),
    `no lone surrogate in ${JSON.stringify(win.name)}`,
  );
  assert.ok(win.name.endsWith('🚀'), 'emoji survives truncation');
}

// --- Tree: windowed reveal on huge flat lists ----------------------------
// A 130k-row list with the only match on the last row used to freeze the
// tab: reveal() materialized every row from 0..index (~1.3M DOM nodes).
{
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  globalThis.document = dom.window.document;
  globalThis.NodeFilter = dom.window.NodeFilter;
  globalThis.Node = dom.window.Node;
  dom.window.Element.prototype.scrollIntoView = function () {};
  const { createTreeView } = await import('./tree-view.js');

  const container = document.createElement('div');
  document.body.appendChild(container);
  const view = createTreeView(container, { onCopyPath() {} });

  const big = Array.from({ length: 130000 }, (_, i) => i);
  assert.ok(view.show(JSON.stringify(big), 'json').ok, 'big list renders');
  const found = view.find('129999');
  assert.equal(found.total, 1, 'one match on the last row');
  const started = Date.now();
  const summary = view.step(0);
  const elapsed = Date.now() - started;
  assert.equal(summary.total, 1);
  assert.ok(elapsed < 5000, `reveal finished in ${elapsed}ms (no freeze)`);
  const rows = container.querySelectorAll('.tree-node').length;
  assert.ok(rows < 2000, `only a window is materialized (${rows} rows, not 130k)`);
  const hit = container.querySelector('.tree-hit');
  assert.ok(hit, 'the match is highlighted');
  assert.ok(
    container.querySelector('.tree-gap-btn'),
    'a "show from the top" gap button is offered',
  );

  // An early match still reveals the classic contiguous way.
  const early = view.find('5');
  assert.ok(early.total >= 1, 'early match found');
  view.step(0);
  assert.ok(container.querySelector('.tree-hit'), 'early match highlighted');
}

// --- Boot: closing an inactive window keeps the active history update ----
// Regression for the SDET-found race: the unconditional clearTimeout in
// closeWindowById dropped the active window's pending (250ms debounced)
// history update when an *inactive* tab was closed.
{
  const html = await readFile(new URL('index.html', import.meta.url), 'utf8');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const installGlobals = (dom) => {
    for (const key of ['window', 'document', 'sessionStorage', 'localStorage',
      'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia', 'getComputedStyle',
      'Node', 'Element', 'HTMLElement', 'CustomEvent', 'Event', 'KeyboardEvent',
      'MutationObserver']) {
      if (dom.window[key] !== undefined) {
        try { globalThis[key] = dom.window[key]; } catch (_) {}
      }
    }
    globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
    globalThis.removeEventListener = dom.window.removeEventListener.bind(dom.window);
    globalThis.Worker = class { constructor() { throw new Error('no worker in test'); } };
    globalThis.ResizeObserver = class {
      constructor() {} observe() {} unobserve() {} disconnect() {}
    };
  };
  const typeText = async (dom, editor, text) => {
    editor.value = text;
    editor.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };
  // A real paste pushes a new history entry (typing only updates the current one).
  const pasteText = async (dom, editor, text) => {
    const paste = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    paste.clipboardData = { getData: () => text };
    editor.dispatchEvent(paste);
    editor.value = text;
    editor.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await sleep(450);
  };

  const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
  installGlobals(dom);
  const app = await import('./app.js?hardening-close=1');
  await app.__historyHydrated();
  const doc = dom.window.document;
  const editor = doc.querySelector('#payloadInput');

  await pasteText(dom, editor, '{"a":1}');
  await pasteText(dom, editor, '{"c":3}');
  doc.querySelector('#newWindowBtn').click();
  await sleep(50);
  // Back to Window 1; Window 2 is now the inactive tab.
  doc.querySelectorAll('.window-tab')[0].click();
  await sleep(50);

  // Type, then close the INACTIVE tab inside the 250ms debounce.
  await typeText(dom, editor, '{"c":3,"d":1}');
  await sleep(60); // let the rAF arm the debounce timer
  doc.querySelectorAll('.window-tab')[1].querySelector('.window-tab-close').click();
  await sleep(450); // the debounce would have fired by now

  doc.querySelector('#historyBackBtn').click();
  await sleep(50);
  assert.equal(editor.value, '{"c":3}', 'back steps to the pre-edit entry');
  doc.querySelector('#historyBackBtn').click();
  await sleep(50);
  assert.equal(editor.value, '{"a":1}', 'back again reaches the first payload');
  doc.querySelector('#historyForwardBtn').click();
  await sleep(50);
  assert.equal(editor.value, '{"c":3}', 'forward steps back through the edits');
  doc.querySelector('#historyForwardBtn').click();
  await sleep(50);
  assert.equal(
    editor.value,
    '{"c":3,"d":1}',
    'forward reaches the typed text: closing the inactive tab did not eat the pending update',
  );
}

// --- Boot: pagehide flushes the debounced draft ---------------------------
// Typing then closing the tab inside the 250ms debounce used to lose the
// keystrokes entirely (the timer never fired).
{
  const html = await readFile(new URL('index.html', import.meta.url), 'utf8');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
  for (const key of ['window', 'document', 'sessionStorage', 'localStorage',
    'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia', 'getComputedStyle',
    'Node', 'Element', 'HTMLElement', 'CustomEvent', 'Event', 'KeyboardEvent',
    'MutationObserver']) {
    if (dom.window[key] !== undefined) {
      try { globalThis[key] = dom.window[key]; } catch (_) {}
    }
  }
  globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
  globalThis.removeEventListener = dom.window.removeEventListener.bind(dom.window);
  globalThis.Worker = class { constructor() { throw new Error('no worker in test'); } };
  globalThis.ResizeObserver = class {
    constructor() {} observe() {} unobserve() {} disconnect() {}
  };
  const app = await import('./app.js?hardening-pagehide=1');
  await app.__historyHydrated();
  const doc = dom.window.document;
  const editor = doc.querySelector('#payloadInput');

  editor.value = '{"fresh":true}';
  editor.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  // Close the tab immediately: the 250ms timer never gets to fire.
  dom.window.dispatchEvent(new dom.window.Event('pagehide'));
  await sleep(50);

  const draft = dom.window.sessionStorage.getItem('payload-formatter:draft:v1');
  assert.equal(draft, '{"fresh":true}', 'pagehide flushed the draft synchronously');
  void app;
  void sleep;
}

// --- Boot: Back steps through edits, then pastes (integrated history) ----
// The requested UX: every debounced edit is its own history stop, so Back
// walks B-edit2 -> B-edit1 -> B-original -> A with no separate snapshot step.
{
  const html = await readFile(new URL('index.html', import.meta.url), 'utf8');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
  for (const key of ['window', 'document', 'sessionStorage', 'localStorage',
    'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia', 'getComputedStyle',
    'Node', 'Element', 'HTMLElement', 'CustomEvent', 'Event', 'KeyboardEvent',
    'MutationObserver']) {
    if (dom.window[key] !== undefined) {
      try { globalThis[key] = dom.window[key]; } catch (_) {}
    }
  }
  globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
  globalThis.removeEventListener = dom.window.removeEventListener.bind(dom.window);
  globalThis.Worker = class { constructor() { throw new Error('no worker in test'); } };
  globalThis.ResizeObserver = class {
    constructor() {} observe() {} unobserve() {} disconnect() {}
  };
  const app = await import('./app.js?hardening-editsteps=1');
  await app.__historyHydrated();
  const doc = dom.window.document;
  const editor = doc.querySelector('#payloadInput');
  const pasteText = async (text) => {
    const paste = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    paste.clipboardData = { getData: () => text };
    editor.dispatchEvent(paste);
    editor.value = text;
    editor.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await sleep(450);
  };
  const typeText = async (text) => {
    editor.value = text;
    editor.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await sleep(450); // let the debounce record this edit as its own entry
  };
  const back = doc.querySelector('#historyBackBtn');
  const forward = doc.querySelector('#historyForwardBtn');
  const goBack = async () => { back.click(); await sleep(50); };
  const goForward = async () => { forward.click(); await sleep(50); };

  await pasteText('{"a":1}');
  await pasteText('{"b":1}');
  await typeText('{"b":2}');
  await typeText('{"b":3}');

  await goBack();
  assert.equal(editor.value, '{"b":2}', 'back: edit2 -> edit1');
  await goBack();
  assert.equal(editor.value, '{"b":1}', 'back: edit1 -> original paste');
  await goBack();
  assert.equal(editor.value, '{"a":1}', 'back: original -> previous paste');
  assert.equal(back.disabled, true, 'back disabled at the oldest entry');

  await goForward();
  assert.equal(editor.value, '{"b":1}', 'forward: previous paste -> original');
  await goForward();
  assert.equal(editor.value, '{"b":2}', 'forward: original -> edit1');
  await goForward();
  assert.equal(editor.value, '{"b":3}', 'forward: edit1 -> edit2');
  assert.equal(forward.disabled, true, 'forward disabled at the newest entry');
  void app;
}

console.log('test-hardening: all assertions passed');
