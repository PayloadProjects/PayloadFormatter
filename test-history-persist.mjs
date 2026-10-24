import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createPayloadHistory } from './payload-history.js';
import {
  saveEntry,
  loadEntry,
  deleteEntries,
  saveWindowHistory,
  loadWindowHistories,
  deleteWindowHistory,
  cleanupStaleHistories,
  enforceStorageBudget,
  touchTabHeartbeat,
  __useTestBackend,
  __clearMemoryBackend,
  __memoryBackend,
} from './history-store.js';

// A window record lists entry ids; this reads the payload texts back.
async function entryTexts(record) {
  return Promise.all(record.entries.map((entry) => (entry.chars ? loadEntry(entry.id) : '')));
}

// A backend that throws on every call (storage denied / broken).
const failingBackend = () => {
  const deny = async () => { throw new Error('denied'); };
  return {
    putMeta: deny, getMetas: deny, deleteMeta: deny,
    putEntry: deny, getEntry: deny, deleteEntry: deny, listEntries: deny,
  };
};

// Persistent per-window paste history: every dataset pasted into every
// window must survive a refresh and stay navigable with Back/Forward.

// --- Model: serialization -----------------------------------------------
{
  const history = createPayloadHistory();
  history.push('{"a":1}');
  history.push('{"b":2}');
  history.back();
  const snapshot = history.toJSON();
  assert.deepEqual(snapshot.entries.map((entry) => entry.chars), [7, 7], 'snapshot lists entry sizes');
  assert.ok(snapshot.entries.every((entry) => typeof entry.id === 'string' && entry.id), 'snapshot lists entry ids');
  assert.ok(!('text' in snapshot.entries[0]), 'snapshot never carries payload text');
  assert.equal(snapshot.index, 0);

  const revived = createPayloadHistory();
  assert.equal(revived.restore(snapshot), true, 'restore accepts a snapshot');
  assert.equal(revived.size(), 2);
  assert.equal(revived.current(), null, 'restored entries start released (text loads on demand)');
  const next = revived.forward();
  assert.equal(next.id, snapshot.entries[1].id, 'restored position navigates forward');
  assert.equal(revived.back().id, snapshot.entries[0].id);
  assert.equal(revived.back(), null, 'no phantom entries past the start');

  const legacy = createPayloadHistory();
  legacy.restore({ entries: ['{"a":1}', '{"b":2}'], index: 0 });
  assert.equal(legacy.current(), '{"a":1}', 'legacy text snapshots restore as resident text');
  assert.equal(legacy.forward().text, '{"b":2}');

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
  const small = (entry) => entry.chars <= 4;
  const texts = (snapshot) => ({ entries: snapshot.entries.map((entry) => entry.text), index: snapshot.index });
  const history = createPayloadHistory();
  history.push('aa');
  history.push('bbbbbbbb');
  history.push('cc');
  // Index sits on 'cc' (position 2).
  assert.deepEqual(texts(history.toPersistable(small)), {
    entries: ['aa', 'cc'],
    index: 1,
  }, 'oversize middle entry dropped, index remapped');

  history.back(); // now on 'aa' (position 0)
  history.back(); // stays: nearest non-empty backwards is none
  const history2 = createPayloadHistory();
  history2.push('aa');
  history2.push('bbbbbbbb');
  history2.back();
  assert.deepEqual(texts(history2.toPersistable(small)), {
    entries: ['aa'],
    index: 0,
  }, 'index on a surviving entry keeps its remapped position');

  const history3 = createPayloadHistory();
  history3.push('bbbbbbbb');
  history3.push('cc');
  history3.back(); // index on the oversize entry
  assert.deepEqual(texts(history3.toPersistable(small)), {
    entries: ['cc'],
    index: 0,
  }, 'index on a dropped entry lands on the nearest earlier survivor');

  const history4 = createPayloadHistory();
  history4.push('bbbbbbbb');
  assert.deepEqual(texts(history4.toPersistable(small)), {
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
  assert.equal(await saveEntry('tab-a', 'window-1', 'e-a', 'a'), true);
  assert.equal(await saveEntry('tab-a', 'window-1', 'e-b', 'b'), true);
  assert.equal(await saveWindowHistory('tab-a', 'window-1', {
    entries: [{ id: 'e-a', chars: 1 }, { id: 'e-b', chars: 1 }], index: 1,
  }), true);
  await saveEntry('tab-a', 'window-2', 'e-x', '<x/>');
  assert.equal(await saveWindowHistory('tab-a', 'window-2', { entries: [{ id: 'e-x', chars: 4 }], index: 0 }), true);
  await saveEntry('tab-b', 'window-1', 'e-other', 'other-tab');
  await saveWindowHistory('tab-b', 'window-1', { entries: [{ id: 'e-other', chars: 9 }], index: 0 });

  const records = await loadWindowHistories('tab-a');
  assert.equal(records.length, 2, 'both windows load');
  assert.ok(records.every((record) => record.entries.every((entry) => !('text' in entry))),
    'loading a window reads only its entry list, never payload text');
  assert.ok(!records.some((record) => record.entries.some((entry) => entry.id === 'e-other')), 'tabs are isolated');
  assert.equal(await loadEntry('e-b'), 'b', 'an entry loads on demand');

  await deleteWindowHistory('tab-a', 'window-1');
  const after = await loadWindowHistories('tab-a');
  assert.equal(after.length, 1, 'deleted window history is gone');
  assert.equal(after[0].windowId, 'window-2');
  assert.equal(await loadEntry('e-a'), null, "a closed window's payloads are deleted too");
  assert.equal(await loadEntry('e-x'), '<x/>', "other windows' payloads are untouched");

  await deleteEntries(['e-x']);
  assert.equal(await loadEntry('e-x'), null, 'deleteEntries removes payloads');
}
__clearMemoryBackend();

// --- Store: large payloads are compressed, written once ------------------
{
  const big = JSON.stringify({ rows: Array.from({ length: 20000 }, (_, i) => ({ id: i, name: `user${i}` })) });
  assert.equal(await saveEntry('gz-tab', 'w1', 'gz-1', big), true);
  const [summary] = await __memoryBackend().listEntries();
  assert.ok(summary.size < big.length / 4, `large payload stored compressed (${summary.size} of ${big.length} chars)`);
  assert.equal(await loadEntry('gz-1'), big, 'compressed payload round-trips byte-for-byte');
  const unicode = `{"text":"${'日本語 ✓ '.repeat(5000)}"}`;
  await saveEntry('gz-tab', 'w1', 'gz-2', unicode);
  assert.equal(await loadEntry('gz-2'), unicode, 'non-ASCII payload round-trips through gzip');
}
__clearMemoryBackend();

// --- Store: the size budget evicts the oldest payloads, never protected ones
{
  const blob = (seed) => Array.from({ length: 3000 }, (_, i) => `${seed}-${(i * 7919) % 104729}`).join(',');
  for (let i = 0; i < 6; i += 1) {
    await saveEntry('budget-tab', 'w1', `b-${i}`, blob(i));
    await new Promise((resolve) => setTimeout(resolve, 5)); // distinct createdAt
  }
  const sizes = await __memoryBackend().listEntries();
  const total = sizes.reduce((sum, entry) => sum + entry.size, 0);
  const evicted = await enforceStorageBudget({ maxBytes: Math.floor(total / 2), protect: ['b-0'] });
  assert.ok(evicted >= 3, `over budget: evicted ${evicted} oldest payloads`);
  assert.notEqual(await loadEntry('b-0'), null, 'a protected (on-screen) payload is never evicted');
  assert.equal(await loadEntry('b-1'), null, 'the oldest unprotected payload goes first');
  assert.notEqual(await loadEntry('b-5'), null, 'the newest payload survives');
  assert.equal(await enforceStorageBudget({ maxBytes: total * 10 }), 0, 'under budget: nothing evicted');
}
__clearMemoryBackend();

// --- Store: closed tabs' leftovers are swept, open tabs are kept ----------
{
  const day = 24 * 3600 * 1000;
  const store = __memoryBackend();
  const old = Date.now() - 2 * day;
  await store.putMeta({ key: 'closed-tab:w1', tabId: 'closed-tab', windowId: 'w1', entries: [{ id: 'c-1', chars: 3 }], index: 0, updatedAt: old });
  await store.putEntry({ id: 'c-1', tabId: 'closed-tab', owner: 'closed-tab:w1', data: 'abc', encoding: 'text', size: 3, createdAt: old });
  // Same age, but its heartbeat says it is still open (e.g. a background tab).
  await store.putMeta({ key: 'open-tab:w1', tabId: 'open-tab', windowId: 'w1', entries: [{ id: 'o-1', chars: 3 }], index: 0, updatedAt: old });
  await store.putEntry({ id: 'o-1', tabId: 'open-tab', owner: 'open-tab:w1', data: 'def', encoding: 'text', size: 3, createdAt: old });
  // An entry no window lists any more (a lost write), long enough ago.
  await store.putEntry({ id: 'orphan', tabId: 'open-tab', owner: 'open-tab:w9', data: 'zzz', encoding: 'text', size: 3, createdAt: old });
  // Legacy v1 record: no tabId field, text inline, long stale.
  await store.putMeta({ key: 'legacy-tab:window-1', windowId: 'window-1', entries: ['old'], index: 0, updatedAt: old });
  const { JSDOM: StorageDom } = await import('jsdom');
  const storageDom = new StorageDom('', { url: 'http://localhost/' });
  globalThis.localStorage = storageDom.window.localStorage;
  touchTabHeartbeat('open-tab');

  await cleanupStaleHistories({ tabId: 'current-tab' });
  const metas = (await store.getMetas()).map((meta) => meta.key);
  assert.ok(!metas.includes('closed-tab:w1'), "a closed tab's window list is swept");
  assert.equal(await loadEntry('c-1'), null, "a closed tab's payloads are swept");
  assert.ok(metas.includes('open-tab:w1'), 'a tab with a fresh heartbeat keeps its history');
  assert.equal(await loadEntry('o-1'), 'def', "an open tab's payloads are kept");
  assert.equal(await loadEntry('orphan'), null, 'payloads no window lists are swept');
  assert.ok(!metas.includes('legacy-tab:window-1'), 'stale legacy records are swept too');
  delete globalThis.localStorage;
}
__clearMemoryBackend();

// --- Store: a failing backend degrades instead of throwing ----------------
{
  __useTestBackend(failingBackend());
  try {
    assert.equal(
      await saveWindowHistory('tab-a', 'window-1', { entries: [{ id: 'x', chars: 1 }], index: 0 }),
      false,
      'failed save reports false',
    );
    assert.equal(await saveEntry('tab-a', 'window-1', 'x', 'a'), false, 'failed entry save reports false');
    assert.equal(await loadEntry('x'), null, 'failed entry load yields null');
    assert.deepEqual(await loadWindowHistories('tab-a'), [], 'failed load yields no records');
    await deleteWindowHistory('tab-a', 'window-1'); // must not throw
    await deleteEntries(['x']); // must not throw
    await cleanupStaleHistories({ tabId: 'tab-a' }); // must not throw
    assert.equal(await enforceStorageBudget(), 0, 'failed budget check evicts nothing');
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
  let releaseLoad;
  const gate = new Promise((resolve) => { releaseLoad = resolve; });
  const tabId = 'race-tab';
  const memory = __memoryBackend();
  await saveEntry(tabId, 'window-1', 'stale-1', '{"stale":true}');
  await saveWindowHistory(tabId, 'window-1', { entries: [{ id: 'stale-1', chars: 14 }], index: 0 });
  let stalled = false;
  __useTestBackend({
    ...memory,
    async getMetas() {
      const snap = (await memory.getMetas()).map((record) => ({ ...record }));
      if (!stalled) {
        stalled = true;
        await gate; // hydration stalls here
      }
      return snap;
    },
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
    const [final] = await loadWindowHistories(tabId);
    assert.deepEqual(await entryTexts(final), ['{"fresh":true}'], 'the newer in-memory state is re-saved');
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
  const remainingTexts = (await Promise.all(remaining.map(entryTexts))).flat();
  assert.ok(remainingTexts.includes('{"stays":2}'), 'surviving window history is untouched');
}
__clearMemoryBackend();

// --- Boot: storage failure mid-session never breaks the app ----------------
{
  const domG = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
  installGlobals(domG);
  const appG = await import('./app.js?history-persist=7');
  await appG.__historyHydrated();
  __useTestBackend(failingBackend());
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
  assert.equal(editor.value, '{"b":2}', 'back steps to the pre-edit entry');
  back.click();
  await sleep(50);
  assert.equal(editor.value, '{"a":1}', 'back again reaches the first payload');
  forward.click();
  await sleep(50);
  assert.equal(editor.value, '{"b":2}', 'forward steps back through the edits');
  forward.click();
  await sleep(50);
  assert.equal(
    editor.value,
    '{"b":2,"typed":true}',
    'forward reaches the typed text: the debounce pushed to Window 1, not Window 2',
  );

  // And Window 2's persisted history was never polluted by Window 1's typing.
  const records = await loadWindowHistories(app.__getTabId());
  const w2 = records.find((record) => record.windowId === w2Id);
  assert.ok(
    !w2 || !(await entryTexts(w2)).some((entry) => entry?.includes('typed')),
    "Window 2's history is untouched by Window 1's typing",
  );
}
// --- Phase 3: large entries persist as Blobs, quota failure degrades --------
{
  // A 3MB entry (over the 2MB Blob threshold) round-trips through the real
  // memory backend as an identical string.
  const big = `{"blob":true,"pad":"${'z'.repeat(3 * 1024 * 1024)}"}`;
  assert.equal(await saveEntry('blob-tab', 'w1', 'big-1', big), true);
  const loaded = await loadEntry('big-1');
  assert.equal(typeof loaded, 'string', 'entries come back as strings, never Blobs');
  assert.equal(loaded, big, '3MB entry survives the compressed round-trip byte-for-byte');
  await deleteWindowHistory('blob-tab', 'w1');

  // Quota failure: the save reports false, nothing throws, the app is fine.
  const quota = async () => {
    const error = new Error('Quota exceeded');
    error.name = 'QuotaExceededError';
    throw error;
  };
  __useTestBackend({ ...__memoryBackend(), putMeta: quota, putEntry: quota, getMetas: async () => [] });
  assert.equal(
    await saveWindowHistory('quota-tab', 'w1', { entries: [{ id: 'x', chars: 1 }], index: 0 }),
    false,
    'QuotaExceededError degrades to false instead of throwing',
  );
  assert.equal(await saveEntry('quota-tab', 'w1', 'x', 'x'), false, 'entry quota failure degrades to false');
  assert.deepEqual(await loadWindowHistories('quota-tab'), [], 'failed backend loads nothing');
  __useTestBackend(null);
}

// --- Phase 3: a 5MB payload survives a refresh via history -----------------
{
  __clearMemoryBackend();
  const domA = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
  installGlobals(domA);
  const appA = await import('./app.js?history-persist=9');
  await appA.__historyHydrated();
  const editorA = domA.window.document.querySelector('#payloadInput');

  const five = JSON.stringify({ restored: true, pad: 'y'.repeat(5 * 1024 * 1024) });
  await ctrlVPaste(domA, editorA, five);
  await appA.__flushHistorySaves();
  const stored = await loadWindowHistories(appA.__getTabId());
  assert.equal(stored.length, 1, 'window history persisted');
  assert.ok(
    stored[0].entries.some((entry) => entry.chars > 4 * 1024 * 1024),
    'the 5MB entry persisted (above the old 2MB cutoff)',
  );
  const snapshot = snapshotStorage();

  // Real refresh: new page, same sessionStorage. The 5MB draft was never
  // saved (2MB sessionStorage rule), so restoration must come from history.
  const domB = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
  for (const [key, value] of Object.entries(snapshot)) {
    domB.window.sessionStorage.setItem(key, value);
  }
  installGlobals(domB);
  const appB = await import('./app.js?history-persist=10');
  await appB.__historyHydrated();
  const editorB = domB.window.document.querySelector('#payloadInput');
  assert.equal(editorB.value, five, '5MB payload seeded into the editor from persisted history');
  assert.equal(editorB.readOnly, false, 'restored 5MB payload stays editable');
}

// --- Persistent storage is requested in context, never at boot ------------
{
  const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
  installGlobals(dom);
  let persistCalls = 0;
  Object.defineProperty(dom.window.navigator, 'storage', {
    value: { persist: () => { persistCalls += 1; return Promise.resolve(true); } },
    configurable: true,
  });
  const app = await import('./app.js?history-persist=11');
  await app.__historyHydrated();
  assert.equal(persistCalls, 0, 'boot never asks for persistent storage');
  const editor = dom.window.document.querySelector('#payloadInput');

  await ctrlVPaste(dom, editor, '{"small":1}');
  await app.__flushHistorySaves();
  assert.equal(persistCalls, 0, 'small payloads never trigger the request');

  const big = 'x'.repeat(3 * 1024 * 1024);
  await ctrlVPaste(dom, editor, big);
  await app.__flushHistorySaves();
  assert.equal(persistCalls, 1, 'first large persist requests persistent storage');

  await ctrlVPaste(dom, editor, `${big}y`);
  await app.__flushHistorySaves();
  assert.equal(persistCalls, 1, 'requested only once per session');
}
__clearMemoryBackend();

// --- Memory: only what is on screen stays resident -------------------------
// The reported workload: many windows, each pasted and cleared repeatedly.
// Saved history must live in storage, not memory, and still be navigable.
{
  const payload = (w, i) => JSON.stringify({ w, i, pad: `${w}-${i}-`.repeat(40_000) });
  const size = payload(1, 1).length;
  const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
  installGlobals(dom);
  const app = await import('./app.js?history-persist=12');
  await app.__historyHydrated();
  const doc = dom.window.document;
  const editor = doc.querySelector('#payloadInput');
  const tabs = () => [...doc.querySelectorAll('.window-tab')];

  for (let w = 1; w <= 3; w += 1) {
    if (w > 1) {
      doc.querySelector('#newWindowBtn').click();
      await sleep(50);
    }
    for (let i = 1; i <= 3; i += 1) {
      await ctrlVPaste(dom, editor, payload(w, i));
      doc.querySelector('#clearBtn').click();
      await sleep(20);
    }
  }
  await app.__flushHistorySaves();
  // Every window's current entry is the empty clear state: nothing on
  // screen needs text, so all nine payloads live only in storage.
  assert.ok(
    app.__residentHistoryChars() < size,
    `cleared payloads are freed from memory (${app.__residentHistoryChars()} chars resident)`,
  );

  // Back loads the released payload from storage.
  doc.querySelector('#historyBackBtn').click();
  await sleep(100);
  assert.equal(editor.value, payload(3, 3), 'Back restores a cleared payload from storage');
  doc.querySelector('#historyBackBtn').click();
  await sleep(100);
  assert.equal(editor.value, payload(3, 2), 'Back keeps walking stored payloads');
  await app.__flushHistorySaves();
  assert.ok(
    app.__residentHistoryChars() <= size + 100,
    `only the payload on screen stays in memory (${app.__residentHistoryChars()} chars)`,
  );

  // A window that is neither active nor recent loads from storage.
  tabs()[0].click();
  await sleep(100);
  doc.querySelector('#historyBackBtn').click();
  await sleep(100);
  assert.equal(editor.value, payload(1, 3), "an inactive window's history loads on demand");
  await app.__flushHistorySaves();
  assert.ok(
    app.__residentHistoryChars() <= 2 * size + 200,
    `switching windows keeps at most the recent window resident (${app.__residentHistoryChars()} chars)`,
  );
  const snapshot = snapshotStorage();

  // Refresh: only the active window's payload is read back into memory.
  const domR = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
  for (const [key, value] of Object.entries(snapshot)) domR.window.sessionStorage.setItem(key, value);
  installGlobals(domR);
  const appR = await import('./app.js?history-persist=13');
  await appR.__historyHydrated();
  const docR = domR.window.document;
  const editorR = docR.querySelector('#payloadInput');
  assert.equal(editorR.value, payload(1, 3), 'refresh restores the active window');
  assert.ok(
    appR.__residentHistoryChars() <= size + 100,
    `refresh loads only the visible payload (${appR.__residentHistoryChars()} chars)`,
  );
  const tabsR = [...docR.querySelectorAll('.window-tab')];
  tabsR[1].click();
  await sleep(100);
  docR.querySelector('#historyBackBtn').click();
  await sleep(100);
  assert.equal(editorR.value, payload(2, 3), "other windows' history is intact after refresh");
}
__clearMemoryBackend();

// --- Format saves the formatted payload (it used to wait for the next paste)
{
  const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
  installGlobals(dom);
  const app = await import('./app.js?history-persist=14');
  await app.__historyHydrated();
  const source = await readFile(new URL('app.js', import.meta.url), 'utf8');
  const format = source.match(/async function formatCurrentPayload[\s\S]*?\n}/)?.[0];
  assert.match(format, /history\.updateCurrent\(getPayloadText\(\)\)\) \{\s*syncHistoryNav\(\);\s*saveHistoryFor\(activeWindow\);/,
    'formatting saves the rewritten entry right away');
}
__clearMemoryBackend();

// --- An entry evicted from storage is skipped, not shown blank -------------
{
  const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
  installGlobals(dom);
  const app = await import('./app.js?history-persist=15');
  await app.__historyHydrated();
  const doc = dom.window.document;
  const editor = doc.querySelector('#payloadInput');
  for (const text of ['{"keep":1}', '{"evicted":2}', '{"now":3}']) await ctrlVPaste(dom, editor, text);
  await app.__flushHistorySaves();
  const [record] = await loadWindowHistories(app.__getTabId());
  // Simulate the storage budget evicting the middle payload.
  await deleteEntries([record.entries[1].id]);
  // Release everything so Back has to go to storage.
  for (const text of ['{"later":4}']) await ctrlVPaste(dom, editor, text);
  await app.__flushHistorySaves();
  doc.querySelector('#historyBackBtn').click();
  await sleep(50);
  assert.equal(editor.value, '{"now":3}');
  doc.querySelector('#historyBackBtn').click();
  await sleep(100);
  assert.equal(editor.value, '{"keep":1}', 'Back skips a payload that was evicted from storage');
}
__clearMemoryBackend();

console.log('All history persistence tests passed.');
