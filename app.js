import { detectPayloadMode } from './payload-detection.js';
import { createTreeController } from './tree-controller.js';
import { createSyntaxEditor } from './text-editor.js';
import { createWindowManager, MAX_WINDOWS } from './window-manager.js';
import { initEpochPopover } from './epoch-popover.js';
import {
  getTabId,
  saveWindowHistory,
  loadWindowHistories,
  deleteWindowHistory,
  cleanupStaleHistories,
  requestPersistence,
} from './history-store.js';

const STORAGE_KEY = 'payload-formatter:draft:v1';
const WINDOWS_KEY = 'payload-formatter:windows:v1';
const WINDOW_DRAFT_PREFIX = 'payload-formatter:window-draft:';
const THEME_STORAGE_KEY = 'payload-formatter:theme:v1';
const WRAP_STORAGE_KEY = 'payload-formatter:wrap:v1';
const MAX_DRAFT_BYTES = 2 * 1024 * 1024;
// History entries persist to IndexedDB up to this size, stored as Blobs past
// 2MB (see history-store.js). Larger than the draft cap on purpose:
// sessionStorage is synchronous with a ~5MB quota, while IndexedDB quotas
// are in the GB range and writes are async.
const MAX_HISTORY_PERSIST_BYTES = 20 * 1024 * 1024;
// Hard ceiling for a single payload: above this the tab risks an out-of-memory
// crash (the string, its formatted copy, and worker clones add up fast).
// Refused up front with an honest message instead of dying mid-paste.
const HARD_MAX_PAYLOAD_CHARS = 100 * 1024 * 1024;
const LARGE_UI_PAYLOAD_CHARS = 512 * 1024;
const LARGE_PAYLOAD_CHARS = 10 * 1024 * 1024;
const PREVIEW_CHARS = 120_000;
const BASE_FORMAT_TIMEOUT_MS = 30_000;
const FORMAT_TIMEOUT_PER_MB_MS = 5_000;
const MAX_FORMAT_TIMEOUT_MS = 120_000;

const editor = document.querySelector('#payloadInput');
const editorBody = document.querySelector('.editor-body');
const pasteFormatBtn = document.querySelector('#pasteFormatBtn');
const copyBtn = document.querySelector('#copyBtn');
const clearBtn = document.querySelector('#clearBtn');
const statusText = document.querySelector('#statusText');
const typeBadge = document.querySelector('#typeBadge');
const metaText = document.querySelector('#metaText');
const largeNotice = document.querySelector('#largeNotice');
const themeToggleBtn = document.querySelector('#themeToggleBtn');
const themeIcon = document.querySelector('#themeIcon');
const themeLabel = document.querySelector('#themeLabel');
const wrapToggleBtn = document.querySelector('#wrapToggleBtn');
const historyBackBtn = document.querySelector('#historyBackBtn');
const historyForwardBtn = document.querySelector('#historyForwardBtn');
const windowTabs = document.querySelector('#windowTabs');
const newWindowBtn = document.querySelector('#newWindowBtn');
const root = document.documentElement;

let busy = false;
let copying = false;
let requestId = 0;
let editRevision = 0;
let persistTimer = 0;
let inputUiFrame = 0;
let worker = null;
let largeText = null;
let largeFormatted = false;
let pastePending = false;
let historyTimer = 0;
// In-flight history persistence writes, so tests (and only tests) can await
// them. Production code fires these writes and never waits.
const pendingHistorySaves = new Set();
// One id per tab, stable across refresh: history records are keyed by it so
// two tabs never share paste history, mirroring the sessionStorage drafts.
const tabId = getTabId();
const pending = new Map();
const syntaxEditor = createSyntaxEditor(editor);
const windowManager = createWindowManager();
// The active window owns the visible payload; `history` always points at its
// paste history and is rebound on every window switch.
let activeWindow = null;
let history = null;

const treeController = createTreeController({
  getText: getPayloadText,
  detectMode: detectModeFast,
  setStatus,
  nextPaint,
  onFormat: formatPayload,
  onPasteText: pasteTextAndFormat,
  // Leaving tree view for text view: snapshot the expansion/scroll so a
  // later window switch (or return to tree view) restores it.
  onTreeHide: () => { if (activeWindow) stashTreeUi(activeWindow); },
  getTreeRestore: () => activeWindow?.ui.tree,
});

initializeTheme();
initializeWrap();
initEpochPopover();
restoreWindows();
// History arrives asynchronously from IndexedDB; the windows above boot
// synchronously from sessionStorage so the UI is never blocked on it.
hydrateWindowHistories();
cleanupStaleHistories();
refreshUi();
treeController.refresh();

editor.addEventListener('input', () => {
  editRevision += 1;
  // Native multi-line insertions can emit many input events in a single task.
  // Keep revision protection immediate; coalesce metadata/highlighting work.
  if (!inputUiFrame) {
    inputUiFrame = requestAnimationFrame(() => {
      inputUiFrame = 0;
      refreshUiForInput();
      scheduleDraftSave();
      // A native paste (not intercepted above) lands here: it is a new
      // payload, so it gets its own history entry instead of editing the
      // current one like ordinary typing does.
      if (pastePending) {
        pastePending = false;
        pushHistory();
      } else {
        scheduleHistoryUpdate();
      }
    });
  }
});
editor.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    formatPayload();
  }
});

// Empty panel: clicking anywhere pastes & formats from the clipboard, the
// same flow as the Paste & Format button. Only when the panel is empty;
// once there is a payload, clicks behave normally (focus, caret).
editorBody?.addEventListener('click', () => {
  if (busy || inLargeMode()) return;
  if (getPayloadText()) return;
  pasteAndFormatPayload();
});

editor.addEventListener('paste', (event) => {
  const text = event.clipboardData?.getData('text/plain') ?? '';
  if (!text) return;

  const currentLength = inLargeMode() ? 0 : editor.value.length;
  const selectedLength = inLargeMode()
    ? 0
    : Math.max(0, (editor.selectionEnd ?? currentLength) - (editor.selectionStart ?? currentLength));
  const nextLength = currentLength - selectedLength + text.length;

  if (!inLargeMode() && nextLength < LARGE_PAYLOAD_CHARS) {
    // Small paste: let the browser insert natively, but remember it was a
    // paste so the input handler records a new history entry for it.
    pastePending = true;
    return;
  }

  event.preventDefault();
  if (acceptPastedText(text)) setStatus('Pasted from clipboard.', 'success');
});

pasteFormatBtn.addEventListener('click', pasteAndFormatPayload);
copyBtn.addEventListener('click', copyPayload);
clearBtn.addEventListener('click', clearPayload);
historyBackBtn?.addEventListener('click', () => navigateHistory(-1));
historyForwardBtn?.addEventListener('click', () => navigateHistory(1));
newWindowBtn?.addEventListener('click', createNewWindow);
windowTabs?.addEventListener('click', (event) => {
  const tab = event.target.closest('.window-tab');
  if (!tab) return;
  if (event.target.closest('.window-tab-close')) {
    closeWindowById(tab.dataset.windowId);
    return;
  }
  activateWindow(tab.dataset.windowId);
});
windowTabs?.addEventListener('dblclick', (event) => {
  if (event.target.closest('.window-tab-close')) return;
  const tab = event.target.closest('.window-tab');
  if (tab) startRename(tab);
});

// Drag-and-drop tab reordering (HTML5 DnD) plus Alt+Arrow keyboard moves.
// The drop indicator lives on .window-bar (never re-rendered) so
// renderWindowBar's replaceChildren() cannot destroy it mid-drag.
const windowBar = document.querySelector('.window-bar');
const dropIndicator = document.createElement('div');
dropIndicator.className = 'tab-drop-indicator';
dropIndicator.hidden = true;
windowBar?.append(dropIndicator);

let draggedWindowId = null;

function hideDropIndicator() {
  dropIndicator.hidden = true;
}

// Insertion index for a drop at clientX, computed against the tabs EXCLUDING
// the dragged one (it still occupies a DOM slot while being dragged).
function dropInsertionIndex(clientX) {
  const tabs = [...windowTabs.querySelectorAll('.window-tab')]
    .filter((tab) => tab.dataset.windowId !== draggedWindowId);
  for (let i = 0; i < tabs.length; i += 1) {
    const rect = tabs[i].getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) return i;
  }
  return tabs.length;
}

function showDropIndicator(index) {
  const tabs = [...windowTabs.querySelectorAll('.window-tab')]
    .filter((tab) => tab.dataset.windowId !== draggedWindowId);
  const barRect = windowBar.getBoundingClientRect();
  let x;
  if (index < tabs.length) {
    x = tabs[index].getBoundingClientRect().left - barRect.left;
  } else if (tabs.length > 0) {
    x = tabs[tabs.length - 1].getBoundingClientRect().right - barRect.left;
  } else {
    hideDropIndicator();
    return;
  }
  dropIndicator.style.left = `${x - 1}px`;
  dropIndicator.hidden = false;
}

function endTabDrag() {
  draggedWindowId = null;
  windowTabs?.querySelector('.window-tab.is-dragging')?.classList.remove('is-dragging');
  hideDropIndicator();
}

function focusTabSelect(id) {
  [...windowTabs.querySelectorAll('.window-tab')]
    .find((tab) => tab.dataset.windowId === id)
    ?.querySelector('.window-tab-select')
    ?.focus({ preventScroll: true });
}

windowTabs?.addEventListener('dragstart', (event) => {
  const tab = event.target.closest('.window-tab');
  // A rename in progress owns the tab: don't let a drag tear it away.
  if (!tab || tab.querySelector('.window-rename-input')) {
    event.preventDefault();
    return;
  }
  draggedWindowId = tab.dataset.windowId;
  event.dataTransfer.setData('text/plain', draggedWindowId);
  event.dataTransfer.effectAllowed = 'move';
  tab.classList.add('is-dragging');
});

windowTabs?.addEventListener('dragover', (event) => {
  if (!draggedWindowId) return;
  event.preventDefault(); // required to allow the drop
  event.dataTransfer.dropEffect = 'move';
  showDropIndicator(dropInsertionIndex(event.clientX));
});

windowTabs?.addEventListener('dragleave', (event) => {
  if (!windowTabs.contains(event.relatedTarget)) hideDropIndicator();
});

windowTabs?.addEventListener('drop', (event) => {
  event.preventDefault();
  const id = (event.dataTransfer && event.dataTransfer.getData('text/plain')) || draggedWindowId;
  const toIndex = dropInsertionIndex(event.clientX);
  endTabDrag();
  if (id && windowManager.moveWindow(id, toIndex)) {
    renderWindowBar();
    persistWindowList();
    focusTabSelect(id);
  }
});

windowTabs?.addEventListener('dragend', endTabDrag);

// Keyboard reordering: Alt+Arrow moves the focused tab. HTML5 DnD has no
// keyboard path, so tabs would otherwise be unmovable without a mouse.
windowTabs?.addEventListener('keydown', (event) => {
  if (!event.altKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
  const tab = event.target.closest('.window-tab');
  if (!tab) return;
  event.preventDefault();
  const id = tab.dataset.windowId;
  const from = windowManager.windows.findIndex((win) => win.id === id);
  if (from < 0) return;
  if (windowManager.moveWindow(id, from + (event.key === 'ArrowLeft' ? -1 : 1))) {
    renderWindowBar();
    persistWindowList();
    focusTabSelect(id);
  }
});
themeToggleBtn?.addEventListener('click', () => {
  applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', { persist: true });
});
wrapToggleBtn?.addEventListener('click', () => {
  applyWrap(root.dataset.wrap !== 'on', { persist: true });
});

function initializeTheme() {
  const saved = readStoredTheme();
  applyTheme(saved || 'dark', { persist: false });
}

function readStoredTheme() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    return saved === 'light' || saved === 'dark' ? saved : null;
  } catch (_) {
    return null;
  }
}

function currentTheme() {
  return root.dataset.theme === 'light' ? 'light' : 'dark';
}

function applyTheme(theme, { persist = false } = {}) {
  const next = theme === 'light' ? 'light' : 'dark';
  root.dataset.theme = next;
  root.style.colorScheme = next;
  updateThemeControl(next);

  if (persist) {
    try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch (_) {}
  }
}

function updateThemeControl(theme) {
  if (!themeToggleBtn) return;
  const next = theme === 'light' ? 'dark' : 'light';
  if (themeIcon) themeIcon.textContent = theme === 'light' ? '☾' : '☀';
  if (themeLabel) themeLabel.textContent = theme === 'light' ? 'Dark mode' : 'Light mode';
  themeToggleBtn.dataset.theme = theme;
  themeToggleBtn.setAttribute('aria-label', `Switch to ${next} mode`);
  themeToggleBtn.title = `Switch to ${next} mode`;
}

function initializeWrap() {
  applyWrap(readStoredWrap(), { persist: false });
}

function readStoredWrap() {
  try {
    return localStorage.getItem(WRAP_STORAGE_KEY) === 'on';
  } catch (_) {
    return false;
  }
}

function applyWrap(on, { persist = false } = {}) {
  const next = on ? 'on' : 'off';
  root.dataset.wrap = next;
  editor.wrap = on ? 'soft' : 'off';
  if (wrapToggleBtn) {
    wrapToggleBtn.setAttribute('aria-pressed', String(on));
    // The toggle now serves both views; describe what it does in the
    // current one (tree rows have no syntax colors to pause).
    const inTree = typeof treeController !== 'undefined' && treeController.isTree();
    wrapToggleBtn.title = on
      ? (inTree ? 'Unwrap tree rows' : 'Unwrap long lines')
      : (inTree ? 'Wrap tree rows' : 'Wrap long lines (syntax colors pause while wrap is on)');
  }
  if (persist) {
    try { localStorage.setItem(WRAP_STORAGE_KEY, next); } catch (_) {}
  }
  syntaxEditor.refresh();
}


function restoreWindows() {
  let meta = null;
  try { meta = JSON.parse(sessionStorage.getItem(WINDOWS_KEY)); } catch (_) {}
  let restored = false;
  if (meta && Array.isArray(meta.windows) && meta.windows.length) {
    for (const item of meta.windows) {
      windowManager.restoreWindow(item.id, item.name, readWindowDraft(item.id));
    }
    if (Number.isFinite(meta.counter)) windowManager.setCounter(meta.counter);
    restored = windowManager.setActive(meta.activeId) && windowManager.size > 0;
    if (!restored && windowManager.size > 0) {
      windowManager.setActive(windowManager.windows[0].id);
      restored = true;
    }
  }
  if (!restored) {
    // First run with windows (or a fresh tab): seed the first window from the
    // legacy single draft when present. The legacy key is left alone so older
    // builds keep working if the user switches back.
    let legacy = null;
    try { legacy = sessionStorage.getItem(STORAGE_KEY); } catch (_) {}
    windowManager.newWindow('', legacy || '');
    if (legacy) setStatus('Restored this tab’s draft.', 'success');
  }
  activeWindow = windowManager.getActive();
  history = activeWindow.history;
  // Drafts are capped below the large-payload threshold, so a restored payload
  // always fits the plain editor; the guard below is insurance regardless.
  const text = activeWindow.payload || '';
  if (text.length >= LARGE_PAYLOAD_CHARS) enterLargeMode(text, { formatted: false });
  else editor.value = text;
  persistWindowList();
  renderWindowBar();
  syncHistoryNav();
}

function persistWindowList() {
  if (!activeWindow) return;
  try {
    sessionStorage.setItem(WINDOWS_KEY, JSON.stringify(windowManager.toJSON()));
  } catch (_) {}
}

function readWindowDraft(id) {
  try { return sessionStorage.getItem(WINDOW_DRAFT_PREFIX + id) || ''; } catch (_) { return ''; }
}

function writeWindowDraft(id, text) {
  try { sessionStorage.setItem(WINDOW_DRAFT_PREFIX + id, text); } catch (_) {}
}

function clearWindowDraft(id) {
  try { sessionStorage.removeItem(WINDOW_DRAFT_PREFIX + id); } catch (_) {}
}

// Writes one window's payload to its draft slot, keeping the long-standing
// rules: large payloads are never persisted, oversize drafts are dropped so a
// refresh can never resurrect stale content.
function persistPayloadFor(win, text, isLarge) {
  if (!win) return;
  if (isLarge || !text || text.length > MAX_DRAFT_BYTES) {
    clearWindowDraft(win.id);
    return;
  }
  if (utf8ByteLength(text) > MAX_DRAFT_BYTES) {
    clearWindowDraft(win.id);
    return;
  }
  writeWindowDraft(win.id, text);
}

// Persistent storage is requested in context, not at boot: the first time a
// large entry is persisted — something actually worth protecting, when the
// browser's permission prompt makes sense. Once per session at most; the
// browser remembers the decision per origin afterwards.
let persistenceRequested = false;

// Persists one window's paste history (entries + position) to IndexedDB.
// Fire-and-forget: a storage failure degrades to session-only history and
// never risks the visible payload. Entries above MAX_HISTORY_PERSIST_BYTES
// are dropped (the store keeps the survivors as Blobs past 2MB); the index
// is remapped to the nearest surviving entry.
function saveHistoryFor(win) {
  if (!win || !win.history) return;
  const snapshot = win.history.toPersistable(
    (text) => text.length <= MAX_HISTORY_PERSIST_BYTES && utf8ByteLength(text) <= MAX_HISTORY_PERSIST_BYTES,
  );
  if (!persistenceRequested && snapshot.entries.some((text) => text.length > MAX_DRAFT_BYTES)) {
    persistenceRequested = true;
    requestPersistence();
  }
  const task = saveWindowHistory(tabId, win.id, snapshot);
  pendingHistorySaves.add(task);
  const done = () => pendingHistorySaves.delete(task);
  task.then(done, done);
}

// Async companion to restoreWindows: loads every window's paste history and
// swaps it in. The boot already seeded each window with its latest draft, so
// hydration only replaces the seeded state when nothing newer happened while
// it was loading — a paste during hydration wins and is re-saved instead of
// being clobbered.
let resolveHistoryHydrated = null;
const historyHydrated = new Promise((resolve) => {
  resolveHistoryHydrated = resolve;
});

async function hydrateWindowHistories() {
  try {
    const revisions = new Map(
      windowManager.windows.map((win) => [win.id, win.history.revision()]),
    );
    const records = await loadWindowHistories(tabId);
    for (const record of records) {
      const win = windowManager.getWindow(record.windowId);
      if (!win) continue;
      if (win.history.revision() !== revisions.get(win.id)) {
        saveHistoryFor(win);
        continue;
      }
      win.history.restore(record);
      // A window whose draft didn't survive (over the 2MB sessionStorage cap)
      // still gets its payload back when history persisted it: seed from the
      // restored position. A paste during hydration wins via the revision
      // guard above, and a seeded draft (payload non-empty) is left alone.
      if (!win.payload && win.history.size() > 0) {
        const text = win.history.current();
        if (text) {
          win.payload = text;
          if (win === activeWindow) setPayloadText(text);
        }
      }
    }
    syncHistoryNav();
  } finally {
    resolveHistoryHydrated();
  }
}

// Per-window UI state: switching windows stashes where the user left the
// outgoing window (text scroll/cursor, tree scroll/expansion) and restores
// the incoming window's snapshot, so each window is exactly as it was left.
function stashTextUi(win) {
  if (!win) return;
  const ui = win.ui.text;
  ui.scrollTop = editor.scrollTop;
  ui.scrollLeft = editor.scrollLeft;
  try {
    ui.selStart = editor.selectionStart ?? 0;
    ui.selEnd = editor.selectionEnd ?? 0;
  } catch (_) { /* selection APIs can throw on some input states */ }
}

function stashTreeUi(win) {
  if (!win || !treeController.isTree()) return;
  const treeView = document.querySelector('#treeView');
  win.ui.tree.scrollTop = treeView ? treeView.scrollTop : 0;
  win.ui.tree.openPaths = treeController.openPaths();
}

function restoreTextUi(win) {
  const ui = win.ui.text;
  editor.scrollTop = ui.scrollTop;
  editor.scrollLeft = ui.scrollLeft;
  try {
    editor.setSelectionRange(ui.selStart, ui.selEnd);
  } catch (_) { /* offsets may exceed a truncated large-mode preview */ }
}

function activateWindow(id, { stash = true } = {}) {
  const next = windowManager.getWindow(id);
  if (!next || busy) return;
  if (activeWindow && next.id === activeWindow.id) return;
  if (stash && activeWindow) {
    // Flush the outgoing window's pending typing update first: the debounce
    // timer would otherwise fire after the switch and update the wrong
    // window's history.
    clearTimeout(historyTimer);
    historyTimer = 0;
    applyHistoryUpdate();
    stashTextUi(activeWindow);
    stashTreeUi(activeWindow);
    const text = getPayloadText();
    activeWindow.payload = text;
    persistPayloadFor(activeWindow, text, inLargeMode());
  }
  activeWindow = next;
  history = next.history;
  windowManager.setActive(id);
  setPayloadText(next.payload || '', { treeRestore: next.ui.tree });
  restoreTextUi(next);
  renderWindowBar();
  syncHistoryNav();
  persistWindowList();
  setStatus(`Switched to ${next.name}.`, 'success');
}

function createNewWindow() {
  if (busy) return;
  const win = windowManager.newWindow();
  if (!win) {
    setStatus(`Window limit reached (${MAX_WINDOWS}). Close one to make room.`, 'warning');
    return;
  }
  persistWindowList();
  activateWindow(win.id);
  editor.focus();
}

function closeWindowById(id) {
  if (busy) return;
  const target = windowManager.getWindow(id);
  if (!target) return;
  const wasActive = !!activeWindow && target.id === activeWindow.id;
  if (wasActive) target.payload = getPayloadText();
  const result = windowManager.closeWindow(id);
  if (!result || !result.closed) {
    setStatus('A workspace needs at least one window.', 'warning');
    return;
  }
  clearWindowDraft(target.id);
  // Drop its persisted history too: closing a window forgets its datasets.
  deleteWindowHistory(tabId, target.id);
  // A pending typing update belongs to the closed window; never let it fire
  // against whoever becomes active next. But when closing an *inactive*
  // window the pending update (if any) belongs to the still-active window,
  // so its timer must stay armed.
  if (wasActive) {
    clearTimeout(historyTimer);
    historyTimer = 0;
  }
  persistWindowList();
  // The payload was already stashed above; switch without stashing again.
  if (wasActive) activateWindow(result.activateId, { stash: false });
  else renderWindowBar();
  setStatus(`Closed ${target.name}.`, 'success');
}

function renderWindowBar() {
  if (!windowTabs || !activeWindow) return;
  windowTabs.replaceChildren();
  const showClose = windowManager.size > 1;
  for (const win of windowManager.windows) {
    const isActive = win.id === activeWindow.id;
    const tab = document.createElement('div');
    tab.className = `window-tab${isActive ? ' is-active' : ''}`;
    tab.dataset.windowId = win.id;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    tab.draggable = true;

    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'window-tab-select';
    select.title = `${win.name} — drag to reorder, Alt+←/→ to move, double-click to rename`;
    const name = document.createElement('span');
    name.className = 'window-tab-name';
    name.textContent = win.name;
    select.append(name);
    tab.append(select);

    if (showClose) {
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'window-tab-close';
      close.textContent = '×';
      close.title = `Close ${win.name}`;
      close.setAttribute('aria-label', `Close ${win.name}`);
      tab.append(close);
    }
    windowTabs.append(tab);
  }
}

function startRename(tabEl) {
  const id = tabEl?.dataset.windowId;
  const win = id && windowManager.getWindow(id);
  if (!win || tabEl.querySelector('.window-rename-input')) return;
  const nameEl = tabEl.querySelector('.window-tab-name');
  if (!nameEl) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'window-rename-input';
  input.value = win.name;
  input.maxLength = 40;
  input.setAttribute('aria-label', 'Rename window');
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (save) {
      const next = input.value.trim();
      if (next && next !== win.name) {
        windowManager.renameWindow(id, next);
        persistWindowList();
      }
    }
    renderWindowBar();
  };
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') finish(true);
    else if (event.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

function pushHistory() {
  if (history.push(getPayloadText())) {
    syncHistoryNav();
    saveHistoryFor(activeWindow);
  }
}

function scheduleHistoryUpdate() {
  clearTimeout(historyTimer);
  historyTimer = setTimeout(() => {
    historyTimer = 0;
    applyHistoryUpdate();
  }, 250);
}

// Applies the debounced typing update to the active window's history.
// Extracted so window switches can flush it synchronously: otherwise a fast
// switch lets the timer fire against the NEW window and the old window's
// history never learns the typed text.
// Typing records a NEW entry per pause (not an in-place rewrite), so Back
// steps through edits: [A, B, B-edit1, B-edit2] -> Back -> B-edit1 -> B -> A.
// push() ignores consecutive duplicates, so idle debounce fires are no-ops.
function applyHistoryUpdate() {
  if (!activeWindow || !history) return;
  pushHistory();
}

function syncHistoryNav() {
  if (historyBackBtn) historyBackBtn.disabled = busy || !history.canBack();
  if (historyForwardBtn) historyForwardBtn.disabled = busy || !history.canForward();
}

// Replaces the visible payload wholesale (history navigation, window
// switches). No history side effects: callers manage their own entries.
function setPayloadText(text, { treeRestore } = {}) {
  editRevision += 1;
  if (text.length >= LARGE_PAYLOAD_CHARS) {
    enterLargeMode(text, { formatted: false });
    refreshUiQuick(text);
  } else {
    if (inLargeMode()) exitLargeMode();
    editor.value = text;
    if (text.length >= LARGE_UI_PAYLOAD_CHARS) refreshUiQuick(text);
    else refreshUi();
  }
  saveDraftNow();
  treeController.refresh(treeRestore);
}

function navigateHistory(direction) {
  if (busy) return;
  const text = direction < 0 ? history.back() : history.forward();
  if (text === null) return;
  setPayloadText(text);
  syncHistoryNav();
  // The position in history changed; persist it so a refresh restores it.
  saveHistoryFor(activeWindow);
  setStatus(direction < 0 ? 'Restored previous payload.' : 'Restored next payload.', 'success');
}


function inLargeMode() {
  return largeText !== null;
}

function getPayloadText() {
  return largeText !== null ? largeText : editor.value;
}

function buildPreview(text) {
  if (text.length <= PREVIEW_CHARS) return text;

  let cut = text.lastIndexOf('\n', PREVIEW_CHARS);
  if (cut < PREVIEW_CHARS / 2) cut = PREVIEW_CHARS;

  const hidden = formatCharacterCount(text.length - cut);
  return `${text.slice(0, cut)}\n… preview ends here · ${hidden} more chars not shown`;
}

function enterLargeMode(text, { formatted = false } = {}) {
  largeText = text;
  largeFormatted = formatted;
  editor.value = buildPreview(text);
  editor.readOnly = true;
  editor.classList.add('large-mode');
  editor.scrollTop = 0;
  editor.scrollLeft = 0;
  clearStoredDraft();

  if (largeNotice) {
    const size = `${formatCharacterCount(text.length)} chars`;
    largeNotice.textContent = formatted
      ? `Large formatted payload (${size}) · read-only preview. Copy uses the full formatted output.`
      : `Large payload (${size}) · read-only preview. Format and Copy use the full payload.`;
    largeNotice.hidden = false;
  }
}

function exitLargeMode() {
  largeText = null;
  largeFormatted = false;
  editor.readOnly = false;
  editor.classList.remove('large-mode');
  if (largeNotice) largeNotice.hidden = true;
}

function acceptPastedText(text) {
  // Refuse before touching the editor: admitting a >100MB payload risks an
  // out-of-memory tab crash a moment later. The clipboard is untouched, so
  // the user can paste a smaller slice instead. (Selection replacement can
  // only shrink the result, so current + pasted is a safe over-estimate.)
  // Returns false when the paste was refused.
  const currentLength = inLargeMode() ? largeText.length : editor.value.length;
  if (currentLength + text.length > HARD_MAX_PAYLOAD_CHARS) {
    setStatus(
      `That payload is too large to open (${formatCharacterCount(currentLength + text.length)}). ` +
      'This tool handles payloads up to 100 MB.',
      'error',
    );
    return false;
  }

  if (inLargeMode()) {
    exitLargeMode();
    editor.value = '';
  }

  const current = editor.value;
  const start = editor.selectionStart ?? current.length;
  const end = editor.selectionEnd ?? current.length;
  const nextLength = current.length - Math.max(0, end - start) + text.length;

  if (nextLength >= LARGE_PAYLOAD_CHARS) {
    const combined = !current && start === 0 && end === 0
      ? text
      : current.slice(0, start) + text + current.slice(end);

    editRevision += 1;
    enterLargeMode(combined);
    refreshUiQuick(combined);
    pushHistory();
    return true;
  }

  insertAtSelectionFast(text);
  editRevision += 1;
  refreshUiForInput();
  scheduleDraftSave();
  pushHistory();
  return true;
}

async function formatPayload() {
  if (busy) return;

  setBusy(true);
  try {
    await formatCurrentPayload();
  } finally {
    setBusy(false);
  }
}

async function formatCurrentPayload() {
  const text = getPayloadText();
  if (!text) {
    setStatus('Paste JSON or XML first.', 'error');
    return;
  }

  const startedRevision = editRevision;
  setStatus('Formatting…');

  try {
    const result = await runWorker(text);

    if (editRevision !== startedRevision) {
      setStatus('Input changed while formatting. Your newer edits were kept; format again.', 'warning');
      return;
    }

    if (result.formatted.length >= LARGE_UI_PAYLOAD_CHARS) {
      setStatus('Rendering formatted payload…');
      await nextPaint();
    }
    if (editRevision !== startedRevision) {
      setStatus('Input changed while formatting. Your newer edits were kept; format again.', 'warning');
      return;
    }

    if (result.formatted.length >= LARGE_PAYLOAD_CHARS) {
      editRevision += 1;
      enterLargeMode(result.formatted, { formatted: true });
      refreshUiQuick(result.formatted, result.mode);
    } else {
      if (inLargeMode()) exitLargeMode();
      editor.value = result.formatted;
      editRevision += 1;

      if (result.formatted.length >= LARGE_UI_PAYLOAD_CHARS || result.largeResult) {
        refreshUiQuick(result.formatted, result.mode);
      } else {
        refreshUi(result.mode, result);
      }
    }
    saveDraftNow();
    // Formatting rewrites the payload in place: keep it on the current
    // history entry instead of recording a second entry per paste.
    if (history.updateCurrent(getPayloadText())) syncHistoryNav();
    await treeController.refresh();

    if (result.bestEffort) {
      setStatus(result.repairNote || 'Formatted with a syntax warning.', 'warning');
    } else if (result.repairNote) {
      setStatus(result.repairNote, 'success');
    } else {
      setStatus(`${result.mode.toUpperCase()} formatted in ${result.elapsedMs} ms.`, 'success');
    }
  } catch (error) {
    setStatus(error?.message || String(error), 'error');
  }
}

async function pasteAndFormatPayload() {
  if (busy) return;

  setBusy(true);
  try {
    if (!navigator.clipboard?.readText) throw new Error('Clipboard read is unavailable.');

    setStatus('Reading clipboard…');
    const text = await navigator.clipboard.readText();
    if (!text) {
      setStatus('Clipboard does not contain text.', 'error');
      return;
    }
    // Check before clearing the editor: a refused paste leaves the current
    // payload exactly as it was.
    if (text.length > HARD_MAX_PAYLOAD_CHARS) {
      setStatus(
        `That payload is too large to open (${formatCharacterCount(text.length)}). ` +
        'This tool handles payloads up to 100 MB.',
        'error',
      );
      return;
    }

    // The button loads a fresh payload: always replace the editor content so
    // consecutive pastes never concatenate into one blob. (Native Ctrl/Cmd+V
    // keeps its insert-at-caret behavior for surgical edits.)
    resetEditorForReplace();
    acceptPastedText(text);
    await formatCurrentPayload();
  } catch (error) {
    editor.focus();
    setStatus(
      'Browser blocked automatic paste. Use Ctrl+V or Cmd+V, then Ctrl+Enter or Cmd+Enter to format.',
      'warning',
    );
  } finally {
    setBusy(false);
  }
}

async function copyPayload() {
  if (copying) return;

  const text = getPayloadText();
  if (!text) return setStatus('Nothing to copy.', 'error');

  copying = true;
  syncActionButtons();
  if (text.length >= LARGE_UI_PAYLOAD_CHARS) setStatus('Copying large payload…');

  try {
    await writeToClipboard(text);
    setStatus('Copied to clipboard.', 'success');
  } catch (error) {
    setStatus(
      inLargeMode()
        ? 'Browser blocked copying the full large payload. Allow clipboard access and try Copy again.'
        : 'Browser blocked clipboard access. Select the text and use Ctrl+C or Cmd+C.',
      'error',
    );
  } finally {
    copying = false;
    syncActionButtons();
  }
}

async function writeToClipboard(text) {
  const clipboard = navigator.clipboard;

  if (clipboard?.write && typeof ClipboardItem === 'function') {
    try {
      const blob = new Blob([text], { type: 'text/plain' });
      await clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
      return;
    } catch (_) {}
  }

  if (clipboard?.writeText) {
    await clipboard.writeText(text);
    return;
  }

  if (inLargeMode()) {
    throw new Error('Clipboard API is required for large payloads.');
  }

  editor.focus();
  editor.select();
  if (!document.execCommand('copy')) throw new Error('Copy is not supported by this browser.');
  editor.setSelectionRange(0, 0);
}

async function pasteTextAndFormat(text) {
  if (busy || !text) return;

  setBusy(true);
  try {
    resetEditorForReplace();
    acceptPastedText(text);
    await formatCurrentPayload();
  } finally {
    setBusy(false);
  }
}

function resetEditorForReplace() {
  if (inLargeMode()) exitLargeMode();
  editor.value = '';
  try { editor.setSelectionRange(0, 0); } catch (_) {}
  clearStoredDraft();
}

function clearPayload() {
  if (!editor.value && !inLargeMode()) return setStatus('Editor is already empty.');
  exitLargeMode();
  editor.value = '';
  editRevision += 1;
  clearStoredDraft();
  pushHistory();
  refreshUi();
  treeController.refresh();
  setStatus('Cleared.', 'success');
  if (!treeController.isTree()) editor.focus();
}

function insertAtSelectionFast(text) {
  const current = editor.value;
  const start = editor.selectionStart ?? current.length;
  const end = editor.selectionEnd ?? current.length;

  // Assigning .value directly avoids the extra synchronous input event and
  // duplicate full-document bookkeeping that setRangeText + dispatchEvent
  // caused for multi-megabyte clipboard payloads.
  if (!current && start === 0 && end === 0) {
    editor.value = text;
  } else {
    editor.value = current.slice(0, start) + text + current.slice(end);
  }

  const caret = start + text.length;
  try { editor.setSelectionRange(caret, caret); } catch (_) {}
  if (!treeController.isTree()) editor.focus();
}

function refreshUiForInput() {
  const text = editor.value;
  if (text.length >= LARGE_UI_PAYLOAD_CHARS) {
    refreshUiQuick(text);
    return;
  }
  refreshUi();
}

function refreshUiQuick(text, forcedMode = null) {
  const mode = forcedMode || detectModeFast(text);
  typeBadge.classList.remove('json', 'xml');

  if (mode) {
    typeBadge.textContent = mode.toUpperCase();
    typeBadge.classList.add(mode);
  } else {
    typeBadge.textContent = text ? 'JSON / XML?' : 'Waiting for payload';
  }

  // String length is O(1). Avoid line-count and UTF-8 byte scans here so a
  // large paste can paint immediately. Exact metrics are available after
  // formatting, when the worker already returns them.
  metaText.textContent = `${formatCharacterCount(text.length)} chars · large payload`;
  syntaxEditor.refresh(mode);
}

function refreshUi(forcedMode = null, metrics = null) {
  const text = editor.value;
  const mode = forcedMode || detectModeFast(text);
  typeBadge.classList.remove('json', 'xml');
  if (mode) {
    typeBadge.textContent = mode.toUpperCase();
    typeBadge.classList.add(mode);
  } else {
    typeBadge.textContent = text ? 'JSON / XML?' : 'Waiting for payload';
  }

  const lines = Number.isFinite(metrics?.lineCount) ? metrics.lineCount : countLinesFast(text);
  const bytes = Number.isFinite(metrics?.bytes) ? metrics.bytes : utf8ByteLength(text);
  metaText.textContent = `${lines.toLocaleString()} ${lines === 1 ? 'line' : 'lines'} · ${formatBytes(bytes)}`;
  syntaxEditor.refresh(mode);
}

function scheduleDraftSave() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(saveDraftNow, 250);
}

function saveDraftNow() {
  clearTimeout(persistTimer);
  if (!activeWindow) return;
  // The debounced keystroke path, formatting, and window switches all funnel
  // here: persist the visible payload into the active window's draft slot.
  const text = getPayloadText();
  const large = inLargeMode();
  persistPayloadFor(activeWindow, text, large);
  // Dual-write the legacy single-draft key: builds without windows (main)
  // restore the last active payload from it, so switching branches or builds
  // never strands the draft.
  try {
    if (!large && text && text.length <= MAX_DRAFT_BYTES && utf8ByteLength(text) <= MAX_DRAFT_BYTES) {
      sessionStorage.setItem(STORAGE_KEY, text);
    } else {
      sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch (_) {}
}

function clearStoredDraft() {
  if (activeWindow) clearWindowDraft(activeWindow.id);
}

// The draft save is debounced (250ms): without a flush, closing the tab
// right after typing loses the keystrokes. pagehide fires reliably on tab
// close; visibilitychange covers the tab being hidden first. Both write
// synchronously, which is safe inside unload handlers.
window.addEventListener('pagehide', () => { saveDraftNow(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveDraftNow();
});

function createWorker() {
  const instance = new Worker(new URL('./formatter-worker.js', import.meta.url), { type: 'module' });

  instance.addEventListener('message', (event) => {
    const message = event.data || {};
    const waiter = pending.get(message.id);
    if (!waiter || waiter.worker !== instance) return;

    clearTimeout(waiter.timeoutId);
    pending.delete(message.id);
    message.ok
      ? waiter.resolve(message.result)
      : waiter.reject(new Error(message.error || 'Formatting failed.'));
  });

  instance.addEventListener('error', () => {
    failWorker(instance, 'Formatting worker failed and was restarted. Your input was kept; try Format again.');
  });

  instance.addEventListener('messageerror', () => {
    failWorker(instance, 'Formatting worker returned an unreadable response and was restarted. Your input was kept; try Format again.');
  });

  return instance;
}

function getWorker() {
  if (worker) return worker;
  worker = createWorker();
  return worker;
}

function failWorker(instance, message) {
  try { instance?.terminate(); } catch (_) {}

  for (const [id, waiter] of pending.entries()) {
    if (waiter.worker !== instance) continue;
    clearTimeout(waiter.timeoutId);
    pending.delete(id);
    waiter.reject(new Error(message));
  }

  if (worker === instance) worker = null;
}

function formatTimeoutFor(textLength) {
  const sizeMb = Math.ceil(textLength / (1024 * 1024));
  return Math.min(
    MAX_FORMAT_TIMEOUT_MS,
    BASE_FORMAT_TIMEOUT_MS + (sizeMb * FORMAT_TIMEOUT_PER_MB_MS),
  );
}

function runWorker(text) {
  const id = ++requestId;

  return new Promise((resolve, reject) => {
    let instance;
    try {
      instance = getWorker();
    } catch (_) {
      reject(new Error('Formatting worker could not start. Refresh the page and try again.'));
      return;
    }

    const timeoutId = setTimeout(() => {
      if (!pending.has(id)) return;
      failWorker(
        instance,
        'Formatting took too long and was stopped. Your input was kept; try again or use a smaller payload.',
      );
    }, formatTimeoutFor(text.length));

    pending.set(id, { resolve, reject, timeoutId, worker: instance });

    try {
      instance.postMessage({ id, text });
    } catch (_) {
      failWorker(instance, 'Formatting could not be started and the worker was restarted. Your input was kept; try Format again.');
    }
  });
}

function setBusy(value) {
  busy = value;
  document.body.classList.toggle('busy', value);
  pasteFormatBtn.disabled = value;
  clearBtn.disabled = value;
  syncActionButtons();
  syncHistoryNav();
}

function syncActionButtons() {
  copyBtn.disabled = busy || copying;
}

function setStatus(message, tone = '') {
  statusText.textContent = message;
  statusText.className = tone;
}


function detectModeFast(text) {
  let index = 0;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  if (text.charCodeAt(index) === 0xFEFF) {
    index += 1;
    while (index < text.length && /\s/.test(text[index])) index += 1;
  }
  const first = text[index] || '';
  if (first === '<') return 'xml';
  if (first === '{' || first === '[') return 'json';
  return detectPayloadMode(text).mode;
}

function countLinesFast(text) {
  if (!text) return 0;
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

function utf8ByteLength(text) {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xD800 && code <= 0xDBFF && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function nextPaint() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

function formatCharacterCount(chars) {
  if (chars < 1000) return chars.toLocaleString();
  if (chars < 1_000_000) return `${(chars / 1000).toFixed(1)}K`;
  return `${(chars / 1_000_000).toFixed(2)}M`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
}

// Test hooks (not part of the UI contract): let the regression suite await
// asynchronous history persistence without racing it.
export function __flushHistorySaves() {
  return Promise.all([...pendingHistorySaves]);
}

export function __historyHydrated() {
  return historyHydrated;
}

export function __getTabId() {
  return tabId;
}
