import { detectPayloadMode } from './payload-detection.js';

const STORAGE_KEY = 'payload-formatter:draft:v1';
const MAX_DRAFT_BYTES = 2 * 1024 * 1024;

const editor = document.querySelector('#payloadInput');
const formatBtn = document.querySelector('#formatBtn');
const copyBtn = document.querySelector('#copyBtn');
const pasteBtn = document.querySelector('#pasteBtn');
const clearBtn = document.querySelector('#clearBtn');
const statusText = document.querySelector('#statusText');
const typeBadge = document.querySelector('#typeBadge');
const metaText = document.querySelector('#metaText');

let busy = false;
let requestId = 0;
let persistTimer = 0;
let worker = createWorker();
const pending = new Map();

restoreDraft();
refreshUi();

editor.addEventListener('input', () => {
  refreshUi();
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
    const text = await navigator.clipboard.readText();
    if (!text) return setStatus('Clipboard does not contain text.', 'error');
    insertAtSelection(text);
    refreshUi();
    saveDraftNow();
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

function insertAtSelection(text) {
  const start = editor.selectionStart ?? editor.value.length;
  const end = editor.selectionEnd ?? editor.value.length;
  editor.setRangeText(text, start, end, 'end');
  editor.dispatchEvent(new Event('input', { bubbles: true }));
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

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
}
