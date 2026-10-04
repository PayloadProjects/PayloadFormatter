// Payload history: back/forward navigation across pasted payloads.
// Pure model, no DOM: entries are payload states, one per paste (or clear).
// In-place edits (typing, formatting) update the current entry instead of
// pushing, so Back/Forward moves between pastes, not keystrokes.
// Clearing records the empty state so an accidental clear is recoverable,
// but navigation skips empty entries: Back/Forward always lands on a real
// pasted payload, never on the blank left behind by a clear.
// Session-only by design: the draft already persists the latest payload.
const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

export function createPayloadHistory({ maxEntries = DEFAULT_MAX_ENTRIES, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  let entries = [];
  let index = -1;
  // Bumps on every mutation so async hydration can tell whether the
  // in-memory history changed while it was loading from storage.
  let revision = 0;

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
    revision += 1;
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
    revision += 1;
    return true;
  }

  function back() {
    const target = nearestPayload(index, -1);
    if (target < 0) return null;
    index = target;
    return entries[index];
  }

  function forward() {
    const target = nearestPayload(index, 1);
    if (target < 0) return null;
    index = target;
    return entries[index];
  }

  // Empty entries (left behind by Clear) are not navigation stops: find the
  // nearest non-empty payload in the given direction, or -1 when none.
  function nearestPayload(from, step) {
    let cursor = from;
    while (true) {
      cursor += step;
      if (cursor < 0 || cursor >= entries.length) return -1;
      if (entries[cursor] !== '') return cursor;
    }
  }

  return {
    push,
    updateCurrent,
    back,
    forward,
    canBack: () => nearestPayload(index, -1) >= 0,
    canForward: () => nearestPayload(index, 1) >= 0,
    current: () => (index >= 0 ? entries[index] : ''),
    size: () => entries.length,
    revision: () => revision,
    toJSON: () => ({ entries: entries.slice(), index }),
    // Rebuilds the history from a persisted snapshot; tolerant of bad data.
    restore(data) {
      if (!data || !Array.isArray(data.entries)) return false;
      entries = data.entries.map((entry) => String(entry ?? ''));
      index = entries.length === 0
        ? -1
        : Math.min(Math.max(Number.isInteger(data.index) ? data.index : entries.length - 1, 0), entries.length - 1);
      evict();
      revision += 1;
      return true;
    },
    // Snapshot for persistence. Entries the predicate rejects (oversize
    // payloads: large payloads are never persisted, matching the draft rule)
    // are dropped; the index is remapped to the nearest surviving entry at
    // or before the old position.
    toPersistable(isPersistable) {
      const kept = [];
      const remap = new Array(entries.length).fill(-1);
      for (let i = 0; i < entries.length; i += 1) {
        if (isPersistable(entries[i])) {
          remap[i] = kept.length;
          kept.push(entries[i]);
        }
      }
      let nextIndex = -1;
      if (kept.length > 0) {
        nextIndex = remap[index];
        if (nextIndex < 0) {
          nextIndex = 0;
          for (let i = 0; i < entries.length && i < index; i += 1) {
            if (remap[i] >= 0) nextIndex = remap[i];
          }
        }
      }
      return { entries: kept, index: nextIndex };
    },
  };
}
