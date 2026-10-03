import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const [html, css, treeCss, ui, build, controllerSource] = await Promise.all(
  ['index.html', 'style.css', 'tree-view.css', 'ui-controls.js', 'build.mjs', 'tree-controller.js']
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

// Frequent actions are ordinary visible toolbar buttons, never a disclosure.
const treeActions = html.match(/<div class="tree-actions"[^>]*>([\s\S]*?)<\/div>/)?.[1];
assert.ok(treeActions, 'tree actions have an inline toolbar group');
assert.deepEqual([...treeActions.matchAll(/<button\b[^>]*id="([^"]+)"/g)].map((m) => m[1]),
  ['treeExpandAll', 'treeCollapseAll']);
assert.doesNotMatch(treeActions, /\bhidden\b|aria-hidden|<details/,
  'both actions must be exposed without opening another control');
assert.doesNotMatch(html, /id="(?:treeMoreBtn|treeMenu)"/,
  'no overflow button is needed for Expand all or Collapse all');
assert.doesNotMatch(treeCss, /\.tree-menu|\.tree-options/,
  'old dropdown positioning must not hide or overlay the actions');

// Exercise the real presentation script; busy status must work without a menu.
let busy = false;
let syncBusy;
const attributes = new Map();
const label = { textContent: 'Paste & Format' };
const action = {
  querySelector: () => label,
  setAttribute: (name, value) => attributes.set(name, value),
};
const document = {
  body: { classList: { contains: () => busy } },
  querySelector: (selector) => selector === '#pasteFormatBtn' ? action : null,
};
const MutationObserver = class {
  constructor(listener) { syncBusy = listener; }
  observe(target, config) {
    assert.equal(target, document.body);
    assert.deepEqual(Array.from(config.attributeFilter), ['class']);
    assert.equal(config.subtree, undefined, 'no full-tree observer');
  }
};
vm.runInNewContext(ui, { document, MutationObserver });
assert.equal(attributes.get('aria-busy'), 'false');
busy = true; syncBusy();
assert.equal(attributes.get('aria-busy'), 'true');
assert.equal(label.textContent, 'Working\u2026');
busy = false; syncBusy();
assert.equal(label.textContent, 'Paste & Format');
assert.equal(attributes.get('aria-busy'), 'false');

// Exercise the existing controller handlers with a small view adapter. Real
// browser tests separately cover rendering, visibility, and keyboard activation.
class Control {
  constructor() {
    this.dataset = {}; this.attributes = new Map(); this.listeners = new Map();
    this.disabled = false; this.value = ''; this.textContent = '';
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener); this.listeners.set(type, listeners);
  }
  click() {
    if (this.disabled) return;
    for (const listener of this.listeners.get('click') || []) listener({ target: this });
  }
}
for (const mode of ['json', 'xml']) {
  const controls = new Map([
    'editorFrame', 'viewTextBtn', 'viewTreeBtn', 'treeView', 'treeSearch',
    'treePrev', 'treeNext', 'treeMatchCount', 'treeExpandAll', 'treeCollapseAll',
  ].map((id) => [id, new Control()]));
  let text = '';
  let expands = 0;
  let collapses = 0;
  const context = vm.createContext({
    document: {
      querySelector: (selector) => controls.get(selector.slice(1)) || null,
      addEventListener() {},
    },
    sessionStorage: { getItem: () => 'tree', setItem() {} },
    setTimeout, clearTimeout,
    createTreeView: () => ({
      clear() {},
      show: (source, detectedMode) => {
        assert.equal(source, text);
        assert.equal(detectedMode, mode);
        return { ok: true };
      },
      expandAll: () => { expands += 1; return { limited: false }; },
      collapseAll: () => { collapses += 1; },
    }),
  });
  const script = controllerSource
    .replace(/^import[^\n]+\n/, '')
    .replace('export function createTreeController', 'function createTreeController');
  vm.runInContext(script, context);
  const controller = context.createTreeController({
    getText: () => text, detectMode: () => mode,
    setStatus() {}, nextPaint: async () => {}, onFormat() {}, onPasteText() {},
  });
  const expand = controls.get('treeExpandAll');
  const collapse = controls.get('treeCollapseAll');
  await controller.refresh();
  assert.equal(expand.disabled, true, 'empty trees disable expansion');
  assert.equal(collapse.disabled, true, 'empty trees disable collapse');
  text = mode === 'json' ? '{"nested":{"value":1}}' : '<root><nested><value>1</value></nested></root>';
  await controller.refresh();
  assert.equal(expand.disabled, false);
  assert.equal(collapse.disabled, false);
  expand.click();
  assert.equal(expands, 1, `${mode}: one click expands`);
  collapse.click();
  assert.equal(collapses, 1, `${mode}: one click collapses`);
  expand.click(); collapse.click();
  assert.equal(expands, 2, `${mode}: repeated expansion needs no menu`);
  assert.equal(collapses, 2, `${mode}: repeated collapse needs no menu`);
}
console.log('All UI cleanup and direct tree action tests passed.');
