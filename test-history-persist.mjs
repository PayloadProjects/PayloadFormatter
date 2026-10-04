import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createPayloadHistory } from './payload-history.js';
import {
  saveWindowHistory,
  loadWindowHistories,
  deleteWindowHistory,
  __useTestBackend,
  __clearMemoryBackend,
} from './history-store.js';

// Persistent per-window paste history: every dataset pasted into every
// window must survive a refresh and stay navigable with Back/Forward.

// --- Model: serialization -----------------------------------------------
{
  const history = createPayloadHistory();
  history.push('{"a":1}');
  history.push('{"b":2}');
  history.back();
  const snapshot = history.toJSON();
  assert.deepEqual(snapshot, { entries: ['{"a":1}', '{"b":2}'], index: 0 });

  const revived = createPayloadHistory();
  assert.equal(revived.restore(snapshot), true, 'restore accepts a snapshot');
  assert.equal(revived.size(), 2);
  assert.equal(revived.forward(), '{"b":2}', 'restored position navigates forward');
  assert.equal(revived.back(), '{"a":1}');
  assert.equal(revived.back(), null, 'no phantom entries past the start');

  const bad = createPayloadHistory();
  assert.equal(bad.restore(null), false, 'restore rejects null');
  assert.equal(bad.restore({ entries: 'nope' }), false, 'restore rejects bad entries');
  assert.equal(bad.size(), 0, 'failed restore leaves history untouched');

  const clamped = createPayloadHistory();
  clamped.restore({ entries: ['x', 'y'], index: 99 });
  assert.equal(clamped.current(), 'y', 'out-of-range index clamps to the last entry');
}

// --- Model: toPersistable drops oversize entries and remaps the index ----
{
  const small = (text) => text.length <= 4;
  const history = createPayloadHistory();
  history.push('aa');
  history.push('bbbbbbbb');
  history.push('cc');
  // Index sits on 'cc' (position 2).
  assert.deepEqual(history.toPersistable(small), {
    entries: ['aa', 'cc'],
    index: 1,
  }, 'oversize middle entry dropped, index remapped');

  history.back(); // now on 'aa' (position 0)
  history.back(); // stays: nearest non-empty backwards is none
  const history2 = createPayloadHistory();
  history2.push('aa');
  history2.push('bbbbbbbb');
  history2.back();
  assert.deepEqual(history2.toPersistable(small), {
    entries: ['aa'],
    index: 0,
  }, 'index on a surviving entry keeps its remapped position');

  const history3 = createPayloadHistory();
  history3.push('bbbbbbbb');
  history3.push('cc');
  history3.back(); // index on the oversize entry
  assert.deepEqual(history3.toPersistable(small), {
    entries: ['cc'],
    index: 0,
  }, 'index on a dropped entry lands on the nearest earlier survivor');

  const history4 = createPayloadHistory();
  history4.push('bbbbbbbb');
  assert.deepEqual(history4.toPersistable(small), {
    entries: [],
    index: -1,
  }, 'all entries dropped yields an empty snapshot');
}

// --- Model: revision bumps on mutation -----------------------------------
{
  const history = createPayloadHistory();
  const start = history.revision();
  history.push('x');
  assert.ok(history.revision() > start, 'push bumps revision');
  const mid = history.revision();
  history.updateCurrent('y');
  assert.ok(history.revision() > mid, 'updateCurrent bumps revision');
  const end = history.revision();
  history.back();
  assert.equal(history.revision(), end, 'navigation does not bump revision');
}

// --- Store: round-trip on the default (memory) backend --------------------
__clearMemoryBackend();
{
  assert.deepEqual(await loadWindowHistories('tab-a'), [], 'no history initially');
  assert.equal(await saveWindowHistory('tab-a', 'window-1', { entries: ['a', 'b'], index: 1 }), true);
  assert.equal(
    await saveWindowHistory('tab-a', 'window-2', { entries: ['<x/>'], index: 0 }),
    true,
  );
  await saveWindowHistory('tab-b', 'window-1', { entries: ['other-tab'], index: 0 });

  const records = await loadWindowHistories('tab-a');
  assert.equal(records.length, 2, 'both windows load');
  assert.ok(!records.some((record) => record.entries[0] === 'other-tab'), 'tabs are isolated');

  await deleteWindowHistory('tab-a', 'window-1');
  const after = await loadWindowHistories('tab-a');
  assert.equal(after.length, 1, 'deleted window history is gone');
  assert.equal(after[0].windowId, 'window-2');
}
__clearMemoryBackend();

// --- Store: a failing backend degrades instead of throwing ----------------
{
  const failing = {
    loadAll: async () => { throw new Error('denied'); },
    save: async () => { throw new Error('denied'); },
    remove: async () => { throw new Error('denied'); },
    cleanup: async () => { throw new Error('denied'); },
  };
  __useTestBackend(failing);
  try {
    assert.equal(
      await saveWindowHistory('tab-a', 'window-1', { entries: ['a'], index: 0 }),
      false,
      'failed save reports false',
    );
    assert.deepEqual(await loadWindowHistories('tab-a'), [], 'failed load yields no records');
    await deleteWindowHistory('tab-a', 'window-1'); // must not throw
  } finally {
    __useTestBackend(null);
  }
}

// --- Boot: the 10-vs-5 refresh scenario -----------------------------------
// Window 1 gets 10 JSON datasets, window 2 gets 5 XML datasets; a refresh
// must keep every one of them navigable, in the right window.
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

function snapshotStorage() {
  const snapshot = {};
  for (let i = 0; i < sessionStorage.length; i += 1) {
    const key = sessionStorage.key(i);
    snapshot[key] = sessionStorage.getItem(key);
  }
  return snapshot;
}

// A real Ctrl+V: the paste event arms pastePending, the synthetic insertion
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

__clearMemoryBackend();
const domA = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
installGlobals(domA);
const appA = await import('./app.js?history-persist=1');
await appA.__historyHydrated();
const docA = domA.window.document;
const editorA = docA.querySelector('#payloadInput');
const tabsA = () => [...docA.querySelectorAll('.window-tab')];

for (let i = 1; i <= 10; i += 1) {
  await ctrlVPaste(domA, editorA, `{"w1":${i}}`);
}
docA.querySelector('#newWindowBtn').click();
await sleep(50);
assert.equal(tabsA().length, 2, 'second window created');
for (let i = 1; i <= 5; i += 1) {
  await ctrlVPaste(domA, editorA, `<order id="${i}"><total>${i * 10}</total></order>`);
}
await appA.__flushHistorySaves();
const storedA = await loadWindowHistories(appA.__getTabId());
assert.equal(storedA.length, 2, 'both windows persisted their history');
assert.equal(
  storedA.find((record) => record.windowId === 'window-1').entries.length,
  10,
  'all 10 window-1 datasets persisted',
);
assert.equal(
  storedA.find((record) => record.windowId === 'window-2').entries.length,
  5,
  'all 5 window-2 datasets persisted',
);
const snapshot = snapshotStorage();

// A real refresh: brand-new page, same sessionStorage, shared storage layer.
const domB = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
for (const [key, value] of Object.entries(snapshot)) {
  domB.window.sessionStorage.setItem(key, value);
}
installGlobals(domB);
const appB = await import('./app.js?history-persist=2');
await appB.__historyHydrated();
await appB.__flushHistorySaves();
const docB = domB.window.document;
const editorB = docB.querySelector('#payloadInput');
const tabsB = () => [...docB.querySelectorAll('.window-tab')];
const backB = docB.querySelector('#historyBackBtn');
const forwardB = docB.querySelector('#historyForwardBtn');

assert.equal(tabsB().length, 2, 'both windows survive the refresh');
assert.ok(tabsB()[1].classList.contains('is-active'), 'window 2 was active');
assert.equal(
  editorB.value,
  '<order id="5"><total>50</total></order>',
  'window 2 shows its latest dataset after refresh',
);

// Walk window 2's whole history backwards, then forwards.
for (let i = 4; i >= 1; i -= 1) {
  backB.click();
  await sleep(30);
  assert.equal(
    editorB.value,
    `<order id="${i}"><total>${i * 10}</total></order>`,
    `window 2 back reaches dataset ${i}`,
  );
}
assert.equal(backB.disabled, true, 'window 2 back disables at the oldest dataset');
for (let i = 2; i <= 5; i += 1) {
  forwardB.click();
  await sleep(30);
  assert.equal(
    editorB.value,
    `<order id="${i}"><total>${i * 10}</total></order>`,
    `window 2 forward reaches dataset ${i}`,
  );
}

// Window 1's ten datasets are intact and isolated from window 2.
tabsB()[0].click();
await sleep(50);
assert.equal(editorB.value, '{"w1":10}', 'window 1 shows its latest dataset');
for (let i = 9; i >= 1; i -= 1) {
  backB.click();
  await sleep(30);
  assert.equal(editorB.value, `{"w1":${i}}`, `window 1 back reaches dataset ${i}`);
}
assert.equal(backB.disabled, true, 'window 1 back disables at the oldest dataset');
assert.ok(
  ![...Array(10)].some((_, i) => editorB.value.includes('<order')),
  'no window-2 data leaks into window 1',
);

// --- Boot: the history position survives a refresh ------------------------
__clearMemoryBackend();
const domC = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
installGlobals(domC);
const appC = await import('./app.js?history-persist=3');
await appC.__historyHydrated();
const docC = domC.window.document;
const editorC = docC.querySelector('#payloadInput');
for (const text of ['{"p":1}', '{"p":2}', '{"p":3}']) {
  await ctrlVPaste(domC, editorC, text);
}
docC.querySelector('#historyBackBtn').click(); // viewing {"p":2}
await sleep(50);
assert.equal(editorC.value, '{"p":2}');
await appC.__flushHistorySaves();
const snapshotC = snapshotStorage();

const domD = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
for (const [key, value] of Object.entries(snapshotC)) {
  domD.window.sessionStorage.setItem(key, value);
}
installGlobals(domD);
const appD = await import('./app.js?history-persist=4');
await appD.__historyHydrated();
const docD = domD.window.document;
const editorD = docD.querySelector('#payloadInput');
assert.equal(editorD.value, '{"p":2}', 'refresh restores the viewed history position');
const forwardD = docD.querySelector('#historyForwardBtn');
assert.equal(forwardD.disabled, false, 'forward is available from the restored position');
forwardD.click();
await sleep(30);
assert.equal(editorD.value, '{"p":3}', 'forward reaches the newer dataset after refresh');

// --- Boot: a paste during hydration wins over the stale load --------------
__clearMemoryBackend();
{
  const records = new Map();
  let releaseLoad;
  const gate = new Promise((resolve) => { releaseLoad = resolve; });
  const tabId = 'race-tab';
  records.set(`${tabId}:window-1`, {
    key: `${tabId}:window-1`,
    windowId: 'window-1',
    entries: ['{"stale":true}'],
    index: 0,
    updatedAt: Date.now(),
  });
  __useTestBackend({
    async loadAll() {
      const snap = [...records.values()].map((record) => ({ ...record }));
      await gate; // hydration stalls here
      return snap;
    },
    async save(tid, windowId, shot) {
      records.set(`${tid}:${windowId}`, {
        key: `${tid}:${windowId}`,
        windowId,
        entries: shot.entries,
        index: shot.index,
        updatedAt: Date.now(),
      });
    },
    async remove(tid, windowId) { records.delete(`${tid}:${windowId}`); },
    async cleanup() {},
  });
  try {
    const domE = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
    domE.window.sessionStorage.setItem('payload-formatter:tab-id', tabId);
    installGlobals(domE);
    const appE = await import('./app.js?history-persist=5');
    const docE = domE.window.document;
    const editorE = docE.querySelector('#payloadInput');
    await ctrlVPaste(domE, editorE, '{"fresh":true}'); // lands while hydration stalls
    releaseLoad();
    await appE.__historyHydrated();
    await appE.__flushHistorySaves();
    assert.equal(editorE.value, '{"fresh":true}', 'fresh paste is not clobbered by the stale load');
    const final = [...records.values()].find((record) => record.windowId === 'window-1');
    assert.deepEqual(final.entries, ['{"fresh":true}'], 'the newer in-memory state is re-saved');
  } finally {
    __useTestBackend(null);
  }
}
__clearMemoryBackend();

// --- Boot: closing a window deletes its persisted history ------------------
{
  const domF = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
  installGlobals(domF);
  const appF = await import('./app.js?history-persist=6');
  await appF.__historyHydrated();
  const docF = domF.window.document;
  const editorF = docF.querySelector('#payloadInput');
  await ctrlVPaste(domF, editorF, '{"gone":1}');
  docF.querySelector('#newWindowBtn').click();
  await sleep(50);
  const tabsF = () => [...docF.querySelectorAll('.window-tab')];
  const doomedId = tabsF()[0].dataset.windowId;
  await ctrlVPaste(domF, editorF, '{"stays":2}');
  await appF.__flushHistorySaves();
  tabsF()[0].querySelector('.window-tab-close').click();
  await sleep(50);
  assert.equal(tabsF().length, 1, 'window closed');
  const remaining = await loadWindowHistories(appF.__getTabId());
  assert.ok(
    !remaining.some((record) => record.windowId === doomedId),
    'closed window history is deleted from storage',
  );
  assert.ok(
    remaining.some((record) => record.entries.includes('{"stays":2}')),
    'surviving window history is untouched',
  );
}
__clearMemoryBackend();

// --- Boot: storage failure mid-session never breaks the app ----------------
{
  const domG = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
  installGlobals(domG);
  const appG = await import('./app.js?history-persist=7');
  await appG.__historyHydrated();
  __useTestBackend({
    loadAll: async () => { throw new Error('denied'); },
    save: async () => { throw new Error('denied'); },
    remove: async () => { throw new Error('denied'); },
    cleanup: async () => { throw new Error('denied'); },
  });
  try {
    const docG = domG.window.document;
    const editorG = docG.querySelector('#payloadInput');
    await ctrlVPaste(domG, editorG, '{"a":1}');
    await ctrlVPaste(domG, editorG, '{"b":2}');
    await appG.__flushHistorySaves();
    assert.equal(editorG.value, '{"b":2}', 'pasting still works when storage fails');
    docG.querySelector('#historyBackBtn').click();
    await sleep(30);
    assert.equal(editorG.value, '{"a":1}', 'in-session history still works when storage fails');
  } finally {
    __useTestBackend(null);
  }
}
__clearMemoryBackend();

// --- Boot: fast window switch keeps the debounced history update --------
// Regression for the SDET-found race: typing in Window 1 then switching to
// Window 2 inside the 250ms debounce used to fire the update against Window
// 2's history, leaving Window 1's history stale (typing updates the current
// entry rather than pushing, so the check is Back/Forward content).
{
  const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
  installGlobals(dom);
  const app = await import('./app.js?history-persist=8');
  await app.__historyHydrated();
  const doc = dom.window.document;
  const editor = doc.querySelector('#payloadInput');

  await ctrlVPaste(dom, editor, '{"a":1}');
  await ctrlVPaste(dom, editor, '{"b":2}');
  editor.value = '{"b":2,"typed":true}';
  editor.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await sleep(50); // switch well inside the 250ms debounce
  doc.querySelector('#newWindowBtn').click();
  await sleep(400);
  await app.__flushHistorySaves();

  const tabs = [...doc.querySelectorAll('.window-tab')];
  const w2Id = tabs[1].dataset.windowId;
  tabs[0].click();
  await sleep(50);
  const back = doc.querySelector('#historyBackBtn');
  const forward = doc.querySelector('#historyForwardBtn');
  assert.equal(back.disabled, false, 'history survives the fast switch');
  back.click();
  await sleep(50);
  assert.equal(editor.value, '{"a":1}', 'back reaches the first payload');
  forward.click();
  await sleep(50);
  assert.equal(
    editor.value,
    '{"b":2,"typed":true}',
    'forward reaches the typed text: the debounce updated Window 1, not Window 2',
  );

  // And Window 2's persisted history was never polluted by Window 1's typing.
  const records = await loadWindowHistories(app.__getTabId());
  const w2 = records.find((record) => record.windowId === w2Id);
  assert.ok(
    !w2 || !w2.entries.some((entry) => entry.includes('typed')),
    "Window 2's history is untouched by Window 1's typing",
  );
}
__clearMemoryBackend();

console.log('All history persistence tests passed.');
