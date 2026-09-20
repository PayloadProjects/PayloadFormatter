import { detectPayloadMode } from './payload-detection.js';

const STORAGE_KEY = 'payload-formatter:draft:v1';
const THEME_STORAGE_KEY = 'payload-formatter:theme:v1';
const MAX_DRAFT_BYTES = 2 * 1024 * 1024;
const LARGE_UI_PAYLOAD_CHARS = 512 * 1024;
const BASE_FORMAT_TIMEOUT_MS = 30_000;
const FORMAT_TIMEOUT_PER_MB_MS = 5_000;
const MAX_FORMAT_TIMEOUT_MS = 120_000;

const editor = document.querySelector('#payloadInput');
const formatBtn = document.querySelector('#formatBtn');
const copyBtn = document.querySelector('#copyBtn');
const pasteBtn = document.querySelector('#pasteBtn');
const clearBtn = document.querySelector('#clearBtn');
const statusText = document.querySelector('#statusText');
const typeBadge = document.querySelector('#typeBadge');
const metaText = document.querySelector('#metaText');
const themeToggleBtn = document.querySelector('#themeToggleBtn');
const themeIcon = document.querySelector('#themeIcon');
const themeLabel = document.querySelector('#themeLabel');
const root = document.documentElement;

let busy = false;
let requestId = 0;
let editRevision = 0;
let persistTimer = 0;
let worker = null;
const pending = new Map();

initializeTheme();
restoreDraft();
refreshUi();

editor.addEventListener('input', () => {
  editRevision += 1;
  refreshUiForInput();
  scheduleDraftSave();
});
editor.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    formatPayload();
  }
});

formatBtn.addEventListener('click', formatPayload);
copyBtn.addEventListener('click', copyPayload);
pasteBtn.addEventListener('click', pastePayload);
clearBtn.addEventListener('click', clearPayload);
themeToggleBtn?.addEventListener('click', () => {
  applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', { persist: true });
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

async function formatPayload() {
  if (busy) return;
  const text = editor.value;
  if (!text) return setStatus('Paste JSON or XML first.', 'error');

  const startedRevision = editRevision;
  setBusy(true);
  setStatus('Formatting…');
  try {
    const result = await runWorker(text);

    if (editRevision !== startedRevision) {
      setStatus('Input changed while formatting. Your newer edits were kept; press Format again.', 'warning');
      return;
    }

    editor.value = result.formatted;
    editRevision += 1;
    refreshUi(result.mode, result);
    saveDraftNow();

    if (result.bestEffort) {
      setStatus(result.repairNote || 'Formatted with a syntax warning.', 'warning');
    } else if (result.repairNote) {
      setStatus(result.repairNote, 'success');
    } else {
      setStatus(`${result.mode.toUpperCase()} formatted in ${result.elapsedMs} ms.`, 'success');
    }
  } catch (error) {
    setStatus(error?.message || String(error), 'error');
  } finally {
    setBusy(false);
  }
}

async function copyPayload() {
  const text = editor.value;
  if (!text) return setStatus('Nothing to copy.', 'error');

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      editor.focus();
      editor.select();
      if (!document.execCommand('copy')) throw new Error('Copy is not supported by this browser.');
      editor.setSelectionRange(0, 0);
    }
    setStatus('Copied to clipboard.', 'success');
  } catch (error) {
    setStatus('Browser blocked clipboard access. Select the text and use Ctrl+C or Cmd+C.', 'error');
  }
}

async function pastePayload() {
  try {
    if (!navigator.clipboard?.readText) throw new Error('Clipboard read is unavailable.');

    setStatus('Reading clipboard…');
    const text = await navigator.clipboard.readText();
    if (!text) return setStatus('Clipboard does not contain text.', 'error');

    insertAtSelectionFast(text);
    editRevision += 1;

    // Keep the paste interaction responsive. Large payloads should become
    // visible before we do any work that scales with the full document size.
    refreshUiForInput();
    scheduleDraftSave();
    setStatus('Pasted from clipboard.', 'success');
  } catch (error) {
    editor.focus();
    setStatus('Browser blocked automatic paste. Use Ctrl+V or Cmd+V in the editor.', 'warning');
  }
}

function clearPayload() {
  if (!editor.value) return setStatus('Editor is already empty.');
  editor.value = '';
  editRevision += 1;
  clearStoredDraft();
  refreshUi();
  setStatus('Cleared.', 'success');
  editor.focus();
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
  editor.focus();
}

function refreshUiForInput() {
  const text = editor.value;
  if (text.length >= LARGE_UI_PAYLOAD_CHARS) {
    refreshUiQuick(text);
    return;
  }
  refreshUi();
}

function refreshUiQuick(text) {
  const mode = detectModeFast(text);
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
}

function scheduleDraftSave() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(saveDraftNow, 250);
}

function saveDraftNow() {
  clearTimeout(persistTimer);
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
  formatBtn.disabled = value;
  clearBtn.disabled = value;
  pasteBtn.disabled = value;
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
