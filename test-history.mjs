import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPayloadHistory } from './payload-history.js';

// back()/forward() return the entry; its text is what the user sees.
const t = (entry) => (entry ? entry.text : null);

const [html, css, app, managerJs, build, pkg] = await Promise.all(
  ['index.html', 'style.css', 'app.js', 'window-manager.js', 'build.mjs', 'package.json']
    .map((file) => readFile(new URL(file, import.meta.url), 'utf8')),
);

// --- Model: basic back/forward navigation ---
{
  const history = createPayloadHistory();
  assert.equal(t(history.back()), null, 'back on empty history returns null');
  assert.equal(t(history.forward()), null, 'forward on empty history returns null');
  assert.equal(history.canBack(), false);
  assert.equal(history.canForward(), false);

  history.push('{"a":1}');
  history.push('<b>2</b>');
  history.push('{"c":3}');
  assert.equal(history.size(), 3);
  assert.equal(history.current(), '{"c":3}');
  assert.equal(history.canBack(), true);
  assert.equal(history.canForward(), false);

  assert.equal(t(history.back()), '<b>2</b>');
  assert.equal(t(history.back()), '{"a":1}');
  assert.equal(t(history.back()), null, 'back past the oldest returns null');
  assert.equal(history.canBack(), false);
  assert.equal(history.canForward(), true);

  assert.equal(t(history.forward()), '<b>2</b>');
  assert.equal(t(history.forward()), '{"c":3}');
  assert.equal(t(history.forward()), null, 'forward past the newest returns null');
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
  t(history.back());
  t(history.back());
  assert.equal(history.push('d'), true);
  assert.equal(history.size(), 2, 'forward entries dropped');
  assert.equal(t(history.back()), 'a');
  assert.equal(t(history.forward()), 'd');
  assert.equal(t(history.forward()), null);
}

// --- Model: updateCurrent edits the entry in place (typing/formatting) ---
{
  const history = createPayloadHistory();
  history.push('{"a":1}');
  history.push('{"b":2}');
  assert.equal(history.updateCurrent('{"b": 2}'), true, 'format rewrites the current entry');
  assert.equal(history.size(), 2, 'no new entry for in-place edits');
  assert.equal(history.current(), '{"b": 2}');
  assert.equal(t(history.back()), '{"a":1}');
  assert.equal(t(history.forward()), '{"b": 2}');

  assert.equal(history.updateCurrent('{"b": 2}'), false, 'unchanged text is a no-op');
}

// --- Model: updateCurrent after going back drops the diverged future ---
{
  const history = createPayloadHistory();
  history.push('a');
  history.push('b');
  t(history.back());
  history.updateCurrent('a-edited');
  assert.equal(history.size(), 1);
  assert.equal(history.current(), 'a-edited');
  assert.equal(history.canForward(), false);
}

// --- Model: clearing between pastes does not trap back/forward on empty ---
{
  const history = createPayloadHistory();
  history.push('{"a":1}'); // paste A
  history.push('');        // clear
  history.push('{"b":2}'); // paste B
  assert.equal(history.canBack(), true);
  assert.equal(t(history.back()), '{"a":1}', 'back skips the empty clear state');
  assert.equal(history.canBack(), false);
  assert.equal(history.canForward(), true);
  assert.equal(t(history.forward()), '{"b":2}', 'forward skips the empty clear state');
  assert.equal(history.canForward(), false);
}

// --- Model: back after an accidental clear restores the payload ---
{
  const history = createPayloadHistory();
  history.push('{"a":1}');
  history.push('');
  assert.equal(history.canBack(), true);
  assert.equal(t(history.back()), '{"a":1}');
  assert.equal(history.canForward(), false, 'nothing navigable past the trailing clear state');
}

// --- Model: consecutive clears record a single empty state ---
{
  const history = createPayloadHistory();
  history.push('{"a":1}');
  assert.equal(history.push(''), true);
  assert.equal(history.push(''), false, 'duplicate empty state is a no-op');
  assert.equal(history.size(), 2);
  assert.equal(t(history.back()), '{"a":1}');
}

// --- Model: updateCurrent on an empty history records the first entry ---
{
  const history = createPayloadHistory();
  assert.equal(history.updateCurrent('typed'), true);
  assert.equal(history.size(), 1);
  assert.equal(history.current(), 'typed');
}
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
  assert.equal(t(history.back()), 'c');
  assert.equal(t(history.back()), 'b');
  assert.equal(t(history.back()), null, 'evicted entry is gone');
  assert.equal(history.canBack(), false);

  const sized = createPayloadHistory({ maxEntries: 100, maxBytes: 4 });
  sized.push('aa');
  sized.push('bb');
  sized.push('cc');
  assert.ok(sized.size() <= 2, 'byte budget evicts oldest entries');
  assert.equal(sized.current(), 'cc', 'newest entry survives eviction');
}

// --- Model: saved entries release their text; unsaved ones never do ---
{
  const history = createPayloadHistory();
  history.push('a'); history.push('b'); history.push('c');
  const [a, b, c] = history.entries();
  a.state = 'saved'; c.state = 'saved';
  history.release();
  assert.equal(a.text, null, 'saved non-current entry is released');
  assert.equal(b.text, 'b', 'unsaved entry stays in memory until its write lands');
  assert.equal(c.text, 'c', 'current entry stays on screen');
  history.release({ keepCurrent: false });
  assert.equal(c.text, null, 'inactive window releases its current entry too');
  assert.equal(history.current(), null, 'released current reads as null (load from storage)');
  history.setText(c, 'wrong length');
  assert.equal(c.text, null, 'setText rejects text that does not match the entry');
  history.setText(c, 'c');
  assert.equal(history.current(), 'c', 'loaded text makes the entry resident again');
  assert.equal(history.push('c'), false, 'duplicate check still works on a reloaded entry');
}

// --- Model: entries leaving the history are queued for storage deletion ---
{
  const history = createPayloadHistory({ maxEntries: 2 });
  history.push('a'); history.push('b');
  const [a, b] = history.entries();
  history.push('c'); // evicts a
  assert.deepEqual(history.takeGarbage(), [a.id], 'evicted entry queued for deletion');
  history.back();
  history.push('d'); // truncates c
  assert.equal(history.takeGarbage().length, 1, 'truncated forward entry queued for deletion');
  history.updateCurrent('d2'); // replaces d
  assert.equal(history.takeGarbage().length, 1, 'replaced (formatted) entry queued for deletion');
  assert.deepEqual(history.takeGarbage(), [], 'garbage drains once');
  assert.ok(b.id, 'entries carry storage ids');

  const roomy = createPayloadHistory();
  roomy.push('a');
  roomy.push('');
  roomy.push('');
  assert.deepEqual(roomy.takeGarbage(), [], 'empty clear entries need no storage');
  assert.equal(roomy.entries()[1].id, '', 'clear entries have no storage id');
}

// --- Model: peek/moveTo/removeAt support loading before navigating ---
{
  const history = createPayloadHistory();
  history.push('a'); history.push('b'); history.push(''); history.push('d');
  const target = history.peek(-1);
  assert.equal(history.entryAt(target).text, 'b', 'peek skips the clear state');
  assert.equal(history.current(), 'd', 'peek does not move');
  history.removeAt(target); // b vanished from storage
  assert.equal(history.entryAt(history.peek(-1)).text, 'a', 'after removal the next stop is a');
  assert.equal(history.moveTo(history.peek(-1)).text, 'a');
  assert.equal(history.canBack(), false);
  history.removeAt(history.index());
  assert.equal(history.current(), '', 'removing the current entry lands next to it');
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
  assert.ok(/id="historyBackBtn"[^>]*><svg/.test(toolbar), 'back uses the circular-arrow icon');
  assert.ok(/id="historyForwardBtn"[^>]*><svg/.test(toolbar), 'forward uses the circular-arrow icon');

  // The strict Clear -> Paste & Format -> Copy order inside .actions is untouched.
  const actions = html.match(/<div class="actions"[^>]*>([\s\S]*?)<\/div>/)?.[1];
  const order = [...actions.matchAll(/id="(.*?)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['clearBtn', 'pasteFormatBtn', 'copyBtn']);
}

// --- Wiring: app.js records pastes, edits, clears and navigates ---
{
  assert.ok(app.includes("from './window-manager.js'"), 'app.js imports the window manager');
  assert.ok(managerJs.includes("from './payload-history.js'"), 'each window owns its own history via the manager');
  assert.ok(app.includes('restoreWindows()'), 'windows restore at startup, each with its own seeded history');
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
