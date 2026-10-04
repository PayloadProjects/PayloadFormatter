// Payload windows: multiple named payload panels inside the one page, so the
// user can juggle payloads without switching browser tabs. Pure model, no DOM:
// each window owns its payload and its own paste history (like a browser tab
// owns its navigation history). Persistence of payloads lives in app.js; the
// manager only serializes the lightweight list (ids, names, active, counter).
import { createPayloadHistory } from './payload-history.js';

export const MAX_WINDOWS = 20;
export const MAX_WINDOW_NAME_LENGTH = 40;

export function createWindowManager() {
  let windows = [];
  let activeId = null;
  let counter = 0;

  function cleanName(name) {
    return String(name ?? '').trim().slice(0, MAX_WINDOW_NAME_LENGTH);
  }

  function getWindow(id) {
    return windows.find((win) => win.id === id) || null;
  }

  function getActive() {
    return getWindow(activeId) || windows[0] || null;
  }

  // Creates a window (does not activate it); returns null at the cap.
  // The history starts seeded with the initial payload when there is one.
  function newWindow(name, payload = '') {
    if (windows.length >= MAX_WINDOWS) return null;
    counter += 1;
    const text = String(payload ?? '');
    const win = {
      id: `window-${counter}`,
      name: cleanName(name) || `Window ${counter}`,
      payload: text,
      history: createPayloadHistory(),
    };
    if (text) win.history.push(text);
    windows.push(win);
    if (!activeId) activeId = win.id;
    return win;
  }

  // Rebuilds one window from persisted metadata; payloads are restored by
  // the caller through the payload argument.
  function restoreWindow(id, name, payload = '') {
    if (getWindow(id) || windows.length >= MAX_WINDOWS) return null;
    const text = String(payload ?? '');
    const win = {
      id: String(id),
      name: cleanName(name) || 'Window',
      payload: text,
      history: createPayloadHistory(),
    };
    if (text) win.history.push(text);
    windows.push(win);
    if (!activeId) activeId = win.id;
    return win;
  }

  function setActive(id) {
    if (!getWindow(id)) return false;
    activeId = id;
    return true;
  }

  function setCounter(value) {
    if (Number.isFinite(value) && value >= counter) counter = Math.floor(value);
  }

  // Blank names are ignored so a cancelled rename keeps the old name.
  function renameWindow(id, name) {
    const win = getWindow(id);
    const clean = cleanName(name);
    if (!win || !clean || clean === win.name) return false;
    win.name = clean;
    return true;
  }

  // Closing the active window activates its neighbour (next, else previous).
  // The last window cannot be closed; the caller clears it instead.
  function closeWindow(id) {
    const index = windows.findIndex((win) => win.id === id);
    if (index < 0) return null;
    if (windows.length === 1) return { closed: false };
    const [removed] = windows.splice(index, 1);
    let activateId = activeId;
    if (removed.id === activeId) {
      activateId = (windows[index] || windows[index - 1]).id;
      activeId = activateId;
    }
    return { closed: true, removed, activateId };
  }

  function toJSON() {
    return {
      windows: windows.map((win) => ({ id: win.id, name: win.name })),
      activeId,
      counter,
    };
  }

  return {
    newWindow,
    restoreWindow,
    getWindow,
    getActive,
    setActive,
    setCounter,
    renameWindow,
    closeWindow,
    toJSON,
    get windows() { return windows; },
    get activeId() { return activeId; },
    get size() { return windows.length; },
  };
}
