import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [app, html] = await Promise.all([
  readFile(new URL('./app.js', import.meta.url), 'utf8'),
  readFile(new URL('./index.html', import.meta.url), 'utf8'),
]);

assert.ok(html.includes('id="pasteFormatBtn"'),
  'combined Paste & Format button must exist');
assert.ok(html.includes('Paste &amp; Format'),
  'combined action must be clearly labeled');
assert.ok(!html.includes('id="pasteBtn"') && !html.includes('id="formatBtn"'),
  'separate Paste and Format buttons must be removed');

assert.ok(app.includes("pasteFormatBtn.addEventListener('click', pasteAndFormatPayload)"),
  'combined button must trigger one clipboard-and-format workflow');
assert.ok(app.includes('async function pasteAndFormatPayload()'),
  'combined workflow must be implemented as one guarded async action');
assert.ok(app.includes('acceptPastedText(text);\n    await formatCurrentPayload();'),
  'clipboard text must be accepted before the same formatter path runs');
assert.ok(app.includes('async function formatCurrentPayload()'),
  'button formatting and keyboard formatting must share one implementation');
assert.ok(app.includes('await formatCurrentPayload();'),
  'Ctrl/Cmd+Enter wrapper must still use the shared formatter implementation');
assert.ok(app.includes('pasteFormatBtn.disabled = value'),
  'combined action must be protected from repeated clicks while busy');

// JSON and XML must still go through the shared worker-based detection/format path.
assert.ok(app.includes("if (first === '<') return 'xml'"));
assert.ok(app.includes("if (first === '{' || first === '[') return 'json'"));
assert.match(html, /app\.js\?v=paste-format-20261002-1/,
  'deployment must bypass stale JavaScript after combining the actions');

console.log('All combined Paste & Format regression tests passed.');
