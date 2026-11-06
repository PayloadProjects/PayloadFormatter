// Text-view search box in the editor strip: type to find (case-insensitive),
// Enter / Shift+Enter or the arrows to step through matches, Escape to
// clear. Matches are highlighted in the editor and counted ("3 / 120").
// Ctrl/Cmd+F anywhere in text view focuses the box, so the browser's own
// find bar (which cannot see lines the editor has not rendered) never opens.
const SEARCH_DEBOUNCE_MS = 150;
const COUNT_DEBOUNCE_MS = 250;

export function createTextSearch({ editor, editorHost, isTextView, isPreview }) {
  const input = document.querySelector('#textSearch');
  const prevBtn = document.querySelector('#textPrev');
  const nextBtn = document.querySelector('#textNext');
  const countLabel = document.querySelector('#textMatchCount');
  const api = editor?.search;
  if (!input || !api) return { refresh() {} };

  let searchTimer = 0;
  let countTimer = 0;
  let lastQuery = '';

  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      clearTimeout(searchTimer);
      // First Enter after typing runs the search; later ones step through hits.
      if (input.value !== lastQuery) runSearch();
      else step(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (input.value) {
        input.value = '';
        runSearch();
      } else {
        editorHost.focus();
      }
    }
  });
  prevBtn?.addEventListener('click', () => step(-1));
  nextBtn?.addEventListener('click', () => step(1));

  api.onFind(focusBox);
  document.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'f') return;
    if (!isTextView()) return;
    event.preventDefault();
    focusBox();
  });
  // Edits and new payloads change the matches: refresh the count (debounced,
  // since counting walks the whole document).
  api.onChange(() => {
    if (!lastQuery) return;
    clearTimeout(countTimer);
    countTimer = setTimeout(showCount, COUNT_DEBOUNCE_MS);
  });
  setButtons();

  function focusBox() {
    const selected = api.selectedText();
    if (selected && selected !== input.value) {
      input.value = selected;
      runSearch();
    }
    input.focus();
    input.select();
  }

  function runSearch() {
    lastQuery = input.value;
    api.setQuery(lastQuery);
    if (lastQuery) api.next();
    setButtons();
    showCount();
  }

  function step(direction) {
    if (!lastQuery) return;
    if (direction < 0) api.previous();
    else api.next();
    showCount();
  }

  function setButtons() {
    const enabled = !!lastQuery;
    if (prevBtn) prevBtn.disabled = !enabled;
    if (nextBtn) nextBtn.disabled = !enabled;
  }

  function showCount() {
    clearTimeout(countTimer);
    if (!countLabel) return;
    if (!lastQuery) {
      countLabel.textContent = '';
      return;
    }
    const { total, index, truncated } = api.stats();
    const scope = isPreview() ? ' in preview' : '';
    if (total === 0) {
      countLabel.textContent = `No matches${scope}`;
    } else {
      const amount = `${total}${truncated ? '+' : ''}`;
      // The current match's position is unknown when the caret is not on a
      // match, or the match lies past the counting cap: show the total only.
      countLabel.textContent = index >= 0
        ? `${index + 1} / ${amount}${scope}`
        : `${amount} ${total === 1 ? 'match' : 'matches'}${scope}`;
    }
  }

  return {
    // Re-counts after the app swaps the payload (window switch, history).
    refresh: showCount,
  };
}
