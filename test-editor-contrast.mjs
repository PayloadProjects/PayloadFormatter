import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [css, treeCss, textCss, html] = await Promise.all(
  ['style.css','tree-view.css','text-editor.css','index.html'].map(file =>
    readFile(new URL(file,import.meta.url),'utf8')),
);
function declarations(source, selector) {
  const escaped=selector.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const body=source.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))?.[1];
  assert.ok(body, `${selector}: style block exists`);
  return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([,k,v])=>[k,v.trim()]));
}
const dark=declarations(css,':root');
const light={...dark,...declarations(css,':root[data-theme="light"]')};
function resolve(tokens,key,seen=new Set()) {
  assert.ok(!seen.has(key),`circular token: ${key}`);seen.add(key);
  const value=tokens[key];assert.ok(value,`missing token: ${key}`);
  const ref=value.match(/^var\((--[\w-]+)\)$/)?.[1];
  return ref?resolve(tokens,ref,seen):value;
}
// https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum
function luminance(hex) {
  assert.match(hex,/^#[0-9a-f]{6}$/i);
  const rgb=hex.slice(1).match(/../g).map(c=>parseInt(c,16)/255)
    .map(c=>c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4);
  return rgb[0]*0.2126+rgb[1]*0.7152+rgb[2]*0.0722;
}
function contrast(a,b) {const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
assert.ok(luminance(resolve(dark,'--editor-bg'))<.006,'dark reading surface stays near-black');
assert.ok(luminance(resolve(dark,'--editor-bg'))<luminance(resolve(dark,'--page-bg')));
assert.ok(luminance(resolve(light,'--editor-bg'))>.9,'light mode remains light');
const readingTokens=['--editor-text','--syntax-key','--syntax-string','--syntax-number','--syntax-boolean','--syntax-attribute','--syntax-muted'];
for(const [theme,tokens] of [['dark',dark],['light',light]]) {
  for(const token of readingTokens) {
    const foreground=resolve(tokens,token);
    assert.ok(contrast(foreground,resolve(tokens,'--editor-bg')) >= (theme==='dark'?7:4.5),`${theme} ${token}: reading contrast`);
    for(const state of ['--tree-hover-bg','--tree-focus-bg','--tree-match-bg','--tree-hit-bg','--code-selection-bg']) {
      assert.ok(contrast(foreground,resolve(tokens,state))>=4.5,`${theme} ${token} on ${state}: text remains readable`);
    }
  }
  assert.notEqual(resolve(tokens,'--syntax-key'),resolve(tokens,'--syntax-string'),'names and values differ');
  assert.notEqual(resolve(tokens,'--syntax-number'),resolve(tokens,'--syntax-string'),'numbers and strings differ');
  assert.notEqual(resolve(tokens,'--tree-match-bg'),resolve(tokens,'--tree-hit-bg'),'active search result is distinct');
}
assert.match(css,/\.editor\s*\{[^}]*background:\s*var\(--editor-bg\)/);
assert.match(css,/\.editor-body\s*\{[^}]*background:\s*var\(--editor-bg\)/);
assert.match(treeCss,/\.tree-panel\s*\{[^}]*background:\s*var\(--editor-bg\)/);
assert.match(treeCss,/\.tree-view\s*\{[^}]*background:\s*var\(--editor-bg\)/);
for(const token of readingTokens.slice(1)) {
  assert.ok(treeCss.includes(`var(${token})`));assert.ok(textCss.includes(`var(${token})`));
}
assert.match(treeCss,/\.tree-hit \.tree-hit-text\s*\{[^}]*box-shadow:\s*0 0 0 1px var\(--tree-hit-border\)/,'current search hit has a non-color-only cue');
for(const file of ['style','tree-view','text-editor']) assert.match(html,new RegExp(file+'\\.css\\?v=[\\w.-]+'));
console.log('Text/Tree syntax contrast passed in both themes, including active/selected states.');
