import {
  EditorState,
  Compartment,
  Prec,
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  defaultKeymap,
  history,
  historyKeymap,
  syntaxHighlighting,
  HighlightStyle,
  bracketMatching,
  json,
  xml,
  search,
  searchKeymap,
  highlightSelectionMatches,
  tags,
} from './vendor/codemirror/codemirror.js';

// The text view is a CodeMirror 6 editor. Unlike a native textarea, which
// lays out every line of the payload on every change (seconds per keystroke
// at 8MB), CodeMirror only renders the lines in view, so multi-megabyte
// payloads stay editable, highlighted and searchable (Ctrl/Cmd+F).
//
// The host element (#payloadInput) keeps the textarea-shaped contract the
// rest of the app relies on: value, selectionStart/End, setSelectionRange,
// select, focus, readOnly, wrap, scrollTop/Left, and an 'input' event after
// every user edit. Setting `value` replaces the document wholesale (fresh
// undo history, no 'input' event), like assigning a textarea's value.

// Token colors come from the theme's --syntax-* variables (text-editor.css).
const highlightStyle = HighlightStyle.define([
  { tag: tags.propertyName, class: 'syntax-key' },
  { tag: [tags.string, tags.attributeValue], class: 'syntax-string' },
  { tag: tags.number, class: 'syntax-number' },
  { tag: [tags.bool, tags.null, tags.keyword], class: 'syntax-boolean' },
  { tag: [tags.tagName, tags.standard(tags.tagName)], class: 'syntax-tag' },
  { tag: tags.attributeName, class: 'syntax-attribute' },
  { tag: tags.character, class: 'syntax-entity' },
  { tag: [tags.comment, tags.processingInstruction, tags.documentMeta], class: 'syntax-comment' },
  {
    tag: [tags.punctuation, tags.separator, tags.bracket, tags.squareBracket, tags.brace, tags.angleBracket, tags.operator],
    class: 'syntax-muted',
  },
]);

const editorTheme = EditorView.theme({
  '&': { height: '100%', color: 'var(--editor-text)', backgroundColor: 'var(--editor-bg)' },
  '&.cm-focused': { outline: 'none', boxShadow: 'inset 0 0 0 1px var(--editor-focus)' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: 'inherit' },
  '.cm-content': { padding: '12px 0', caretColor: 'var(--editor-caret)' },
  '.cm-line': { padding: '0 12px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--editor-caret)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    { backgroundColor: 'var(--code-selection-bg)' },
  '.cm-activeLine': { backgroundColor: 'var(--tree-hover-bg)' },
  '.cm-gutters': {
    backgroundColor: 'var(--editor-bg)',
    color: 'var(--syntax-muted)',
    borderRight: '1px solid var(--guide)',
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--editor-text)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px' },
  '.cm-selectionMatch': { backgroundColor: 'var(--tree-match-bg)' },
  '.cm-searchMatch': { backgroundColor: 'var(--tree-match-bg)', outline: '1px solid var(--tree-hit-border)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--tree-hit-bg)' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--tree-match-bg)', outline: '1px solid var(--guide)' },
  '.cm-panels': { backgroundColor: 'var(--strip-bg)', color: 'var(--editor-text)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--panel-border)' },
});

function languageFor(mode) {
  if (mode === 'json') return json();
  if (mode === 'xml') return xml();
  return [];
}

export function createSyntaxEditor(host) {
  if (!host) return { refresh() {} };
  const root = document.documentElement;
  const language = new Compartment();
  const wrapping = new Compartment();
  const readOnly = new Compartment();
  let mode = null;
  let wrapOn = root.dataset.wrap === 'on';
  let readOnlyOn = false;
  // doc.toString() on a multi-megabyte document is not free and the app
  // reads `value` several times per edit: cache it per (immutable) doc.
  let cachedDoc = null;
  let cachedText = '';

  function extensions() {
    return [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      highlightActiveLine(),
      bracketMatching(),
      highlightSelectionMatches(),
      search({ top: true }),
      syntaxHighlighting(highlightStyle),
      // Ctrl/Cmd+Enter formats (the app listens for it on the host); stop
      // the default keymap from also inserting a blank line.
      Prec.highest(keymap.of([{ key: 'Mod-Enter', run: () => true }])),
      keymap.of([...searchKeymap, ...historyKeymap, ...defaultKeymap]),
      language.of(languageFor(mode)),
      wrapping.of(wrapOn ? EditorView.lineWrapping : []),
      readOnly.of(EditorState.readOnly.of(readOnlyOn)),
      editorTheme,
      EditorView.contentAttributes.of({
        'aria-label': 'JSON or XML payload',
        'aria-describedby': 'editorHelp',
        spellcheck: 'false',
        autocorrect: 'off',
        autocapitalize: 'off',
      }),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        syncEmpty();
        host.dispatchEvent(new Event('input', { bubbles: true }));
      }),
    ];
  }

  const view = new EditorView({
    parent: host,
    state: EditorState.create({ doc: '', extensions: extensions() }),
  });

  function text() {
    const doc = view.state.doc;
    if (doc !== cachedDoc) {
      cachedDoc = doc;
      cachedText = doc.toString();
    }
    return cachedText;
  }

  function syncEmpty() {
    host.classList.toggle('is-empty', view.state.doc.length === 0);
  }

  function clamp(offset) {
    const length = view.state.doc.length;
    const value = Number(offset);
    return Number.isFinite(value) ? Math.min(Math.max(0, Math.trunc(value)), length) : length;
  }

  function reconfigure(compartment, extension) {
    view.dispatch({ effects: compartment.reconfigure(extension) });
  }

  Object.defineProperties(host, {
    value: {
      configurable: true,
      get: text,
      set(next) {
        const doc = String(next ?? '');
        view.setState(EditorState.create({ doc, extensions: extensions() }));
        cachedDoc = view.state.doc;
        cachedText = doc.includes('\r') ? cachedDoc.toString() : doc;
        syncEmpty();
      },
    },
    selectionStart: {
      configurable: true,
      get: () => view.state.selection.main.from,
      set(next) { host.setSelectionRange(next, Math.max(clamp(next), view.state.selection.main.to)); },
    },
    selectionEnd: {
      configurable: true,
      get: () => view.state.selection.main.to,
      set(next) { host.setSelectionRange(Math.min(view.state.selection.main.from, clamp(next)), next); },
    },
    readOnly: {
      configurable: true,
      get: () => readOnlyOn,
      set(next) {
        readOnlyOn = !!next;
        reconfigure(readOnly, EditorState.readOnly.of(readOnlyOn));
      },
    },
    wrap: {
      configurable: true,
      get: () => (wrapOn ? 'soft' : 'off'),
      set(next) {
        const on = next === 'soft' || next === 'hard';
        if (on === wrapOn) return;
        wrapOn = on;
        reconfigure(wrapping, wrapOn ? EditorView.lineWrapping : []);
      },
    },
    scrollTop: {
      configurable: true,
      get: () => view.scrollDOM.scrollTop,
      set(next) { view.scrollDOM.scrollTop = next; },
    },
    scrollLeft: {
      configurable: true,
      get: () => view.scrollDOM.scrollLeft,
      set(next) { view.scrollDOM.scrollLeft = next; },
    },
    setSelectionRange: {
      configurable: true,
      value(start, end = start) {
        const anchor = clamp(start);
        view.dispatch({ selection: { anchor, head: Math.max(anchor, clamp(end)) } });
      },
    },
    select: {
      configurable: true,
      value() { view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }); },
    },
    focus: {
      configurable: true,
      value() { view.focus(); },
    },
  });
  syncEmpty();

  return {
    view,
    // Switches the grammar when the detected payload type changes. Called on
    // every UI refresh, so an unchanged mode is a no-op.
    refresh(nextMode = mode) {
      if (nextMode === mode) return;
      mode = nextMode;
      reconfigure(language, languageFor(mode));
    },
  };
}
