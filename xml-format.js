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

  const tokens = tokenizeXml(source);
  let output = '';
  let depth = 0;
  let lastApplied = 'undefined';

  const writeStructuralBreak = () => {
    if (output && !output.endsWith('\n')) output += '\n';
    output += '\t'.repeat(Math.min(depth, 255));
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;

    if (token.type === 'text') {
      if (!token.value.trim()) continue;
      output += token.value;
      lastApplied = 'text';
      continue;
    }

    if (token.type === 'cdata') {
      output += token.value;
      lastApplied = 'cdata';
      continue;
    }

    if (token.type === 'pi') {
      output += token.value;
      lastApplied = 'instruction';
      continue;
    }

    if (token.type === 'comment') {
      if (!['text', 'cdata', 'undefined'].includes(lastApplied)) writeStructuralBreak();
      output += token.value;
      lastApplied = 'comment';
      continue;
    }

    if (token.type === 'declaration') {
      if (!['text', 'cdata', 'undefined'].includes(lastApplied)) writeStructuralBreak();
      output += token.value;
      lastApplied = 'declaration';
      continue;
    }

    if (token.type === 'close') {
      depth = Math.max(0, depth - 1);
      if (!['text', 'cdata', 'open-end', 'undefined'].includes(lastApplied)) writeStructuralBreak();
      output += `</${token.name}>`;
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
        output += normalized.slice(0, -1) + '/>';
        index += 1;
        lastApplied = 'self-end';
        continue;
      }

      output += normalized;
      if (token.type === 'open') {
        depth += 1;
        lastApplied = 'open-end';
      } else {
        lastApplied = 'self-end';
      }
    }
  }

  return output;
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
  const stripped = xml
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<\?[^?]*\?>/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '');
  const tagRegex = /<\/?([A-Za-z_][\w:.-]*)(?:\s[^<>]*?)?\s*\/?>/g;
  const stack = [];
  let match;
  let found = 0;

  while ((match = tagRegex.exec(stripped))) {
    found += 1;
    const full = match[0];
    const name = match[1];
    if (full.startsWith('</')) {
      const expected = stack.pop();
      if (expected !== name) throw new Error(`Invalid XML: expected closing tag </${expected || '?'}> but found </${name}>.`);
    } else if (!full.endsWith('/>')) {
      stack.push(name);
    }
  }

  if (!found) throw new Error('Invalid XML: no XML elements were found.');
  if (stack.length) throw new Error(`Invalid XML: missing closing tag for <${stack[stack.length - 1]}>.`);
  return true;
}
