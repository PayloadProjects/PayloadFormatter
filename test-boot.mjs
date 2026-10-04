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

console.log('All boot and flow regression tests passed.');
