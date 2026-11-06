export function normalizeJsonEncodedInput(input) {
  const original = String(input ?? '').trim();
  if (!original) return { text: original, repaired: false, repairNote: '' };

  // Never touch already-valid JSON. This keeps ordinary payloads and legitimate
  // JSON escape sequences byte-for-byte intact until the normal formatter runs.
  if (parsesAsJson(original)) {
    return { text: original, repaired: false, repairNote: '' };
  }

  let candidate = original;
  const notes = [];

  for (let pass = 1; pass <= 3; pass += 1) {
    if (!looksLikeEscapedJsonInput(candidate)) break;

    const decoded = decodeOneEscapeLayer(candidate);
    if (decoded === candidate) break;
    candidate = decoded;
    notes.push(`removed JSON escape layer ${pass}`);

    const extracted = extractJsonValueWithWrapperTail(candidate);
    if (extracted) {
      candidate = extracted.document;
      if (extracted.removedTail) notes.push('removed surrounding wrapper punctuation');
    }

    if (parsesAsJson(candidate)) {
      return {
        text: candidate,
        repaired: true,
        repairNote: `Normalized pasted JSON: ${notes.join('; ')}.`,
      };
    }
  }

  // If normalization cannot prove that the result is valid JSON, return the
  // original input. We do not want a best-effort repair to silently corrupt a
  // payload that has a genuine syntax error.
  return { text: original, repaired: false, repairNote: '' };
}

export function decodeOneEscapeLayer(input) {
  const text = String(input ?? '');
  const out = [];

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== '\\' || index + 1 >= text.length) {
      out.push(char);
      continue;
    }

    // Treat a whole slash run before a quote as one encoding token. Ordinary
    // structural quotes arrive as \" and become ". Quotes that were literal
    // characters inside an already-escaped JSON string can arrive with several
    // backslashes (for example several nested escape characters); those
    // must become exactly \" in the recovered JSON text, not \\\" which would
    // change the parsed value by introducing a literal backslash.
    let slashEnd = index;
    while (slashEnd < text.length && text[slashEnd] === '\\') slashEnd += 1;
    const slashCount = slashEnd - index;
    const afterSlashes = text[slashEnd];
    if (afterSlashes === '"') {
      if (slashCount > 1) out.push('\\');
      out.push('"');
      index = slashEnd;
      continue;
    }

    const next = text[index + 1];

    // One escape layer can double literal backslashes. Additional
    // and encoders also commonly produce invalid inner JSON escapes
    // such as \\' or \\&. Apostrophes and ampersands do not require escaping in
    // JSON, so normalize those encoding artifacts while decoding the layer.
    if (next === '\\') {
      const afterPair = text[index + 2];
      if (afterPair === "'" || afterPair === '&') {
        out.push(afterPair);
        index += 2;
        continue;
      }
      out.push('\\');
      index += 1;
      continue;
    }

    // These escape patterns are not legal JSON
    // escapes. Removing only the encoding backslash preserves the actual value.
    if (next === "'" || next === '&') {
      out.push(next);
      index += 1;
      continue;
    }

    // Preserve every other sequence. If it is a legitimate inner JSON escape
    // (\n, \t, \uXXXX, etc.), JSON.parse will validate it after encoding decode.
    out.push(char);
  }

  return out.join('');
}

export function extractJsonValueWithWrapperTail(input) {
  const text = String(input ?? '').trim();
  if (!text || (text[0] !== '{' && text[0] !== '[')) return null;

  const stack = [];
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') stack.push('}');
    else if (char === '[') stack.push(']');
    else if (char === '}' || char === ']') {
      if (!stack.length || stack[stack.length - 1] !== char) return null;
      stack.pop();
      if (!stack.length) {
        const document = text.slice(0, index + 1);
        const tail = text.slice(index + 1);
        if (!tail.trim()) return { document, removedTail: false };
        if (!isIgnorableWrapperTail(tail)) return null;
        return { document, removedTail: true };
      }
    }
  }

  return null;
}

function looksLikeEscapedJsonInput(input) {
  const text = String(input ?? '').trimStart();
  if (!text || (text[0] !== '{' && text[0] !== '[')) return false;

  // Look only at the first property/string delimiter. Valid JSON has an
  // unescaped opening quote here; encodinged JSON commonly has \" instead.
  const firstQuote = text.indexOf('"', 1);
  if (firstQuote < 0 || firstQuote > 96) return false;

  let slashCount = 0;
  for (let index = firstQuote - 1; index >= 0 && text[index] === '\\'; index -= 1) slashCount += 1;
  return slashCount > 0;
}

function isIgnorableWrapperTail(tail) {
  let normalized = String(tail ?? '').trim();
  if (!normalized || normalized.length > 64) return false;

  // Encoded inputs can preserve the whitespace between a nested JSON value and
  // its containing punctuation, leaving literal "\\n", "\\r" or "\\t" in the
  // input. Remove both escaped and real whitespace before applying the
  // punctuation-only safety check.
  normalized = normalized.replace(/\\[nrt]/g, '').replace(/\s/g, '');
  if (!normalized) return false;

  // Accept only closing punctuation left behind when a user copies the value
  // portion of a larger JSON wrapper. Any letters, digits, '<', etc. make
  // the tail non-ignorable and the original payload is left untouched.
  for (const char of normalized) {
    if (!'"\'`;,:}])'.includes(char)) return false;
  }
  return true;
}

function parsesAsJson(text) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
