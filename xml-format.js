export function normalizeEscapedXml(input) {
  let s = input.trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    try {
      const parsed = JSON.parse(s);
      if (typeof parsed === 'string' && parsed.includes('<')) s = parsed.trim();
    } catch (_) {}
  }
  s = s.replace(/\\+"/g, '"');
  return s;
}

export function prettyXml(xml) {
  const source = String(xml ?? '').trim();
  if (!source) return '';
  return formatXmlTokens(tokenizeXml(source));
}

export function formatAndValidateXml(xml) {
  const source = String(xml ?? '').trim();
  if (!source) throw new Error('Invalid XML: no XML elements were found.');
  return formatAndValidateXmlStreaming(source);
}

function formatAndValidateXmlStreaming(source) {
  const chunks = [];
  const stack = [];
  const indentCache = [''];
  let depth = 0;
  let index = 0;
  let textStart = 0;
  let found = 0;
  let lastApplied = 'undefined';

  const indent = () => {
    const safeDepth = Math.min(depth, 255);
    while (indentCache.length <= safeDepth) {
      indentCache.push(indentCache[indentCache.length - 1] + '\t');
    }
    return indentCache[safeDepth];
  };

  const structuralBreak = () => {
    chunks.push('\n', indent());
  };

  const appendText = (end) => {
    if (end <= textStart) return;
    let hasNonWhitespace = false;
    for (let i = textStart; i < end; i += 1) {
      const code = source.charCodeAt(i);
      if (code !== 32 && code !== 9 && code !== 10 && code !== 13) {
        hasNonWhitespace = true;
        break;
      }
    }
    if (!hasNonWhitespace) return;
    chunks.push(source.slice(textStart, end));
    lastApplied = 'text';
  };

  while (index < source.length) {
    const lt = source.indexOf('<', index);
    if (lt < 0) break;

    appendText(lt);

    // Comments / CDATA / declarations / processing instructions are handled
    // directly without creating temporary token objects.
    if (source.startsWith('<!--', lt)) {
      const close = source.indexOf('-->', lt + 4);
      if (close < 0) throw new Error('Invalid XML: unterminated comment.');
      if (!['text', 'cdata', 'undefined'].includes(lastApplied)) structuralBreak();
      chunks.push(source.slice(lt, close + 3));
      lastApplied = 'comment';
      index = close + 3;
      textStart = index;
      continue;
    }

    if (source.startsWith('<![CDATA[', lt)) {
      const close = source.indexOf(']]>', lt + 9);
      if (close < 0) throw new Error('Invalid XML: unterminated CDATA section.');
      chunks.push(source.slice(lt, close + 3));
      lastApplied = 'cdata';
      index = close + 3;
      textStart = index;
      continue;
    }

    if (source.startsWith('<?', lt)) {
      const close = source.indexOf('?>', lt + 2);
      if (close < 0) throw new Error('Invalid XML: unterminated processing instruction.');
      chunks.push(source.slice(lt, close + 2));
      lastApplied = 'instruction';
      index = close + 2;
      textStart = index;
      continue;
    }

    if (source.startsWith('<!', lt)) {
      const close = findXmlTagEnd(source, lt);
      if (close < 0) throw new Error('Invalid XML: unterminated declaration.');
      if (!['text', 'cdata', 'undefined'].includes(lastApplied)) structuralBreak();
      chunks.push(source.slice(lt, close + 1).trim());
      lastApplied = 'declaration';
      index = close + 1;
      textStart = index;
      continue;
    }

    const tagEnd = findXmlTagEnd(source, lt);
    if (tagEnd < 0) throw new Error('Invalid XML: unterminated tag.');

    const closing = source.charCodeAt(lt + 1) === 47;
    let nameStart = lt + (closing ? 2 : 1);
    while (nameStart < tagEnd && isXmlWhitespaceCode(source.charCodeAt(nameStart))) nameStart += 1;
    let nameEnd = nameStart;
    while (nameEnd < tagEnd) {
      const code = source.charCodeAt(nameEnd);
      if (isXmlWhitespaceCode(code) || code === 47 || code === 62) break;
      nameEnd += 1;
    }
    const name = source.slice(nameStart, nameEnd);
    if (!name) throw new Error('Invalid XML: malformed tag.');

    if (closing) {
      found += 1;
      const expected = stack.pop();
      if (expected !== name) {
        throw new Error(`Invalid XML: expected closing tag </${expected || '?'}> but found </${name}>.`);
      }
      depth = Math.max(0, depth - 1);
      if (!['text', 'cdata', 'open-end', 'undefined'].includes(lastApplied)) structuralBreak();
      chunks.push('</', name, '>');
      lastApplied = 'close-end';
      index = tagEnd + 1;
      textStart = index;
      continue;
    }

    let probe = tagEnd - 1;
    while (probe > nameEnd && isXmlWhitespaceCode(source.charCodeAt(probe))) probe -= 1;
    const selfClosing = source.charCodeAt(probe) === 47;
    found += 1;

    if (!['text', 'cdata', 'undefined'].includes(lastApplied)) structuralBreak();

    const normalized = normalizeXmlOpeningTagFast(source, lt, tagEnd, nameStart, nameEnd, selfClosing);

    if (!selfClosing) {
      const immediate = findImmediateClosingTagFast(source, tagEnd + 1, name);
      if (immediate >= 0) {
        chunks.push(normalized.slice(0, -1), '/>');
        index = immediate;
        textStart = index;
        lastApplied = 'self-end';
        continue;
      }

      chunks.push(normalized);
      stack.push(name);
      depth += 1;
      lastApplied = 'open-end';
    } else {
      chunks.push(normalized);
      lastApplied = 'self-end';
    }

    index = tagEnd + 1;
    textStart = index;
  }

  appendText(source.length);

  if (!found) throw new Error('Invalid XML: no XML elements were found.');
  if (stack.length) {
    throw new Error(`Invalid XML: missing closing tag for <${stack[stack.length - 1]}>.`);
  }

  return chunks.join('');
}

function normalizeXmlOpeningTagFast(source, tagStart, tagEnd, nameStart, nameEnd, selfClosing) {
  // Fast return when the tag already has canonical spacing. Most machine-
  // generated XML takes this path, avoiding a second attribute parse.
  let needsNormalization = false;
  let quote = 0;
  let previousWasSpace = false;

  for (let i = nameEnd; i < tagEnd; i += 1) {
    const code = source.charCodeAt(i);
    if (quote) {
      if (code === quote) quote = 0;
      continue;
    }
    if (code === 34 || code === 39) {
      quote = code;
      previousWasSpace = false;
      continue;
    }
    if (code === 9 || code === 10 || code === 13) {
      needsNormalization = true;
      break;
    }
    if (code === 32) {
      if (previousWasSpace) {
        needsNormalization = true;
        break;
      }
      previousWasSpace = true;
      continue;
    }
    if (code === 61) {
      if ((i > tagStart && source.charCodeAt(i - 1) === 32)
          || (i + 1 < tagEnd && source.charCodeAt(i + 1) === 32)) {
        needsNormalization = true;
        break;
      }
    }
    previousWasSpace = false;
  }

  if (!needsNormalization) {
    return source.slice(tagStart, tagEnd + 1).trim();
  }

  return normalizeXmlOpeningTag(source.slice(tagStart, tagEnd + 1), selfClosing);
}

function findImmediateClosingTagFast(source, from, name) {
  let index = from;
  while (index < source.length && isXmlWhitespaceCode(source.charCodeAt(index))) index += 1;
  if (source.charCodeAt(index) !== 60 || source.charCodeAt(index + 1) !== 47) return -1;

  let cursor = index + 2;
  while (cursor < source.length && isXmlWhitespaceCode(source.charCodeAt(cursor))) cursor += 1;
  if (!source.startsWith(name, cursor)) return -1;
  cursor += name.length;
  while (cursor < source.length && isXmlWhitespaceCode(source.charCodeAt(cursor))) cursor += 1;
  if (source.charCodeAt(cursor) !== 62) return -1;
  return cursor + 1;
}

function isXmlWhitespaceCode(code) {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

function formatXmlTokens(tokens) {
  const chunks = [];
  let depth = 0;
  let lastApplied = 'undefined';
  const indentCache = [''];

  const indent = () => {
    const safeDepth = Math.min(depth, 255);
    while (indentCache.length <= safeDepth) {
      indentCache.push(indentCache[indentCache.length - 1] + '\t');
    }
    return indentCache[safeDepth];
  };

  const writeStructuralBreak = () => {
    chunks.push('\n', indent());
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;

    if (token.type === 'text') {
      if (!token.value.trim()) continue;
      chunks.push(token.value);
      lastApplied = 'text';
      continue;
    }

    if (token.type === 'cdata') {
      chunks.push(token.value);
      lastApplied = 'cdata';
      continue;
    }

    if (token.type === 'pi') {
      chunks.push(token.value);
      lastApplied = 'instruction';
      continue;
    }

    if (token.type === 'comment') {
      if (!['text', 'cdata', 'undefined'].includes(lastApplied)) writeStructuralBreak();
      chunks.push(token.value);
      lastApplied = 'comment';
      continue;
    }

    if (token.type === 'declaration') {
      if (!['text', 'cdata', 'undefined'].includes(lastApplied)) writeStructuralBreak();
      chunks.push(token.value);
      lastApplied = 'declaration';
      continue;
    }

    if (token.type === 'close') {
      depth = Math.max(0, depth - 1);
      if (!['text', 'cdata', 'open-end', 'undefined'].includes(lastApplied)) writeStructuralBreak();
      chunks.push('</', token.name, '>');
      lastApplied = 'close-end';
      continue;
    }

    if (token.type === 'open' || token.type === 'self') {
      if (!['text', 'cdata', 'undefined'].includes(lastApplied)) writeStructuralBreak();

      const normalized = normalizeXmlOpeningTag(token.value, token.type === 'self');

      if (
        token.type === 'open'
        && tokens[index + 1]?.type === 'close'
        && tokens[index + 1]?.name === token.name
      ) {
        chunks.push(normalized.slice(0, -1), '/>');
        index += 1;
        lastApplied = 'self-end';
        continue;
      }

      chunks.push(normalized);
      if (token.type === 'open') {
        depth += 1;
        lastApplied = 'open-end';
      } else {
        lastApplied = 'self-end';
      }
    }
  }

  return chunks.join('');
}


function tokenizeXml(source) {
  const tokens = [];
  let index = 0;
  let textStart = 0;

  const pushText = (end) => {
    if (end > textStart) tokens.push({ type: 'text', value: source.slice(textStart, end), name: '' });
  };

  while (index < source.length) {
    if (source[index] !== '<') {
      index += 1;
      continue;
    }

    pushText(index);
    const end = findXmlTagEnd(source, index);
    if (end < 0) {
      tokens.push({ type: 'text', value: source.slice(index), name: '' });
      return tokens;
    }

    const value = source.slice(index, end + 1);
    tokens.push(classifyXmlToken(value));
    index = end + 1;
    textStart = index;
  }

  pushText(source.length);
  return tokens;
}

function findXmlTagEnd(source, start) {
  if (source.startsWith('<!--', start)) {
    const end = source.indexOf('-->', start + 4);
    return end < 0 ? -1 : end + 2;
  }
  if (source.startsWith('<![CDATA[', start)) {
    const end = source.indexOf(']]>', start + 9);
    return end < 0 ? -1 : end + 2;
  }

  let quote = '';
  let bracketDepth = 0;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '[') {
      bracketDepth += 1;
      continue;
    }
    if (char === ']' && bracketDepth > 0) {
      bracketDepth -= 1;
      continue;
    }
    if (char === '>' && bracketDepth === 0) return index;
  }
  return -1;
}

function classifyXmlToken(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('</')) return { type: 'close', value: trimmed, name: xmlTagName(trimmed, 2) };
  if (trimmed.startsWith('<?')) return { type: 'pi', value: trimmed, name: '' };
  if (trimmed.startsWith('<!--')) return { type: 'comment', value: trimmed, name: '' };
  if (trimmed.startsWith('<![CDATA[')) return { type: 'cdata', value: trimmed, name: '' };
  if (trimmed.startsWith('<!')) return { type: 'declaration', value: trimmed, name: '' };
  if (/\/\s*>$/.test(trimmed)) return { type: 'self', value: trimmed, name: xmlTagName(trimmed, 1) };
  return { type: 'open', value: trimmed, name: xmlTagName(trimmed, 1) };
}

function normalizeXmlOpeningTag(value, selfClosing) {
  const endLength = selfClosing ? 2 : 1;
  const inner = value.slice(1, value.length - endLength);
  let index = 0;

  while (index < inner.length && /\s/.test(inner[index])) index += 1;
  const nameStart = index;
  while (index < inner.length && !/\s/.test(inner[index])) index += 1;
  const name = inner.slice(nameStart, index);

  let normalized = `<${name}`;

  while (index < inner.length) {
    while (index < inner.length && /\s/.test(inner[index])) index += 1;
    if (index >= inner.length) break;

    const attrStart = index;
    while (index < inner.length && !/[\s=]/.test(inner[index])) index += 1;
    const attrName = inner.slice(attrStart, index);
    if (!attrName) break;

    while (index < inner.length && /\s/.test(inner[index])) index += 1;
    normalized += ` ${attrName}`;

    if (inner[index] !== '=') continue;

    index += 1;
    while (index < inner.length && /\s/.test(inner[index])) index += 1;
    normalized += '=';

    if (inner[index] === '"' || inner[index] === "'") {
      const quote = inner[index];
      const valueStart = index;
      index += 1;
      while (index < inner.length && inner[index] !== quote) index += 1;
      if (index < inner.length) index += 1;
      normalized += inner.slice(valueStart, index);
    } else {
      const valueStart = index;
      while (index < inner.length && !/\s/.test(inner[index])) index += 1;
      normalized += inner.slice(valueStart, index);
    }
  }

  return normalized + (selfClosing ? '/>' : '>');
}

function xmlTagName(value, start) {
  let index = start;
  while (index < value.length && /\s/.test(value[index])) index += 1;
  const begin = index;
  while (index < value.length && !/[\s/>]/.test(value[index])) index += 1;
  return value.slice(begin, index);
}

export function validateXmlLight(xml) {
  const source = String(xml ?? '').trim();
  if (!source) throw new Error('Invalid XML: no XML elements were found.');
  validateXmlTokens(tokenizeXml(source));
  return true;
}

function validateXmlTokens(tokens) {
  const stack = [];
  let found = 0;

  for (const token of tokens) {
    if (token.type === 'open') {
      found += 1;
      stack.push(token.name);
      continue;
    }
    if (token.type === 'self') {
      found += 1;
      continue;
    }
    if (token.type === 'close') {
      found += 1;
      const expected = stack.pop();
      if (expected !== token.name) {
        throw new Error(`Invalid XML: expected closing tag </${expected || '?'}> but found </${token.name}>.`);
      }
    }
  }

  if (!found) throw new Error('Invalid XML: no XML elements were found.');
  if (stack.length) throw new Error(`Invalid XML: missing closing tag for <${stack[stack.length - 1]}>.`);
}

