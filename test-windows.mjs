import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
  const bar = html.match(/<div class="window-bar">([\s\S]*?)<\/div>\s*<section class="workspace"/)?.[1];
  assert.ok(bar, 'window bar sits between the topbar and the workspace');
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
  assert.ok(app.includes('setPayloadText(next.payload'), 'switching swaps the payload');
  assert.ok(app.includes('dblclick'), 'rename starts on double-click');
}

// --- Wiring: styles, deploy bundle, and suite registration ---
{
  assert.ok(css.includes('.window-bar'), 'window bar styles exist');
  assert.ok(css.includes('.window-tab.is-active'), 'active tab is styled');
  assert.ok(css.includes('.window-rename-input'), 'rename input is styled');
  assert.ok(build.includes("'window-manager.js'"), 'deploy bundle ships the window manager');
  const scripts = JSON.parse(pkg).scripts;
  assert.ok(scripts.test.includes('test-windows.mjs'), 'suite runs the window tests');
}

console.log('All payload window regression tests passed.');
