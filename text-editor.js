import {
  EditorState,
  Compartment,
  Prec,
  RangeSetBuilder,
  EditorView,
  ViewPlugin,
  Decoration,
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
  highlightSelectionMatches,
  SearchQuery,
  setSearchQuery,
  getSearchQuery,
  findNext,
  findPrevious,
  tags,
} from './vendor/codemirror/codemirror.js';

// The text view is a CodeMirror 6 editor. Unlike a native textarea, which
// lays out every line of the payload on every change (seconds per keystroke
// at 8MB), CodeMirror only renders the lines in view, so multi-megabyte
// payloads stay editable, highlighted and searchable. Search is driven by
// the text-view search box in the editor strip (text-search.js).
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
});

// Counting stops here: past this many matches the label shows "N+".
const MAX_COUNTED_MATCHES = 10_000;

const matchMark = Decoration.mark({ class: 'cm-searchMatch' });
const selectedMatchMark = Decoration.mark({ class: 'cm-searchMatch cm-searchMatch-selected' });

// Marks the current query's matches in the visible lines only (cheap at any
// document size). CodeMirror's built-in highlighter only runs while its own
// search panel is open; the app uses the strip search box instead.
const searchMatchHighlighter = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = this.build(view);
  }

  update(update) {
    if (update.docChanged || update.viewportChanged || update.selectionSet
        || getSearchQuery(update.state) !== getSearchQuery(update.startState)) {
      this.decorations = this.build(update.view);
    }
  }

  build(view) {
    const query = getSearchQuery(view.state);
    if (!query.search || !query.valid) return Decoration.none;
    const builder = new RangeSetBuilder();
    const { main } = view.state.selection;
    for (const { from, to } of view.visibleRanges) {
      const cursor = query.getCursor(view.state, from, to);
      for (let match = cursor.next(); !match.done; match = cursor.next()) {
        const { from: start, to: end } = match.value;
        builder.add(start, end, start === main.from && end === main.to ? selectedMatchMark : matchMark);
      }
    }
    return builder.finish();
  }
}, { decorations: (plugin) => plugin.decorations });

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
  // The strip search box's query; re-applied whenever the document is
  // replaced (a new payload gets a fresh editor state).
  let searchText = '';
  const changeListeners = new Set();
  const findListeners = new Set();
  const notifyChange = () => { for (const listener of changeListeners) listener(); };

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
      search(),
      searchMatchHighlighter,
      syntaxHighlighting(highlightStyle),
      Prec.highest(keymap.of([
        // Ctrl/Cmd+Enter formats (the app listens for it on the host); stop
        // the default keymap from also inserting a blank line.
        { key: 'Mod-Enter', run: () => true },
        // Find goes to the strip search box; F3 / Mod-g step through hits.
        { key: 'Mod-f', run: () => { for (const listener of findListeners) listener(); return true; } },
        { key: 'F3', run: findNext, shift: findPrevious },
        { key: 'Mod-g', run: findNext, shift: findPrevious },
      ])),
      keymap.of([...historyKeymap, ...defaultKeymap]),
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
        notifyChange();
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

  function applySearchQuery() {
    const query = new SearchQuery({ search: searchText, caseSensitive: false, literal: true });
    view.dispatch({ effects: setSearchQuery.of(query) });
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
        if (searchText) applySearchQuery();
        notifyChange();
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
    search: {
      // Case-insensitive literal search, highlighted in the visible lines.
      setQuery(text) {
        searchText = String(text ?? '');
        applySearchQuery();
      },
      // Select and scroll to the next/previous match (wrapping around).
      // Returns false when there is no match.
      next: () => !!searchText && findNext(view),
      previous: () => !!searchText && findPrevious(view),
      // { total, index, truncated }: index is the selected match, or -1.
      stats() {
        const query = getSearchQuery(view.state);
        if (!searchText || !query.valid) return { total: 0, index: -1, truncated: false };
        const { main } = view.state.selection;
        const cursor = query.getCursor(view.state);
        let total = 0;
        let index = -1;
        for (let match = cursor.next(); !match.done; match = cursor.next()) {
          if (match.value.from === main.from && match.value.to === main.to) index = total;
          total += 1;
          if (total >= MAX_COUNTED_MATCHES) return { total, index, truncated: true };
        }
        return { total, index, truncated: false };
      },
      // Short single-line selection, to seed the search box on Ctrl/Cmd+F.
      selectedText() {
        const { main } = view.state.selection;
        if (main.empty || main.to - main.from > 200) return '';
        const text = view.state.sliceDoc(main.from, main.to);
        return text.includes('\n') ? '' : text;
      },
      // Called after every document change (user edit or new payload).
      onChange(listener) { changeListeners.add(listener); },
      // Called when Ctrl/Cmd+F is pressed inside the editor.
      onFind(listener) { findListeners.add(listener); },
    },
  };
}
