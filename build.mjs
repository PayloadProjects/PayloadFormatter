import { rm, mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

const files = [
  'index.html',
  'favicon.svg',
  'json-xml-formatter-icon.png',
  'style.css',
  'tree-view.js',
  'tree-controller.js',
  'tree-view.css',
  'app.js',
  'ui-controls.js',
  'formatter-worker.js',
  'payload-detection.js',
  'payload-history.js',
  'resilient-format.js',
  'window-manager.js',
  'input-normalization.js',
  'xml-format.js',
  'text-editor.js',
  'text-editor.css',
  'syntax-shared.js',
  'syntax-model.js',
  'syntax-worker.js',
  'vendor/prism/prism.js',
  'vendor/prism/LICENSE',
  'vendor/prism/README.md',
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
    source = source.replace(/(['"])(\.\/[^'"\s]+\.js)(?:\?[^'"\s]*)?\1/g,
      (_, quote, path) => `${quote}${path}?v=${revision}${quote}`);
  } else {
    source = source.replace(/(\.\/[^'"\s]+\.(?:js|css))(?:\?[^'"\s]*)?/g,
      (_, path) => `${path}?v=${revision}`);
  }
  await writeFile(`dist/${file}`, source);
}
console.log('Static production files created in dist/');
