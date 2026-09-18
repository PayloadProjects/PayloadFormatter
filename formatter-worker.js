import { detectPayloadMode } from './payload-detection.js';
import { formatJsonBestEffort, formatXmlBestEffort } from './resilient-format.js';

self.addEventListener('message', (event) => {
  const { id, text } = event.data || {};
  try {
    const detection = detectPayloadMode(text);
    if (!detection.mode) throw new Error('Could not detect JSON or XML. Paste a JSON or XML payload and try again.');
    const result = detection.mode === 'json'
      ? formatJsonBestEffort(text)
      : formatXmlBestEffort(text);
    self.postMessage({ id, ok: true, result });
  } catch (error) {
    self.postMessage({ id, ok: false, error: error?.message || String(error) });
  }
});
