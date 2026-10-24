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
