import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, css, app, pkg] = await Promise.all([
  readFile(new URL('./index.html', import.meta.url), 'utf8'),
  readFile(new URL('./style.css', import.meta.url), 'utf8'),
  readFile(new URL('./app.js', import.meta.url), 'utf8'),
  readFile(new URL('./package.json', import.meta.url), 'utf8'),
]);

assert.ok(html.includes('id="themeToggleBtn"'), 'theme toggle button must exist');
assert.match(html, /style\.css\?v=[A-Za-z0-9._-]+/, 'theme CSS must use a versioned URL so GitHub Pages cannot serve stale styles');
assert.match(html, /app\.js\?v=[A-Za-z0-9._-]+/, 'theme JavaScript must use a versioned URL so GitHub Pages cannot serve a stale click handler');
assert.ok(html.includes('content="dark light"'), 'document must advertise both supported color schemes');
assert.ok(html.includes("payload-formatter:theme:v1"), 'theme must be applied before CSS to avoid a startup flash');
assert.ok(!html.includes("prefers-color-scheme: light"), 'first visit should keep the formatter\'s existing dark default');

assert.ok(css.includes(':root[data-theme="light"]'), 'light theme tokens must exist');
assert.ok(css.includes('--editor-bg:'), 'editor colors must be theme tokens');
assert.ok(css.includes('--json-bg:'), 'JSON badge colors must support both themes');
assert.ok(css.includes('--xml-bg:'), 'XML badge colors must support both themes');
assert.ok(css.includes('.theme-toggle'), 'theme control must be styled');
assert.ok(css.includes('scrollbar-color:'), 'editor scrollbar must remain visible in both themes');

assert.ok(app.includes("const THEME_STORAGE_KEY = 'payload-formatter:theme:v1'"));
assert.ok(app.includes('localStorage.getItem(THEME_STORAGE_KEY)'));
assert.ok(app.includes('localStorage.setItem(THEME_STORAGE_KEY, next)'));
assert.ok(app.includes("currentTheme() === 'dark' ? 'light' : 'dark'"));
assert.ok(app.includes("applyTheme(saved || 'dark'"), 'dark must remain the default until the user chooses light mode');
assert.ok(app.includes("detectPayloadMode"), 'theme work must not replace JSON/XML payload detection');
assert.ok(app.includes("async function formatPayload()"), 'theme work must not replace formatter behavior');

const packageJson = JSON.parse(pkg);
assert.ok(packageJson.scripts.test.includes('test.mjs'));
assert.ok(packageJson.scripts.test.includes('test-theme.mjs'));

console.log('All Payload Formatter theme regression tests passed.');

const clearIndex = html.indexOf('id="clearBtn"');
const pasteIndex = html.indexOf('id="pasteBtn"');
const formatIndex = html.indexOf('id="formatBtn"');
const copyIndex = html.indexOf('id="copyBtn"');
assert.ok(clearIndex < pasteIndex && pasteIndex < formatIndex && formatIndex < copyIndex,
  'compact action order must remain Clear → Paste → Format → Copy');
assert.ok(html.indexOf('id="payloadInput"') < html.indexOf('class="toolbar"'),
  'compact layout must keep the action bar below the editor');
assert.ok(css.includes('height: 100dvh'), 'app shell should be constrained to the dynamic viewport height');
assert.ok(css.includes('overflow: hidden'), 'page-level overflow should be contained');
assert.ok(css.includes('resize: none'), 'editor must not be vertically resizable beyond the viewport');
assert.ok(css.includes('flex: 1'), 'editor workspace should consume remaining viewport space');
assert.ok(css.includes('.brand-mark') && css.includes('.editor-strip'), 'formatter should keep a distinct branded compact identity');

assert.ok(html.includes('class="brand-mark"'), 'formatter should expose a compact brand mark');
assert.ok(html.includes('class="editor-strip"'), 'editor should have its own compact payload strip');
assert.ok(html.includes('Ctrl/Cmd + Enter to format.'), 'keyboard formatting shortcut should be discoverable');

assert.ok(html.includes('style.css?v=viewport-20260920-1'),
  'viewport scrollbar fix must bypass stale cached CSS');
