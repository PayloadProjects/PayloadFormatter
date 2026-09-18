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
  const protectedBlocks = [];
  let s = xml
    .replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, (m) => `___PAYLOADDIFF_BLOCK_${protectedBlocks.push(m) - 1}___`)
    .replace(/>\s*</g, '><')
    .trim();

  const tokens = s.split(/(<[^>]+>)/g).filter(Boolean);
  const lines = [];
  let depth = 0;

  for (let token of tokens) {
    token = token.replace(/___PAYLOADDIFF_BLOCK_(\d+)___/g, (_, i) => protectedBlocks[Number(i)]);
    const t = token.trim();
    if (!t) continue;

    if (t.startsWith('</')) depth = Math.max(0, depth - 1);
    lines.push(`${'  '.repeat(depth)}${t}`);

    if (isOpeningXmlTag(t)) depth += 1;
  }
  return lines.join('\n');
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

function isOpeningXmlTag(t) {
  return t.startsWith('<') && !t.startsWith('</') && !t.startsWith('<?') && !t.startsWith('<!') && !t.endsWith('/>');
}
