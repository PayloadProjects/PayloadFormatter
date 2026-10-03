import { buildSyntaxModel } from './syntax-model.js';

self.addEventListener('message', ({ data }) => {
  const { id, text, mode } = data || {};
  try {
    const { lines, spans } = buildSyntaxModel(text, mode);
    self.postMessage({ id, ok: true, lines, spans }, [lines.buffer, spans.buffer]);
  } catch (_) {
    self.postMessage({ id, ok: false });
  }
});
