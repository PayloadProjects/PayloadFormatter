import { detectPayloadMode } from './payload-detection.js';

const STORAGE_KEY = 'payload-formatter:draft:v1';
const THEME_STORAGE_KEY = 'payload-formatter:theme:v1';
const MAX_DRAFT_BYTES = 2 * 1024 * 1024;
const LARGE_UI_PAYLOAD_CHARS = 512 * 1024;

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
let persistTimer = 0;
let worker = createWorker();
const pending = new Map();

initializeTheme();
restoreDraft();
refreshUi();

editor.addEventListener('input', () => {
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
  if (!text.trim()) return setStatus('Paste JSON or XML first.', 'error');

  setBusy(true);
  setStatus('Formatting…');
  try {
    const result = await runWorker(text);
    editor.value = result.formatted;
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
  sessionStorage.removeItem(STORAGE_KEY);
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
    typeBadge.textContent = text.trim() ? 'JSON / XML?' : 'Waiting for payload';
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
    typeBadge.textContent = text.trim() ? 'JSON / XML?' : 'Waiting for payload';
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
    sessionStorage.removeItem(STORAGE_KEY);
    return;
  }
  // UTF-8 byte length can never be smaller than the number of UTF-16 code
  // units for plain ASCII-heavy payloads. Skip the expensive byte count early
  // for drafts that are obviously too large to persist.
  if (text.length > MAX_DRAFT_BYTES) return;
  const bytes = utf8ByteLength(text);
  if (bytes > MAX_DRAFT_BYTES) return;
  try { sessionStorage.setItem(STORAGE_KEY, text); } catch (_) {}
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
    if (!waiter) return;
    pending.delete(message.id);
    message.ok ? waiter.resolve(message.result) : waiter.reject(new Error(message.error || 'Formatting failed.'));
  });
  instance.addEventListener('error', () => {
    for (const waiter of pending.values()) waiter.reject(new Error('Formatting worker failed. Refresh and try again.'));
    pending.clear();
  });
  return instance;
}

function runWorker(text) {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, text });
  });
}

function setBusy(value) {
  busy = value;
  document.body.classList.toggle('busy', value);
  formatBtn.disabled = value;
  clearBtn.disabled = value;
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
