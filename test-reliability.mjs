import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [app, ci, html] = await Promise.all([
  readFile(new URL('./app.js', import.meta.url), 'utf8'),
  readFile(new URL('./.github/workflows/ci.yml', import.meta.url), 'utf8'),
  readFile(new URL('./index.html', import.meta.url), 'utf8'),
]);

assert.ok(app.includes('let editRevision = 0'),
  'editor revisions must protect newer user input from stale worker results');
assert.ok(app.includes('if (editRevision !== startedRevision)'),
  'formatter must not overwrite edits made while a worker request is running');
assert.ok(app.includes('function failWorker(instance, message)'),
  'worker failures need a centralized recovery path');
assert.ok(app.includes("instance.addEventListener('error'"),
  'worker runtime failures must be handled');
assert.ok(app.includes("instance.addEventListener('messageerror'"),
  'unreadable worker responses must be handled');
assert.ok(app.includes('instance?.terminate()'),
  'failed or timed-out workers must be terminated before reuse');
assert.ok(app.includes('function formatTimeoutFor(textLength)'),
  'format requests need a bounded timeout');
assert.ok(app.includes('MAX_FORMAT_TIMEOUT_MS = 120_000'),
  'format timeout must have a hard upper bound');
assert.ok(app.includes('clearTimeout(waiter.timeoutId)'),
  'completed requests must clean up timeout handles');
assert.ok(app.includes('clearStoredDraft();'),
  'oversized payloads must remove stale persisted drafts');
assert.ok(app.includes('pasteBtn.disabled = value'),
  'programmatic paste should be disabled while formatting is active');
assert.ok(!app.includes("if (!text.trim())"),
  'large format requests must not clone/scan the entire payload on the main thread just to test emptiness');
assert.match(html, /app\.js\?v=reliability-20260920-1/,
  'the reliability build must bypass stale cached JavaScript');

assert.ok(ci.includes('- main'));
assert.ok(ci.includes('- "Tag_#2"'),
  'CI must run for the existing Tag_#2 branch without creating another branch');

console.log('All formatter reliability regression tests passed.');
