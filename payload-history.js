// Payload history: back/forward navigation across pasted payloads.
// Pure model, no DOM and no storage: entries are payload states, one per
// paste (or clear, or debounced edit). Formatting rewrites the current entry
// in place instead of pushing.
// Clearing records the empty state so an accidental clear is recoverable,
// but navigation skips empty entries: Back/Forward always lands on a real
// pasted payload, never on the blank left behind by a clear.
//
// Entries are { id, chars, text, state, preview }. `preview` is the first
// line or so of the payload, whitespace collapsed (PREVIEW_CHARS at most):
// it is persisted with the entry list so the Inspector can label entries
// whose text was released. `text` is null once the caller has
// saved the entry to storage and released it from memory: the model keeps
// only ids and sizes for those, so a long history in many windows costs
// almost nothing until an entry is actually viewed again. The caller loads
// the text back (see app.js) and hands it to setText().
//
// state: 'memory' (not saved yet), 'saved' (in storage; text may be null),
// 'skipped' (never persisted: too large, or storage failed; stays resident).
const DEFAULT_MAX_ENTRIES = 100;
// Budget for text held in memory. Saved entries are released, so this only
// bites when storage is unavailable or an entry is too large to persist.
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

const PREVIEW_CHARS = 80;

export function previewOf(text) {
  return String(text ?? '').slice(0, PREVIEW_CHARS * 4).replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS);
}

let idCounter = 0;
function defaultCreateId() {
  idCounter += 1;
  return `${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createPayloadHistory({
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxBytes = DEFAULT_MAX_BYTES,
  createId = defaultCreateId,
} = {}) {
  let entries = [];
  let index = -1;
  // Bumps on every mutation so async hydration can tell whether the
  // in-memory history changed while it was loading from storage.
  let revision = 0;
  // Ids of saved entries that left the history (evicted, truncated or
  // replaced): the caller drains these and deletes them from storage.
  let garbage = [];

  function makeEntry(text) {
    // Empty entries (clears) need no storage: they are "saved" by definition.
    if (!text) return { id: '', chars: 0, text: '', state: 'saved', preview: '' };
    return { id: createId(), chars: text.length, text, state: 'memory', preview: previewOf(text) };
  }

  function discard(entry) {
    if (entry && entry.id) garbage.push(entry.id);
  }

  function residentChars() {
    let total = 0;
    for (const entry of entries) if (entry.text) total += entry.text.length;
    return total;
  }

  function evict() {
    while (entries.length > maxEntries && entries.length > 1) {
      discard(entries.shift());
      index -= 1;
    }
    // Over the memory budget: saved entries just give up their text (it can
    // be loaded back). Only then drop the oldest unsaved entries other than
    // the current one. Released entries cost nothing, so they are never
    // dropped by this rule.
    if (residentChars() > maxBytes) {
      entries.forEach((entry, i) => {
        if (i !== index && entry.state === 'saved' && entry.text) entry.text = null;
      });
    }
    while (residentChars() > maxBytes) {
      const victim = entries.findIndex((entry, i) => i !== index && entry.text);
      if (victim < 0) break;
      removeAt(victim);
    }
    if (index >= entries.length) index = entries.length - 1;
  }

  function removeAt(position) {
    if (position < 0 || position >= entries.length) return false;
    discard(entries[position]);
    entries.splice(position, 1);
    // Removing the current entry lands on the one before it (else the next).
    if (position < index) index -= 1;
    else if (position === index) index = position > 0 ? position - 1 : (entries.length ? 0 : -1);
    return true;
  }

  function sameText(entry, text) {
    if (!entry || entry.chars !== text.length) return false;
    // A released entry can't be compared cheaply; treat it as different.
    return entry.text !== null && entry.text === text;
  }

  // Record a new payload state. Drops any "forward" entries (the user
  // diverged after going back, like a browser). Consecutive duplicates
  // are ignored.
  function push(text) {
    text = String(text ?? '');
    if (index >= 0 && sameText(entries[index], text)) return false;
    for (const dropped of entries.slice(index + 1)) discard(dropped);
    entries = entries.slice(0, index + 1);
    entries.push(makeEntry(text));
    index = entries.length - 1;
    evict();
    revision += 1;
    return true;
  }

  // The current payload changed without a new paste (formatting): keep the
  // entry count stable and drop newer entries only when the text actually
  // changed. The replaced entry gets a fresh id, so the old copy is deleted
  // from storage and the new one saved.
  function updateCurrent(text) {
    text = String(text ?? '');
    if (index < 0) return push(text);
    if (sameText(entries[index], text)) return false;
    for (const dropped of entries.slice(index + 1)) discard(dropped);
    entries = entries.slice(0, index + 1);
    discard(entries[index]);
    entries[index] = makeEntry(text);
    evict();
    revision += 1;
    return true;
  }

  // Empty entries (left behind by Clear) are not navigation stops: find the
  // nearest non-empty payload in the given direction, or -1 when none.
  function nearestPayload(from, step) {
    let cursor = from;
    while (true) {
      cursor += step;
      if (cursor < 0 || cursor >= entries.length) return -1;
      if (entries[cursor].chars !== 0) return cursor;
    }
  }

  function moveTo(position) {
    if (position < 0 || position >= entries.length) return null;
    index = position;
    return entries[index];
  }

  function toDescriptor(entry) {
    return { id: entry.id, chars: entry.chars, preview: entry.preview || '' };
  }

  return {
    push,
    updateCurrent,
    // Navigation in two steps so the caller can load a released entry's
    // text before committing: peek() finds the target, moveTo() commits.
    peek: (direction) => nearestPayload(index, direction < 0 ? -1 : 1),
    moveTo,
    entryAt: (position) => entries[position] || null,
    removeAt(position) {
      const removed = removeAt(position);
      if (removed) revision += 1;
      return removed;
    },
    back: () => moveTo(nearestPayload(index, -1)),
    forward: () => moveTo(nearestPayload(index, 1)),
    canBack: () => nearestPayload(index, -1) >= 0,
    canForward: () => nearestPayload(index, 1) >= 0,
    // Current text, or null when the current entry was released from memory.
    current: () => (index >= 0 ? entries[index].text : ''),
    currentEntry: () => (index >= 0 ? entries[index] : null),
    index: () => index,
    size: () => entries.length,
    revision: () => revision,
    entries: () => entries.slice(),
    residentChars,
    // Makes a loaded entry resident again (after navigation or a window
    // switch brought it back on screen).
    setText(entry, text) {
      if (entry && entry.chars === text.length) {
        entry.text = text;
        if (!entry.preview) entry.preview = previewOf(text);
      }
    },
    // Releases the text of saved entries; the current entry is kept unless
    // keepCurrent is false (an inactive window). Returns chars released.
    release({ keepCurrent = true } = {}) {
      let freed = 0;
      entries.forEach((entry, i) => {
        if (entry.state !== 'saved' || !entry.text) return;
        if (keepCurrent && i === index) return;
        freed += entry.text.length;
        entry.text = null;
      });
      return freed;
    },
    takeGarbage() {
      const ids = garbage;
      garbage = [];
      return ids;
    },
    toJSON: () => ({ entries: entries.map(toDescriptor), index }),
    // Rebuilds the history from a persisted snapshot; tolerant of bad data.
    // Entries are descriptors ({ id, chars, preview }, text released) or plain
    // strings (legacy records and tests), which come back as unsaved text.
    restore(data) {
      if (!data || !Array.isArray(data.entries)) return false;
      for (const entry of entries) discard(entry);
      entries = data.entries.map((item) => {
        if (item && typeof item === 'object' && typeof item.id === 'string') {
          const chars = Number.isInteger(item.chars) && item.chars >= 0 ? item.chars : 0;
          if (!item.id || chars === 0) return makeEntry('');
          const text = typeof item.text === 'string' && item.text.length === chars ? item.text : null;
          // Entries saved before previews existed get one once loaded.
          const preview = typeof item.preview === 'string' ? item.preview.slice(0, PREVIEW_CHARS) : previewOf(text ?? '');
          return { id: item.id, chars, text, state: 'saved', preview };
        }
        return makeEntry(String(item ?? ''));
      });
      // Restored ids are live in storage: never schedule them for deletion.
      garbage = garbage.filter((id) => !entries.some((entry) => entry.id === id));
      index = entries.length === 0
        ? -1
        : Math.min(Math.max(Number.isInteger(data.index) ? data.index : entries.length - 1, 0), entries.length - 1);
      evict();
      revision += 1;
      return true;
    },
    // Snapshot of the entries worth persisting (the caller's predicate, e.g.
    // not skipped). Rejected entries are dropped; the index is remapped to
    // the nearest surviving entry at or before the old position.
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
        nextIndex = remap[index] ?? -1;
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
