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
assert.ok(html.includes('./favicon.svg?v=1'),
  'favicon URL should stay versioned to reduce stale browser caching');

console.log('All favicon deployment regression tests passed.');
