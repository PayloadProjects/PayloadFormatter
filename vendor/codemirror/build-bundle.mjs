// Rebuilds vendor/codemirror/codemirror.js from the pinned npm packages and
// collects their licenses. Run with: npm run vendor:codemirror
import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';

const here = new URL('./', import.meta.url);
const packages = [
  '@codemirror/state', '@codemirror/view', '@codemirror/commands', '@codemirror/language',
  '@codemirror/lang-json', '@codemirror/lang-xml', '@codemirror/search', '@codemirror/autocomplete',
  '@lezer/common', '@lezer/highlight', '@lezer/lr', '@lezer/json', '@lezer/xml',
  'style-mod', 'w3c-keyname', 'crelt',
];

const versions = [];
for (const name of packages) {
  const pkg = JSON.parse(await readFile(new URL(`../../node_modules/${name}/package.json`, import.meta.url), 'utf8'));
  versions.push(`${name}@${pkg.version}`);
}

await build({
  entryPoints: [new URL('entry.js', here).pathname],
  outfile: new URL('codemirror.js', here).pathname,
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'es2020',
  legalComments: 'none',
  banner: { js: `/* CodeMirror 6 bundle (MIT). Built from: ${versions.join(', ')}. See LICENSE. */` },
});

// All bundled packages are MIT licensed by Marijn Haverbeke and contributors.
const license = await readFile(new URL('../../node_modules/@codemirror/view/LICENSE', import.meta.url), 'utf8');
await writeFile(new URL('LICENSE', here), `${license.trim()}\n\nApplies to the bundled packages:\n${versions.map((v) => `- ${v}`).join('\n')}\n`);
console.log(`vendor/codemirror/codemirror.js rebuilt (${versions.length} packages).`);
