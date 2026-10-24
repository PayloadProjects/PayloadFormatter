// Persistent per-window paste history.
//
// Why IndexedDB and not sessionStorage: sessionStorage is capped around
// 5MB, so ten large-ish datasets would evict each other and the user would
// be back to losing data. IndexedDB quotas are in the hundreds of MB, so
// every pasted dataset in every window actually survives a refresh.
//
// Layout: two object stores.
//  - 'entries': one record per payload, written once and never rewritten.
//    Large payloads are gzip-compressed (JSON/XML typically shrink 5-10x).
//  - 'window-history': one small record per window listing its entry ids
//    and position. Rewriting it on every paste/clear/navigation is cheap.
// Loading a window's history reads only the small list; a payload's text
// is read when it is actually shown (loadEntry).
//
// Records are keyed by browser tab (a random id kept in sessionStorage, so
// it survives refresh but not a new tab): two tabs never share history,
// mirroring how the sessionStorage drafts already behave. Data left behind
// by closed tabs is swept by cleanupStaleHistories, and a total storage
// budget evicts the oldest payloads first (enforceStorageBudget).
//
// Every exported function is total: when storage is unavailable, blocked,
// or over quota, the app degrades to session-only history. A storage
// failure must never break the app or lose the visible payload.
const DB_NAME = 'payload-formatter';
const DB_VERSION = 2;
const META_STORE = 'window-history';
const ENTRY_STORE = 'entries';
const TAB_ID_KEY = 'payload-formatter:tab-id';
const HEARTBEAT_PREFIX = 'payload-formatter:alive:';

// Payloads at or above this size are gzip-compressed. Smaller ones stay
// plain strings: cheaper, and inspectable in devtools.
const COMPRESS_MIN_CHARS = 16 * 1024;
// Without CompressionStream, entries above this size are stored as Blobs:
// IndexedDB keeps Blobs as separate files, skipping a structured-clone copy.
const BLOB_ENTRY_CHARS = 2 * 1024 * 1024;

export const DEFAULT_STORAGE_BUDGET_BYTES = 500 * 1024 * 1024;
export const STALE_TAB_MS = 24 * 3600 * 1000;
// An entry no window lists (a write that lost its window, a failed delete)
// is swept once it is this old; younger ones may belong to a save in flight.
const ORPHAN_ENTRY_MS = 10 * 60 * 1000;

function keyFor(tabId, windowId) {
  return `${tabId}:${windowId}`;
}

// v1 window records carry no tabId field; it is the key's first segment.
function metaTabId(meta) {
  return meta.tabId || String(meta.key ?? '').split(':')[0];
}

async function encode(text) {
  if (text.length >= COMPRESS_MIN_CHARS && typeof CompressionStream === 'function') {
    try {
      const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
      const data = await new Response(stream).blob();
      return { data, encoding: 'gzip', size: data.size };
    } catch (_) { /* fall through to an uncompressed record */ }
  }
  if (text.length > BLOB_ENTRY_CHARS) {
    const data = new Blob([text], { type: 'text/plain;charset=utf-8' });
    return { data, encoding: 'blob', size: data.size };
  }
  return { data: text, encoding: 'text', size: text.length };
}

async function decode(record) {
  if (!record) return null;
  if (record.encoding === 'gzip') {
    const stream = record.data.stream().pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).text();
  }
  if (record.data instanceof Blob) return await record.data.text();
  return String(record.data ?? '');
}

// Legacy (v1) window records held the payload text inline as strings or
// Blobs. They come back as descriptors carrying their text, which the app
// re-saves in the new layout.
async function normalizeMeta(record) {
  const entries = await Promise.all((Array.isArray(record.entries) ? record.entries : []).map(async (item) => {
    if (item && typeof item === 'object' && !(item instanceof Blob) && typeof item.id === 'string') {
      return { id: item.id, chars: Number(item.chars) || 0 };
    }
    return String(item instanceof Blob ? await item.text() : (item ?? ''));
  }));
  return { windowId: record.windowId, entries, index: record.index, updatedAt: record.updatedAt };
}

function entrySummary(record) {
  return {
    id: record.id,
    tabId: record.tabId,
    owner: record.owner,
    size: record.size || 0,
    createdAt: record.createdAt || 0,
  };
}

// In-memory backend: used when IndexedDB is unavailable (jsdom, blocked
// third-party contexts) and as the fallback when IndexedDB fails mid-run.
// Module-level on purpose: it is shared by every importer in the process,
// so in tests a fresh app boot in the same process sees previously saved
// records — exactly how IndexedDB behaves across real refreshes.
function createMemoryBackend() {
  const metas = new Map();
  const entries = new Map();
  return {
    async putMeta(record) { metas.set(record.key, record); },
    async getMetas() { return [...metas.values()]; },
    async deleteMeta(key) { metas.delete(key); },
    async putEntry(record) { entries.set(record.id, record); },
    async getEntry(id) { return entries.get(id) || null; },
    async deleteEntry(id) { entries.delete(id); },
    async listEntries() { return [...entries.values()].map(entrySummary); },
    // Test support: drop everything this backend holds.
    clear() {
      metas.clear();
      entries.clear();
    },
  };
}

const memoryBackend = createMemoryBackend();

// IndexedDB backend. v1 had only the window store with inline payloads;
// v2 adds the entry store and keeps old window records for migration.
function createIndexedDbBackend() {
  let dbPromise = null;
  let broken = false;

  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        let request;
        try {
          request = indexedDB.open(DB_NAME, DB_VERSION);
        } catch (error) {
          reject(error);
          return;
        }
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(META_STORE)) {
            db.createObjectStore(META_STORE, { keyPath: 'key' });
          }
          if (!db.objectStoreNames.contains(ENTRY_STORE)) {
            db.createObjectStore(ENTRY_STORE, { keyPath: 'id' });
          }
        };
        request.onsuccess = () => {
          const db = request.result;
          // Another tab upgrading the schema: step aside instead of blocking it.
          db.onversionchange = () => db.close();
          resolve(db);
        };
        request.onerror = () => reject(request.error || new Error('indexeddb open failed'));
        request.onblocked = () => reject(new Error('indexeddb open blocked'));
      });
      dbPromise.catch(() => {
        // Never retry a dead database; the store falls back to memory.
        broken = true;
        dbPromise = null;
      });
    }
    return dbPromise;
  }

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('indexeddb request failed'));
    });
  }

  async function store(name, mode) {
    const db = await openDb();
    return db.transaction(name, mode).objectStore(name);
  }

  return {
    get unavailable() {
      return broken;
    },
    async putMeta(record) {
      await requestToPromise((await store(META_STORE, 'readwrite')).put(record));
    },
    async getMetas() {
      return await requestToPromise((await store(META_STORE, 'readonly')).getAll());
    },
    async deleteMeta(key) {
      await requestToPromise((await store(META_STORE, 'readwrite')).delete(key));
    },
    async putEntry(record) {
      await requestToPromise((await store(ENTRY_STORE, 'readwrite')).put(record));
    },
    async getEntry(id) {
      return (await requestToPromise((await store(ENTRY_STORE, 'readonly')).get(id))) || null;
    },
    async deleteEntry(id) {
      await requestToPromise((await store(ENTRY_STORE, 'readwrite')).delete(id));
    },
    // Blob values are handles, not contents, so this never reads payloads
    // off disk; only small inline strings come along.
    async listEntries() {
      const records = await requestToPromise((await store(ENTRY_STORE, 'readonly')).getAll());
      return records.map(entrySummary);
    },
  };
}

let idbBackend = null;
let testBackend = null;

function getBackend() {
  if (testBackend) return testBackend;
  if (typeof indexedDB === 'undefined') return memoryBackend;
  if (!idbBackend) idbBackend = createIndexedDbBackend();
  if (idbBackend.unavailable) return memoryBackend;
  return idbBackend;
}

// Entry writes in flight, by id: a delete waits for the write first, so a
// slow save can never resurrect an entry that was already deleted.
const pendingEntryWrites = new Map();

// One id per tab, stable across refresh (sessionStorage survives reload)
// but unique per tab, so histories never cross tabs.
export function getTabId() {
  try {
    let id = sessionStorage.getItem(TAB_ID_KEY);
    if (!id) {
      id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      sessionStorage.setItem(TAB_ID_KEY, id);
    }
    return id;
  } catch (_) {
    return `volatile-${Math.random().toString(36).slice(2, 10)}`;
  }
}

// Open tabs stamp a heartbeat in localStorage (shared across tabs) so the
// sweep can tell a closed tab's leftovers from a tab that is still open.
export function touchTabHeartbeat(tabId) {
  try { localStorage.setItem(HEARTBEAT_PREFIX + tabId, String(Date.now())); } catch (_) {}
}

function readHeartbeats() {
  const beats = new Map();
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith(HEARTBEAT_PREFIX)) {
        beats.set(key.slice(HEARTBEAT_PREFIX.length), Number(localStorage.getItem(key)) || 0);
      }
    }
  } catch (_) {}
  return beats;
}

function dropHeartbeat(tabId) {
  try { localStorage.removeItem(HEARTBEAT_PREFIX + tabId); } catch (_) {}
}

// Saves one payload. Written once per entry id; entries never change.
export async function saveEntry(tabId, windowId, id, text) {
  const task = (async () => {
    const encoded = await encode(String(text ?? ''));
    await getBackend().putEntry({
      id,
      tabId,
      owner: keyFor(tabId, windowId),
      chars: String(text ?? '').length,
      ...encoded,
      createdAt: Date.now(),
    });
  })();
  pendingEntryWrites.set(id, task);
  try {
    await task;
    return true;
  } catch (_) {
    return false;
  } finally {
    if (pendingEntryWrites.get(id) === task) pendingEntryWrites.delete(id);
  }
}

// Reads one payload's text, or null when it is gone (evicted, or storage
// failed): the caller drops it from the history.
export async function loadEntry(id) {
  try {
    const pending = pendingEntryWrites.get(id);
    if (pending) await pending.catch(() => {});
    const text = await decode(await getBackend().getEntry(id));
    return typeof text === 'string' ? text : null;
  } catch (_) {
    return null;
  }
}

export async function deleteEntries(ids) {
  await Promise.all((ids || []).filter(Boolean).map(async (id) => {
    try {
      const pending = pendingEntryWrites.get(id);
      if (pending) await pending.catch(() => {});
      await getBackend().deleteEntry(id);
    } catch (_) {}
  }));
}

// Saves a window's entry list ({ entries: [{ id, chars }], index }).
export async function saveWindowHistory(tabId, windowId, snapshot) {
  try {
    await getBackend().putMeta({
      key: keyFor(tabId, windowId),
      tabId,
      windowId,
      entries: snapshot.entries.map((entry) => ({ id: entry.id, chars: entry.chars })),
      index: snapshot.index,
      updatedAt: Date.now(),
      v: 2,
    });
    return true;
  } catch (_) {
    return false;
  }
}

// This tab's windows: entry lists only, never payload text (legacy records
// excepted, see normalizeMeta).
export async function loadWindowHistories(tabId) {
  try {
    const records = await getBackend().getMetas();
    const prefix = `${tabId}:`;
    const mine = (Array.isArray(records) ? records : [])
      .filter((record) => record && typeof record.key === 'string' && record.key.startsWith(prefix));
    return await Promise.all(mine.map(normalizeMeta));
  } catch (_) {
    return [];
  }
}

// Closing a window forgets its datasets: its list and every payload it owns.
export async function deleteWindowHistory(tabId, windowId) {
  try {
    const backend = getBackend();
    const owner = keyFor(tabId, windowId);
    await backend.deleteMeta(owner);
    const entries = await backend.listEntries();
    await deleteEntries(entries.filter((entry) => entry.owner === owner).map((entry) => entry.id));
  } catch (_) {}
}

// Sweeps what closed tabs left behind. A tab counts as closed when neither
// its heartbeat nor its last save is newer than maxAgeMs (a day by default,
// so a discarded or sleeping tab keeps its history). Also removes entries
// no window lists any more. The current tab is never swept.
export async function cleanupStaleHistories({ tabId = null, maxAgeMs = STALE_TAB_MS, now = Date.now() } = {}) {
  try {
    const backend = getBackend();
    const beats = readHeartbeats();
    const metas = await backend.getMetas();
    const lastSeen = new Map(beats);
    for (const meta of metas) {
      if (!meta) continue;
      const owner = metaTabId(meta);
      lastSeen.set(owner, Math.max(lastSeen.get(owner) || 0, meta.updatedAt || 0));
    }
    const stale = new Set();
    for (const [id, seen] of lastSeen) {
      if (id !== tabId && seen < now - maxAgeMs) stale.add(id);
    }
    const live = new Set();
    for (const meta of metas) {
      if (!meta) continue;
      if (stale.has(metaTabId(meta))) {
        await backend.deleteMeta(meta.key);
        continue;
      }
      for (const entry of Array.isArray(meta.entries) ? meta.entries : []) {
        if (entry && typeof entry.id === 'string') live.add(entry.id);
      }
    }
    const entries = await backend.listEntries();
    await deleteEntries(entries
      .filter((entry) => stale.has(entry.tabId)
        || (!live.has(entry.id) && entry.createdAt < now - ORPHAN_ENTRY_MS))
      .map((entry) => entry.id));
    for (const id of stale) dropHeartbeat(id);
  } catch (_) {}
}

// Keeps the total stored size under maxBytes by deleting the oldest
// payloads first (down to 90% of the budget, so it does not run on every
// paste). Ids in `protect` (what is on screen) are never evicted. A window
// that still lists an evicted id drops it when it next tries to load it.
export async function enforceStorageBudget({ maxBytes = DEFAULT_STORAGE_BUDGET_BYTES, protect = [] } = {}) {
  try {
    const entries = await getBackend().listEntries();
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (total <= maxBytes) return 0;
    const keep = new Set(protect);
    const target = maxBytes * 0.9;
    const victims = [];
    for (const entry of entries.sort((a, b) => a.createdAt - b.createdAt)) {
      if (total <= target) break;
      if (keep.has(entry.id)) continue;
      victims.push(entry.id);
      total -= entry.size;
    }
    await deleteEntries(victims);
    return victims.length;
  } catch (_) {
    return 0;
  }
}

// Ask the browser not to evict this origin's storage under disk pressure.
// Best-effort and silent: Safari can still drop it (7-day ITP rule), and the
// app already degrades to session-only history when storage goes away.
export function requestPersistence() {
  try {
    const storage = typeof navigator !== 'undefined' ? navigator.storage : null;
    if (storage && typeof storage.persist === 'function') {
      Promise.resolve(storage.persist()).catch(() => {});
    }
  } catch (_) {}
}

// Test support: install an instrumented backend (e.g. deferred or failing),
// or drop back to the default selection with null.
export function __useTestBackend(backend) {
  testBackend = backend || null;
}

export function __clearMemoryBackend() {
  memoryBackend.clear();
}

// Test support: the in-memory backend, for tests that build on it.
export function __memoryBackend() {
  return memoryBackend;
}
