import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

// Extreme-load guards and the empty-panel click-to-paste:
// 1. Tree view refuses payloads >= 2MB with a clear message (no DOM hang).
// 2. Pastes over 100MB are refused up front with an honest error.
// 3. Clicking an empty panel runs the Paste & Format flow.
const html = await readFile(new URL('index.html', import.meta.url), 'utf8');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function installGlobals(dom) {
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
}

// --- 1. Tree view size guard ----------------------------------------------
{
  const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
  installGlobals(dom);
  const { createTreeController } = await import('./tree-controller.js?guards=1');

  let payload = '{"a":1}';
  const statuses = [];
  const controller = createTreeController({
    getText: () => payload,
    detectMode: () => 'json',
    setStatus: (text, kind) => statuses.push([text, kind]),
    nextPaint: () => Promise.resolve(),
    onFormat: () => {},
    onPasteText: () => {},
  });

  controller.setView('tree');
  await sleep(100);
  assert.equal(controller.hasTree(), true, 'small payload builds the tree');

  payload = 'x'.repeat(3 * 1024 * 1024); // 3MB of non-JSON; mode forced to json
  controller.setView('text');
  controller.setView('tree');
  await sleep(100);
  assert.equal(controller.hasTree(), false, 'oversize payload does not build a tree');
  const treeText = dom.window.document.querySelector('#treeView').textContent;
  assert.ok(treeText.includes('2 MB'), 'refusal states the cap');
  assert.ok(treeText.includes('3.0 MB'), 'refusal states the actual size');
  assert.ok(treeText.includes('Text view'), 'refusal names the way out');
  assert.ok(
    statuses.some(([text, kind]) => text.includes('too large') && kind === 'warning'),
    'status warns instead of failing silently',
  );
}

// --- 2. Paste size ceiling -------------------------------------------------
{
  const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
  installGlobals(dom);
  await import('./app.js?guards=2');
  const doc = dom.window.document;
  const editor = doc.querySelector('#payloadInput');
  const status = doc.querySelector('#statusText');

  const firePaste = (text) => {
    const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    event.clipboardData = { getData: () => text };
    editor.dispatchEvent(event);
    return event;
  };

  // A normal small paste still works.
  firePaste('{"kept":true}');
  editor.value = '{"kept":true}';
  editor.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await sleep(450);
  assert.equal(editor.value, '{"kept":true}', 'small paste admitted');

  // A 101MB paste is refused: nothing admitted, current payload untouched.
  const huge = 'x'.repeat(101 * 1024 * 1024);
  const event = firePaste(huge);
  assert.equal(event.defaultPrevented, true, 'huge paste is intercepted');
  await sleep(100);
  assert.equal(editor.value, '{"kept":true}', 'current payload untouched by refused paste');
  assert.ok(status.textContent.includes('too large'), 'status names the problem');
  assert.ok(status.textContent.includes('100 MB'), 'status states the limit');
}

// --- 3. Click empty panel to paste & format --------------------------------
{
  const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
  installGlobals(dom);
  await import('./app.js?guards=3');
  const doc = dom.window.document;
  const editor = doc.querySelector('#payloadInput');
  const status = doc.querySelector('#statusText');
  const body = doc.querySelector('.editor-body');

  let reads = 0;
  dom.window.navigator.clipboard = {
    readText: async () => {
      reads += 1;
      return '{"clicked":true}';
    },
  };

  body.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await sleep(400);
  assert.equal(reads, 1, 'clicking the empty panel reads the clipboard');
  assert.equal(editor.value, '{"clicked":true}', 'clipboard text lands in the editor');
  assert.ok(
    doc.querySelector('.empty-state').textContent.includes('Click anywhere'),
    'empty state teaches the gesture',
  );

  // Clicking a non-empty panel does not touch the clipboard.
  reads = 0;
  body.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await sleep(200);
  assert.equal(reads, 0, 'clicking a non-empty panel leaves the clipboard alone');
  assert.equal(editor.value, '{"clicked":true}', 'payload untouched');

  // Clipboard denied: the button's guidance shows, editor focused for Ctrl+V.
  editor.value = '';
  editor.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await sleep(450);
  dom.window.navigator.clipboard = {
    readText: async () => { throw new Error('denied'); },
  };
  body.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await sleep(400);
  assert.ok(
    status.textContent.includes('Ctrl+V'),
    'denied clipboard shows the manual-paste guidance',
  );
  assert.equal(editor.value, '', 'nothing pasted when the clipboard is denied');

  // Tree view: the empty state teaches the gesture, and clicking the empty
  // tree panel pastes (the click bubbles to .editor-body).
  editor.value = '';
  editor.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await sleep(450);
  doc.querySelector('#viewTextBtn').click();
  await sleep(50);
  doc.querySelector('#viewTreeBtn').click();
  await sleep(100);
  assert.ok(
    doc.querySelector('#treeView').textContent.includes('Click anywhere in the panel'),
    'tree empty state teaches click-to-paste',
  );
  dom.window.navigator.clipboard = {
    readText: async () => '{"fromTree":1}',
  };
  doc.querySelector('#treeView').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await sleep(400);
  assert.equal(editor.value, '{"fromTree":1}', 'clicking the empty tree panel pastes');
}

console.log('All extreme-load guard tests passed.');
