// Bundle entry for vendor/codemirror/codemirror.js. The site ships without a
// build step, so the CodeMirror packages are pre-bundled into one ES module
// and committed. Rebuild after changing this file or the pinned versions in
// package.json:  npm run vendor:codemirror
export { EditorState, Compartment, Prec, RangeSetBuilder } from '@codemirror/state';
export {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  ViewPlugin,
  Decoration,
} from '@codemirror/view';
export { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
export { syntaxHighlighting, HighlightStyle, bracketMatching } from '@codemirror/language';
export { json } from '@codemirror/lang-json';
export { xml } from '@codemirror/lang-xml';
export {
  search,
  highlightSelectionMatches,
  SearchQuery,
  setSearchQuery,
  getSearchQuery,
  findNext,
  findPrevious,
} from '@codemirror/search';
export { tags } from '@lezer/highlight';
