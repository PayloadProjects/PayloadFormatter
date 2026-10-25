// jsdom has no layout engine: Range geometry methods are missing, and the
// CodeMirror text view calls them when it measures lines. Give them empty
// geometry so measuring degrades quietly instead of logging TypeErrors.
export function shimLayout(window) {
  const proto = window?.Range?.prototype;
  if (!proto) return;
  const emptyRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
  if (!proto.getClientRects) {
    proto.getClientRects = () => Object.assign([], { item: () => null });
  }
  if (!proto.getBoundingClientRect) proto.getBoundingClientRect = emptyRect;
}

// History Back/Forward is synchronous for entries still in memory, but an
// entry kept only in storage is loaded first, with the page marked busy
// (body.busy) until it lands. On a slow CI runner that load can outlast any
// fixed delay, so after clicking a history button wait for the short delay
// and then for the app to leave the busy state.
export async function settleAfter(element, ms = 50, timeoutMs = 10000) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  const body = element?.ownerDocument?.body;
  const deadline = Date.now() + timeoutMs;
  while (body?.classList.contains('busy') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
