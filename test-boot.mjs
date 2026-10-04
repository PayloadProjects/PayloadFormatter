import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

// Boot-level regression: the real app.js must wire up in a browser-like DOM
// with no runtime exceptions, and the headline user flows must behave.
// Static tests cannot see wiring mistakes (wrong ids, null buttons, broken
// handlers); this file boots the app and drives it like a user would.
const html = await readFile(new URL('index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });

for (const key of ['window', 'document', 'sessionStorage', 'localStorage',
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
// Browsers provide these; jsdom does not. The formatting worker only starts
// lazily, so the stub must never fire during boot.
globalThis.Worker = class {
  constructor() { throw new Error('Worker must not start during the boot test'); }
};
globalThis.ResizeObserver = class {
  constructor() {}
  observe() {}
  unobserve() {}
  disconnect() {}
};

let bootError = null;
try {
  await import('./app.js');
} catch (error) {
  bootError = error;
}
assert.equal(bootError, null, `app.js boots cleanly: ${bootError?.stack || bootError}`);

const q = (selector) => document.querySelector(selector);
for (const id of ['historyBackBtn', 'historyForwardBtn', 'clearBtn', 'pasteFormatBtn',
  'copyBtn', 'wrapToggleBtn', 'typeBadge', 'payloadInput', 'statusText']) {
  assert.ok(q(`#${id}`), `#${id} resolves`);
}
assert.equal(q('#historyBackBtn').disabled, true, 'back starts disabled');
assert.equal(q('#historyForwardBtn').disabled, true, 'forward starts disabled');
assert.equal(q('#statusText').textContent, 'Ready.', 'status starts ready with no draft');

// The reported history flow, driven through real DOM events:
// paste A -> clear -> paste B -> back lands on A -> forward returns to B.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const editor = q('#payloadInput');

async function nativePaste(text) {
  const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
  event.clipboardData = { getData: () => text };
  editor.dispatchEvent(event);
  // jsdom performs no native insertion; emulate the browser, then let the
  // app's rAF-coalesced input handler and debounced history update run.
  editor.value = text;
  try { editor.setSelectionRange(text.length, text.length); } catch (_) {}
  editor.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await sleep(450);
}

await nativePaste('{"a":1}');
assert.equal(q('#historyBackBtn').disabled, true, 'single paste: back stays disabled');
q('#clearBtn').click();
await sleep(50);
assert.equal(editor.value, '', 'clear empties the editor');
await nativePaste('{"b":2}');
assert.equal(q('#historyBackBtn').disabled, false, 'clear then paste: back enables');
q('#historyBackBtn').click();
await sleep(50);
assert.equal(editor.value, '{"a":1}', 'back skips the clear state and restores paste A');
assert.equal(q('#statusText').textContent, 'Restored previous payload.');
q('#historyForwardBtn').click();
await sleep(50);
assert.equal(editor.value, '{"b":2}', 'forward restores paste B');

// --- Window flow: new window, switch, rename ---
const tabs = () => [...document.querySelectorAll('.window-tab')];
assert.equal(tabs().length, 1, 'one window at startup');
assert.equal(tabs()[0].querySelector('.window-tab-name').textContent, 'Window 1');

q('#newWindowBtn').click();
await sleep(50);
assert.equal(tabs().length, 2, 'new window adds a tab');
assert.ok(tabs()[1].classList.contains('is-active'), 'the new window is active');
assert.equal(editor.value, '', 'the new window starts empty');

await nativePaste('{"x":9}');
tabs()[0].click();
await sleep(50);
assert.equal(editor.value, '{"b":2}', 'switching tabs restores that window’s payload');
assert.ok(tabs()[0].classList.contains('is-active'), 'tab active state follows');
tabs()[1].click();
await sleep(50);
assert.equal(editor.value, '{"x":9}', 'switching back restores the second payload');

const firstTab = tabs()[0];
firstTab.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
await sleep(50);
const renameInput = firstTab.querySelector('.window-rename-input');
assert.ok(renameInput, 'double-click opens the rename input');
renameInput.value = 'Orders';
renameInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
await sleep(50);
assert.equal(
  document.querySelector('.window-tab').querySelector('.window-tab-name').textContent,
  'Orders',
  'rename commits on Enter',
);

// --- Refresh survival: a reload keeps every window's payload, name, and order ---
// Snapshot this page's sessionStorage, then boot a brand-new page copy with it,
// the way a real refresh replays persisted state.
const snapshot = {};
for (let i = 0; i < sessionStorage.length; i += 1) {
  const key = sessionStorage.key(i);
  snapshot[key] = sessionStorage.getItem(key);
}
assert.ok(snapshot['payload-formatter:windows:v1'], 'window list is persisted');
assert.ok(snapshot['payload-formatter:window-draft:window-1'], 'window payloads are persisted');
assert.equal(snapshot['payload-formatter:draft:v1'], '{"x":9}',
  'legacy key mirrors the active payload so pre-window builds keep working');

const dom2 = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
for (const [key, value] of Object.entries(snapshot)) {
  dom2.window.sessionStorage.setItem(key, value);
}
for (const key of ['window', 'document', 'sessionStorage', 'localStorage',
  'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia', 'getComputedStyle',
  'Node', 'Element', 'HTMLElement', 'CustomEvent', 'Event', 'KeyboardEvent',
  'MutationObserver']) {
  if (dom2.window[key] !== undefined) {
    try { globalThis[key] = dom2.window[key]; } catch (_) {}
  }
}
try { Object.defineProperty(globalThis, 'navigator', { value: dom2.window.navigator, configurable: true }); } catch (_) {}
globalThis.addEventListener = dom2.window.addEventListener.bind(dom2.window);
globalThis.removeEventListener = dom2.window.removeEventListener.bind(dom2.window);

// A fresh module instance against the fresh page: the closest thing to reload.
await import('./app.js?refresh=1');
const doc2 = dom2.window.document;
const tabs2 = [...doc2.querySelectorAll('.window-tab')];
assert.equal(tabs2.length, 2, 'both windows survive the refresh');
assert.equal(tabs2[0].querySelector('.window-tab-name').textContent, 'Orders', 'renamed tab survives');
assert.equal(tabs2[1].querySelector('.window-tab-name').textContent, 'Window 2');
assert.ok(tabs2[1].classList.contains('is-active'), 'the active window is restored');
assert.equal(doc2.querySelector('#payloadInput').value, '{"x":9}', 'the active payload is restored');

console.log('All boot and flow regression tests passed.');
