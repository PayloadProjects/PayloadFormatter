import { Prism } from './vendor/prism/prism.js';
import { MAX_HIGHLIGHT_CHARS, MAX_TOKEN_SPANS } from './syntax-shared.js';

// Lexing only: never parse, repair, decode, or rewrite the user's payload.
// Compact offsets are transferred to the renderer; no generated HTML crosses threads.
export function buildSyntaxModel(text, mode) {
  if (typeof text !== 'string' || text.length > MAX_HIGHLIGHT_CHARS) {
    throw new RangeError('Displayed text exceeds the highlighting budget.');
  }
  const lines = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines.push(i + 1);
  const spans = [];
  let offset = 0;
  const grammar = mode === 'xml' ? Prism.languages.xml : mode === 'json' ? Prism.languages.json : null;
  const colors = { property: 1, string: 2, 'attr-value': 2, cdata: 2, number: 3, boolean: 4,
    null: 4, keyword: 4, punctuation: 5, operator: 5, 'attr-name': 6, tag: 7,
    entity: 8, comment: 9, doctype: 9, prolog: 9 };
  function write(length, color) {
    const start = offset;
    offset += length;
    if (!color || !length) return;
    const end = spans.length;
    if (end && spans[end - 1] === color && spans[end - 2] === start) {
      spans[end - 2] = offset;
    } else if (end < MAX_TOKEN_SPANS * 3) {
      spans.push(start, offset, color);
    }
  }
  function visit(token, inherited = 0) {
    if (typeof token === 'string') return write(token.length, inherited);
    if (Array.isArray(token)) {
      for (const child of token) visit(child, inherited);
      return;
    }
    if (token.type === 'cdata' && typeof token.content === 'string'
        && token.content.startsWith('<![CDATA[') && token.content.endsWith(']]>')) {
      write(9, 5); write(token.content.length - 12, 2); write(3, 5);
      return;
    }
    visit(token.content, colors[token.type] ?? inherited);
  }
  visit(grammar ? Prism.tokenize(text, grammar) : text, mode === 'xml' ? 2 : 0);
  if (offset !== text.length) throw new Error('Highlighting offsets did not preserve the source.');
  return { lines: Uint32Array.from(lines), spans: Uint32Array.from(spans) };
}
