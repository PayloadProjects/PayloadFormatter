import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [app, html] = await Promise.all([
  readFile(new URL('./app.js', import.meta.url), 'utf8'),
  readFile(new URL('./index.html', import.meta.url), 'utf8'),
]);

assert.ok(app.includes('const LARGE_UI_PAYLOAD_CHARS = 512 * 1024'),
  'large payloads need a dedicated lightweight UI path');
assert.ok(app.includes('refreshUiForInput()'),
  'paste and manual input should share the optimized refresh path');
assert.ok(app.includes('function refreshUiQuick(text)'),
  'large payloads should avoid synchronous line/byte scans');
assert.ok(app.includes('chars · large payload'),
  'large-payload metadata should use an O(1) character-count summary');
assert.ok(app.includes('insertAtSelectionFast(text)'),
  'paste button should use the fast insertion path');
assert.ok(!app.includes("editor.dispatchEvent(new Event('input'"),
  'programmatic paste must not trigger a second synchronous input pipeline');
assert.ok(app.includes("if (!current && start === 0 && end === 0)"),
  'empty-editor paste should assign clipboard text directly without concatenation');
assert.ok(app.includes("setStatus('Reading clipboard…')"),
  'paste should immediately acknowledge clipboard work to the user');
assert.match(html, /app\.js\?v=[A-Za-z0-9._-]+/,
  'GitHub Pages must load a versioned JavaScript asset instead of a stale cached file');

// Guard both formatter paths while changing paste performance behavior.
assert.ok(app.includes("if (first === '<') return 'xml'"));
assert.ok(app.includes("if (first === '{' || first === '[') return 'json'"));

console.log('All large-paste responsiveness regression tests passed.');
