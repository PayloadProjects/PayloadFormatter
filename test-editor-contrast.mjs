import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [css, treeCss, html] = await Promise.all(
  ['style.css', 'tree-view.css', 'index.html'].map(file =>
    readFile(new URL(file, import.meta.url), 'utf8')),
);

function declarations(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = source.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))?.[1];
  assert.ok(body, `${selector}: style block exists`);
  return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)]
    .map(([, name, value]) => [name, value.trim()]));
}
const dark = declarations(css, ':root');
const light = { ...dark, ...declarations(css, ':root[data-theme="light"]') };
function resolve(tokens, key, seen = new Set()) {
  assert.ok(!seen.has(key), `circular token: ${key}`);
  seen.add(key);
  const value = tokens[key];
  assert.ok(value, `missing token: ${key}`);
  const ref = value.match(/^var\((--[\w-]+)\)$/)?.[1];
  return ref ? resolve(tokens, ref, seen) : value;
}
// WCAG relative luminance / contrast, not a test of one specific hex palette.
// https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum
function luminance(hex) {
  assert.match(hex, /^#[0-9a-f]{6}$/i, 'opaque RGB color');
  const rgb = hex.slice(1).match(/../g).map(c => parseInt(c, 16) / 255)
    .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function contrast(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
const surface = resolve(dark, '--editor-bg');
assert.ok(luminance(surface) < 0.006, 'dark reading surface stays near-black, not slate-gray');
assert.ok(luminance(surface) < luminance(resolve(dark, '--page-bg')),
  'the reading surface is darker than the surrounding page');
const readingTokens = ['--editor-text', '--syntax-key', '--syntax-string', '--syntax-number',
  '--syntax-boolean', '--syntax-attribute', '--syntax-muted'];
for (const token of readingTokens) {
  const foreground = resolve(dark, token);
  assert.ok(contrast(foreground, surface) >= 7, `${token}: dark reading contrast >= 7:1`);
  for (const state of ['--tree-hover-bg', '--tree-focus-bg', '--tree-hit-bg']) {
    assert.ok(contrast(foreground, resolve(dark, state)) >= 4.5,
      `${token} on ${state}: text remains readable when highlighted`);
  }
}
assert.ok(luminance(resolve(light, '--editor-bg')) > 0.9, 'light mode remains light');
assert.ok(contrast(resolve(light, '--editor-text'), resolve(light, '--editor-bg')) >= 7);
for (const [syntax, original] of [
  ['--syntax-key', '--json-text'], ['--syntax-string', '--success'],
  ['--syntax-number', '--warning'], ['--syntax-boolean', '--xml-text'],
  ['--syntax-attribute', '--xml-text'], ['--syntax-muted', '--muted'],
]) {
  assert.equal(resolve(light, syntax), resolve(light, original), 'light syntax colors are unchanged');
}
assert.match(css, /\.editor\s*\{[^}]*background:\s*var\(--editor-bg\)/);
assert.match(css, /\.editor-body\s*\{[^}]*background:\s*var\(--editor-bg\)/);
assert.match(treeCss, /\.tree-panel\s*\{[^}]*background:\s*var\(--editor-bg\)/);
assert.match(treeCss, /\.tree-view\s*\{[^}]*background:\s*var\(--editor-bg\)/);
for (const token of readingTokens.slice(1)) assert.ok(treeCss.includes(`var(${token})`));
assert.match(html, /style\.css\?v=[\w.-]+/);
assert.match(html, /tree-view\.css\?v=[\w.-]+/);
console.log('Editor surface and JSON/XML syntax contrast checks passed.');
