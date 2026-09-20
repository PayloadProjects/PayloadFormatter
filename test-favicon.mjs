import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [build, html] = await Promise.all([
  readFile(new URL('./build.mjs', import.meta.url), 'utf8'),
  readFile(new URL('./index.html', import.meta.url), 'utf8'),
]);

assert.ok(build.includes("'favicon.svg'"),
  'production build must copy favicon.svg into dist');
assert.ok(html.includes('rel="icon"'),
  'index.html must declare a favicon');

console.log('All favicon deployment regression tests passed.');

assert.ok(html.includes('./json-xml-formatter-icon.png?v=4'),
  'browser tab must use the new cache-busting PNG favicon');
assert.ok(build.includes("'json-xml-formatter-icon.png'"),
  'production build must copy the PNG favicon into dist');
