import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const [html, css, treeCss, ui, build] = await Promise.all(
  ['index.html', 'style.css', 'tree-view.css', 'ui-controls.js', 'build.mjs']
    .map((file) => readFile(new URL(file, import.meta.url), 'utf8')),
);

// Preserve the user's action order in the DOM and CSS, not just the labels.
const actions = html.match(/<div class="actions"[^>]*>([\s\S]*?)<\/div>/)?.[1];
assert.ok(actions, 'formatting actions exist');
assert.deepEqual([...actions.matchAll(/<button\b[^>]*id="([^"]+)"/g)].map((m) => m[1]),
  ['clearBtn', 'pasteFormatBtn', 'copyBtn']);
assert.doesNotMatch(css, /(?:row|column)-reverse|(?:^|[;{])\s*order\s*:/,
  'CSS must not visually move Clear out of its original first position');
assert.match(css, /grid-template-columns:\s*auto minmax\(0, 1fr\) auto/,
  'mobile keeps all three actions in the same order');
assert.ok(html.indexOf('class="editor-body"') < html.indexOf('class="toolbar"'));
assert.ok(!html.includes('brand-subtitle') && !html.includes('workspace-note'));
assert.equal((html.match(/Local only/g) || []).length, 1);
assert.ok(html.includes('aria-describedby="editorHelp"'));
assert.ok(html.includes('Ctrl/Cmd + Enter to format.'));
assert.match(html, /ui-controls\.js\?v=[\w.-]+/);
assert.ok(build.includes("'ui-controls.js'"));
assert.ok(treeCss.includes('background: var(--selected-bg)'));
assert.ok(treeCss.includes('color: var(--heading)'));
assert.ok(css.includes('prefers-reduced-motion'));

// Exercise the actual disclosure and busy indicator in a small DOM harness.
class Element {
  constructor(id, parent = null) {
    this.id = id; this.parent = parent; this.hidden = false;
    this.attributes = new Map(); this.listeners = new Map();
    this.textContent = ''; this.disabled = false;
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener); this.listeners.set(type, listeners);
  }
  fire(type, props = {}) {
    const event = { target: this, preventDefault() {}, stopPropagation() {}, ...props };
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
  contains(target) { return target === this || !!target?.parent && this.contains(target.parent); }
  focus() { focused = this; }
  closest(selector) { return selector === 'button' ? this : null; }
}
let focused;
let busy = false;
let syncBusy;
const options = new Element('options');
const toggle = new Element('toggle', options);
const menu = new Element('menu', options); menu.hidden = true;
const expand = new Element('expand', menu);
const action = new Element('action');
const label = new Element('label'); label.textContent = 'Paste & Format';
action.querySelector = () => label;
const text = new Element('viewTextBtn');
const tree = new Element('viewTreeBtn');
const outside = new Element('outside');
const document = new Element('document');
document.body = { classList: { contains: () => busy } };
document.querySelector = (s) => ({
  '#treeMoreBtn': toggle, '#treeMenu': menu, '.tree-options': options,
  '#pasteFormatBtn': action,
}[s] || null);
document.getElementById = (id) => id === 'viewTextBtn' ? text : tree;
const MutationObserver = class {
  constructor(listener) { syncBusy = listener; }
  observe(target, config) {
    assert.equal(target, document.body);
    assert.deepEqual(Array.from(config.attributeFilter), ['class']);
    assert.equal(config.subtree, undefined, 'no full-tree observer');
  }
};
vm.runInNewContext(ui, { document, MutationObserver });
assert.equal(action.attributes.get('aria-busy'), 'false');
toggle.fire('click');
assert.equal(menu.hidden, false);
assert.equal(toggle.attributes.get('aria-expanded'), 'true');
options.fire('keydown', { key: 'Escape' });
assert.equal(menu.hidden, true);
assert.equal(focused, toggle);
toggle.fire('click');
menu.fire('click', { target: expand });
assert.equal(menu.hidden, true);
toggle.fire('click');
document.fire('pointerdown', { target: outside });
assert.equal(menu.hidden, true);
toggle.fire('click');
options.fire('focusout', { relatedTarget: expand });
assert.equal(menu.hidden, false);
options.fire('focusout', { relatedTarget: outside });
assert.equal(menu.hidden, true);
toggle.fire('click');
text.fire('click');
assert.equal(menu.hidden, true);
toggle.fire('click');
busy = true; syncBusy();
assert.equal(menu.hidden, true);
assert.equal(action.attributes.get('aria-busy'), 'true');
assert.equal(label.textContent, 'Working\u2026');
busy = false; syncBusy();
assert.equal(label.textContent, 'Paste & Format');
assert.equal(action.attributes.get('aria-busy'), 'false');
console.log('All UI cleanup interaction and layout contract tests passed.');
