import { formatPayload } from './formatter.js';

self.addEventListener('message', (event) => {
  const { id, text } = event.data || {};
  try {
    const result = formatPayload(text);
    self.postMessage({ id, ok: true, result });
  } catch (error) {
    self.postMessage({ id, ok: false, error: error?.message || String(error) });
  }
});
