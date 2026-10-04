// Payload history: back/forward navigation across pasted payloads.
// Pure model, no DOM: entries are payload states, one per paste (or clear).
// In-place edits (typing, formatting) update the current entry instead of
// pushing, so Back/Forward moves between pastes, not keystrokes.
// Session-only by design: the draft already persists the latest payload.
const DEFAULT_MAX_ENTRIES = 25;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export function createPayloadHistory({ maxEntries = DEFAULT_MAX_ENTRIES, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  let entries = [];
  let index = -1;

  function totalBytes() {
    let total = 0;
    for (const entry of entries) total += entry.length;
    return total;
  }

  function evict() {
    while ((entries.length > maxEntries || totalBytes() > maxBytes) && entries.length > 1) {
      entries.shift();
      index -= 1;
    }
    if (index >= entries.length) index = entries.length - 1;
  }

  // Record a new payload state. Drops any "forward" entries (the user
  // diverged after going back, like a browser). Consecutive duplicates
  // are ignored.
  function push(text) {
    text = String(text ?? '');
    if (index >= 0 && entries[index] === text) return false;
    entries = entries.slice(0, index + 1);
    entries.push(text);
    index = entries.length - 1;
    evict();
    return true;
  }

  // The current payload changed without a new paste (typing, formatting):
  // keep the entry count stable and preserve any newer entries only when
  // the text is actually different.
  function updateCurrent(text) {
    text = String(text ?? '');
    if (index < 0) return push(text);
    if (entries[index] === text) return false;
    entries = entries.slice(0, index + 1);
    entries[index] = text;
    evict();
    return true;
  }

  function back() {
    if (index <= 0) return null;
    index -= 1;
    return entries[index];
  }

  function forward() {
    if (index < 0 || index >= entries.length - 1) return null;
    index += 1;
    return entries[index];
  }

  return {
    push,
    updateCurrent,
    back,
    forward,
    canBack: () => index > 0,
    canForward: () => index >= 0 && index < entries.length - 1,
    current: () => (index >= 0 ? entries[index] : ''),
    size: () => entries.length,
  };
}
