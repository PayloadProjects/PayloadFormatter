import { detectPayloadMode } from './payload-detection.js';
import { formatJsonBestEffort, formatXmlBestEffort } from './resilient-format.js';

self.addEventListener('message', (event) => {
  const { id, text } = event.data || {};
  try {
    const mode = detectModeFast(text);
    if (!mode) throw new Error('Could not detect JSON or XML. Paste a JSON or XML payload and try again.');
    const result = mode === 'json'
      ? formatJsonBestEffort(text)
      : formatXmlBestEffort(text);

    // The parsed JSON object is useful to unit tests and internal callers, but
    // the browser UI never reads it. Avoid structured-cloning a second copy of
    // a potentially huge object graph back to the main thread.
    const { parsed: _parsed, ...wireResult } = result;
    self.postMessage({ id, ok: true, result: wireResult });
  } catch (error) {
    self.postMessage({ id, ok: false, error: error?.message || String(error) });
  }
});

function detectModeFast(text) {
  const source = String(text ?? '');
  let index = 0;
  while (index < source.length && /\s/.test(source[index])) index += 1;
  if (source.charCodeAt(index) === 0xFEFF) {
    index += 1;
    while (index < source.length && /\s/.test(source[index])) index += 1;
  }
  const first = source[index] || '';
  if (first === '<') return 'xml';
  if (first === '{' || first === '[') return 'json';
  return detectPayloadMode(source).mode;
}
