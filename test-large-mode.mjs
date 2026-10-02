import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [app, html, css] = await Promise.all([
  readFile(new URL('./app.js', import.meta.url), 'utf8'),
  readFile(new URL('./index.html', import.meta.url), 'utf8'),
  readFile(new URL('./style.css', import.meta.url), 'utf8'),
]);

assert.ok(app.includes('let largeText = null'),
  'large payload mode must retain the full payload outside the textarea');
assert.ok(app.includes('return largeText !== null ? largeText : editor.value'),
  'Format and Copy must resolve the full payload, not the preview');
assert.ok(app.includes("editor.addEventListener('paste'"),
  'manual Ctrl/Cmd+V must intercept payloads that would overflow the textarea');
assert.ok(app.includes('nextLength >= LARGE_PAYLOAD_CHARS'),
  'paste handling must switch to preview mode when the resulting document is large');
assert.ok(app.includes('enterLargeMode(result.formatted, { formatted: true })'),
  'large formatted JSON/XML output must stay out of the textarea layout engine');
assert.ok(app.includes('const text = getPayloadText()'),
  'formatter and copy paths must operate on the full in-memory payload');
assert.ok(app.includes('if (inLargeMode()) {\n    clearStoredDraft();'),
  'preview text must never be persisted as if it were the full payload');
assert.ok(html.includes('id="largeNotice"'),
  'large mode must tell the user that the textarea is only a preview');
assert.ok(css.includes('.large-notice') && css.includes('.editor.large-mode'),
  'large mode notice and preview state must be styled');
assert.ok(!html.includes('id="downloadBtn"'),
  'large mode must keep the compact workflow without adding Download');
assert.ok(html.includes('id="pasteFormatBtn"') && !html.includes('id="pasteBtn"') && !html.includes('id="formatBtn"'),
  'large mode must use the combined Paste & Format action');
assert.match(html, /app\.js\?v=[A-Za-z0-9._-]+/,
  'the deployed page must keep JavaScript cache-busted');
assert.match(html, /style\.css\?v=[A-Za-z0-9._-]+/,
  'the deployed page must keep CSS cache-busted');

console.log('All large-payload preview mode regression tests passed.');
