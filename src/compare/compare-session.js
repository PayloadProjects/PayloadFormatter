// Remembers each window's comparison across a reload, in this browser only, the
// same way the app keeps window history. Storage failing just means nothing is
// restored.
const DB_NAME = 'payload-formatter-compare';
const STORE = 'session';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function write(run) {
  if (typeof indexedDB === 'undefined') return;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      run(tx.objectStore(STORE));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (_) {
    // Nothing to do: the comparison on screen is unaffected.
  }
}

export function saveSession(key, value) {
  return write((store) => store.put(value, key));
}

export function deleteSession(key) {
  return write((store) => store.delete(key));
}

// Every saved record, as { key: value }.
export async function loadSession() {
  if (typeof indexedDB === 'undefined') return {};
  try {
    const db = await openDb();
    const entries = await new Promise((resolve, reject) => {
      const found = {};
      const request = db.transaction(STORE).objectStore(STORE).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(found);
          return;
        }
        found[cursor.key] = cursor.value;
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
    db.close();
    return entries;
  } catch (_) {
    return {};
  }
}
