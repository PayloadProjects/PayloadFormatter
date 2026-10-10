import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// DOM-level coverage for the wrap-mode syntax overlay. Static tests pin the
// CSS/JS shape, but only a live createSyntaxEditor run proves the mirror
// actually builds one numbered block per source line with token spans.
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
globalThis.document = dom.window.document;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
globalThis.removeEventListener = dom.window.removeEventListener.bind(dom.window);
globalThis.ResizeObserver = class { observe() {} disconnect() {} };

// The worker is stubbed: it answers with one canned token (the first three
// characters as a tag) plus real line offsets for whatever text it receives.
globalThis.Worker = class {
  constructor() { this.handlers = {}; }
  addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn); }
  postMessage(msg) {
    const text = msg.text;
    const lines = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') lines.push(i + 1);
    const spans = new Uint32Array([0, Math.min(3, text.length), 7]); // 7 = 'tag'
    setTimeout(() => {
      for (const fn of this.handlers.message ?? []) {
        fn({ data: { id: msg.id, ok: true, lines: new Uint32Array(lines), spans } });
      }
    }, 0);
  }
  terminate() {}
};

document.body.innerHTML = `
<div id="editorFrame" data-view="text">
  <div id="textEditor" class="text-editor">
    <div id="syntaxViewport" class="syntax-viewport" aria-hidden="true">
      <div id="syntaxActiveLine" class="syntax-active-line" hidden></div>
      <pre id="syntaxMirror" class="syntax-mirror"></pre>
      <div id="syntaxGutter" class="syntax-gutter"></div>
    </div>
    <textarea id="payloadInput" class="editor"></textarea>
  </div>
</div>`;

const editor = document.querySelector('#payloadInput');
// jsdom reports zero box metrics; the overlay needs a real box to size the
// wrapping mirror against.
Object.defineProperty(editor, 'clientWidth', { value: 800, configurable: true });
Object.defineProperty(editor, 'clientHeight', { value: 600, configurable: true });
Object.defineProperty(editor, 'offsetLeft', { value: 0, configurable: true });

document.documentElement.dataset.wrap = 'on';
const { createSyntaxEditor } = await import('./text-editor.js');
const syntax = createSyntaxEditor(editor);

editor.value = '<a>\n<b>x</b>\n</a>';
syntax.refresh('xml');
await new Promise((resolve) => setTimeout(resolve, 150));

const host = document.querySelector('#textEditor');
const mirror = document.querySelector('#syntaxMirror');
assert.ok(host.classList.contains('has-syntax'), 'wrap mode keeps syntax highlighting');
assert.equal(host.dataset.syntaxState, 'ready', 'wrap overlay reaches the ready state');

const rows = [...mirror.querySelectorAll('.syntax-wline')];
assert.equal(rows.length, 3, 'one block per source line');
assert.deepEqual(
  rows.map((row) => row.querySelector('.syntax-wln')?.textContent),
  ['1', '2', '3'],
  'each block carries its line number',
);
assert.equal(host.style.getPropertyValue('--wln-w'), '4ch', 'number width is reserved');
const tag = rows[0].querySelector('.syntax-tag');
assert.ok(tag, 'token spans render inside the line blocks');
assert.equal(tag.textContent, '<a>', 'token text is intact');

// Scrolling only repositions the already-built mirror.
const before = mirror.innerHTML;
editor.scrollTop = 48;
editor.dispatchEvent(new dom.window.Event('scroll'));
await new Promise((resolve) => setTimeout(resolve, 50));
assert.equal(mirror.innerHTML, before, 'scroll does not rebuild the wrap mirror');
assert.match(mirror.style.transform, /translate\(0px, -48px\)/, 'scroll offsets the mirror');

// Oversized payloads stand down to the plain editor instead of building a
// giant mirror.
editor.value = `x${'\n'.repeat(300 * 1024)}`;
syntax.refresh('xml');
await new Promise((resolve) => setTimeout(resolve, 50));
assert.ok(!host.classList.contains('has-syntax'), 'oversized text skips the wrap overlay');
assert.equal(host.dataset.syntaxState, 'wrap-size', 'oversized wrap reports its state');
assert.equal(mirror.querySelectorAll('.syntax-wline').length, 0, 'no wrap blocks are built');

console.log('All wrap overlay DOM tests passed.');
