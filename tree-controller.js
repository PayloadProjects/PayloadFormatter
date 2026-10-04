import { createTreeView } from './tree-view.js';

const VIEW_STORAGE_KEY = 'payload-formatter:view:v1';
const LARGE_TREE_CHARS = 512 * 1024;
// Hard ceiling: above this the tree would try to build hundreds of thousands
// of DOM nodes and hang the tab. Text view stays available for any size.
const MAX_TREE_CHARS = 2 * 1024 * 1024;

// Connects the Text/Tree toggle, the tree toolbar and the tree itself to the
// rest of the app. app.js supplies the payload and the formatter; this module
// never reads the editor directly, so large-payload mode keeps working.
export function createTreeController({ getText, detectMode, setStatus, nextPaint, onFormat, onPasteText }) {
  const frame = document.querySelector('#editorFrame');
  const textBtn = document.querySelector('#viewTextBtn');
  const treeBtn = document.querySelector('#viewTreeBtn');
  const container = document.querySelector('#treeView');
  const search = document.querySelector('#treeSearch');
  const prevBtn = document.querySelector('#treePrev');
  const nextBtn = document.querySelector('#treeNext');
  const countLabel = document.querySelector('#treeMatchCount');
  const expandBtn = document.querySelector('#treeExpandAll');
  const collapseBtn = document.querySelector('#treeCollapseAll');

  if (!frame || !textBtn || !treeBtn || !container) {
    return { refresh: async () => {}, isTree: () => false, setView: () => {} };
  }

  const tree = createTreeView(container, { onCopyPath: copyPath });
  let view = readStoredView();
  let token = 0;
  let searchTimer = 0;
  let hasTree = false;

  applyView();
  setTools(false);

  textBtn.addEventListener('click', () => setView('text'));
  treeBtn.addEventListener('click', () => setView('tree'));

  expandBtn?.addEventListener('click', () => {
    const { limited } = tree.expandAll();
    setStatus(
      limited ? 'Expanded the first levels. Open deeper nodes individually.' : 'Expanded all nodes.',
      limited ? 'warning' : 'success',
    );
  });
  collapseBtn?.addEventListener('click', () => tree.collapseAll());

  search?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 180);
  });
  search?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      clearTimeout(searchTimer);
      if (!tree.step) return;
      // First Enter after typing runs the search; later ones step through hits.
      if (searchPending()) runSearch();
      else showCount(tree.step(event.shiftKey ? -1 : 1));
    } else if (event.key === 'Escape' && search.value) {
      search.value = '';
      runSearch();
    }
  });
  prevBtn?.addEventListener('click', () => showCount(tree.step(-1)));
  nextBtn?.addEventListener('click', () => showCount(tree.step(1)));

  // The editor is hidden in tree view, so keep the two global shortcuts alive.
  document.addEventListener('keydown', (event) => {
    if (view !== 'tree') return;
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      onFormat();
    }
  });
  document.addEventListener('paste', (event) => {
    if (view !== 'tree') return;
    const target = event.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (!text) return;
    event.preventDefault();
    onPasteText(text);
  });

  let lastQuery = '';
  function searchPending() {
    return search.value.trim().toLowerCase() !== lastQuery;
  }

  function runSearch() {
    lastQuery = search.value.trim().toLowerCase();
    showCount(tree.find(search.value), lastQuery);
  }

  function showCount(result, query = lastQuery) {
    if (!countLabel) return;
    if (!query) {
      countLabel.textContent = '';
    } else if (!result || result.total === 0) {
      countLabel.textContent = result?.truncated ? 'No matches yet' : 'No matches';
    } else {
      countLabel.textContent = `${result.index + 1} / ${result.total}${result.truncated ? '+' : ''}`;
    }
  }

  function setTools(enabled) {
    for (const control of [search, prevBtn, nextBtn, expandBtn, collapseBtn]) {
      if (control) control.disabled = !enabled;
    }
  }

  function readStoredView() {
    try {
      return sessionStorage.getItem(VIEW_STORAGE_KEY) === 'tree' ? 'tree' : 'text';
    } catch (_) {
      return 'text';
    }
  }

  function applyView() {
    frame.dataset.view = view;
    textBtn.setAttribute('aria-pressed', String(view === 'text'));
    treeBtn.setAttribute('aria-pressed', String(view === 'tree'));
  }

  function setView(next) {
    if (next !== 'tree' && next !== 'text') return;
    view = next;
    applyView();
    try { sessionStorage.setItem(VIEW_STORAGE_KEY, view); } catch (_) {}
    if (view === 'tree') refresh();
  }

  async function refresh() {
    if (view !== 'tree') return;
    const id = ++token;
    const text = getText();

    hasTree = false;
    if (!text) {
      tree.clear('Nothing to show yet. Click anywhere in the panel to paste & format.');
      setTools(false);
      showCount(null, '');
      return;
    }

    const mode = detectMode(text);
    if (!mode) {
      tree.clear('Could not detect JSON or XML, so there is no tree to show.');
      setTools(false);
      return;
    }

    // Refuse before building: a multi-MB payload is hundreds of thousands of
    // DOM nodes, which hangs the tab. The message states the cap and the
    // way out (Text view handles any size).
    if (text.length >= MAX_TREE_CHARS) {
      tree.clear(
        `Tree view supports payloads up to ${(MAX_TREE_CHARS / 1048576).toFixed(0)} MB — ` +
        `this one is ${(text.length / 1048576).toFixed(1)} MB. Use Text view for large payloads.`,
      );
      setTools(false);
      showCount(null, '');
      setStatus('Tree view skipped: payload too large.', 'warning');
      return;
    }

    if (text.length >= LARGE_TREE_CHARS) {
      setStatus('Building tree…');
      await nextPaint();
      if (id !== token) return;
    }

    const result = tree.show(text, mode);
    if (id !== token) return;

    if (!result.ok) {
      setTools(false);
      showCount(null, '');
      setStatus(`Tree unavailable: ${result.error}`, 'error');
      return;
    }

    hasTree = true;
    setTools(true);
    if (search?.value.trim()) runSearch();
    else showCount(null, '');
    if (text.length >= LARGE_TREE_CHARS) setStatus('Tree ready.', 'success');
  }

  async function copyPath(path) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(path);
      } else {
        const scratch = document.createElement('textarea');
        scratch.value = path;
        scratch.setAttribute('readonly', '');
        scratch.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
        document.body.appendChild(scratch);
        scratch.select();
        const copied = document.execCommand('copy');
        scratch.remove();
        if (!copied) throw new Error('copy unsupported');
      }
      setStatus(`Copied path ${path}`, 'success');
    } catch (_) {
      setStatus('Browser blocked clipboard access, so the path was not copied.', 'error');
    }
  }

  return {
    refresh,
    isTree: () => view === 'tree',
    hasTree: () => hasTree,
    setView,
  };
}
