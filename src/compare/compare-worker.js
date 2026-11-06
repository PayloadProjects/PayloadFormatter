import { compareTexts } from './compare-diff.js';
import { normalizePayload } from './compare-normalize.js';

self.addEventListener('message', ({ data }) => {
  const { id, left, right, options, normalize } = data || {};
  try {
    const sides = normalize ? [normalizePayload(left, options), normalizePayload(right, options)] : null;
    const leftText = sides ? sides[0].text : left;
    const rightText = sides ? sides[1].text : right;
    self.postMessage({ id, ok: true, sides, result: compareTexts(leftText, rightText, options) });
  } catch (error) {
    self.postMessage({ id, ok: false, error: error?.message || String(error) });
  }
});
