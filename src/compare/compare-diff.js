// Line and character comparison engine. Pure logic, no DOM: it runs in a worker
// (compare-worker.js) and in tests.
//
// compareTexts() returns `ops`: runs that cover every line of both sides in
// display order, so the view can line the two panes up row by row:
//   { kind, l, lc, r, rc }   l/r first line (0-based), lc/rc line counts
// same     rows that match          lc === rc
// changed  rows that differ inside  lc === rc, paired line by line
// removed  left only                rc === 0
// added    right only               lc === 0
// moved    same text found elsewhere on the other side (lc or rc is 0);
//          `target` is that line and `group` ties both ends together
// ignored  lines left out of the comparison: blank lines under ignoreEmptyLines,
//          and the inside of a field named in ignoreFields (lc or rc is 0)

export const KIND = Object.freeze({
  SAME: 'same', CHANGED: 'changed', REMOVED: 'removed', ADDED: 'added', MOVED: 'moved', IGNORED: 'ignored',
});

// Past this many edits in one region Myers' memory grows too fast; regions that
// different are reported as replaced rather than aligned line by line.
const MAX_EDIT_DISTANCE = 4096;
const MAX_PATIENCE_DEPTH = 64;
// Pairing similar lines inside a hunk is quadratic; bigger hunks pair by position.
const MAX_PAIRING_CELLS = 40_000;
const MIN_PAIR_SIMILARITY = 0.34;
const MAX_MOVE_CANDIDATES = 32;
// Total effort spent looking for moves; past it the rest shows as added/removed.
const MAX_MOVE_WORK = 3_000_000;
// A move this short is only believed if it is unmistakable (see findMoves).
const MIN_MOVE_LINES = 3;
const MAX_PARTNER_SCAN = 200;
// Key of a line that takes no part in the comparison.
const SKIP = '\u0000skip';
// Character comparison gives up beyond this (the unequal middle is marked whole).
const MAX_INLINE_TOKENS = 4000;

export function splitLines(text) {
  return text === '' ? [] : text.split(/\r\n|\r|\n/);
}

// One spelling for every way of writing the same number: 1.0, 1.00, 1e0 and 10e-1.
export function canonicalNumber(text) {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) return text;
  const digits = match[2] + (match[3] || '');
  const stripped = digits.replace(/^0+/, '');
  const point = match[2].length + Number(match[4] || 0) - (digits.length - stripped.length);
  const significant = stripped.replace(/0+$/, '');
  if (!significant) return '0';
  return `${match[1]}${significant}e${point}`;
}

const JSON_LINE_START = /^\s*["{}[\]\d-]/;
const JSON_TOKEN = /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

function decodeEscapes(text) {
  if (!text.includes('\\')) return text;
  return text
    .replace(/\\u([0-9a-fA-F]{4})/g, (_all, hex) => {
      const ch = String.fromCharCode(parseInt(hex, 16));
      return ch === '"' || ch === '\\' ? `\\${ch}` : ch;
    })
    .replace(/\\\//g, '/');
}

// The same value spelled differently (1.0 and 1, \u00e9 and é) gets the same key.
function equivalentKey(line) {
  if (!JSON_LINE_START.test(line)) return line;
  return line
    .replace(JSON_TOKEN, (token) => (token[0] === '"' ? decodeEscapes(token) : canonicalNumber(token)))
    .replace(/,\s*$/, '');
}

function lineKey(line, options) {
  let key = line;
  if (options.equivalentValues) key = equivalentKey(key);
  if (options.ignoreWhitespace) key = key.replace(/\s+/g, '');
  if (options.ignoreCase) key = key.toLowerCase();
  return key;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Keys for all lines. Lines holding a field named in ignoreFields compare equal
// whatever the value is, and the inside of a multi-line value is left out. Indent
// finds the end of such a value, so this works on formatted text.
function lineKeys(lines, options) {
  const names = (options.ignoreFields || []).filter(Boolean).map(escapeRegExp).join('|');
  if (!names) return lines.map((line) => lineKey(line, options));
  const jsonField = new RegExp(`^(\\s*)"(${names})"\\s*:\\s*(.*?),?\\s*$`);
  const xmlOneLine = new RegExp(`^(\\s*)<(${names})(\\s[^>]*)?>[^<]*</\\2\\s*>\\s*$`);
  const xmlOpen = new RegExp(`^(\\s*)<(${names})(\\s[^>]*[^/])?>\\s*$`);
  const xmlAttribute = new RegExp(`(\\s(?:${names})\\s*=\\s*)("[^"]*"|'[^']*')`, 'g');
  const keys = new Array(lines.length);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const json = jsonField.exec(line);
    if (json) {
      keys[i] = `${json[1]}"${json[2]}":*`;
      if (/[{[]$/.test(json[3])) {
        const close = json[3].endsWith('{') ? '}' : ']';
        let end = i + 1;
        while (end < lines.length && !(lines[end].startsWith(`${json[1]}${close}`))) end += 1;
        for (let j = i + 1; j <= end && j < lines.length; j += 1) keys[j] = SKIP;
        i = end;
      }
      continue;
    }
    const single = xmlOneLine.exec(line);
    if (single) {
      keys[i] = `${single[1]}<${single[2]}>*`;
      continue;
    }
    const open = xmlOpen.exec(line);
    if (open) {
      keys[i] = `${open[1]}<${open[2]}>*`;
      const closing = `${open[1]}</${open[2]}`;
      let end = i + 1;
      while (end < lines.length && !lines[end].startsWith(closing)) end += 1;
      for (let j = i + 1; j <= end && j < lines.length; j += 1) keys[j] = SKIP;
      i = end;
      continue;
    }
    keys[i] = lineKey(line.includes('=') ? line.replace(xmlAttribute, '$1*') : line, options);
  }
  return keys;
}

// Lines that differ on screen but were treated as equal because of an ignore option.
function countIgnored(ops, leftLines, rightLines) {
  let rows = 0;
  for (const op of ops) {
    if (op.kind === KIND.SAME) {
      for (let i = 0; i < op.lc; i += 1) if (leftLines[op.l + i] !== rightLines[op.r + i]) rows += 1;
    } else if (op.kind === KIND.IGNORED) {
      rows += op.lc + op.rc;
    }
  }
  return rows;
}

// --- Longest common subsequence: patience anchors, Myers in between ---------

// Forward Myers with a saved trace. Calls match(i, j) for pairs in ascending
// order; false when the region needs more than MAX_EDIT_DISTANCE edits.
function myers(a, aLo, aHi, b, bLo, bHi, match) {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const limit = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace = [];
  let finalD = -1;
  outer:
  for (let d = 0; d <= limit; d += 1) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
        ? v[offset + k + 1]
        : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[aLo + x] === b[bLo + y]) { x += 1; y += 1; }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        finalD = d;
        break outer;
      }
    }
  }
  if (finalD < 0) return false;

  const pairs = [];
  let x = n;
  let y = m;
  for (let d = finalD; d > 0; d -= 1) {
    const saved = trace[d];
    const at = (k) => saved[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1; y -= 1;
      pairs.push(x, y);
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x -= 1; y -= 1;
    pairs.push(x, y);
  }
  for (let i = pairs.length - 2; i >= 0; i -= 2) match(aLo + pairs[i], bLo + pairs[i + 1]);
  return true;
}

// Lines unique in both ranges, in left order, as [leftIndex, rightIndex].
function uniqueCommon(a, aLo, aHi, b, bLo, bHi) {
  const seen = new Map();
  for (let i = aLo; i < aHi; i += 1) {
    const entry = seen.get(a[i]);
    if (entry) entry.a += 1;
    else seen.set(a[i], { a: 1, b: 0, ai: i, bi: 0 });
  }
  for (let j = bLo; j < bHi; j += 1) {
    const entry = seen.get(b[j]);
    if (entry) {
      entry.b += 1;
      entry.bi = j;
    }
  }
  const out = [];
  for (const entry of seen.values()) {
    if (entry.a === 1 && entry.b === 1) out.push(entry);
  }
  return out;
}

// Longest increasing run of right positions among the anchors.
function longestIncreasing(anchors) {
  const tails = [];
  const previous = new Int32Array(anchors.length);
  for (let i = 0; i < anchors.length; i += 1) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (anchors[tails[mid]].bi < anchors[i].bi) lo = mid + 1;
      else hi = mid;
    }
    previous[i] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = i;
  }
  const chain = [];
  for (let at = tails.length ? tails[tails.length - 1] : -1; at >= 0; at = previous[at]) chain.push(anchors[at]);
  return chain.reverse();
}

function solve(a, aLo, aHi, b, bLo, bHi, match, depth) {
  while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) {
    match(aLo, bLo);
    aLo += 1; bLo += 1;
  }
  let tail = 0;
  while (aLo < aHi - tail && bLo < bHi - tail && a[aHi - 1 - tail] === b[bHi - 1 - tail]) tail += 1;
  const aEnd = aHi - tail;
  const bEnd = bHi - tail;
  if (aLo < aEnd && bLo < bEnd) {
    const anchors = depth < MAX_PATIENCE_DEPTH ? longestIncreasing(uniqueCommon(a, aLo, aEnd, b, bLo, bEnd)) : [];
    if (anchors.length) {
      let ai = aLo;
      let bi = bLo;
      for (const anchor of anchors) {
        solve(a, ai, anchor.ai, b, bi, anchor.bi, match, depth + 1);
        match(anchor.ai, anchor.bi);
        ai = anchor.ai + 1;
        bi = anchor.bi + 1;
      }
      solve(a, ai, aEnd, b, bi, bEnd, match, depth + 1);
    } else {
      myers(a, aLo, aEnd, b, bLo, bEnd, match);
    }
  }
  for (let i = 0; i < tail; i += 1) match(aEnd + i, bEnd + i);
}

// --- Pairing the lines of a hunk that were edited, not replaced --------------

function words(line) {
  return line.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
}

// A line that is only a value: an array item such as `2,` or `"open"`.
const BARE_VALUE = /^\s*(?:"(?:[^"\\]|\\.)*"|-?\d[\d.eE+-]*|true|false|null),?\s*$/;

function similarity(left, right, leftWords, rightWords) {
  // Two values in the same spot are one value edited, even with nothing in common.
  if (BARE_VALUE.test(left) && BARE_VALUE.test(right)) return 0.5;
  const leftKey = /^\s*"([^"]*)"\s*:/.exec(left)?.[1];
  const rightKey = /^\s*"([^"]*)"\s*:/.exec(right)?.[1];
  if (leftKey !== undefined && leftKey === rightKey) return 0.6;
  if (!leftWords.length || !rightWords.length) {
    // Punctuation only: `],` and `]` are the same line with a comma added.
    return left.trim().replace(/,$/, '') === right.trim().replace(/,$/, '') ? 1 : 0;
  }
  const bag = new Map();
  for (const word of leftWords) bag.set(word, (bag.get(word) || 0) + 1);
  let shared = 0;
  for (const word of rightWords) {
    const count = bag.get(word);
    if (count) {
      shared += 1;
      bag.set(word, count - 1);
    }
  }
  return (2 * shared) / (leftWords.length + rightWords.length);
}

// Order-preserving best pairing. Returns [leftPos, rightPos] pairs, ascending.
function pairLines(leftLines, rightLines) {
  const n = leftLines.length;
  const m = rightLines.length;
  if (!n || !m) return [];
  const leftWords = leftLines.map(words);
  const rightWords = rightLines.map(words);
  const score = (i, j) => similarity(leftLines[i], rightLines[j], leftWords[i], rightWords[j]);
  if (n * m > MAX_PAIRING_CELLS) {
    const pairs = [];
    for (let i = 0; i < Math.min(n, m); i += 1) {
      if (score(i, i) >= MIN_PAIR_SIMILARITY) pairs.push([i, i]);
    }
    return pairs;
  }
  const width = m + 1;
  const best = new Float64Array((n + 1) * width);
  const took = new Uint8Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const skipLeft = best[(i + 1) * width + j];
      const skipRight = best[i * width + j + 1];
      const s = score(i, j);
      const pair = s >= MIN_PAIR_SIMILARITY ? s + best[(i + 1) * width + j + 1] : -1;
      if (pair >= skipLeft && pair >= skipRight) {
        best[i * width + j] = pair;
        took[i * width + j] = 1;
      } else if (skipLeft >= skipRight) {
        best[i * width + j] = skipLeft;
      } else {
        best[i * width + j] = skipRight;
        took[i * width + j] = 2;
      }
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const choice = took[i * width + j];
    if (choice === 1) {
      pairs.push([i, j]);
      i += 1; j += 1;
    } else if (choice === 2) j += 1;
    else i += 1;
  }
  return pairs;
}

// --- Moved blocks --------------------------------------------------------------

function isSignificant(line) {
  return (line.match(/[\p{L}\p{N}]/gu) || []).length >= 3;
}

// Marks lines present on both sides but in different places. moved[side][line]
// holds { group, target }. A block needs at least one line with real content,
// so lone brackets never count as moves. A short block must also be unmistakable:
// its text appears once per side, and it isn't really an edit of a nearby line
// (`"qty": 1` vs `"qty": 3`), which should show as changed.
function findMoves(removed, added, leftKeys, rightKeys, leftLines, gaps, rightLines) {
  const movedLeft = new Map();
  const movedRight = new Map();
  if (!removed.length || !added.length) return { movedLeft, movedRight };
  let counts = null;
  const appearsOnce = (key) => {
    if (!counts) {
      counts = new Map();
      for (const k of leftKeys) counts.set(k, (counts.get(k) || 0) + 1);
      for (const k of rightKeys) counts.set(k, (counts.get(k) || 0) + 65536);
    }
    return counts.get(key) === 65537;
  };
  const gapOfLeft = (line) => {
    let lo = 0;
    let hi = gaps.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (gaps[mid].lEnd <= line) lo = mid + 1;
      else hi = mid;
    }
    return gaps[lo];
  };
  const gapOfRight = (line) => {
    let lo = 0;
    let hi = gaps.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (gaps[mid].rEnd <= line) lo = mid + 1;
      else hi = mid;
    }
    return gaps[lo];
  };
  const fieldOf = (line) => /^\s*"([^"]*)"\s*:/.exec(line)?.[1] ?? /^\s*<([^\s/>]+)/.exec(line)?.[1];
  const hasPartner = (line, others, from, to) => {
    const field = fieldOf(line);
    if (field === undefined) return false;
    for (let i = from; i < Math.min(to, from + MAX_PARTNER_SCAN); i += 1) {
      if (others[i] !== line && fieldOf(others[i]) === field) return true;
    }
    return false;
  };
  const isUnmistakable = (start, at, length) => {
    for (let i = 0; i < length; i += 1) {
      const leftLine = removed[start + i];
      const rightLine = added[at + i];
      if (!appearsOnce(leftKeys[leftLine])) return false;
      const leftGap = gapOfLeft(leftLine);
      const rightGap = gapOfRight(rightLine);
      if (hasPartner(leftLines[leftLine], rightLines, leftGap.r, leftGap.rEnd)) return false;
      if (hasPartner(rightLines[rightLine], leftLines, rightGap.l, rightGap.lEnd)) return false;
    }
    return true;
  };
  const addedAt = new Map();
  const nextAdded = new Map();
  added.forEach((line, position) => {
    const key = rightKeys[line];
    if (!addedAt.has(key)) addedAt.set(key, []);
    addedAt.get(key).push(position);
    nextAdded.set(line, position);
  });
  let group = 0;
  let work = 0;
  for (let start = 0; start < removed.length && work < MAX_MOVE_WORK; start += 1) {
    if (movedLeft.has(removed[start])) continue;
    const candidates = addedAt.get(leftKeys[removed[start]]);
    if (!candidates) continue;
    let bestLength = 0;
    let bestAt = -1;
    let tried = 0;
    for (const at of candidates) {
      if (movedRight.has(added[at])) continue;
      if (tried >= MAX_MOVE_CANDIDATES) break;
      tried += 1;
      work += 1;
      let length = 0;
      while (start + length < removed.length && at + length < added.length
        && (length === 0 || (removed[start + length] === removed[start] + length && added[at + length] === added[at] + length))
        && !movedLeft.has(removed[start + length]) && !movedRight.has(added[at + length])
        && leftKeys[removed[start + length]] === rightKeys[added[at + length]]) {
        length += 1;
      }
      work += length;
      if (length > bestLength) {
        bestLength = length;
        bestAt = at;
      }
    }
    if (!bestLength) continue;
    let significant = false;
    for (let i = 0; i < bestLength; i += 1) significant ||= isSignificant(leftLines[removed[start + i]]);
    if (!significant) continue;
    if (bestLength < MIN_MOVE_LINES && !isUnmistakable(start, bestAt, bestLength)) continue;
    group += 1;
    for (let i = 0; i < bestLength; i += 1) {
      movedLeft.set(removed[start + i], { group, target: added[bestAt + i] });
      movedRight.set(added[bestAt + i], { group, target: removed[start + i] });
    }
    start += bestLength - 1;
  }
  return { movedLeft, movedRight };
}

// --- Assembling ops -------------------------------------------------------------

export function compareTexts(leftText, rightText, options = {}) {
  const leftLines = splitLines(leftText);
  const rightLines = splitLines(rightText);
  const leftKeys = lineKeys(leftLines, options);
  const rightKeys = lineKeys(rightLines, options);
  const skipBlank = !!options.ignoreEmptyLines;
  const blank = (key) => key === SKIP || (skipBlank && key.trim() === '');

  // Intern the lines still in play as numbers: comparing ints is what keeps a
  // 300,000-line comparison fast.
  const ids = new Map();
  const intern = (key) => {
    let id = ids.get(key);
    if (id === undefined) {
      id = ids.size;
      ids.set(key, id);
    }
    return id;
  };
  const leftIndex = [];
  const rightIndex = [];
  const a = [];
  const b = [];
  leftKeys.forEach((key, line) => {
    if (!blank(key)) { leftIndex.push(line); a.push(intern(key)); }
  });
  rightKeys.forEach((key, line) => {
    if (!blank(key)) { rightIndex.push(line); b.push(intern(key)); }
  });

  const matchedLeft = [];
  const matchedRight = [];
  solve(Int32Array.from(a), 0, a.length, Int32Array.from(b), 0, b.length, (i, j) => {
    matchedLeft.push(leftIndex[i]);
    matchedRight.push(rightIndex[j]);
  }, 0);

  // Everything between matches is a gap. Moves are found across all gaps first,
  // because a line that moved should not be paired with an unrelated edit.
  const gaps = [];
  const removed = [];
  const added = [];
  let li = 0;
  let ri = 0;
  for (let m = 0; m <= matchedLeft.length; m += 1) {
    const lEnd = m < matchedLeft.length ? matchedLeft[m] : leftLines.length;
    const rEnd = m < matchedLeft.length ? matchedRight[m] : rightLines.length;
    if (li < lEnd || ri < rEnd) gaps.push({ l: li, lEnd, r: ri, rEnd, match: m });
    for (let line = li; line < lEnd; line += 1) if (!blank(leftKeys[line])) removed.push(line);
    for (let line = ri; line < rEnd; line += 1) if (!blank(rightKeys[line])) added.push(line);
    li = lEnd + 1;
    ri = rEnd + 1;
  }
  const { movedLeft, movedRight } = findMoves(removed, added, leftKeys, rightKeys, leftLines, gaps, rightLines);

  const ops = [];
  const pushRow = (kind, l, r, extra) => {
    const last = ops[ops.length - 1];
    const lCount = l >= 0 ? 1 : 0;
    const rCount = r >= 0 ? 1 : 0;
    if (last && last.kind === kind && (!extra || last.group === extra.group)
      && (lCount === 0 || last.l + last.lc === l) && (rCount === 0 || last.r + last.rc === r)
      && (kind !== KIND.MOVED || (last.lc > 0) === (lCount > 0))
      && (kind !== KIND.IGNORED || (last.lc > 0) === (lCount > 0))) {
      last.lc += lCount;
      last.rc += rCount;
      return;
    }
    ops.push({ kind, l: l >= 0 ? l : nextLeft, lc: lCount, r: r >= 0 ? r : nextRight, rc: rCount, ...extra });
  };
  let nextLeft = 0;
  let nextRight = 0;
  const emit = (kind, l, r, extra) => {
    pushRow(kind, l, r, extra);
    if (l >= 0) nextLeft = l + 1;
    if (r >= 0) nextRight = r + 1;
  };

  const emitLeftOnly = (line) => {
    if (blank(leftKeys[line])) return emit(KIND.IGNORED, line, -1);
    const moved = movedLeft.get(line);
    if (moved) return emit(KIND.MOVED, line, -1, { group: moved.group, target: moved.target });
    return emit(KIND.REMOVED, line, -1);
  };
  const emitRightOnly = (line) => {
    if (blank(rightKeys[line])) return emit(KIND.IGNORED, -1, line);
    const moved = movedRight.get(line);
    if (moved) return emit(KIND.MOVED, -1, line, { group: moved.group, target: moved.target });
    return emit(KIND.ADDED, -1, line);
  };

  let gapAt = 0;
  for (let m = 0; m <= matchedLeft.length; m += 1) {
    if (gapAt < gaps.length && gaps[gapAt].match === m) {
      const gap = gaps[gapAt];
      gapAt += 1;
      const leftOpen = [];
      const rightOpen = [];
      for (let line = gap.l; line < gap.lEnd; line += 1) {
        if (!blank(leftKeys[line]) && !movedLeft.has(line)) leftOpen.push(line);
      }
      for (let line = gap.r; line < gap.rEnd; line += 1) {
        if (!blank(rightKeys[line]) && !movedRight.has(line)) rightOpen.push(line);
      }
      const pairs = pairLines(leftOpen.map((line) => leftLines[line]), rightOpen.map((line) => rightLines[line]));
      let lCursor = gap.l;
      let rCursor = gap.r;
      for (const [lp, rp] of pairs) {
        const pairedLeft = leftOpen[lp];
        const pairedRight = rightOpen[rp];
        while (lCursor < pairedLeft) emitLeftOnly(lCursor++);
        while (rCursor < pairedRight) emitRightOnly(rCursor++);
        emit(KIND.CHANGED, pairedLeft, pairedRight);
        lCursor = pairedLeft + 1;
        rCursor = pairedRight + 1;
      }
      while (lCursor < gap.lEnd) emitLeftOnly(lCursor++);
      while (rCursor < gap.rEnd) emitRightOnly(rCursor++);
    }
    if (m < matchedLeft.length) emit(KIND.SAME, matchedLeft[m], matchedRight[m]);
  }
  const ignoring = options.ignoreWhitespace || options.ignoreCase || options.ignoreEmptyLines
    || options.equivalentValues || options.ignoreFields?.length;
  return {
    ops,
    ...summarize(ops),
    ignoredRows: ignoring ? countIgnored(ops, leftLines, rightLines) : 0,
    leftLines: leftLines.length,
    rightLines: rightLines.length,
  };
}

// Runs of non-matching ops form one "difference" for navigation.
function summarize(ops) {
  const counts = { added: 0, removed: 0, changed: 0, moved: 0 };
  const differences = [];
  const movedGroups = new Set();
  let open = null;
  ops.forEach((op, index) => {
    if (op.kind === KIND.ADDED) counts.added += op.rc;
    else if (op.kind === KIND.REMOVED) counts.removed += op.lc;
    else if (op.kind === KIND.CHANGED) counts.changed += op.lc;
    else if (op.kind === KIND.MOVED) movedGroups.add(op.group);
    if (op.kind === KIND.SAME || op.kind === KIND.IGNORED) {
      open = null;
      return;
    }
    if (open) {
      open.last = index;
    } else {
      open = { first: index, last: index };
      differences.push(open);
    }
  });
  counts.moved = movedGroups.size;
  return { counts, differences, identical: differences.length === 0 };
}

// --- Characters inside a changed line ------------------------------------------

function tokenize(line) {
  return line.match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu) || [];
}

// What differs inside a pair of lines, as { left: [[from, to]...], right: [...] }
// (character offsets). Works on words and symbols, so `"total": 129.5` vs
// `"total": 130.5` marks the whole number instead of scattered digits.
export function inlineDiff(left, right, options = {}) {
  let start = 0;
  const shortest = Math.min(left.length, right.length);
  const same = (x, y) => (options.ignoreCase ? x.toLowerCase() === y.toLowerCase() : x === y);
  while (start < shortest && same(left[start], right[start])) start += 1;
  let end = 0;
  while (end < shortest - start && same(left[left.length - 1 - end], right[right.length - 1 - end])) end += 1;
  // Widen to token edges, so a partly equal number or word is marked whole.
  const isWord = (ch) => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
  while (start > 0 && (isWord(left[start - 1]) && (isWord(left[start]) || isWord(right[start])))) start -= 1;
  while (end > 0 && isWord(left[left.length - end]) && (isWord(left[left.length - end - 1]) || isWord(right[right.length - end - 1]))) end -= 1;
  const leftMiddle = left.slice(start, left.length - end);
  const rightMiddle = right.slice(start, right.length - end);
  const whole = () => ({
    left: leftMiddle ? [[start, start + leftMiddle.length]] : [],
    right: rightMiddle ? [[start, start + rightMiddle.length]] : [],
  });
  if (!leftMiddle || !rightMiddle) return whole();
  const leftTokens = tokenize(leftMiddle);
  const rightTokens = tokenize(rightMiddle);
  if (leftTokens.length + rightTokens.length > MAX_INLINE_TOKENS) return whole();

  const ids = new Map();
  const toId = (token) => {
    const key = lineKey(token, options);
    if (!ids.has(key)) ids.set(key, ids.size);
    return ids.get(key);
  };
  const a = Int32Array.from(leftTokens, toId);
  const b = Int32Array.from(rightTokens, toId);
  const matched = [];
  if (!myers(a, 0, a.length, b, 0, b.length, (i, j) => matched.push([i, j]))) return whole();

  const ranges = (tokens, side) => {
    const out = [];
    const kept = new Set(matched.map((pair) => pair[side]));
    let offset = start;
    tokens.forEach((token, index) => {
      const significant = !(options.ignoreWhitespace && /^\s+$/.test(token));
      if (!kept.has(index) && significant) {
        const last = out[out.length - 1];
        if (last && last[1] === offset) last[1] += token.length;
        else out.push([offset, offset + token.length]);
      }
      offset += token.length;
    });
    return out;
  };
  return { left: ranges(leftTokens, 0), right: ranges(rightTokens, 1) };
}
