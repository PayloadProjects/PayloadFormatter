// Where a line sits in a formatted payload, found from its indentation: walk up
// to each less-indented line. Only meaningful for formatted text, and gives up
// on extremely long walks rather than freezing the page on a caret move.
import { pathString } from '../panels/inspector.js';

const MAX_WALK_LINES = 1_000_000;

function indentOf(text) {
  let indent = 0;
  while (indent < text.length) {
    const code = text.charCodeAt(indent);
    if (code !== 32 && code !== 9) break;
    indent += 1;
  }
  return indent;
}

const isCloser = (text, indent) => {
  const code = text.charCodeAt(indent);
  return code === 125 || code === 93;
};
const opensArray = (text) => /\[\s*$/.test(text);

function keyOf(text) {
  const raw = /^\s*"((?:[^"\\]|\\.)*)"\s*:/.exec(text)?.[1];
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(`"${raw}"`);
  } catch (_) {
    return raw;
  }
}

// [{ key } | { index }] from the root to this line, or null if it took too long.
export function jsonPathSegments(getLine, lineIndex) {
  let line = lineIndex;
  let walked = 0;
  const first = getLine(line);
  // A closing bracket belongs to the value it closes: find where that opened.
  if (isCloser(first, indentOf(first))) {
    const indent = indentOf(first);
    while (line > 0) {
      line -= 1;
      walked += 1;
      if (walked > MAX_WALK_LINES) return null;
      if (indentOf(getLine(line)) === indent) break;
    }
  }
  const segments = [];
  for (;;) {
    const text = getLine(line);
    const indent = indentOf(text);
    if (indent === 0) break;
    // One pass up to the parent, counting the items started on the way.
    let items = 0;
    let parent = line - 1;
    for (; parent >= 0; parent -= 1) {
      walked += 1;
      if (walked > MAX_WALK_LINES) return null;
      const above = getLine(parent);
      const aboveIndent = indentOf(above);
      if (aboveIndent < indent) break;
      if (aboveIndent === indent && !isCloser(above, indent)) items += 1;
    }
    if (parent < 0) break;
    if (opensArray(getLine(parent))) {
      segments.unshift({ index: items });
    } else {
      const key = keyOf(text);
      if (key !== undefined) segments.unshift({ key });
    }
    line = parent;
  }
  return segments;
}

export function xmlPathSegments(getLine, lineIndex) {
  const nameOf = (text) => /^\s*<([^\s/>!?]+)/.exec(text)?.[1];
  const segments = [];
  let indent = indentOf(getLine(lineIndex));
  const own = nameOf(getLine(lineIndex));
  if (own) segments.unshift({ tag: own });
  let walked = 0;
  for (let i = lineIndex - 1; i >= 0 && indent > 0; i -= 1) {
    walked += 1;
    if (walked > MAX_WALK_LINES) return null;
    const text = getLine(i);
    const lineIndent = indentOf(text);
    if (lineIndent >= indent) continue;
    const name = nameOf(text);
    if (name) segments.unshift({ tag: name });
    indent = lineIndent;
  }
  return segments;
}

export function jsonPathAt(getLine, lineIndex) {
  const segments = jsonPathSegments(getLine, lineIndex);
  return segments ? pathString('json', segments) : '';
}

export function xmlPathAt(getLine, lineIndex) {
  const segments = xmlPathSegments(getLine, lineIndex);
  return segments?.length ? pathString('xml', segments) : '';
}
