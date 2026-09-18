export function detectPayloadMode(input) {
  const text = cleanInput(input);
  if (!text) return { mode: null, confidence: 0, reason: 'empty payload' };
  if (looksXml(text)) return { mode: 'xml', confidence: 0.98, reason: 'XML markup detected' };
  try {
    const value = JSON.parse(text);
    if (typeof value === 'string') {
      const nested = cleanInput(value);
      if (looksXml(nested)) return { mode: 'xml', confidence: 0.92, reason: 'XML inside string wrapper' };
      if (/^[\[{]/.test(nested)) return { mode: 'json', confidence: 0.94, reason: 'JSON inside string wrapper' };
    }
    return { mode: 'json', confidence: 0.99, reason: 'valid JSON' };
  } catch (_) {}
  if (looksEscapedJson(text) || looksLooseJson(text)) return { mode: 'json', confidence: 0.9, reason: 'JSON-like structure detected' };
  if (looksLooseXml(text)) return { mode: 'xml', confidence: 0.84, reason: 'XML-like structure detected' };
  return { mode: null, confidence: 0, reason: 'payload type is ambiguous' };
}

export function formatPayload(input) {
  const mode = detectPayloadMode(input).mode;
  if (!mode) throw new Error('Could not detect JSON or XML. Paste a JSON or XML payload and try again.');
  return mode === 'json' ? formatJsonBestEffort(input) : formatXmlBestEffort(input);
}

export function formatJsonBestEffort(input) {
  const started = now();
  const original = cleanInput(input);
  if (!original) throw new Error('Nothing to format. Paste a payload first.');
  const attempts = [];
  pushAttempt(attempts, original, []);

  let transported = original;
  const notes = [];
  for (let pass = 1; pass <= 3 && looksEscapedJson(transported); pass += 1) {
    const next = decodeTransport(transported);
    if (next === transported) break;
    transported = next;
    notes.push('removed escaped JSON transport layer ' + pass);
    const extracted = extractJsonDocument(transported);
    if (extracted) {
      transported = extracted.text;
      if (extracted.removedTail) notes.push('removed surrounding wrapper punctuation');
    }
    pushAttempt(attempts, transported, notes);
  }

  const fixedEscapes = repairInvalidEscapes(transported);
  pushAttempt(attempts, fixedEscapes.text, notes.concat(fixedEscapes.changed ? ['removed invalid JSON escape markers'] : []));
  const fixedCommas = removeTrailingCommas(fixedEscapes.text);
  pushAttempt(attempts, fixedCommas.text, notes.concat(fixedEscapes.changed ? ['removed invalid JSON escape markers'] : [], fixedCommas.changed ? ['removed trailing commas'] : []));

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const parsed = parseWrappedJson(attempt.text);
      const formatted = JSON.stringify(parsed.value, null, 2);
      const allNotes = attempt.notes.concat(parsed.layers ? ['unwrapped ' + parsed.layers + ' JSON-string transport layer' + (parsed.layers === 1 ? '' : 's')] : [], parsed.repairedNested ? ['repaired decoded JSON string'] : []);
      return buildResult('json', formatted, true, false, attempt.text !== original || parsed.layers > 0 || parsed.repairedNested, allNotes.length ? 'Normalized pasted JSON: ' + unique(allNotes).join('; ') + '.' : '', '', started);
    } catch (error) {
      lastError = error;
    }
  }

  const formatted = prettyJsonLoose(unwrapForDisplay(fixedCommas.text || transported || original));
  const warning = lastError && lastError.message ? lastError.message : 'JSON syntax could not be validated.';
  return buildResult('json', formatted, false, true, formatted !== original, 'Best-effort formatted JSON. The payload still has a syntax issue: ' + warning, warning, started);
}

export function formatXmlBestEffort(input) {
  const started = now();
  const original = cleanInput(input);
  if (!original) throw new Error('Nothing to format. Paste a payload first.');
  let cleaned = original;
  let repaired = false;

  if (cleaned.startsWith('"') && cleaned.endsWith('"') && cleaned.includes('<')) {
    const outer = repairInvalidEscapes(cleaned);
    cleaned = outer.text;
    repaired = outer.changed;
  }
  const normalized = normalizeEscapedXml(cleaned);
  repaired = repaired || normalized !== cleaned;
  cleaned = normalized;
  const inner = cleaned.replace(/\\(['&])/g, '$1');
  repaired = repaired || inner !== cleaned;
  cleaned = inner;

  let valid = true;
  let warning = '';
  try { validateXmlLight(cleaned); } catch (error) { valid = false; warning = error.message || 'XML syntax could not be validated.'; }
  const formatted = prettyXml(cleaned);
  const note = valid ? (repaired ? 'Normalized escaped XML transport data before formatting.' : '') : 'Best-effort formatted XML. The payload still has a syntax issue: ' + warning;
  return buildResult('xml', formatted, valid, !valid, repaired || formatted !== original, note, warning, started);
}

export function prettyJsonLoose(input) {
  const text = String(input == null ? '' : input).trim();
  if (!text) return '';
  const lines = [];
  let current = '';
  let depth = 0;
  let quote = '';
  let escaped = false;
  function flush() {
    current = current.replace(/[ \t]+$/g, '');
    if (current.trim()) lines.push('  '.repeat(Math.max(0, depth)) + current.trimStart());
    current = '';
  }
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === '{' || ch === '[') { current = current.replace(/[ \t]+$/g, '') + ch; flush(); depth += 1; continue; }
    if (ch === '}' || ch === ']') { if (current.trim()) flush(); depth = Math.max(0, depth - 1); current += ch; continue; }
    if (ch === ',') { current = current.replace(/[ \t]+$/g, '') + ','; flush(); continue; }
    if (ch === ':') { current = current.replace(/[ \t]+$/g, '') + ': '; continue; }
    if (/\s/.test(ch)) { if (current && !/[ \t]$/.test(current)) current += ' '; continue; }
    current += ch;
  }
  if (current.trim()) flush();
  return lines.join('\n');
}

export function normalizeEscapedXml(input) {
  let text = String(input == null ? '' : input).trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === 'string' && parsed.includes('<')) text = parsed.trim();
    } catch (_) {}
  }
  return text.replace(/\\+"/g, '"');
}

export function prettyXml(xml) {
  const blocks = [];
  const text = String(xml == null ? '' : xml).replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, function (match) {
    blocks.push(match);
    return '___PF_BLOCK_' + (blocks.length - 1) + '___';
  }).replace(/>\s*</g, '><').trim();
  const tokens = text.split(/(<[^>]+>)/g).filter(Boolean);
  const lines = [];
  let depth = 0;
  for (let token of tokens) {
    token = token.replace(/___PF_BLOCK_(\d+)___/g, function (_, index) { return blocks[Number(index)]; });
    const t = token.trim();
    if (!t) continue;
    if (t.startsWith('</')) depth = Math.max(0, depth - 1);
    lines.push('  '.repeat(depth) + t);
    if (isOpeningTag(t)) depth += 1;
  }
  return lines.join('\n');
}

export function validateXmlLight(xml) {
  const stripped = String(xml == null ? '' : xml).replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<\?[^?]*\?>/g, '').replace(/<!DOCTYPE[\s\S]*?>/gi, '');
  const regex = /<\/?([A-Za-z_][\w:.-]*)(?:\s[^<>]*?)?\s*\/?>/g;
  const stack = [];
  let match;
  let found = 0;
  while ((match = regex.exec(stripped))) {
    found += 1;
    const full = match[0];
    const name = match[1];
    if (full.startsWith('</')) {
      const expected = stack.pop();
      if (expected !== name) throw new Error('Invalid XML: expected closing tag </' + (expected || '?') + '> but found </' + name + '>.');
    } else if (!full.endsWith('/>')) stack.push(name);
  }
  if (!found) throw new Error('Invalid XML: no XML elements were found.');
  if (stack.length) throw new Error('Invalid XML: missing closing tag for <' + stack[stack.length - 1] + '>.');
  return true;
}

function parseWrappedJson(text) {
  let value = JSON.parse(text);
  let layers = 0;
  let repairedNested = false;
  while (typeof value === 'string' && layers < 3 && /^[\[{]/.test(value.trim())) {
    let nested = value.trim();
    try { value = JSON.parse(nested); }
    catch (firstError) {
      const a = repairInvalidEscapes(nested);
      const b = removeTrailingCommas(a.text);
      if (!a.changed && !b.changed) throw firstError;
      value = JSON.parse(b.text);
      repairedNested = true;
    }
    layers += 1;
  }
  return { value, layers, repairedNested };
}

function unwrapForDisplay(text) {
  let value = String(text == null ? '' : text).trim();
  for (let i = 0; i < 3; i += 1) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed !== 'string' || !/^[\[{]/.test(parsed.trim())) break;
      value = parsed.trim();
    } catch (_) { break; }
  }
  return value;
}

function decodeTransport(input) {
  const text = String(input == null ? '' : input);
  const out = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch !== '\\' || i + 1 >= text.length) { out.push(ch); continue; }
    let end = i;
    while (end < text.length && text[end] === '\\') end += 1;
    const count = end - i;
    if (text[end] === '"') {
      if (count > 1) out.push('\\');
      out.push('"');
      i = end;
      continue;
    }
    const next = text[i + 1];
    if (next === '\\') { out.push('\\'); i += 1; continue; }
    if (next === "'" || next === '&') { out.push(next); i += 1; continue; }
    out.push(ch);
  }
  return out.join('');
}

function extractJsonDocument(input) {
  const text = String(input == null ? '' : input).trim();
  if (!/^[\[{]/.test(text)) return null;
  const stack = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (!stack.length || stack[stack.length - 1] !== ch) return null;
      stack.pop();
      if (!stack.length) {
        const tail = text.slice(i + 1);
        if (!tail.trim()) return { text: text.slice(0, i + 1), removedTail: false };
        const simpleTail = tail.trim().replace(/\\[nrt]/g, '').replace(/\s/g, '');
        if (!simpleTail || simpleTail.length > 64 || !Array.from(simpleTail).every(function (c) { return '"\'`;,:}])'.includes(c); })) return null;
        return { text: text.slice(0, i + 1), removedTail: true };
      }
    }
  }
  return null;
}

function repairInvalidEscapes(input) {
  const text = String(input == null ? '' : input);
  const out = [];
  let inString = false;
  let escaped = false;
  let changed = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (!inString) { out.push(ch); if (ch === '"') inString = true; continue; }
    if (escaped) { out.push(ch); escaped = false; continue; }
    if (ch === '"') { out.push(ch); inString = false; continue; }
    if (ch === '\\' && i + 1 < text.length) {
      const next = text[i + 1];
      if (next === "'" || next === '&') { out.push(next); i += 1; changed = true; continue; }
      out.push(ch); escaped = true; continue;
    }
    out.push(ch);
  }
  return { text: out.join(''), changed };
}

function removeTrailingCommas(input) {
  const text = String(input == null ? '' : input);
  const out = [];
  let inString = false;
  let escaped = false;
  let changed = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out.push(ch);
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out.push(ch); continue; }
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      if (text[j] === '}' || text[j] === ']') { changed = true; continue; }
    }
    out.push(ch);
  }
  return { text: out.join(''), changed };
}

function looksXml(text) { return /^(?:<\?xml\b|<!DOCTYPE\b|<!--|<([A-Za-z_][\w:.-]*)(?:\s|\/?>))/i.test(text); }
function looksLooseXml(text) { return text.startsWith('<') && /<[A-Za-z_][\w:.-]*(?:\s[^<>]*?)?>/.test(text) && (/<\/[A-Za-z_][\w:.-]*\s*>|\/\s*>/.test(text) || /^<\?xml\b/i.test(text)); }
function looksEscapedJson(text) { if (!/^[\[{]/.test(text)) return false; const head = text.slice(0, 512); return /^[\[{]\s*\\+"/.test(head) || /\\+"[^"\\]{1,100}\\+"\s*:/.test(head); }
function looksLooseJson(text) { if (!/^[\[{]/.test(text)) return false; const head = text.slice(0, 2048); if (text.startsWith('{') && /(?:"[^"\n]{1,160}"|'[^'\n]{1,160}')\s*:/.test(head)) return true; return text.startsWith('[') && /[\[{"'0-9tfn-]/.test(text.slice(1, 256)); }
function isOpeningTag(text) { return text.startsWith('<') && !text.startsWith('</') && !text.startsWith('<?') && !text.startsWith('<!') && !text.endsWith('/>'); }
function cleanInput(input) { const text = String(input == null ? '' : input).replace(/^\uFEFF/, '').trim(); const match = text.match(/^```(?:json|xml)?\s*\n([\s\S]*?)\n```\s*$/i); return match ? match[1].trim() : text; }
function pushAttempt(list, text, notes) { if (!text || list.some(function (item) { return item.text === text; })) return; list.push({ text, notes: unique(notes.filter(Boolean)) }); }
function unique(values) { return Array.from(new Set(values)); }
function buildResult(mode, formatted, valid, bestEffort, repaired, repairNote, warning, started) { return { mode, formatted, valid, bestEffort, repaired, repairNote, warning, lineCount: formatted ? formatted.split('\n').length : 0, bytes: typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(formatted).length : formatted.length, elapsedMs: Math.round(now() - started) }; }
function now() { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }
