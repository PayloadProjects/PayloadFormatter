import { detectPayloadMode } from './payload-detection.js';
import { createTreeController } from './tree-controller.js';
import { createSyntaxEditor } from './text-editor.js';
import { createPayloadHistory } from './payload-history.js';

const STORAGE_KEY = 'payload-formatter:draft:v1';
const THEME_STORAGE_KEY = 'payload-formatter:theme:v1';
const WRAP_STORAGE_KEY = 'payload-formatter:wrap:v1';
const MAX_DRAFT_BYTES = 2 * 1024 * 1024;
const LARGE_UI_PAYLOAD_CHARS = 512 * 1024;
const LARGE_PAYLOAD_CHARS = 2 * 1024 * 1024;
const PREVIEW_CHARS = 120_000;
const BASE_FORMAT_TIMEOUT_MS = 30_000;
const FORMAT_TIMEOUT_PER_MB_MS = 5_000;
const MAX_FORMAT_TIMEOUT_MS = 120_000;

const editor = document.querySelector('#payloadInput');
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
const pending = new Map();
const syntaxEditor = createSyntaxEditor(editor);
const history = createPayloadHistory();

const treeController = createTreeController({
  getText: getPayloadText,
  detectMode: detectModeFast,
  setStatus,
  nextPaint,
  onFormat: formatPayload,
  onPasteText: pasteTextAndFormat,
});

initializeTheme();
initializeWrap();
restoreDraft();
initializeHistory();
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
  acceptPastedText(text);
  setStatus('Pasted from clipboard.', 'success');
});

pasteFormatBtn.addEventListener('click', pasteAndFormatPayload);
copyBtn.addEventListener('click', copyPayload);
clearBtn.addEventListener('click', clearPayload);
historyBackBtn?.addEventListener('click', () => navigateHistory(-1));
historyForwardBtn?.addEventListener('click', () => navigateHistory(1));
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
    wrapToggleBtn.title = on
      ? 'Unwrap long lines'
      : 'Wrap long lines (syntax colors pause while wrap is on)';
  }
  if (persist) {
    try { localStorage.setItem(WRAP_STORAGE_KEY, next); } catch (_) {}
  }
  syntaxEditor.refresh();
}


function initializeHistory() {
  const text = getPayloadText();
  if (text) history.push(text);
  syncHistoryNav();
}

function pushHistory() {
  if (history.push(getPayloadText())) syncHistoryNav();
}

function scheduleHistoryUpdate() {
  clearTimeout(historyTimer);
  historyTimer = setTimeout(() => {
    historyTimer = 0;
    if (history.updateCurrent(getPayloadText())) syncHistoryNav();
  }, 250);
}

function syncHistoryNav() {
  if (historyBackBtn) historyBackBtn.disabled = busy || !history.canBack();
  if (historyForwardBtn) historyForwardBtn.disabled = busy || !history.canForward();
}

function navigateHistory(direction) {
  if (busy) return;
  const text = direction < 0 ? history.back() : history.forward();
  if (text === null) return;

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
  syncHistoryNav();
  treeController.refresh();
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
    return;
  }

  insertAtSelectionFast(text);
  editRevision += 1;
  refreshUiForInput();
  scheduleDraftSave();
  pushHistory();
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

    if (treeController.isTree()) resetEditorForReplace();
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
  if (inLargeMode()) {
    clearStoredDraft();
    return;
  }

  const text = editor.value;
  if (!text) {
    clearStoredDraft();
    return;
  }
  // UTF-8 byte length can never be smaller than the number of UTF-16 code
  // units for plain ASCII-heavy payloads. Skip the expensive byte count early
  // for drafts that are obviously too large to persist. Also remove any older
  // small draft so refresh can never resurrect stale content.
  if (text.length > MAX_DRAFT_BYTES) {
    clearStoredDraft();
    return;
  }
  const bytes = utf8ByteLength(text);
  if (bytes > MAX_DRAFT_BYTES) {
    clearStoredDraft();
    return;
  }
  try { sessionStorage.setItem(STORAGE_KEY, text); } catch (_) {}
}

function clearStoredDraft() {
  try { sessionStorage.removeItem(STORAGE_KEY); } catch (_) {}
}

function restoreDraft() {
  try {
    const saved = sessionStorage.getItem(STORAGE_KEY);
    if (saved) {
      editor.value = saved;
      setStatus('Restored this tab’s draft.', 'success');
    }
  } catch (_) {}
}

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
