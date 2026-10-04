import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

// Pin local-time assertions to UTC so they run the same everywhere.
process.env.TZ = 'UTC';
import {
  EPOCH_UNITS,
  cleanTimestamp,
  detectUnit,
  timestampToMs,
  msToUnitStrings,
  dateToUnitStrings,
  formatUtc,
  formatLocal,
  formatRelative,
  convertTimestamp,
} from './epoch-converter.js';

// --- Pure logic: unit detection ------------------------------------------
assert.equal(detectUnit('1728000000'), 's', '10 digits -> seconds');
assert.equal(detectUnit('1698765432123'), 'ms', '13 digits -> milliseconds');
assert.equal(detectUnit('1698765432123456'), 'us', '16 digits -> microseconds');
assert.equal(detectUnit('1698765432123456789'), 'ns', '19 digits -> nanoseconds');
assert.equal(detectUnit('12345678901'), 'ms', '11 digits rounds up to ms');
assert.equal(detectUnit('-86400'), 's', 'negative timestamps detected');
assert.equal(detectUnit('1728000000.5'), 's', 'fractional seconds detected');
assert.equal(detectUnit('1,728,000,000'), 's', 'thousands separators ignored');
assert.equal(detectUnit('1728000000 '), 's', 'surrounding whitespace ignored');
assert.equal(detectUnit('abc'), null, 'non-numeric -> null');
assert.equal(detectUnit(''), null, 'empty -> null');
assert.equal(detectUnit('12.34.56'), null, 'malformed -> null');
assert.equal(cleanTimestamp('1_728_000_000'), '1728000000', 'underscores stripped');

// --- Pure logic: conversion -----------------------------------------------
assert.equal(timestampToMs('1728000000', 's'), 1728000000000);
assert.equal(timestampToMs('1728000000123', 'ms'), 1728000000123);
assert.equal(timestampToMs('1728000000.5', 's'), 1728000000500, 'fractional seconds keep ms');
assert.ok(Number.isNaN(timestampToMs('abc', 's')), 'garbage -> NaN');
assert.ok(Number.isNaN(timestampToMs('123', 'bogus')), 'unknown unit -> NaN');

const units = msToUnitStrings(1728000000000);
assert.equal(units.s, '1728000000');
assert.equal(units.ms, '1728000000000');
assert.equal(units.us, '1728000000000000');
assert.equal(units.ns, '1728000000000000000', 'nanoseconds keep full precision via BigInt');

assert.equal(dateToUnitStrings(new Date(1728000000000), 's'), '1728000000');
assert.equal(dateToUnitStrings(new Date(1728000000000), 'ns'), '1728000000000000000');

assert.equal(formatUtc(new Date(1728000000000)), '2024-10-04T00:00:00Z', 'UTC trims .000');
assert.equal(formatUtc(new Date(1728000000123)), '2024-10-04T00:00:00.123Z', 'UTC keeps real millis');
assert.ok(formatLocal(new Date(1728000000000)).startsWith('2024-10-04'), 'local starts with the date');

const nowMs = 1728000000000;
assert.equal(formatRelative(new Date(nowMs - 5000), nowMs), '5 seconds ago');
assert.equal(formatRelative(new Date(nowMs - 3600000), nowMs), '1 hour ago');
assert.equal(formatRelative(new Date(nowMs + 86400000 * 3), nowMs), 'in 3 days');
assert.equal(formatRelative(new Date(nowMs), nowMs), 'just now');

const good = convertTimestamp('1728000000', 's');
assert.equal(good.error, undefined);
assert.equal(good.utc, '2024-10-04T00:00:00Z');
assert.ok(good.relative.length > 0, 'relative is a non-empty string');
assert.ok(good.local.length > 0 && good.units.ns === '1728000000000000000');

const bad = convertTimestamp('not-a-time', 's');
assert.ok(bad.error, 'garbage input reports an error');

const neg = convertTimestamp('-86400', 's');
assert.equal(neg.utc, '1969-12-31T00:00:00Z', 'pre-1970 timestamps work');

// --- DOM wiring: button, popover, live conversion --------------------------
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

await import('./app.js?epoch=1');
const doc = dom.window.document;
const q = (s) => doc.querySelector(s);

const button = q('#epochBtn');
const popover = q('#epochPopover');
assert.ok(button, 'header has the Epoch button');
assert.ok(popover, 'popover markup exists');
assert.equal(popover.hidden, true, 'popover starts closed');
assert.ok(q('#epochBtn svg'), 'button uses an SVG clock icon, not an emoji');

// Open via the button.
button.click();
await sleep(50);
assert.equal(popover.hidden, false, 'click opens the popover');
assert.equal(button.getAttribute('aria-expanded'), 'true');

// Live conversion as you type.
const input = q('#epochInput');
input.value = '1728000000';
input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
await sleep(50);
assert.equal(
  doc.querySelector('[data-epoch-value="utc"]').textContent,
  '2024-10-04T00:00:00Z',
  'UTC row converts live',
);
assert.ok(
  q('#epochDetected').textContent.includes('seconds'),
  'unit auto-detection is announced',
);
assert.ok(
  doc.querySelector('[data-epoch-value="local"]').textContent.includes('2024'),
  'local row renders',
);
assert.equal(
  doc.querySelector('[data-epoch-value="unit-s"]').textContent,
  '1728000000',
  'seconds row holds just the seconds value',
);
assert.equal(
  doc.querySelector('[data-epoch-value="unit-ns"]').textContent,
  '1728000000000000000',
  'nanos row holds just the nanoseconds value',
);
assert.equal(
  doc.querySelector('[data-epoch-copy="utc"]').disabled,
  false,
  'copy enables once there is a value',
);

// Manual unit override changes the result.
q('#epochUnitSelect').value = 'ms';
q('#epochUnitSelect').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
await sleep(50);
assert.equal(
  doc.querySelector('[data-epoch-value="utc"]').textContent,
  '1970-01-21T00:00:00Z',
  'manual unit override re-converts (1728000000 ms)',
);
q('#epochUnitSelect').value = 'auto';
q('#epochUnitSelect').dispatchEvent(new dom.window.Event('change', { bubbles: true }));

// Invalid input: gentle error, values cleared, no crash.
input.value = 'abc';
input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
await sleep(50);
assert.equal(q('#epochError').hidden, false, 'error shows for garbage input');
assert.equal(doc.querySelector('[data-epoch-value="utc"]').textContent, '', 'values clear on error');

// Now button fills the current timestamp.
input.value = '';
input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
q('#epochNowBtn').click();
await sleep(50);
assert.ok(/^\d{13}$/.test(input.value), 'Now fills 13-digit milliseconds');
assert.ok(doc.querySelector('[data-epoch-value="utc"]').textContent.endsWith('Z'), 'Now converts');

// Copy button writes the row value to the clipboard.
let copied = null;
dom.window.navigator.clipboard = { writeText: async (t) => { copied = t; } };
doc.querySelector('[data-epoch-copy="utc"]').click();
await sleep(50);
assert.ok(copied && copied.endsWith('Z'), 'copy writes the UTC value');
assert.equal(doc.querySelector('[data-epoch-copy="utc"]').textContent, 'Copied', 'copy feedback shows');

// Each unit row copies only its own value, not a combined string.
input.value = '1728000000';
input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
await sleep(50);
doc.querySelector('[data-epoch-copy="unit-ms"]').click();
await sleep(50);
assert.equal(copied, '1728000000000', 'millis row copies just milliseconds');
doc.querySelector('[data-epoch-copy="unit-ns"]').click();
await sleep(50);
assert.equal(copied, '1728000000000000000', 'nanos row copies just nanoseconds');

// Live mode: keeps itself on the current time without clicking Now.
const liveBtn = q('#epochLiveBtn');
assert.ok(liveBtn, 'Live toggle exists');
assert.equal(liveBtn.getAttribute('aria-pressed'), 'false', 'live starts off');
liveBtn.click();
await sleep(50);
assert.equal(liveBtn.getAttribute('aria-pressed'), 'true', 'live engages');
assert.ok(liveBtn.classList.contains('is-active'), 'live shows its active state');
const firstTick = input.value;
assert.ok(/^\d{13}$/.test(firstTick), 'live fills the current milliseconds');
assert.ok(doc.querySelector('[data-epoch-value="utc"]').textContent.endsWith('Z'), 'live converts');
await sleep(1200);
assert.notEqual(input.value, firstTick, 'live ticks forward on its own');

// Typing by hand takes over from live mode.
input.value = '1728000000';
input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
await sleep(50);
assert.equal(liveBtn.getAttribute('aria-pressed'), 'false', 'manual typing stops live');
assert.equal(input.value, '1728000000', 'typed value is preserved');

// Closing the popover stops the timer.
liveBtn.click();
await sleep(50);
const liveValue = input.value;
assert.equal(liveBtn.getAttribute('aria-pressed'), 'true', 'live re-engaged');
doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await sleep(1300);
button.click();
await sleep(50);
assert.equal(input.value, liveValue, 'no ticks happen while closed');
assert.equal(liveBtn.getAttribute('aria-pressed'), 'false', 'live is off after close');

// Switching to the Date → Epoch tab stops live mode.
liveBtn.click();
await sleep(50);
q('#epochTabToEpoch').click();
await sleep(50);
assert.equal(liveBtn.getAttribute('aria-pressed'), 'false', 'tab switch stops live');

// Clicking into the input freezes live mode, keeping the value as a snapshot
// for copying or editing. pointerdown (not focus) is the real trigger: the
// input is usually already focused, and focus would not re-fire on click.
q('#epochTabToDate').click();
await sleep(50);
liveBtn.click();
await sleep(50);
assert.equal(liveBtn.getAttribute('aria-pressed'), 'true', 'live re-engaged');
const snapshot = input.value;
input.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }));
await sleep(1200);
assert.equal(liveBtn.getAttribute('aria-pressed'), 'false', 'clicking the input stops live');
assert.equal(input.value, snapshot, 'clicked value stays put for copying/editing');

// Date → Epoch tab.
q('#epochTabToEpoch').click();
await sleep(50);
assert.equal(q('#epochPaneToEpoch').hidden, false, 'reverse pane opens');
assert.equal(q('#epochPaneToDate').hidden, true, 'forward pane hides');
const dateInput = q('#epochDateInput');
dateInput.value = '2024-10-04T00:00';
dateInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
await sleep(50);
const epochOut = doc.querySelector('[data-epoch-value="epoch"]').textContent;
assert.ok(/^\d+$/.test(epochOut), 'date converts to a numeric epoch');
assert.equal(q('#epochTargetUnit').value, 'ms', 'default target unit is milliseconds');

// Escape closes and returns focus to the button.
doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await sleep(50);
assert.equal(popover.hidden, true, 'Escape closes the popover');
assert.equal(doc.activeElement, button, 'focus returns to the button');

// Outside click closes without stealing focus.
button.click();
await sleep(50);
assert.equal(popover.hidden, false, 'reopens');
doc.body.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
await sleep(50);
assert.equal(popover.hidden, true, 'outside click closes');

// Reopening preserves state (does not wipe the input).
button.click();
await sleep(50);
assert.ok(input.value.length > 0, 'input preserved across reopen');

console.log('All epoch converter tests passed.');
