import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { buildSyntaxModel } from './syntax-model.js';
import { TOKEN_CLASSES, MAX_HIGHLIGHT_CHARS, MAX_VISIBLE_CHARS, MAX_VISIBLE_SPANS, lineAt } from './syntax-shared.js';

function inspect(text, mode) {
  const model = buildSyntaxModel(text, mode);
  let cursor = 0, reconstructed = '';
  const labeled = [];
  for (let i = 0; i < model.spans.length; i += 3) {
    const [from, to, type] = model.spans.slice(i, i + 3);
    assert.ok(from >= cursor && to > from && to <= text.length);
    assert.ok(TOKEN_CLASSES[type]);
    reconstructed += text.slice(cursor, from) + text.slice(from, to);
    labeled.push([TOKEN_CLASSES[type], text.slice(from, to)]);
    cursor = to;
  }
  reconstructed += text.slice(cursor);
  assert.equal(reconstructed, text, 'highlighting must preserve every character');
  assert.deepEqual(Array.from(model.lines), [0, ...Array.from(text.matchAll(/\n/g), m => m.index + 1)]);
  return { model, labeled };
}
const json = String.raw`{"name":"A \"quoted\" value","path":"C:\\temp\\file","price":-12.75e2,"on":true,"nil":null,"items":[1,2]}`;
const j = inspect(json, 'json').labeled;
for (const [type, value] of [['key', '"name"'], ['number', '-12.75e2'], ['boolean', 'true'], ['boolean', 'null']]) {
  assert.ok(j.some(([t,v]) => t === type && v === value), `${type}: ${value}`);
}
const xml = `<?xml version="1.0"?>\n<r:root xmlns:r="urn:test" count='2' note="A &amp; B">\n\t<!-- note -->\n\t<name>cafe\u0301 \u4e2d\u6587 \ud83d\ude00</name>\n\t<![CDATA[x < y && z]]>\n</r:root>`;
const x = inspect(xml, 'xml').labeled;
assert.ok(x.some(([t,v]) => t === 'attribute' && v === 'count'));
assert.ok(x.some(([t,v]) => t === 'tag' && v.includes('r:root')));
assert.ok(x.some(([t,v]) => t === 'comment' && v.includes('<!-- note -->')));
assert.ok(x.some(([t,v]) => t === 'string' && v === 'x < y && z'));
assert.ok(x.some(([t,v]) => t === 'entity' && v === '&amp;'));
for (const [text, mode] of [
  ['', 'json'], ['{\n\t"broken": [1,,', 'json'], ['<root note="unfinished', 'xml'],
  ['<!DOCTYPE root [<!ENTITY e "A > B">]><root>&e;</root>', 'xml'],
  ['<root><![CDATA[<script>alert(1)</script>]]></root>', 'xml'],
  ['\ufeff{"text":"\u05d0\u05d1\u05d2", "emoji":"\ud83d\ude00"}\r\n', 'json'],
  [String.raw`<root><path>C:\temp\folder\</path><text>\ \\ \\\</text></root>`, 'xml'],
  ['["x",0,false,null]\n', 'json'], ['plain text\n\n', null],
]) inspect(text, mode);
assert.equal(lineAt(Uint32Array.from([0,4,9]), 0), 0);
assert.equal(lineAt(Uint32Array.from([0,4,9]), 8), 1);
assert.equal(lineAt(Uint32Array.from([0,4,9]), 9), 2);
assert.throws(() => buildSyntaxModel('x'.repeat(MAX_HIGHLIGHT_CHARS + 1), 'json'), RangeError);
for (const mode of ['json','xml']) {
  const source = mode === 'json'
    ? '{"items":[' + Array(4000).fill('{"id":1,"name":"sample"}').join(',') + ']}'
    : '<root>' + '<item id="1">sample</item>'.repeat(4000) + '</root>';
  inspect(source, mode);
}
assert.ok(MAX_VISIBLE_CHARS < MAX_HIGHLIGHT_CHARS && MAX_VISIBLE_SPANS <= 4000);

// Exercise the actual module worker and its transferable buffers under Node.
const workerURL = new URL('./syntax-worker.js', import.meta.url).href;
const w = new Worker(`const {parentPort}=require('node:worker_threads');
  globalThis.self={addEventListener:(_,fn)=>parentPort.on('message',data=>fn({data})),
    postMessage:(value,transfer)=>parentPort.postMessage(value,transfer)};
  import(${JSON.stringify(workerURL)}).then(()=>parentPort.postMessage({ready:true}));`, { eval: true });
function message() {
  return new Promise((resolve,reject) => {
    const timer=setTimeout(()=>reject(new Error('syntax worker timed out')),5000);
    w.once('message',data=>{clearTimeout(timer);resolve(data)});
    w.once('error',error=>{clearTimeout(timer);reject(error)});
  });
}
try {
  assert.equal((await message()).ready, true);
  for (const [id,text,mode] of [[1,json,'json'],[2,xml,'xml']]) {
    const response=message(); w.postMessage({id,text,mode});
    const result=await response;
    assert.equal(result.id,id); assert.equal(result.ok,true);
    assert.ok(result.lines instanceof Uint32Array && result.spans instanceof Uint32Array);
    assert.deepEqual(result.spans,buildSyntaxModel(text,mode).spans);
  }
  const response=message(); w.postMessage({id:3,text:'x'.repeat(MAX_HIGHLIGHT_CHARS+1),mode:'xml'});
  assert.equal((await response).ok,false);
} finally { await w.terminate(); }

const [app, ui, html, css, build] = await Promise.all(['app.js','text-editor.js','index.html','text-editor.css','build.mjs'].map(f=>readFile(new URL(f,import.meta.url),'utf8')));
assert.ok(app.includes('syntaxEditor.refresh(mode)'));
assert.ok(html.includes('aria-hidden="true" inert'), 'decorative syntax has no duplicate accessible text');
assert.ok(css.includes('forced-colors: active'), 'system high-contrast keeps native text visible');
assert.doesNotMatch(ui, /\.innerHTML\s*=/, 'untrusted payload must never become HTML');
assert.match(ui, /token\.textContent\s*=/);
assert.match(ui, /plain\('long-line'\)/);
assert.match(ui, /worker\?\.terminate\(\)/);
assert.match(build, /createHash\('sha256'\)/, 'nested worker and module assets are cache-versioned together');
await access(new URL('./vendor/prism/LICENSE',import.meta.url));
console.log('Syntax tokens, source preservation, worker and rendering safeguards passed.');
