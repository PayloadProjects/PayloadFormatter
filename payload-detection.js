export function detectPayloadMode(input, options = {}) {
  const original = String(input ?? '');
  const filename = String(options.filename ?? '');
  const mimeType = String(options.mimeType ?? '').toLowerCase();
  const text = normalizeForDetection(original);

  if (text) {
    const direct = detectContent(text);
    if (direct) return direct;

    // A copied response body is sometimes itself wrapped as a JSON string.
    // Unwrap only for detection; the formatter remains responsible for repair.
    const unwrapped = unwrapStringPayload(text);
    if (unwrapped && unwrapped !== text) {
      const nested = detectContent(normalizeForDetection(unwrapped));
      if (nested) {
        return {
          ...nested,
          confidence: Math.max(0.82, nested.confidence - 0.05),
          reason: `${nested.reason}; detected inside an outer string wrapper`,
        };
      }
    }
  }

  const extension = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
  if (extension === 'json' || mimeType.includes('json')) {
    return { mode: 'json', confidence: 0.62, reason: 'file extension or MIME type indicates JSON' };
  }
  if (extension === 'xml' || mimeType.includes('xml')) {
    return { mode: 'xml', confidence: 0.62, reason: 'file extension or MIME type indicates XML' };
  }

  return { mode: null, confidence: 0, reason: 'payload type is ambiguous' };
}

export function looksLikeJsonPayload(input) {
  return detectContent(normalizeForDetection(String(input ?? '')))?.mode === 'json';
}

export function looksLikeXmlPayload(input) {
  return detectContent(normalizeForDetection(String(input ?? '')))?.mode === 'xml';
}

function detectContent(text) {
  if (!text) return null;

  if (looksStronglyLikeXml(text)) {
    return { mode: 'xml', confidence: 0.98, reason: 'content starts with XML markup' };
  }

  const strictJson = tryJson(text);
  if (strictJson.ok) {
    if (strictJson.value && typeof strictJson.value === 'object') {
      return { mode: 'json', confidence: 0.99, reason: 'content is valid JSON' };
    }
    if (typeof strictJson.value === 'string') {
      const nested = detectContent(normalizeForDetection(strictJson.value));
      if (nested) return nested;
    }
    return { mode: 'json', confidence: 0.9, reason: 'content is a valid JSON value' };
  }

  if (looksLikeEscapedTransportJson(text)) {
    return { mode: 'json', confidence: 0.94, reason: 'content matches escaped/transport JSON structure' };
  }

  if (looksLikeLooseJson(text)) {
    return { mode: 'json', confidence: 0.84, reason: 'content has JSON object/array structure even though syntax is imperfect' };
  }

  if (looksLooselyLikeXml(text)) {
    return { mode: 'xml', confidence: 0.84, reason: 'content has XML element structure even though syntax may be imperfect' };
  }

  return null;
}

function normalizeForDetection(input) {
  let text = String(input ?? '').replace(/^\uFEFF/, '').trim();

  // Ignore Markdown fences that often arrive with copied examples.
  const fence = text.match(/^```(?:json|xml)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fence) text = fence[1].trim();

  return text;
}

function looksStronglyLikeXml(text) {
  return /^(?:<\?xml\b|<!DOCTYPE\b|<!--|<([A-Za-z_][\w:.-]*)(?:\s|\/?>))/i.test(text);
}

function looksLooselyLikeXml(text) {
  if (!text.startsWith('<')) return false;
  if (!/<[A-Za-z_][\w:.-]*(?:\s[^<>]*?)?>/.test(text)) return false;
  return /<\/[A-Za-z_][\w:.-]*\s*>|\/\s*>/.test(text) || /^<\?xml\b/i.test(text);
}

function looksLikeEscapedTransportJson(text) {
  if (!/^[\[{]/.test(text)) return false;

  // Typical copied/logged body: {\"key\":...} or [\{"key":...}].
  const head = text.slice(0, 512);
  if (/^[\[{]\s*\\+"/.test(head)) return true;
  if (/\\+"[^"\\]{1,100}\\+"\s*:/.test(head)) return true;

  return false;
}

function looksLikeLooseJson(text) {
  if (!/^[\[{]/.test(text)) return false;
  const head = text.slice(0, 2048);

  // Accept broken/trailing-comma/single-quoted JSON-like bodies without requiring
  // successful parsing. Requiring a key/value or array value avoids classifying
  // arbitrary brace-delimited text as JSON.
  if (/^[{]/.test(text) && /(?:"[^"\n]{1,160}"|'[^'\n]{1,160}')\s*:/.test(head)) return true;
  if (/^[[]/.test(text) && /[\[{"'0-9tfn-]/.test(text.slice(1, 256))) return true;
  return false;
}

function unwrapStringPayload(text) {
  const parsed = tryJson(text);
  if (parsed.ok && typeof parsed.value === 'string') return parsed.value.trim();

  // Best-effort outer quote removal for copied strings that contain invalid
  // inner escapes. This is detection-only and never mutates the editor value.
  if (text.length >= 2 && text[0] === '"' && text[text.length - 1] === '"') {
    return text.slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
      .trim();
  }
  return text;
}

function tryJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: null };
  }
}
