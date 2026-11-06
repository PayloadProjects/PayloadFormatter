// Remembers the two sides across a reload, in this browser only, the same way the
// app keeps window history. Storage failing just means nothing is restored.
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

export async function saveSession(key, value) {
  if (typeof indexedDB === 'undefined') return;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (_) {
    // Nothing to do: the comparison on screen is unaffected.
  }
}

export async function loadSession() {
  if (typeof indexedDB === 'undefined') return null;
  try {
    const db = await openDb();
    const read = (key) => new Promise((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get(key);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
    const [state, left, right] = await Promise.all([read('state'), read('left'), read('right')]);
    db.close();
    return { state, left, right };
  } catch (_) {
    return null;
  }
}
