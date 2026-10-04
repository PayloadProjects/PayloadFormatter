import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createPayloadHistory } from './payload-history.js';
import {
  saveWindowHistory,
  loadWindowHistories,
  __useTestBackend,
  __clearMemoryBackend,
} from './history-store.js';

// Phase 4 — adversarial verification of the raised large-payload cliffs:
// tree 10MB, editable 10MB, history 100 entries / 32MB, persistence 20MB.
// Method (SDET): boundary values, feature interactions, corrupt inputs,
// measured timings. Anything DOM/layout stays a real-machine eyeball item.
const html = await readFile(new URL('index.html', import.meta.url), 'utf8');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MB = 1024 * 1024;

function installGlobals(dom) {
  for (const key of ['window', 'document', 'DOMParser', 'sessionStorage', 'localStorage',
    'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia', 'getComputedStyle',
    'Node', 'Element', 'HTMLElement', 'CustomEvent', 'Event', 'KeyboardEvent',
    'MutationObserver']) {
    if (dom.window[key] !== undefined) {
      try { globalThis[key] = dom.window[key]; } catch (_) {}
    }
  }
  try { Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true }); } catch (_) {}
  globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
  globalThis.removeEventListener = dom.window.removeEventListener.bind(dom.window);
  globalThis.Worker = class {
    constructor() { throw new Error('Worker must not start during this test'); }
  };
  globalThis.ResizeObserver = class {
    constructor() {}
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

async function bootApp(query) {
  const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
  installGlobals(dom);
  const app = await import(`./app.js?${query}`);
  await app.__historyHydrated();
  const doc = dom.window.document;
  return { dom, app, doc, editor: doc.querySelector('#payloadInput') };
}

// A real Ctrl+V: the paste event arms the handler, the synthetic insertion
// plus input event completes it, and the app records one history entry.
async function ctrlVPaste(dom, editor, text) {
  const paste = new dom.window.Event('paste', { bubbles: true, cancelable: true });
  paste.clipboardData = { getData: () => text };
  editor.dispatchEvent(paste);
  editor.value = text;
  try { editor.setSelectionRange(text.length, text.length); } catch (_) {}
  editor.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await sleep(450);
}

// Valid JSON of exactly `bytes` chars (fixed-width items, legal trailing space).
function jsonOfSize(bytes) {
  const item = '"0123456789",'; // 13 chars
  const count = Math.max(1, Math.floor((bytes - 16) / item.length));
  const payload = `[${item.repeat(count)}"0123456789"]`;
  assert.ok(payload.length <= bytes, 'sizing math holds');
  return payload.padEnd(bytes, ' ');
}

function xmlOfSize(bytes) {
  const item = '<i id="12345">abcdefghij</i>'; // 30 chars
  const count = Math.max(1, Math.floor((bytes - 20) / item.length));
  const payload = `<root>${item.repeat(count)}</root>`;
  assert.ok(payload.length <= bytes, 'sizing math holds');
  return payload.padEnd(bytes, ' ');
}

function treeControllerFor(dom, payload, mode) {
  return import('./tree-controller.js?cliff=1').then(({ createTreeController }) =>
    createTreeController({
      getText: () => payload,
      detectMode: () => mode,
      setStatus: () => {},
      nextPaint: () => Promise.resolve(),
      onFormat: () => {},
      onPasteText: () => {},
    }),
  );
}

// --- A1. Tree cap boundaries: 9.9MB builds, exactly 10MB refuses ------------
{
  const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
  installGlobals(dom);

  const under = jsonOfSize(Math.floor(9.9 * MB));
  assert.equal(under.length < 10 * MB, true);
  const controller = await treeControllerFor(dom, under, 'json');
  const t0 = Date.now();
  controller.setView('tree');
  await sleep(3000);
  assert.equal(controller.hasTree(), true, '9.9MB JSON builds a tree under the cap');
  assert.ok(Date.now() - t0 < 20000, '9.9MB tree build stays in budget');

  const at = jsonOfSize(10 * MB);
  assert.equal(at.length, 10 * MB, 'boundary payload is exactly 10MB');
  const controller2 = await treeControllerFor(dom, at, 'json');
  controller2.setView('tree');
  await sleep(300);
  assert.equal(controller2.hasTree(), false, 'exactly 10MB is refused (>= boundary)');
  const msg = dom.window.document.querySelector('#treeView').textContent;
  assert.ok(msg.includes('10 MB'), 'refusal names the 10MB cap');
}

// --- A2. 8.5MB XML tree builds (above the old 8M XML cap) -------------------
// Note: jsdom's DOMParser is a pure-JS implementation, ~10-50x slower than a
// browser's native one — the generous budget below reflects the harness,
// not the app. Real-browser timing is a user-eyeball item.
{
  const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
  installGlobals(dom);
  const payload = xmlOfSize(Math.floor(8.5 * MB));
  const controller = await treeControllerFor(dom, payload, 'xml');
  const t0 = Date.now();
  controller.setView('tree');
  await sleep(25000);
  assert.equal(controller.hasTree(), true, '8.5MB XML builds a tree under the raised 10M cap');
  assert.ok(Date.now() - t0 < 40000, '8.5MB XML tree build stays in budget');
}

// --- A3. Late-match reveal on a 4MB flat array (H-1 fix at 2x old cap) ------
{
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  globalThis.document = dom.window.document;
  globalThis.NodeFilter = dom.window.NodeFilter;
  globalThis.Node = dom.window.Node;
  dom.window.Element.prototype.scrollIntoView = function () {};
  const { createTreeView } = await import('./tree-view.js?cliff=reveal');

  const container = document.createElement('div');
  document.body.appendChild(container);
  const view = createTreeView(container, { onCopyPath() {} });

  // ~4MB, ~270k fixed-width items; the only match sits at index 200000
  // (inside the 400k search-visit budget).
  const n = 270000;
  const items = new Array(n);
  for (let i = 0; i < n; i += 1) items[i] = `item-${String(i).padStart(6, '0')}`;
  const payload = JSON.stringify(items);
  assert.ok(payload.length > 3 * MB && payload.length < 5 * MB, `~4MB probe (${(payload.length / MB).toFixed(1)}MB)`);
  assert.ok(view.show(payload, 'json').ok, '4MB flat list renders');
  const found = view.find('item-200000');
  assert.equal(found.total, 1, 'one match at index 200000');
  const t0 = Date.now();
  view.step(0);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 15000, `reveal finished in ${elapsed}ms (no freeze at 4MB)`);
  const rows = container.querySelectorAll('.tree-node').length;
  assert.ok(rows < 8000, `reveal stays windowed (${rows} rows, not 270k)`);
  assert.ok(container.querySelector('.tree-hit'), 'the match is highlighted');
}

// --- B1. Editability boundaries: 9.9MB editable, exactly 10MB read-only ----
{
  const { dom, app, doc, editor } = await bootApp('cliff-edit');
  const firePaste = (text) => {
    const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    event.clipboardData = { getData: () => text };
    editor.dispatchEvent(event);
    return event;
  };

  const under = 'x'.repeat(Math.floor(9.9 * MB));
  const e1 = firePaste(under);
  assert.equal(e1.defaultPrevented, false, '9.9MB takes the native editable path');
  editor.value = under;
  editor.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await sleep(700);
  assert.equal(editor.readOnly, false, '9.9MB stays editable');

  editor.value = '';
  const at = 'x'.repeat(10 * MB);
  const e2 = firePaste(at);
  assert.equal(e2.defaultPrevented, true, 'exactly 10MB is intercepted');
  await sleep(300);
  assert.equal(editor.readOnly, true, 'exactly 10MB is read-only');
  assert.ok(doc.querySelector('#largeNotice').textContent.includes('read-only'), 'notice shown');
  await app.__flushHistorySaves();
}

// --- B2. Typing into 9MB: input -> paint round-trip stays responsive --------
{
  const { dom, editor } = await bootApp('cliff-type');
  const nine = jsonOfSize(9 * MB);
  await ctrlVPaste(dom, editor, nine);

  // Simulate one keystroke, then measure until the input's rAF work (queued
  // before ours) has run.
  editor.value = nine + ' ';
  editor.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  const t0 = Date.now();
  await new Promise((resolve) => dom.window.requestAnimationFrame(() => resolve()));
  await new Promise((resolve) => dom.window.requestAnimationFrame(() => resolve()));
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 5000, `9MB keystroke round-trip in ${elapsed}ms (no pathological per-key cost)`);
}

// --- C1. 101 pushes evict to 100 entries, oldest-first ----------------------
{
  const history = createPayloadHistory(); // defaults: 100 entries / 32MB
  for (let i = 0; i < 101; i += 1) history.push(`entry-${i}`);
  assert.equal(history.size(), 100, 'count cap holds at 100');
  let last = null;
  for (let i = 0; i < 99; i += 1) last = history.back();
  assert.equal(last, 'entry-1', 'oldest survivor is push #2 (push #1 evicted)');
  assert.equal(history.back(), null, 'nothing before the oldest survivor');
}

// --- C2. 32MB byte cap evicts 9MB entries oldest-first ----------------------
{
  const history = createPayloadHistory();
  const big = 'e'.repeat(9 * MB);
  for (let i = 0; i < 5; i += 1) history.push(big + i); // 45MB total
  assert.equal(history.size(), 3, 'byte cap keeps ~3 entries of 9MB');
  assert.ok(history.current().endsWith('4'), 'newest entry kept');
  assert.ok(history.back().endsWith('3'), 'one step back');
  assert.ok(history.back().endsWith('2'), 'two steps back');
  assert.equal(history.back(), null, 'evicted entries are unreachable');
}

// --- C3. CJK eviction terminates sanely (units counted, not UTF-8 bytes) ----
{
  const history = createPayloadHistory();
  const cjk = '日'.repeat(9 * MB); // 9M units, 27MB as UTF-8
  for (let i = 0; i < 5; i += 1) history.push(cjk + i);
  assert.ok(history.size() >= 1 && history.size() <= 4, `CJK eviction sane (size ${history.size()})`);
  assert.ok(history.current().endsWith('4'), 'newest CJK entry kept');
}

// --- D1. 19.9MB persists, 20.1MB is dropped by the persist cap --------------
{
  const { dom, app, editor } = await bootApp('cliff-persist20');
  const fireLargePaste = (text) => {
    const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    event.clipboardData = { getData: () => text };
    editor.dispatchEvent(event);
  };

  const keep = `{${'x'.repeat(Math.floor(19.9 * MB))}}`; // '{' -> O(1) mode detect
  fireLargePaste(keep);
  await sleep(200);
  await app.__flushHistorySaves();
  const recs = await loadWindowHistories(app.__getTabId());
  assert.equal(recs.length, 1, 'history record saved');
  assert.equal(recs[0].entries.length, 1, '19.9MB entry kept by the 20MB persist cap');
  assert.equal(recs[0].entries[0].length, keep.length, '19.9MB entry round-trips intact');

  const drop = `{${'x'.repeat(Math.floor(20.1 * MB))}}`;
  fireLargePaste(drop);
  await sleep(200);
  await app.__flushHistorySaves();
  const recs2 = await loadWindowHistories(app.__getTabId());
  assert.equal(recs2[0].entries.length, 0, '20.1MB entry dropped by the persist cap');
  assert.equal(typeof recs2[0].entries, 'object', 'record survives with empty entries');
}

// --- D2. CJK byte-half of the persist predicate -----------------------------
// 7M CJK chars = 7M units (< 20M length cap) but 21MB as UTF-8 (> 20M byte
// cap): storage cost is bytes, so it must be dropped.
{
  const { dom, app, editor } = await bootApp('cliff-cjk');
  const cjk = '日'.repeat(7 * MB);
  const paste = new dom.window.Event('paste', { bubbles: true, cancelable: true });
  paste.clipboardData = { getData: () => cjk };
  editor.dispatchEvent(paste); // 7M chars < 10M: native editable path
  editor.value = cjk;
  editor.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await sleep(600);
  await app.__flushHistorySaves();
  const recs = await loadWindowHistories(app.__getTabId());
  assert.ok(
    recs.every((record) => !record.entries.some((entry) => entry.includes('日'))),
    '7M CJK chars (21MB UTF-8) dropped by the byte-half of the persist cap',
  );
}

// --- E1. Corrupt persisted records never break restore ----------------------
{
  const history = createPayloadHistory();
  assert.equal(history.restore(null), false, 'null record rejected');
  assert.equal(history.restore({ entries: null }), false, 'null entries rejected');
  assert.equal(history.restore({ entries: 'nope' }), false, 'non-array entries rejected');
  assert.equal(history.restore({ entries: [null, 123, {}], index: 99 }), true, 'tolerates junk entries');
  assert.equal(history.size(), 3, 'junk coerced to strings');
  assert.equal(history.current(), '[object Object]', 'index clamped to last entry');
}

// --- F1. Window-switch race with a 9MB pending debounce (BUG-1 at scale) ----
{
  const { dom, doc, editor } = await bootApp('cliff-race');
  const nine = jsonOfSize(9 * MB);
  await ctrlVPaste(dom, editor, nine); // history: [nine]
  doc.querySelector('#newWindowBtn').click();
  await sleep(50);
  const tabs = [...doc.querySelectorAll('.window-tab')];
  tabs[0].click(); // back to window 1
  await sleep(50);

  editor.value = nine + ' ';
  editor.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await sleep(50); // well inside the 250ms debounce
  tabs[1].click(); // switch: activateWindow must flush the 9MB update synchronously
  await sleep(400); // let any stray timer fire (it must be a no-op duplicate)
  tabs[0].click();
  await sleep(50);

  const back = doc.querySelector('#historyBackBtn');
  assert.equal(back.disabled, false, 'typed 9MB entry flushed on switch, not lost');
  back.click();
  await sleep(50);
  assert.equal(editor.value.length, nine.length, 'Back reaches the pre-edit 9MB entry');
  const forward = doc.querySelector('#historyForwardBtn');
  forward.click();
  await sleep(50);
  assert.equal(editor.value.length, nine.length + 1, 'Forward returns to the typed entry');
}

// --- F2. Clear with 9MB history: Back skips the empty entry -----------------
{
  const { dom, doc, editor } = await bootApp('cliff-clear');
  const nine = jsonOfSize(9 * MB);
  await ctrlVPaste(dom, editor, nine);
  doc.querySelector('#clearBtn').click();
  await sleep(100);
  await ctrlVPaste(dom, editor, '{"small":1}');
  doc.querySelector('#historyBackBtn').click();
  await sleep(50);
  assert.equal(editor.value, nine, 'Back skips the empty clear entry at 9MB scale');
}

// --- F3. 20 windows x 5MB histories hydrate in budget ------------------------
{
  __clearMemoryBackend();
  const five = 'q'.repeat(5 * MB);
  for (let i = 0; i < 20; i += 1) {
    await saveWindowHistory('hydra-tab', `w${i}`, { entries: ['a', five], index: 1 });
  }
  const t0 = Date.now();
  const recs = await loadWindowHistories('hydra-tab');
  const elapsed = Date.now() - t0;
  assert.equal(recs.length, 20, 'all 20 large histories load');
  assert.ok(recs.every((r) => r.entries[1] === five), '5MB Blob entries round-trip on all windows');
  assert.ok(elapsed < 20000, `20-window large hydration in ${elapsed}ms`);
  __clearMemoryBackend();
}

console.log('All large-cliff adversarial verification tests passed.');
