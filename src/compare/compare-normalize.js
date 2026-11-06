// Prepares a payload for comparison without ever changing its data. Format only
// touches line breaks and indentation; Sort keys also reorders members, writing
// every key and value exactly as pasted. Each result is checked against the
// original, and if anything but layout differs the original is kept.
import { detectPayloadMode } from '../format/payload-detection.js';
import { formatJsonBestEffort, formatValidJson, formatXmlBestEffort } from '../format/resilient-format.js';

const BOM = '\ufeff';
const isJsonSpace = (code) => code === 32 || code === 10 || code === 13 || code === 9;
const JSON_PUNCTUATION = new Set(['{', '}', '[', ']', ':', ',', '"', "'"].map((ch) => ch.charCodeAt(0)));

// True when two JSON-like texts differ only in whitespace outside strings. Quotes
// of both kinds count as strings, which can only make the check stricter.
export function sameJsonContent(a, b) {
  let i = 0;
  let j = 0;
  let quote = 0;
  let previous = 0;
  for (;;) {
    if (!quote) {
      const startI = i;
      const startJ = j;
      while (i < a.length && isJsonSpace(a.charCodeAt(i))) i += 1;
      while (j < b.length && isJsonSpace(b.charCodeAt(j))) j += 1;
      // Whitespace between two bare words separates them: "1 2" is not "12".
      if ((i > startI) !== (j > startJ) && i < a.length && previous
        && !JSON_PUNCTUATION.has(previous) && !JSON_PUNCTUATION.has(a.charCodeAt(i))) return false;
    }
    if (i >= a.length || j >= b.length) return i >= a.length && j >= b.length;
    const code = a.charCodeAt(i);
    if (code !== b.charCodeAt(j)) return false;
    i += 1;
    j += 1;
    previous = code;
    if (quote) {
      if (code === 92) {
        if (a.charCodeAt(i) !== b.charCodeAt(j)) return false;
        i += 1;
        j += 1;
      } else if (code === quote) {
        quote = 0;
      }
    } else if (code === 34 || code === 39) {
      quote = code;
    }
  }
}

function normalizeXmlTag(tag) {
  if (!/\s/.test(tag)) return tag;
  let out = '';
  let quote = '';
  for (let i = 0; i < tag.length; i += 1) {
    const ch = tag[i];
    if (quote) {
      out += ch;
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
    } else if (/\s/.test(ch)) {
      if (!out.endsWith(' ')) out += ' ';
    } else {
      out += ch;
    }
  }
  return out.replace(/ ?= ?/g, '=').replace(/ (\/?>)$/, '$1');
}

function xmlReader(text) {
  let pos = 0;
  let afterOpenTag = false;
  const until = (marker, from) => {
    const end = text.indexOf(marker, from);
    return end < 0 ? text.length : end + marker.length;
  };
  return () => {
    while (pos < text.length) {
      const start = pos;
      if (text[pos] !== '<') {
        const next = text.indexOf('<', pos);
        pos = next < 0 ? text.length : next;
        const piece = text.slice(start, pos);
        // Whitespace between tags is layout, but inside <a> </a> it is the value.
        if (piece.trim()) { afterOpenTag = false; return piece; }
        if (afterOpenTag && text[pos + 1] === '/') { afterOpenTag = false; return piece; }
        continue;
      }
      if (text.startsWith('<!--', pos)) pos = until('-->', pos);
      else if (text.startsWith('<![CDATA[', pos)) pos = until(']]>', pos);
      else if (text.startsWith('<?', pos)) pos = until('?>', pos);
      else {
        let quote = '';
        let i = pos + 1;
        for (; i < text.length; i += 1) {
          const ch = text[i];
          if (quote) { if (ch === quote) quote = ''; } else if (ch === '"' || ch === "'") quote = ch;
          else if (ch === '>') break;
        }
        pos = Math.min(i + 1, text.length);
        const tag = text.slice(start, pos);
        afterOpenTag = text[start + 1] !== '/' && text[start + 1] !== '!' && !tag.endsWith('/>');
        return normalizeXmlTag(tag);
      }
      afterOpenTag = false;
      return text.slice(start, pos);
    }
    return null;
  };
}

// True when two XML texts differ only in layout: whitespace between tags and
// inside tags. Text, attribute values, CDATA and comments must match exactly.
export function sameXmlContent(a, b) {
  const nextA = xmlReader(a);
  const nextB = xmlReader(b);
  for (;;) {
    const tokenA = nextA();
    if (tokenA !== nextB()) return false;
    if (tokenA === null) return true;
  }
}

// JSON text with every object's members sorted by key. Keys and values keep the
// payload's own spelling and duplicate keys are all kept, in their own order.
// With sortArrays, array items are ordered too, by their text. Null when the text
// isn't valid JSON or is nested too deep.
function sortedJson(text, sortArrays = false) {
  try {
    JSON.parse(text);
  } catch (_) {
    return null;
  }
  let i = 0;
  const skipSpace = () => {
    while (isJsonSpace(text.charCodeAt(i))) i += 1;
  };
  const readString = () => {
    const start = i;
    i += 1;
    while (text.charCodeAt(i) !== 34) i += text.charCodeAt(i) === 92 ? 2 : 1;
    i += 1;
    return text.slice(start, i);
  };
  const readValue = () => {
    skipSpace();
    const code = text.charCodeAt(i);
    if (code === 123) {
      i += 1;
      const members = [];
      skipSpace();
      while (text.charCodeAt(i) !== 125) {
        const key = readString();
        skipSpace();
        i += 1; // colon
        members.push({ name: JSON.parse(key), key, value: readValue() });
        skipSpace();
        if (text.charCodeAt(i) === 44) { i += 1; skipSpace(); }
      }
      i += 1;
      members.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
      return `{${members.map((member) => `${member.key}:${member.value}`).join(',')}}`;
    }
    if (code === 91) {
      i += 1;
      const items = [];
      skipSpace();
      while (text.charCodeAt(i) !== 93) {
        items.push(readValue());
        skipSpace();
        if (text.charCodeAt(i) === 44) { i += 1; skipSpace(); }
      }
      i += 1;
      if (sortArrays) items.sort();
      return `[${items.join(',')}]`;
    }
    if (code === 34) return readString();
    const start = i;
    while (i < text.length && !isJsonSpace(text.charCodeAt(i)) && !JSON_PUNCTUATION.has(text.charCodeAt(i))) i += 1;
    return text.slice(start, i);
  };
  try {
    return formatValidJson(readValue()).text;
  } catch (_) {
    return null; // nested too deep to sort
  }
}

export function detectMode(text) {
  const start = text.search(/\S/);
  const first = start < 0 ? '' : text[start];
  if (first === '<') return 'xml';
  if (first === '{' || first === '[') return 'json';
  return text.trim() ? detectPayloadMode(text).mode : null;
}

// { text, mode, status }. status says what the pane shows against what was pasted:
// pasted (untouched), layout, layout-no-sort, sorted, sorted-arrays, invalid-layout (not valid,
// layout only), kept (formatting would have changed data, so untouched), or ''
// when there is nothing to show.
export function normalizePayload(text, { format = true, sortKeys = false, sortArrays = false } = {}) {
  const mode = detectMode(text);
  const asPasted = (status) => ({ text, mode, status });
  if (!text) return asPasted('');
  const sorting = sortKeys || sortArrays;
  if (!text.trim() || !mode || (!format && !sorting)) return asPasted('pasted');
  const bom = text.startsWith(BOM) ? BOM : '';
  const body = text.slice(bom.length);
  try {
    if (mode === 'json' && sorting) {
      const sorted = sortedJson(body, sortArrays);
      if (sorted !== null) return { text: bom + sorted, mode, status: sortArrays ? 'sorted-arrays' : 'sorted' };
    }
    if (!format) return asPasted('pasted');
    const result = mode === 'json'
      ? formatJsonBestEffort(body)
      : formatXmlBestEffort(body, { keepEmptyElements: true });
    const same = mode === 'json' ? sameJsonContent(body, result.formatted) : sameXmlContent(body, result.formatted);
    if (!same) return asPasted('kept');
    if (!result.valid) return { text: bom + result.formatted, mode, status: 'invalid-layout' };
    return { text: bom + result.formatted, mode, status: sorting ? 'layout-no-sort' : 'layout' };
  } catch (_) {
    return asPasted('kept');
  }
}
