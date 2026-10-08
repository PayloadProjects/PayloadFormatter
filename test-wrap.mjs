import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, css, editorCss, app, editorJs, treeCss] = await Promise.all(
  ['index.html', 'style.css', 'text-editor.css', 'app.js', 'text-editor.js', 'tree-view.css']
    .map((file) => readFile(new URL(file, import.meta.url), 'utf8')),
);

// The Wrap control lives next to the payload type badge in the editor strip.
// The strip-meta block nests the tree actions div, so capture through its close.
const stripMeta = html.match(/<div class="editor-strip-meta"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/)?.[1];
assert.ok(stripMeta, 'editor strip meta exists');
assert.deepEqual([...stripMeta.matchAll(/<(?:button|span)\b[^>]*id="([^"]+)"/g)].map((m) => m[1]),
  ['wrapToggleBtn', 'treeExpandAll', 'treeCollapseAll', 'typeBadge'],
  'Wrap, tree actions and badge sit in that order');
assert.match(stripMeta, /id="wrapToggleBtn"[^>]*aria-pressed="false"/,
  'wrap toggle starts unpressed');
assert.match(stripMeta, /title="Wrap long lines \(syntax colors pause while wrap is on\)"/,
  'wrap toggle explains the syntax overlay pause');

// The wrap preference is restored before first paint, like the theme.
const headScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(headScript && headScript.includes("localStorage.getItem('payload-formatter:wrap:v1')"),
  'head script reads the wrap preference');
assert.ok(headScript.includes('document.documentElement.dataset.wrap'),
  'head script sets dataset.wrap early');

// Toggling wrap flips the native textarea wrapping and persists the choice.
assert.ok(app.includes("const WRAP_STORAGE_KEY = 'payload-formatter:wrap:v1'"),
  'wrap uses its own storage key');
assert.match(app, /editor\.wrap = on \? 'soft' : 'off'/,
  'wrap toggles the native textarea wrap attribute');
assert.ok(app.includes("localStorage.setItem(WRAP_STORAGE_KEY, next)"),
  'wrap choice is persisted');
assert.match(app, /wrapToggleBtn\?\.addEventListener\('click'/,
  'wrap toggle has a click handler');
assert.match(app, /wrapToggleBtn\.setAttribute\('aria-pressed', String\(on\)\)/,
  'wrap toggle exposes its state via aria-pressed');
assert.match(app, /root\.dataset\.wrap = next/,
  'wrap state is published on the root element');
assert.match(app, /applyWrap\([\s\S]*?\) \{[\s\S]*?syntaxEditor\.refresh\(\)/,
  'applying wrap re-renders the syntax editor');

// The overlay cannot map wrapped source lines to visual rows, so it stands
// down in wrap mode instead of rendering misaligned highlights.
assert.ok(editorJs.includes("document.documentElement.dataset.wrap === 'on'"),
  'syntax editor reads the wrap state');
assert.match(editorJs, /wrapNow !== wrapOn/,
  'a wrap toggle invalidates the syntax snapshot');
assert.match(editorJs, /if \(wrapOn\) \{[\s\S]*?plain\('wrap'\)/,
  'wrap mode clears the overlay via the plain fallback');
assert.ok(editorJs.includes("host.style.removeProperty('--gutter-width')"),
  'wrap mode releases the gutter reservation');
assert.match(editorJs, /function render\(\) \{[\s\S]*?dataset\.wrap === 'on'[\s\S]*?plain\('wrap'\)/,
  'render never paints the overlay while wrap is on');

// Wrap styling: the editor wraps, the gutter hides, both themes inherit it.
assert.match(css, /html\[data-wrap="on"\] \.text-editor \.editor \{\s*white-space: pre-wrap; overflow-wrap: anywhere;/,
  'wrapped editor CSS exists');
assert.match(css, /html\[data-wrap="on"\] \.syntax-gutter \{\s*display: none;/,
  'gutter hides in wrap mode');
assert.match(css, /\.strip-btn\[aria-pressed="true"\]/,
  'pressed wrap toggle has an active style');

// Tree wrap: the same toggle serves tree view (no view scoping), and rows
// become multi-line within the panel width. The span min-width reset is
// what lets flex items actually shrink so their text can wrap.
assert.doesNotMatch(stripMeta, /id="wrapToggleBtn"[^>]*data-view-scope/,
  'wrap toggle is not scoped to text view anymore');
assert.match(treeCss, /html\[data-wrap="on"\] \.tree-row \{\s*width: auto;\s*white-space: normal;\s*flex-wrap: wrap;/,
  'wrapped tree rows stay within the panel width');
assert.match(treeCss, /html\[data-wrap="on"\] \.tree-row > span \{\s*min-width: 0;\s*overflow-wrap: anywhere;/,
  'tree label spans can shrink and break long tokens when wrapped');
assert.match(app, /treeController\.isTree\(\)/,
  'wrap tooltip adapts to the current view');

// Compact chrome: the payload panel gets the space, chrome shrinks.
assert.match(css, /\.shell \{[^}]*padding: 8px 12px 10px;[^}]*gap: 8px;/,
  'shell padding and gap are compact');
assert.match(css, /\.topbar \{ min-height: 28px;/, 'topbar is slimmer');
assert.match(css, /\.brand-mark \{ width: 22px; height: 22px;/, 'brand mark is smaller');
assert.match(css, /h1 \{[^}]*font-size: 15px;/, 'heading is smaller');
assert.match(css, /\.editor-strip \{ min-height: 28px;[^}]*padding: 2px 10px;/,
  'editor strip is slimmer');
assert.match(css, /\.toolbar \{ min-height: 28px;[^}]*padding: 2px 10px;/,
  'toolbar matches the strip');
assert.match(treeCss, /\.tree-search \{[^}]*height: 24px;/,
  'tree search input matches the slimmer strip');
// The mirror overlay paddings must track the editor padding exactly.
assert.match(css, /\.editor \{[^}]*padding: 12px;/, 'editor padding is compact');
assert.match(editorCss, /\.syntax-mirror \{[^}]*padding: 12px 12px 12px calc\(var\(--gutter-width\) \+ 12px\);/,
  'mirror padding tracks the editor padding');
assert.match(editorCss, /\.syntax-gutter \{[^}]*padding: 12px 8px 12px 0;/,
  'gutter padding tracks the editor padding');

// Cache-busted asset versions cover every touched file.
for (const [asset, version] of [
  ['style.css', 'windows-v1'],
  ['app.js', 'windows-v1'],
  ['text-editor.css', 'wrap-compact-v1'],
  ['tree-view.css', 'wrap-compact-v1'],
]) {
  assert.match(html, new RegExp(`\\./${asset.replace('.', '\\.')}\\?v=${version}`),
    `${asset} carries the new cache-busting version`);
}

// Single editor strip: view toggle, tree search, wrap, tree actions and badge
// share one row; the old second tree-tools row is gone.
const strip = html.match(/<div class="editor-strip"[^>]*>([\s\S]*?)<\/div>\s*<div class="editor-body"/)?.[1];
assert.ok(strip, 'single editor strip exists');
for (const id of ['viewTextBtn', 'viewTreeBtn', 'treeSearch', 'treePrev', 'treeNext',
  'treeMatchCount', 'wrapToggleBtn', 'treeExpandAll', 'treeCollapseAll', 'typeBadge']) {
  assert.ok(strip.includes(`id="${id}"`), `${id} lives in the single strip`);
}
assert.ok(!html.includes('tree-tools'), 'the second tree-tools row is gone');
assert.ok(!html.includes('editor-strip-left'), 'the strip has no leftover left wrapper');
assert.match(treeCss, /\.editor-frame\[data-view="tree"\] \[data-view-scope="text"\]/,
  'text-only controls hide in tree view');
assert.match(treeCss, /\.editor-frame:not\(\[data-view="tree"\]\) \[data-view-scope="tree"\]/,
  'tree-only controls hide in text view');
assert.match(treeCss, /\.tree-strip-search \{[^}]*flex: 1 1 200px;/,
  'tree search grows inside the single strip');

console.log('All word-wrap and compact-chrome regression tests passed.');
