import {
  normalizeJsonTransportInput,
  decodeOneTransportLayer,
  extractJsonDocumentWithWrapperTail,
} from './input-normalization.js';
import { normalizeEscapedXml, prettyXml, validateXmlLight } from './xml-format.js';

export function formatJsonBestEffort(input) {
  const started = now();
  const original = String(input ?? '').trim();
  if (!original) throw new Error('Nothing to format. Paste or upload a payload first.');

  const recovered = recoverJsonForFormatting(original);
  const attempts = [];
  addAttempt(attempts, recovered.text, recovered.notes);

  const invalidEscapes = repairKnownInvalidJsonEscapes(recovered.text);
  addAttempt(attempts, invalidEscapes.text, [
    ...recovered.notes,
    ...(invalidEscapes.changed ? ['removed non-JSON escape markers inside strings'] : []),
  ]);

  const trailingCommas = removeTrailingJsonCommas(invalidEscapes.text);
  addAttempt(attempts, trailingCommas.text, [
    ...recovered.notes,
    ...(invalidEscapes.changed ? ['removed non-JSON escape markers inside strings'] : []),
    ...(trailingCommas.changed ? ['removed trailing commas'] : []),
  ]);

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const decoded = parseJsonDocument(attempt.text);
      const parsed = decoded.value;
      const formatted = JSON.stringify(parsed, null, 2);
      const notes = [
        ...attempt.notes,
        ...(decoded.layers ? [`unwrapped ${decoded.layers} JSON-string transport layer${decoded.layers === 1 ? '' : 's'}`] : []),
        ...(decoded.repairedNested ? ['repaired invalid escapes inside decoded JSON transport string'] : []),
      ];
      return {
        mode: 'json',
        formatted,
        parsed,
        valid: true,
        bestEffort: false,
        repaired: attempt.text !== original || decoded.layers > 0 || decoded.repairedNested,
        repairNote: notes.length
          ? `Normalized pasted JSON: ${unique(notes).join('; ')}.`
          : '',
        items: '',
        lineCount: countLines(formatted),
        bytes: byteLength(formatted),
        elapsedMs: Math.round(now() - started),
      };
    } catch (error) {
      lastError = error;
    }
  }

  const displayText = attempts[attempts.length - 1]?.text || recovered.text || original;
  const formatted = prettyJsonLoose(unwrapJsonTextForLooseFormatting(displayText));
  const issue = lastError?.message || 'JSON syntax could not be validated.';

  return {
    mode: 'json',
    formatted,
    parsed: null,
    valid: false,
    bestEffort: true,
    repaired: formatted !== original || recovered.repaired,
    repairNote: `Best-effort formatted JSON. The payload still has a syntax issue: ${issue}`,
    items: issue,
    lineCount: countLines(formatted),
    bytes: byteLength(formatted),
    elapsedMs: Math.round(now() - started),
  };
}

export function formatXmlBestEffort(input) {
  const started = now();
  const original = String(input ?? '').trim();
  if (!original) throw new Error('Nothing to format. Paste or upload a payload first.');

  // XML copied from logs/APIs is often wrapped in a JSON string. If that outer
  // transport string contains source-language escapes such as \' the JSON
  // decoder cannot unwrap it. Repair only the quoted transport wrapper first;
  // ordinary raw XML is left untouched.
  const quotedTransport = looksLikeQuotedXmlTransport(original);
  const recoveredXml = recoverXmlTransport(original);
  let xmlTransportText = recoveredXml.text;
  let xmlTransportChanged = recoveredXml.changed;

  let cleaned = normalizeEscapedXml(xmlTransportText);

  // After a quoted transport wrapper is decoded, source-language artifacts can
  // remain inside the XML text itself (for example SAMPLE\'s). XML does not use a
  // backslash to escape apostrophes or ampersands, so remove only those known
  // wrapper artifacts. Do not apply this to ordinary raw XML because a literal
  // backslash there belongs to the user's nested.
  let repairedInnerTransport = false;
  if (quotedTransport) {
    const normalizedInner = cleaned.replace(/\\(['&])/g, '$1');
    repairedInnerTransport = normalizedInner !== cleaned;
    cleaned = normalizedInner;
  }

  let valid = true;
  let items = '';
  try {
    validateXmlLight(cleaned);
  } catch (error) {
    valid = false;
    items = error?.message || 'XML syntax could not be validated.';
  }

  const formatted = prettyXml(cleaned);
  const normalizedTransport = xmlTransportChanged || repairedInnerTransport || cleaned !== original;
  return {
    mode: 'xml',
    formatted,
    parsed: null,
    valid,
    bestEffort: !valid,
    repaired: normalizedTransport || formatted !== original,
    repairNote: valid
      ? (normalizedTransport ? 'Normalized escaped XML transport data before formatting.' : '')
      : `Best-effort formatted XML. The payload still has a syntax issue: ${items}`,
    items,
    lineCount: countLines(formatted),
    bytes: byteLength(formatted),
    elapsedMs: Math.round(now() - started),
  };
}

export function recoverJsonForFormatting(input) {
  const original = String(input ?? '').trim();
  if (!original) return { text: original, repaired: false, notes: [] };

  const queue = [{ text: original, notes: [] }];
  const seen = new Set();

  for (let step = 0; queue.length && step < 32; step += 1) {
    const current = queue.shift();
    const candidate = String(current.text ?? '').trim();
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);

    // Strongest proof: if this candidate is already a JSON object/array,
    // stop immediately. Valid JSON strings are unwrapped and explored rather
    // than returned as the final formatted payload.
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') {
        return {
          text: candidate,
          repaired: candidate !== original,
          notes: unique(current.notes),
        };
      }
      if (typeof parsed === 'string') {
        const nested = parsed.trim();
        if (nested && !seen.has(nested)) {
          queue.push({
            text: nested,
            notes: [...current.notes, 'unwrapped JSON-string transport layer'],
          });
        }
      }
    } catch (_) {}

    // Explore an outer literal quote wrapper. This is common when users paste
    // a value copied from a log/source representation.
    const unquoted = stripJsonTransportWrapperQuotes(candidate);
    if (unquoted !== candidate && !seen.has(unquoted)) {
      queue.push({
        text: unquoted,
        notes: [...current.notes, 'removed outer transport quotes'],
      });
    }

    // Explore one transport decode even when heuristic detection is uncertain.
    // We do not commit to this mutation unless a later candidate proves itself
    // by parsing as a JSON object/array.
    if (candidate.includes('\\')) {
      const decoded = decodeOneTransportLayer(candidate).trim();
      if (decoded && decoded !== candidate && !seen.has(decoded)) {
        queue.push({
          text: decoded,
          notes: [...current.notes, 'removed escaped JSON transport layer'],
        });
      }
    }

    // A common copied transport shape begins with quote + backslash before
    // the real JSON nested, e.g. "\"\\{...}" or similar logger wrappers.
    // Explore the slice beginning at the first real object/array delimiter and
    // accept it only if a later candidate proves to be valid JSON.
    const embedded = extractEmbeddedJsonCandidate(candidate);
    if (embedded && embedded !== candidate && !seen.has(embedded)) {
      queue.push({
        text: embedded,
        notes: [...current.notes, 'removed prefix/suffix outside embedded JSON nested'],
      });
    }

    // Explore a JSON nested embedded in harmless surrounding punctuation.
    const extracted = extractJsonDocumentWithWrapperTail(candidate);
    if (extracted && extracted.nested !== candidate && !seen.has(extracted.nested)) {
      queue.push({
        text: extracted.nested,
        notes: [
          ...current.notes,
          ...(extracted.removedTail ? ['removed surrounding log wrapper punctuation'] : []),
        ],
      });
    }

    // Known logger/source artifacts and trailing commas are also explored as
    // candidates, again requiring a successful JSON parse before acceptance.
    const invalidEscapes = repairKnownInvalidJsonEscapes(candidate);
    if (invalidEscapes.changed && !seen.has(invalidEscapes.text)) {
      queue.push({
        text: invalidEscapes.text,
        notes: [...current.notes, 'removed non-JSON escape markers inside strings'],
      });
    }

    const trailing = removeTrailingJsonCommas(candidate);
    if (trailing.changed && !seen.has(trailing.text)) {
      queue.push({
        text: trailing.text,
        notes: [...current.notes, 'removed trailing commas'],
      });
    }
  }

  // Fall back to the conservative legacy normalizer for malformed content
  // where no proof-backed candidate became a valid object/array.
  const strict = normalizeJsonTransportInput(original);
  return strict.repaired
    ? {
        text: strict.text,
        repaired: true,
        notes: [strict.repairNote || 'normalized escaped JSON transport data'],
      }
    : { text: original, repaired: false, notes: [] };
}
export function repairKnownInvalidJsonEscapes(input) {
  const text = String(input ?? '');
  const out = [];
  let inString = false;
  let escaped = false;
  let changed = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (!inString) {
      out.push(char);
      if (char === '"') inString = true;
      continue;
    }

    if (escaped) {
      out.push(char);
      escaped = false;
      continue;
    }

    if (char === '"') {
      out.push(char);
      inString = false;
      continue;
    }

    if (char === '\\' && index + 1 < text.length) {
      const next = text[index + 1];
      if (next === "'" || next === '&') {
        out.push(next);
        index += 1;
        changed = true;
        continue;
      }
      out.push(char);
      escaped = true;
      continue;
    }

    out.push(char);
  }

  return { text: out.join(''), changed };
}

export function removeTrailingJsonCommas(input) {
  const text = String(input ?? '');
  const out = [];
  let inString = false;
  let escaped = false;
  let changed = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      out.push(char);
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      out.push(char);
      continue;
    }

    if (char === ',') {
      let cursor = index + 1;
      while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
      if (text[cursor] === '}' || text[cursor] === ']') {
        changed = true;
        continue;
      }
    }

    out.push(char);
  }

  return { text: out.join(''), changed };
}

export function prettyJsonLoose(input) {
  const text = String(input ?? '').trim();
  if (!text) return '';

  const lines = [];
  let current = '';
  let depth = 0;
  let stringQuote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  const write = (value) => { current += value; };
  const trimRight = () => { current = current.replace(/[ \t]+$/g, ''); };
  const newline = () => {
    trimRight();
    if (current.trim()) lines.push(`${'  '.repeat(Math.max(0, depth))}${current.trimStart()}`);
    current = '';
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1] || '';

    if (lineComment) {
      if (char === '\n') {
        lineComment = false;
        newline();
      } else {
        write(char);
      }
      continue;
    }

    if (blockComment) {
      write(char);
      if (char === '*' && next === '/') {
        write('/');
        index += 1;
        blockComment = false;
      }
      continue;
    }

    if (stringQuote) {
      write(char);
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === stringQuote) stringQuote = '';
      continue;
    }

    if (char === '"' || char === "'") {
      stringQuote = char;
      write(char);
      continue;
    }

    if (char === '/' && next === '/') {
      write('//');
      index += 1;
      lineComment = true;
      continue;
    }

    if (char === '/' && next === '*') {
      write('/*');
      index += 1;
      blockComment = true;
      continue;
    }

    if (char === '{' || char === '[') {
      trimRight();
      write(char);
      newline();
      depth += 1;
      continue;
    }

    if (char === '}' || char === ']') {
      if (current.trim()) newline();
      depth = Math.max(0, depth - 1);
      write(char);
      continue;
    }

    if (char === ',') {
      trimRight();
      write(',');
      newline();
      continue;
    }

    if (char === ':') {
      trimRight();
      write(': ');
      continue;
    }

    if (/\s/.test(char)) {
      if (current && !/[ \t]$/.test(current)) write(' ');
      continue;
    }

    write(char);
  }

  if (current.trim()) newline();
  return lines.join('\n');
}

function parseJsonDocument(text) {
  let value = JSON.parse(text);
  let layers = 0;
  let repairedNested = false;

  // A payload copied from an API/log can itself be serialized as a JSON string:
  // "{\"items\":[...]}". Parsing only once returns a JavaScript string. The
  // decoded inner nested can still contain source-language artifacts such as
  // \' or trailing commas, so repair only that decoded JSON nested before the
  // next parse rather than re-stringifying it as one escaped line.
  while (typeof value === 'string' && layers < 3) {
    let nested = value.trim();

    // Some loggers/API wrappers decode only one transport layer at a time.
    // Example: the outer JSON string parses successfully, but its value is
    // still {\\"key\\":1}. Treat that as another transport layer instead
    // of accepting the whole payload as one ordinary string.
    if (!looksLikeJsonDocumentText(nested) && looksLikeTransportEscapedJson(nested)) {
      const decoded = decodeOneTransportLayer(nested);
      if (decoded !== nested) {
        nested = decoded.trim();
        repairedNested = true;
      }
    }

    if (!looksLikeJsonDocumentText(nested)) break;

    try {
      value = JSON.parse(nested);
    } catch (firstError) {
      const invalidEscapes = repairKnownInvalidJsonEscapes(nested);
      const trailingCommas = removeTrailingJsonCommas(invalidEscapes.text);
      if (!invalidEscapes.changed && !trailingCommas.changed) throw firstError;
      value = JSON.parse(trailingCommas.text);
      repairedNested = true;
    }
    layers += 1;
  }

  return { value, layers, repairedNested };
}

function unwrapJsonTextForLooseFormatting(input) {
  return recoverJsonForFormatting(input).text;
}

function extractEmbeddedJsonCandidate(input) {
  const text = String(input ?? '').trim();
  if (!text) return '';

  const objectStart = text.indexOf('{');
  const arrayStart = text.indexOf('[');
  let start = -1;
  if (objectStart >= 0 && arrayStart >= 0) start = Math.min(objectStart, arrayStart);
  else start = Math.max(objectStart, arrayStart);
  if (start <= 0) return '';

  const opener = text[start];
  const closer = opener === '{' ? '}' : ']';

  // Use the final matching delimiter as a candidate boundary. Any remaining
  // prefix/suffix is treated as transport noise only after JSON.parse proves
  // the sliced value is a real nested.
  const end = text.lastIndexOf(closer);
  if (end <= start) return '';

  return text.slice(start, end + 1).trim();
}

function stripJsonTransportWrapperQuotes(input) {
  const text = String(input ?? '').trim();
  if (text.length < 3) return text;

  // Standard literal quote wrapper.
  if ((text[0] === '"' && text[text.length - 1] === '"')
      || (text[0] === "'" && text[text.length - 1] === "'")) {
    const inner = text.slice(1, -1).trim();
    if (looksLikeJsonDocumentText(inner) || looksLikeTransportEscapedJson(inner)) return inner;
  }

  // A copied logger value can contain escaped quote characters around the
  // entire nested: \"{...}\".
  if (text.startsWith('\\\"') && text.endsWith('\\\"')) {
    const inner = text.slice(2, -2).trim();
    if (looksLikeJsonDocumentText(inner) || looksLikeTransportEscapedJson(inner)) return inner;
  }

  return text;
}

function looksLikeQuotedJsonTransport(input) {
  const text = String(input ?? '').trim();
  if (text.length < 3) return false;
  const unquoted = stripJsonTransportWrapperQuotes(text);
  return unquoted !== text;
}

function looksLikeJsonDocumentText(input) {
  const text = String(input ?? '').trim();
  return text.startsWith('{') || text.startsWith('[');
}

function recoverXmlTransport(input) {
  const original = String(input ?? '').trim();
  const queue = [original];
  const seen = new Set();

  for (let step = 0; queue.length && step < 24; step += 1) {
    const candidate = String(queue.shift() ?? '').trim();
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);

    const normalized = normalizeEscapedXml(candidate);
    try {
      validateXmlLight(normalized);
      return { text: candidate, changed: candidate !== original };
    } catch (_) {}

    try {
      const parsed = JSON.parse(candidate);
      if (typeof parsed === 'string' && parsed.trim()) queue.push(parsed.trim());
    } catch (_) {}

    if (candidate.includes('\\')) {
      const decoded = decodeOneTransportLayer(candidate).trim();
      if (decoded && decoded !== candidate) queue.push(decoded);
    }

    if (
      candidate.length >= 2
      && ((candidate.startsWith('"') && candidate.endsWith('"'))
        || (candidate.startsWith("'") && candidate.endsWith("'")))
    ) {
      queue.push(candidate.slice(1, -1).trim());
    }
  }

  return { text: original, changed: false };
}

function looksLikeQuotedXmlTransport(input) {
  const text = String(input ?? '').trim();
  return text.length >= 2 && text.startsWith('"') && text.endsWith('"') && text.includes('<');
}

function looksLikeTransportEscapedJson(input) {
  const text = String(input ?? '').trimStart();
  if (!text || (text[0] !== '{' && text[0] !== '[')) return false;
  const firstQuote = text.indexOf('"', 1);
  if (firstQuote < 0 || firstQuote > 96) return false;
  let slashCount = 0;
  for (let index = firstQuote - 1; index >= 0 && text[index] === '\\'; index -= 1) slashCount += 1;
  return slashCount > 0;
}

function addAttempt(attempts, text, notes) {
  if (!text || attempts.some((attempt) => attempt.text === text)) return;
  attempts.push({ text, notes: unique(notes.filter(Boolean)) });
}

function unique(values) {
  return [...new Set(values)];
}

function countLines(text) {
  if (!text) return 0;
  let count = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) count += 1;
  }
  return count;
}

function byteLength(text) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length;
  return Buffer.byteLength(text, 'utf8');
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
