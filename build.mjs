import { rm, mkdir, copyFile } from 'node:fs/promises';

const files = [
  'index.html',
  'style.css',
  'app.js',
  'formatter-worker.js',
  'payload-detection.js',
  'resilient-format.js',
  'input-normalization.js',
  'xml-format.js',
  '.nojekyll',
];

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });

for (const file of files) {
  await copyFile(file, `dist/${file}`);
}

console.log('Static production files created in dist/');
