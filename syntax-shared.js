// Presentation limits apply to the displayed text, not the retained full payload.
export const MAX_HIGHLIGHT_CHARS = 2 * 1024 * 1024;
export const MAX_TOKEN_SPANS = 200_000;
export const MAX_VISIBLE_CHARS = 150_000;
export const MAX_VISIBLE_SPANS = 4000;
// Wrap-mode overlay renders the whole text (not a line window) so it can
// track wrapped rows: it needs tighter budgets than the nowrap path.
export const MAX_WRAP_HIGHLIGHT_CHARS = 256 * 1024;
export const MAX_WRAP_LINES = 25000;
export const MAX_WRAP_SPANS = 60000;
export const TOKEN_CLASSES = ['', 'key', 'string', 'number', 'boolean', 'muted', 'attribute', 'tag', 'entity', 'comment'];

// Last line start <= offset, including a final empty line after a newline.
export function lineAt(starts, offset) {
  let lo = 0, hi = starts.length;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid;
  }
  return lo;
}
