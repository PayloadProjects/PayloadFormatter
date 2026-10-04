// Persistent per-window paste history.
//
// Why IndexedDB and not sessionStorage: sessionStorage is capped around
// 5MB, so ten large-ish datasets would evict each other and the user would
// be back to losing data. IndexedDB quotas are in the hundreds of MB, so
// every pasted dataset in every window actually survives a refresh.
//
// Records are keyed by browser tab (a random id kept in sessionStorage, so
// it survives refresh but not a new tab): two tabs never share history,
// mirroring how the sessionStorage drafts already behave.
//
// Every exported function is total: when storage is unavailable, blocked,
// or over quota, the app degrades to session-only history. A storage
// failure must never break the app or lose the visible payload.
const DB_NAME = 'payload-formatter';
const STORE_NAME = 'window-history';
const TAB_ID_KEY = 'payload-formatter:tab-id';

function keyFor(tabId, windowId) {
  return `${tabId}:${windowId}`;
}

// Entries above this size are stored as Blobs instead of inline strings.
// IndexedDB keeps Blobs as separate files on disk, so a 20MB payload skips
// the structured-clone copy and doesn't balloon a single record. Small
// entries stay plain strings: cheaper, and inspectable in devtools.
const BLOB_ENTRY_BYTES = 2 * 1024 * 1024;

function toStorable(entry) {
  const text = String(entry ?? '');
  return text.length > BLOB_ENTRY_BYTES
    ? new Blob([text], { type: 'text/plain;charset=utf-8' })
    : text;
}

async function fromStorable(entry) {
  if (entry instanceof Blob) return await entry.text();
  return String(entry ?? '');
}

async function restoreEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return Promise.all(entries.map(fromStorable));
}

// In-memory backend: used when IndexedDB is unavailable (jsdom, blocked
// third-party contexts) and as the fallback when IndexedDB fails mid-run.
// Module-level on purpose: it is shared by every importer in the process,
// so in tests a fresh app boot in the same process sees previously saved
// records — exactly how IndexedDB behaves across real refreshes.
function createMemoryBackend() {
  const records = new Map();
  return {
    async loadAll(tabId) {
      const prefix = `${tabId}:`;
      const out = [];
      for (const record of records.values()) {
        if (record.key.startsWith(prefix)) {
          out.push({ ...record, entries: await restoreEntries(record.entries) });
        }
      }
      return out;
    },
    async save(tabId, windowId, snapshot) {
      records.set(keyFor(tabId, windowId), {
        key: keyFor(tabId, windowId),
        windowId,
        entries: snapshot.entries.map(toStorable),
        index: snapshot.index,
        updatedAt: Date.now(),
      });
    },
    async remove(tabId, windowId) {
      records.delete(keyFor(tabId, windowId));
    },
    async cleanup(before) {
      for (const [key, record] of records) {
        if (record.updatedAt < before) records.delete(key);
      }
    },
    // Test support: drop everything this backend holds.
    clear() {
      records.clear();
    },
  };
}

const memoryBackend = createMemoryBackend();

// IndexedDB backend. One database, one object store, one record per window:
// { key, windowId, entries, index, updatedAt }.
function createIndexedDbBackend() {
  let dbPromise = null;
  let broken = false;

  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        let request;
        try {
          request = indexedDB.open(DB_NAME, 1);
        } catch (error) {
          reject(error);
          return;
        }
        request.onupgradeneeded = () => {
          request.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
        };
        request.onsuccess = () => resolve(request.result);
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

  async function store(mode) {
    const db = await openDb();
    return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
  }

  return {
    get unavailable() {
      return broken;
    },
    async loadAll(tabId) {
      const objectStore = await store('readonly');
      const records = await requestToPromise(objectStore.getAll());
      const prefix = `${tabId}:`;
      const out = [];
      for (const record of records) {
        if (record && typeof record.key === 'string' && record.key.startsWith(prefix)) {
          out.push({ ...record, entries: await restoreEntries(record.entries) });
        }
      }
      return out;
    },
    async save(tabId, windowId, snapshot) {
      const objectStore = await store('readwrite');
      await requestToPromise(objectStore.put({
        key: keyFor(tabId, windowId),
        windowId,
        entries: snapshot.entries.map(toStorable),
        index: snapshot.index,
        updatedAt: Date.now(),
      }));
    },
    async remove(tabId, windowId) {
      const objectStore = await store('readwrite');
      await requestToPromise(objectStore.delete(keyFor(tabId, windowId)));
    },
    async cleanup(before) {
      const objectStore = await store('readwrite');
      const records = await requestToPromise(objectStore.getAll());
      await Promise.all(
        records
          .filter((record) => record && record.updatedAt < before)
          .map((record) => requestToPromise(objectStore.delete(record.key))),
      );
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

export async function saveWindowHistory(tabId, windowId, snapshot) {
  try {
    await getBackend().save(tabId, windowId, snapshot);
    return true;
  } catch (_) {
    return false;
  }
}

export async function loadWindowHistories(tabId) {
  try {
    const records = await getBackend().loadAll(tabId);
    return Array.isArray(records) ? records : [];
  } catch (_) {
    return [];
  }
}

export async function deleteWindowHistory(tabId, windowId) {
  try {
    await getBackend().remove(tabId, windowId);
  } catch (_) {}
}

export async function cleanupStaleHistories(maxAgeMs = 7 * 24 * 3600 * 1000) {
  try {
    await getBackend().cleanup(Date.now() - maxAgeMs);
  } catch (_) {}
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
