import { rm, mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

const files = [
  'index.html',
  'assets/favicon.svg',
  'assets/json-xml-formatter-icon.png',
  'src/styles/style.css',
  'src/tree/tree-view.js',
  'src/tree/tree-controller.js',
  'src/styles/tree-view.css',
  'src/app.js',
  'src/ui-controls.js',
  'src/format/formatter-worker.js',
  'src/format/payload-detection.js',
  'src/history/payload-history.js',
  'src/history/history-store.js',
  'src/panels/epoch-converter.js',
  'src/panels/epoch-popover.js',
  'src/format/resilient-format.js',
  'src/history/window-manager.js',
  'src/format/input-normalization.js',
  'src/format/xml-format.js',
  'src/editor/text-editor.js',
  'src/editor/text-search.js',
  'src/panels/inspector.js',
  'src/editor/minimap.js',
  'src/format/payload-diagnose.js',
  'src/editor/issue-helper.js',
  'src/styles/text-editor.css',
  'vendor/codemirror/codemirror.js',
  'vendor/codemirror/LICENSE',
  '.nojekyll',
];

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });

for (const file of files) {
  await mkdir(dirname(`dist/${file}`), { recursive: true });
  await copyFile(file, `dist/${file}`);
}

// One deterministic asset revision also invalidates nested worker/module imports.
// A changed grammar or tree renderer cannot be mixed with cached older modules.
const hash = createHash('sha256');
for (const file of files) hash.update(file).update(await readFile(file));
const revision = hash.digest('hex').slice(0, 16);
for (const file of files.filter(file => /\.(?:js|html)$/.test(file))) {
  let source = await readFile(`dist/${file}`, 'utf8');
  if (file.endsWith('.js')) {
    source = source.replace(/(['"])(\.\.?\/[^'"\s]+\.js)(?:\?[^'"\s]*)?\1/g,
      (_, quote, path) => `${quote}${path}?v=${revision}${quote}`);
  } else {
    source = source.replace(/(\.\/[^'"\s]+\.(?:js|css))(?:\?[^'"\s]*)?/g,
      (_, path) => `${path}?v=${revision}`);
  }
  await writeFile(`dist/${file}`, source);
}
console.log('Static production files created in dist/');
