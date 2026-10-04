import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPayloadHistory } from './payload-history.js';

const [html, css, app, build, pkg] = await Promise.all(
  ['index.html', 'style.css', 'app.js', 'build.mjs', 'package.json']
    .map((file) => readFile(new URL(file, import.meta.url), 'utf8')),
);

// --- Model: basic back/forward navigation ---
{
  const history = createPayloadHistory();
  assert.equal(history.back(), null, 'back on empty history returns null');
  assert.equal(history.forward(), null, 'forward on empty history returns null');
  assert.equal(history.canBack(), false);
  assert.equal(history.canForward(), false);

  history.push('{"a":1}');
  history.push('<b>2</b>');
  history.push('{"c":3}');
  assert.equal(history.size(), 3);
  assert.equal(history.current(), '{"c":3}');
  assert.equal(history.canBack(), true);
  assert.equal(history.canForward(), false);

  assert.equal(history.back(), '<b>2</b>');
  assert.equal(history.back(), '{"a":1}');
  assert.equal(history.back(), null, 'back past the oldest returns null');
  assert.equal(history.canBack(), false);
  assert.equal(history.canForward(), true);

  assert.equal(history.forward(), '<b>2</b>');
  assert.equal(history.forward(), '{"c":3}');
  assert.equal(history.forward(), null, 'forward past the newest returns null');
}

// --- Model: consecutive duplicates are ignored ---
{
  const history = createPayloadHistory();
  assert.equal(history.push('x'), true);
  assert.equal(history.push('x'), false, 'duplicate push is a no-op');
  assert.equal(history.size(), 1);
  history.push('y');
  assert.equal(history.size(), 2);
}

// --- Model: pushing after going back truncates the forward entries ---
{
  const history = createPayloadHistory();
  history.push('a');
  history.push('b');
  history.push('c');
  history.back();
  history.back();
  assert.equal(history.push('d'), true);
  assert.equal(history.size(), 2, 'forward entries dropped');
  assert.equal(history.back(), 'a');
  assert.equal(history.forward(), 'd');
  assert.equal(history.forward(), null);
}

// --- Model: updateCurrent edits the entry in place (typing/formatting) ---
{
  const history = createPayloadHistory();
  history.push('{"a":1}');
  history.push('{"b":2}');
  assert.equal(history.updateCurrent('{"b": 2}'), true, 'format rewrites the current entry');
  assert.equal(history.size(), 2, 'no new entry for in-place edits');
  assert.equal(history.current(), '{"b": 2}');
  assert.equal(history.back(), '{"a":1}');
  assert.equal(history.forward(), '{"b": 2}');

  assert.equal(history.updateCurrent('{"b": 2}'), false, 'unchanged text is a no-op');
}

// --- Model: updateCurrent after going back drops the diverged future ---
{
  const history = createPayloadHistory();
  history.push('a');
  history.push('b');
  history.back();
  history.updateCurrent('a-edited');
  assert.equal(history.size(), 1);
  assert.equal(history.current(), 'a-edited');
  assert.equal(history.canForward(), false);
}

// --- Model: updateCurrent on an empty history records the first entry ---
{
  const history = createPayloadHistory();
  assert.equal(history.updateCurrent('typed'), true);
  assert.equal(history.size(), 1);
  assert.equal(history.current(), 'typed');
}

// --- Model: entry and byte caps evict the oldest first ---
{
  const history = createPayloadHistory({ maxEntries: 3 });
  history.push('a');
  history.push('b');
  history.push('c');
  history.push('d');
  assert.equal(history.size(), 3);
  assert.equal(history.back(), 'c');
  assert.equal(history.back(), 'b');
  assert.equal(history.back(), null, 'evicted entry is gone');
  assert.equal(history.canBack(), false);

  const sized = createPayloadHistory({ maxEntries: 100, maxBytes: 4 });
  sized.push('aa');
  sized.push('bb');
  sized.push('cc');
  assert.ok(sized.size() <= 2, 'byte budget evicts oldest entries');
  assert.equal(sized.current(), 'cc', 'newest entry survives eviction');
}

// --- Wiring: history nav lives in the toolbar, before the action group ---
{
  const toolbar = html.match(/<div class="toolbar">([\s\S]*?)<div class="status-area">/)?.[1];
  assert.ok(toolbar, 'toolbar exists');
  const navIndex = toolbar.indexOf('class="history-nav"');
  const actionsIndex = toolbar.indexOf('class="actions"');
  assert.ok(navIndex !== -1 && actionsIndex !== -1 && navIndex < actionsIndex,
    'history nav sits in the toolbar before the Clear/Paste/Copy action group');
  assert.ok(toolbar.includes('id="historyBackBtn"'), 'back button exists');
  assert.ok(toolbar.includes('id="historyForwardBtn"'), 'forward button exists');
  assert.ok(/id="historyBackBtn"[^>]*disabled/.test(toolbar), 'back starts disabled');
  assert.ok(/id="historyForwardBtn"[^>]*disabled/.test(toolbar), 'forward starts disabled');
  assert.ok(toolbar.includes('aria-label="Previous payload"'), 'back has an accessible label');
  assert.ok(toolbar.includes('aria-label="Next payload"'), 'forward has an accessible label');

  // The strict Clear -> Paste & Format -> Copy order inside .actions is untouched.
  const actions = html.match(/<div class="actions"[^>]*>([\s\S]*?)<\/div>/)?.[1];
  const order = [...actions.matchAll(/id="(.*?)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['clearBtn', 'pasteFormatBtn', 'copyBtn']);
}

// --- Wiring: app.js records pastes, edits, clears and navigates ---
{
  assert.ok(app.includes("from './payload-history.js'"), 'app.js imports the history model');
  assert.ok(app.includes('initializeHistory()'), 'history seeded from the restored draft');
  const accept = app.match(/function acceptPastedText[\s\S]*?\n}/)?.[0];
  assert.ok(accept?.includes('pushHistory()'), 'pasted payloads are recorded');
  assert.ok(app.includes('history.updateCurrent(getPayloadText())'), 'formats rewrite the current entry');
  const clear = app.match(/function clearPayload[\s\S]*?\n}/)?.[0];
  assert.ok(clear?.includes('pushHistory()'), 'clearing records the empty state');
  assert.ok(app.includes('pastePending = true'), 'small native pastes are marked as pastes');
  assert.ok(app.includes('function navigateHistory(direction)'), 'back/forward restores entries');
  assert.ok(app.includes('function syncHistoryNav()'), 'nav buttons reflect history position');
  assert.ok(/setBusy\(value\)[\s\S]*?syncHistoryNav\(\)/.test(app), 'nav locks while busy');
}

// --- Wiring: styles, deploy bundle, and suite registration ---
{
  assert.ok(css.includes('.history-nav'), 'history nav styles exist');
  assert.ok(build.includes("'payload-history.js'"), 'deploy bundle ships the history module');
  const scripts = JSON.parse(pkg).scripts;
  assert.ok(scripts.test.includes('test-history.mjs'), 'suite runs the history tests');
}

console.log('All payload history regression tests passed.');
