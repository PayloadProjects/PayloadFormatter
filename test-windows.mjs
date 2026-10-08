import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createWindowManager, MAX_WINDOWS } from './window-manager.js';

const [html, css, app, build, pkg] = await Promise.all(
  ['index.html', 'style.css', 'app.js', 'build.mjs', 'package.json']
    .map((file) => readFile(new URL(file, import.meta.url), 'utf8')),
);

// --- Model: creation, naming, and identity ---
{
  const manager = createWindowManager();
  const first = manager.newWindow();
  const second = manager.newWindow('Custom');
  const third = manager.newWindow('  ');
  assert.equal(first.name, 'Window 1');
  assert.equal(second.name, 'Custom');
  assert.equal(third.name, 'Window 3', 'blank names fall back to the numbered default');
  assert.notEqual(first.id, second.id, 'ids are unique');
  assert.equal(manager.size, 3);
  assert.equal(manager.getActive().id, first.id, 'the first window starts active');
  assert.ok(manager.setActive(second.id));
  assert.equal(manager.getActive().id, second.id);
  assert.equal(manager.setActive('nope'), false, 'unknown id is rejected');
  assert.equal(manager.getActive().id, second.id, 'active is unchanged on rejection');
}

// --- Model: renaming ---
{
  const manager = createWindowManager();
  const win = manager.newWindow();
  assert.equal(manager.renameWindow(win.id, 'Orders API'), true);
  assert.equal(win.name, 'Orders API');
  assert.equal(manager.renameWindow(win.id, 'Orders API'), false, 'same name is a no-op');
  assert.equal(manager.renameWindow(win.id, '   '), false, 'blank rename is ignored');
  assert.equal(win.name, 'Orders API', 'blank rename keeps the old name');
  assert.equal(manager.renameWindow('nope', 'X'), false);
  manager.renameWindow(win.id, 'x'.repeat(100));
  assert.equal(win.name.length, 40, 'names are capped');
}

// --- Model: closing, neighbour activation, last-window guard ---
{
  const manager = createWindowManager();
  const a = manager.newWindow();
  const b = manager.newWindow();
  const c = manager.newWindow();
  manager.setActive(b.id);

  let result = manager.closeWindow(b.id);
  assert.equal(result.closed, true);
  assert.equal(result.activateId, c.id, 'closing the active window moves to the next neighbour');
  manager.setActive(c.id);
  result = manager.closeWindow(c.id);
  assert.equal(result.activateId, a.id, 'no next neighbour: moves to the previous one');
  manager.setActive(a.id);
  result = manager.closeWindow(a.id);
  assert.equal(result.closed, false, 'the last window cannot be closed');
  assert.equal(manager.size, 1);

  // Closing an inactive window keeps the active one.
  const d = manager.newWindow();
  manager.setActive(a.id);
  result = manager.closeWindow(d.id);
  assert.equal(result.closed, true);
  assert.equal(result.activateId, a.id);
  assert.equal(manager.getActive().id, a.id);
  assert.equal(manager.closeWindow('nope'), null);
}

// --- Model: window cap ---
{
  const manager = createWindowManager();
  for (let i = 0; i < MAX_WINDOWS; i += 1) manager.newWindow();
  assert.equal(manager.newWindow(), null, 'no more windows past the cap');
  assert.equal(manager.size, MAX_WINDOWS);
}

// --- Model: numbering never reuses ids ---
{
  const manager = createWindowManager();
  const a = manager.newWindow();
  const b = manager.newWindow();
  manager.closeWindow(a.id);
  const c = manager.newWindow();
  assert.notEqual(c.id, a.id, 'closed ids are not recycled');
  assert.notEqual(c.id, b.id);
}

// --- Model: each window owns an independent paste history ---
{
  const manager = createWindowManager();
  const a = manager.newWindow('', '{"a":1}');
  const b = manager.newWindow('', '{"b":2}');
  assert.equal(a.history.current(), '{"a":1}');
  assert.equal(b.history.current(), '{"b":2}');
  b.history.push('{"b":3}');
  assert.equal(a.history.size(), 1, 'histories do not leak across windows');
  assert.equal(a.history.back(), null);
}

// --- Model: reordering windows ---
{
  const manager = createWindowManager();
  const a = manager.newWindow('A');
  const b = manager.newWindow('B');
  const c = manager.newWindow('C');
  const d = manager.newWindow('D');
  const names = () => manager.windows.map((win) => win.name);

  assert.equal(manager.moveWindow(c.id, 0), true);
  assert.deepEqual(names(), ['C', 'A', 'B', 'D'], 'moves a middle window to the front');

  assert.equal(manager.moveWindow(a.id, 3), true);
  assert.deepEqual(names(), ['C', 'B', 'D', 'A'], 'moves a window to the end');

  assert.equal(manager.moveWindow('nope', 0), false, 'unknown id is a no-op');
  assert.equal(manager.moveWindow(b.id, 1), false, 'dropping in place is a no-op');

  assert.equal(manager.moveWindow(d.id, 99), true, 'an overshooting index clamps to the end');
  assert.deepEqual(names(), ['C', 'B', 'A', 'D']);
  assert.equal(manager.moveWindow(c.id, -5), false, 'a negative index clamps to the front (already there)');

  // The two-tab swap: index math must account for the removal shift.
  const pair = createWindowManager();
  const w1 = pair.newWindow('W1');
  pair.newWindow('W2');
  assert.equal(pair.moveWindow(w1.id, 1), true);
  assert.deepEqual(pair.windows.map((win) => win.name), ['W2', 'W1'], 'two tabs swap');

  // toJSON preserves the new order, so it persists and restores.
  assert.deepEqual(manager.toJSON().windows.map((win) => win.name), ['C', 'B', 'A', 'D'],
    'serialization keeps the reordered list');
}

// --- Model: per-window UI state (scroll/cursor/expansion snapshots) ---
{
  const manager = createWindowManager();
  const win = manager.newWindow('A', '{"a":1}');
  assert.deepEqual(win.ui, {
    text: { scrollTop: 0, scrollLeft: 0, selStart: 0, selEnd: 0 },
    tree: { scrollTop: 0, openPaths: [] },
  }, 'new windows start with zeroed UI state');
  win.ui.text.scrollTop = 456;
  win.ui.tree.openPaths.push([0]);

  const json = manager.toJSON();
  assert.ok(!('ui' in json.windows[0]), 'UI state is ephemeral, never serialized');

  const revived = createWindowManager();
  const back = revived.restoreWindow(win.id, win.name, '{"a":1}');
  assert.deepEqual(back.ui.text.scrollTop, 0, 'restored windows start with fresh UI state');
}

// --- Model: metadata serialization round-trip ---
{
  const manager = createWindowManager();
  const a = manager.newWindow('First', '{"a":1}');
  manager.newWindow('Second');
  manager.setActive(a.id);
  manager.setCounter(7);
  const json = manager.toJSON();
  assert.deepEqual(json.windows, [
    { id: a.id, name: 'First' },
    { id: 'window-2', name: 'Second' },
  ]);
  assert.equal(json.activeId, a.id);
  assert.equal(json.counter, 7);
  assert.ok(!JSON.stringify(json).includes('{"a":1}'), 'payloads stay out of the metadata');

  const restored = createWindowManager();
  restored.setCounter(json.counter);
  for (const item of json.windows) restored.restoreWindow(item.id, item.name, '{"a":1}');
  restored.setActive(json.activeId);
  assert.equal(restored.size, 2);
  assert.equal(restored.getActive().name, 'First');
  assert.equal(restored.getActive().history.current(), '{"a":1}', 'restored payload seeds history');
  const next = restored.newWindow();
  assert.equal(next.id, 'window-8', 'counter survives the round-trip');
}

// --- Wiring: window bar markup ---
{
  const bar = html.match(/<div id="editorFrame"[^>]*>\s*<div class="window-bar">([\s\S]*?)<\/div>\s*<div class="editor-strip"/)?.[1];
  assert.ok(bar, 'window bar is the first thing in the editor card, directly above the editor strip');
  assert.ok(bar.includes('id="windowTabs"'), 'tab container exists');
  assert.ok(bar.includes('role="tablist"'), 'tabs expose the tablist role');
  assert.ok(bar.includes('id="newWindowBtn"'), 'new-window button exists');
}

// --- Wiring: app.js drives windows ---
{
  assert.ok(app.includes("from './window-manager.js'"), 'app.js imports the window manager');
  assert.ok(app.includes('restoreWindows()'), 'windows restore at startup');
  assert.ok(!app.includes('restoreDraft()'), 'legacy single-draft restore is gone');
  assert.ok(!app.includes('function initializeHistory('), 'global history init is replaced by per-window seeding');
  assert.ok(app.includes('function activateWindow('), 'window switching exists');
  assert.ok(app.includes('function createNewWindow('), 'window creation exists');
  assert.ok(app.includes('function closeWindowById('), 'window closing exists');
  assert.ok(app.includes('function renderWindowBar('), 'tab bar rendering exists');
  assert.ok(app.includes('function startRename('), 'tab renaming exists');
  assert.ok(app.includes('WINDOW_DRAFT_PREFIX'), 'drafts are namespaced per window');
  assert.ok(app.includes('payload-formatter:windows:v1'), 'window list is persisted');
  assert.ok(app.includes('STORAGE_KEY'), 'legacy draft key is still migrated');
  const restore = app.match(/function restoreWindows\(\) \{([\s\S]*?)\n\}\n\nfunction persistWindowList/)?.[1];
  assert.ok(restore && !restore.includes('removeItem(STORAGE_KEY)'),
    'the first-run migration never deletes the legacy key');
  assert.ok(app.includes('setPayloadText(next.payload'), 'switching swaps the payload');
  assert.ok(app.includes('dblclick'), 'rename starts on double-click');
}

// --- Wiring: tab reordering ---
{
  assert.ok(app.includes('moveWindow('), 'app.js calls the window-manager reorder');
  assert.ok(app.includes('tab.draggable = true'), 'tabs are draggable');
  for (const type of ['dragstart', 'dragover', 'dragleave', 'drop', 'dragend']) {
    assert.ok(app.includes(`addEventListener('${type}'`), `tab ${type} is handled`);
  }
  assert.ok(app.includes("'ArrowLeft'") && app.includes('altKey'),
    'Alt+Arrow keyboard reorder exists for non-mouse users');
  assert.ok(app.includes('window-rename-input') && app.includes('A rename in progress owns the tab'),
    'a drag starting mid-rename is cancelled');
  assert.match(css, /\.tab-drop-indicator \{[^}]*position: absolute;/,
    'the drop insertion line is absolutely positioned');
  assert.match(css, /\.window-tab\.is-dragging \{[^}]*opacity: 0\.35;/,
    'the dragged tab has a faded visual state');
  assert.match(css, /\.window-bar \{[^}]*position: relative;/,
    'the window bar anchors the drop indicator');
}
{
  assert.ok(css.includes('.window-bar'), 'window bar styles exist');
  assert.ok(css.includes('.window-tab.is-active'), 'active tab is styled');
  assert.ok(css.includes('.window-rename-input'), 'rename input is styled');
  assert.ok(/\.window-tabs \{[^}]*flex: 0 1 auto;/.test(css),
    'tab strip hugs its tabs so the new-window button sits right after them');
  assert.ok(build.includes("'window-manager.js'"), 'deploy bundle ships the window manager');
  const scripts = JSON.parse(pkg).scripts;
  assert.ok(scripts.test.includes('test-windows.mjs'), 'suite runs the window tests');
}

// --- DOM: drag-and-drop reorders tabs, keyboard moves too ---
{
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
  dom.window.Element.prototype.scrollIntoView = function () {};

  await import('./app.js?tab-reorder=1');
  const doc = dom.window.document;
  const tabIds = () => [...doc.querySelectorAll('.window-tab')].map((tab) => tab.dataset.windowId);

  // Three windows to reorder.
  doc.querySelector('#newWindowBtn').click();
  doc.querySelector('#newWindowBtn').click();
  assert.deepEqual(tabIds(), ['window-1', 'window-2', 'window-3'], 'three windows created');

  // Stub layout: tabs sit left to right, 100px each, so the drop insertion
  // math is exact (jsdom reports zero rects otherwise).
  const stubRects = () => {
    [...doc.querySelectorAll('.window-tab')].forEach((tab, i) => {
      tab.getBoundingClientRect = () => ({
        left: i * 100, right: (i + 1) * 100, width: 100,
        top: 0, bottom: 28, height: 28, x: i * 100, y: 0, toJSON: () => ({}),
      });
    });
  };
  stubRects();

  const mockTransfer = () => ({ setData() {}, getData: () => '', effectAllowed: '', dropEffect: '' });
  function dragEvent(type, target, clientX = 0) {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    event.dataTransfer = mockTransfer();
    event.clientX = clientX;
    target.dispatchEvent(event);
    return event;
  }
  const tabsEl = doc.querySelector('#windowTabs');
  const indicator = doc.querySelector('.tab-drop-indicator');
  assert.ok(indicator, 'drop indicator exists');

  // Drag window-1 past the end (clientX past the last midpoint) and drop.
  const first = doc.querySelector('.window-tab');
  dragEvent('dragstart', first);
  assert.ok(first.classList.contains('is-dragging'), 'dragged tab is marked');
  dragEvent('dragover', tabsEl, 350);
  assert.equal(indicator.hidden, false, 'drop indicator appears while dragging');
  dragEvent('drop', tabsEl, 350);
  assert.deepEqual(tabIds(), ['window-2', 'window-3', 'window-1'], 'drop past the end moves the tab last');
  assert.equal(first.classList.contains('is-dragging'), false, 'drag state is cleaned up');
  assert.equal(indicator.hidden, true, 'indicator hides after drop');

  // Drag window-1 (now last) back to the front.
  stubRects();
  const lastTab = [...doc.querySelectorAll('.window-tab')].at(-1);
  dragEvent('dragstart', lastTab);
  dragEvent('dragover', tabsEl, 10);
  dragEvent('drop', tabsEl, 10);
  assert.deepEqual(tabIds(), ['window-1', 'window-2', 'window-3'], 'drop at the front moves the tab first');

  // Keyboard: Alt+ArrowRight moves the focused tab right one.
  const selectBtn = doc.querySelector('.window-tab .window-tab-select');
  selectBtn.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
    bubbles: true, cancelable: true, altKey: true, key: 'ArrowRight',
  }));
  assert.deepEqual(tabIds(), ['window-2', 'window-1', 'window-3'], 'Alt+ArrowRight moves the focused tab right');
  // And Alt+ArrowLeft moves it back.
  const moved = [...doc.querySelectorAll('.window-tab')][1].querySelector('.window-tab-select');
  moved.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
    bubbles: true, cancelable: true, altKey: true, key: 'ArrowLeft',
  }));
  assert.deepEqual(tabIds(), ['window-1', 'window-2', 'window-3'], 'Alt+ArrowLeft moves the focused tab left');

  // The reorder survives persistence: the saved list is in tab order.
  const saved = JSON.parse(dom.window.sessionStorage.getItem('payload-formatter:windows:v1'));
  assert.deepEqual(saved.windows.map((win) => win.id), ['window-1', 'window-2', 'window-3'],
    'persisted window list follows the tab order');

  // A drag started while renaming is cancelled.
  const tab = doc.querySelector('.window-tab');
  tab.querySelector('.window-tab-select').dispatchEvent(new dom.window.Event('dblclick', { bubbles: true }));
  assert.ok(tab.querySelector('.window-rename-input'), 'rename started on double-click');
  const cancelled = dragEvent('dragstart', tab);
  assert.equal(cancelled.defaultPrevented, true, 'dragstart is cancelled while renaming');
  assert.ok(!tab.classList.contains('is-dragging'), 'no drag state while renaming');
}

// --- DOM: switching windows restores scroll, cursor, and tree expansion ---
{
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
  dom.window.Element.prototype.scrollIntoView = function () {};

  await import('./app.js?window-ui-state=1');
  const doc = dom.window.document;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const editor = doc.querySelector('#payloadInput');
  const treeView = doc.querySelector('#treeView');
  const tabFor = (id) => [...doc.querySelectorAll('.window-tab')]
    .find((tab) => tab.dataset.windowId === id);
  const clickTab = (id) => tabFor(id).querySelector('.window-tab-select').click();

  doc.querySelector('#newWindowBtn').click(); // window-2 created and activated
  clickTab('window-1');
  editor.value = JSON.stringify({ a: { b: { c: 1, d: 2 } }, e: [1, 2, 3, 4, 5] });
  editor.scrollTop = 456;
  editor.scrollLeft = 12;
  editor.setSelectionRange(10, 20);

  // Text view: window-1's scroll and cursor survive a round-trip.
  clickTab('window-2');
  assert.equal(editor.value, '', 'window-2 starts empty');
  editor.scrollTop = 10; // window-2 gets its own position
  clickTab('window-1');
  assert.equal(editor.scrollTop, 456, 'text scrollTop restored');
  assert.equal(editor.scrollLeft, 12, 'text scrollLeft restored');
  assert.equal(editor.selectionStart, 10, 'cursor position restored');
  assert.equal(editor.selectionEnd, 20, 'selection end restored');
  clickTab('window-2');
  assert.equal(editor.scrollTop, 10, 'window-2 kept its own scroll position');

  // Tree view: expansion and scroll survive a round-trip.
  clickTab('window-1');
  doc.querySelector('#viewTreeBtn').click();
  await sleep(150);
  let treeRows = [...treeView.querySelectorAll('.tree-row')];
  assert.ok(treeRows.length >= 4, 'tree built for window-1');
  treeRows[2].dispatchEvent(new dom.window.Event('click', { bubbles: true })); // expand a.b
  assert.ok(treeRows[2].parentElement.classList.contains('open'), 'a.b expanded');
  treeView.scrollTop = 123;

  clickTab('window-2');
  await sleep(150);
  clickTab('window-1');
  await sleep(150);
  assert.equal(treeView.scrollTop, 123, 'tree scroll restored');
  treeRows = [...treeView.querySelectorAll('.tree-row')];
  assert.ok(treeRows[2].parentElement.classList.contains('open'), 'tree expansion restored');

  // Toggling tree -> text -> tree also round-trips (leave-tree snapshot).
  doc.querySelector('#viewTextBtn').click();
  await sleep(50);
  doc.querySelector('#viewTreeBtn').click();
  await sleep(150);
  treeRows = [...treeView.querySelectorAll('.tree-row')];
  assert.ok(treeRows[2].parentElement.classList.contains('open'), 'view toggle restores expansion');
  assert.equal(treeView.scrollTop, 123, 'view toggle restores tree scroll');
}

console.log('All payload window regression tests passed.');
