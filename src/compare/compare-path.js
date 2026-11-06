// Where a line sits in a formatted payload, found from its indentation: walk up
// to each less-indented line. Only meaningful for formatted text, and gives up
// on very long walks rather than slowing the caret down.
const MAX_WALK_LINES = 20000;

const indentOf = (text) => /^\s*/.exec(text)[0].length;
const isCloser = (text) => /^\s*[}\]]/.test(text);
const keyOf = (text) => /^\s*"((?:[^"\\]|\\.)*)"\s*:/.exec(text)?.[1];

// How many items of the array start before this line. An item starts at the
// array's item indent, and anything that isn't a closing bracket starts one.
function itemIndex(getLine, line, arrayLine, indent) {
  let index = 0;
  for (let i = line - 1; i > arrayLine; i -= 1) {
    const text = getLine(i);
    if (indentOf(text) === indent && !isCloser(text)) index += 1;
  }
  return index;
}

export function jsonPathAt(getLine, lineIndex) {
  let line = lineIndex;
  // A closing bracket belongs to the value it closes: find where that opened.
  if (isCloser(getLine(line))) {
    const indent = indentOf(getLine(line));
    let walked = 0;
    while (line > 0) {
      line -= 1;
      walked += 1;
      if (walked > MAX_WALK_LINES) return '';
      if (indentOf(getLine(line)) === indent) break;
    }
  }
  const parts = [];
  let walked = 0;
  for (;;) {
    const text = getLine(line);
    const indent = indentOf(text);
    if (indent === 0) break;
    let parent = line - 1;
    while (parent >= 0 && indentOf(getLine(parent)) >= indent) {
      parent -= 1;
      walked += 1;
      if (walked > MAX_WALK_LINES) return '';
    }
    if (parent < 0) break;
    if (/\[\s*$/.test(getLine(parent))) {
      parts.unshift(`[${itemIndex(getLine, line, parent, indent)}]`);
    } else {
      const key = keyOf(text);
      if (key !== undefined) parts.unshift(`.${key}`);
    }
    line = parent;
  }
  return `$${parts.join('')}`;
}

export function xmlPathAt(getLine, lineIndex) {
  const nameOf = (text) => /^\s*<([^\s/>!?]+)/.exec(text)?.[1];
  const parts = [];
  let indent = indentOf(getLine(lineIndex));
  const own = nameOf(getLine(lineIndex));
  if (own) parts.unshift(own);
  let walked = 0;
  for (let i = lineIndex - 1; i >= 0 && indent > 0; i -= 1) {
    walked += 1;
    if (walked > MAX_WALK_LINES) return '';
    const text = getLine(i);
    const lineIndent = indentOf(text);
    if (lineIndent >= indent) continue;
    const name = nameOf(text);
    if (name) parts.unshift(name);
    indent = lineIndent;
  }
  return parts.length ? `/${parts.join('/')}` : '';
}
