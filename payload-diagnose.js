// Payload diagnosis: finds the first real problem in a JSON or XML payload
// and explains it the way a person would ("Missing comma after 31"), with
// the exact location and, when the fix is unambiguous, the edit that fixes
// it. Pure logic, no DOM: the issue bar (issue-helper.js) shows the result
// and applies `fix.changes` through the editor.
//
// An issue is { message, hint, from, to, line, col, fix? } where from/to are
// character offsets into the text (to > from) and fix is
// { label, changes: [{ from, to, insert }] } in ascending, non-overlapping
// order. diagnose() returns null when it finds nothing wrong.

const SNIPPET_CHARS = 24;

export function diagnose(text, mode) {
  const source = String(text ?? '');
  if (!source.trim()) return null;
  if (mode === 'json') return diagnoseJson(source);
  if (mode === 'xml') return diagnoseXml(source);
  return null;
}

// Line and column (both 1-based) of an offset.
export function lineColumn(text, offset) {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, col: offset - lineStart + 1 };
}

// Applies a fix's changes (ascending, non-overlapping) to a string.
export function applyFix(text, fix) {
  let out = '';
  let cursor = 0;
  for (const { from, to, insert } of fix.changes) {
    out += text.slice(cursor, from) + insert;
    cursor = to;
  }
  return out + text.slice(cursor);
}

function snippet(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS - 1)}…` : flat;
}

function makeIssue(text, { message, hint, from, to, fix }) {
  const start = Math.max(0, Math.min(from, text.length));
  let end = Math.max(start, Math.min(to ?? start + 1, text.length));
  // Point issues (an insertion spot) still need a visible character.
  if (end === start) {
    if (start < text.length) end = start + 1;
  }
  const { line, col } = lineColumn(text, start);
  const issue = { message, hint, from: start, to: end, line, col };
  if (fix) issue.fix = fix;
  return issue;
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

const JSON_CLOSER = { '{': '}', '[': ']' };
const WORD_FIXES = {
  True: 'true', TRUE: 'true', False: 'false', FALSE: 'false',
  None: 'null', NULL: 'null', Null: 'null', nil: 'null', undefined: 'null',
};

function isSpace(code) {
  return code === 32 || code === 10 || code === 13 || code === 9;
}

function isWordStart(ch) {
  return /[A-Za-z_$]/.test(ch);
}

export function diagnoseJson(text) {
  const n = text.length;
  // Each open container: { ch, at, state, lastComma }. lastComma is the
  // offset of a comma that is still the most recent token in it, else -1.
  // Object states: 'key-or-end' | 'key' | 'colon' | 'value' | 'comma-or-end'.
  // Array states: 'value-or-end' | 'value' | 'comma-or-end'.
  const stack = [];
  let rootDone = false;
  let rootStart = -1;
  // Where the most recent complete value (or key) ended, for "missing comma".
  let lastEnd = -1;
  let lastStart = -1;
  let i = 0;

  const issue = (spec) => makeIssue(text, spec);
  const top = () => stack[stack.length - 1];
  const expectingValue = () => {
    const ctx = top();
    if (!ctx) return !rootDone;
    return ctx.state === 'value' || ctx.state === 'value-or-end';
  };
  const expectingKey = () => {
    const ctx = top();
    return !!ctx && (ctx.state === 'key' || ctx.state === 'key-or-end');
  };

  // A value or key just ended at `end`: advance the container state.
  const valueDone = (start, end) => {
    lastStart = start;
    lastEnd = end;
    const ctx = top();
    if (!ctx) {
      rootDone = true;
      return;
    }
    ctx.state = 'comma-or-end';
    ctx.lastComma = -1;
  };
  const keyDone = (start, end) => {
    lastStart = start;
    lastEnd = end;
    top().state = 'colon';
    top().lastComma = -1;
  };

  // A value-like token starting at `start` arrived where a comma (or the
  // end of the container) was required. Points at the previous value, which
  // is where the comma goes.
  const missingComma = (start) => {
    const prev = text.slice(lastStart, lastEnd);
    return issue({
      message: `Missing comma after ${snippet(prev)}`,
      hint: `Add a comma right after it, before the next ${start < n && text[start] === '"' ? 'item' : 'value'}.`,
      from: lastStart,
      to: lastEnd,
      fix: { label: 'Add the comma', changes: [{ from: lastEnd, to: lastEnd, insert: ',' }] },
    });
  };

  // Called when a value is about to start at `start`. Returns an issue when
  // a value is not allowed here, or null.
  const checkValueAllowed = (start, describe) => {
    const ctx = top();
    if (!ctx) {
      if (!rootDone) return null;
      return issue({
        message: 'Extra content after the end of the JSON',
        hint: 'A JSON payload holds one value. Wrap several values in [ ] and separate them with commas.',
        from: start,
        to: Math.min(n, start + 1),
      });
    }
    if (ctx.state === 'comma-or-end') return missingComma(start);
    if (ctx.state === 'colon') {
      return issue({
        message: `Missing colon after ${snippet(text.slice(lastStart, lastEnd))}`,
        hint: 'A property name is followed by a colon and then its value.',
        from: start,
        to: start + 1,
        fix: { label: 'Add the colon', changes: [{ from: lastEnd, to: lastEnd, insert: ':' }] },
      });
    }
    if (expectingKey()) return describe ? describe() : null;
    return null;
  };

  while (i < n) {
    const code = text.charCodeAt(i);
    if (isSpace(code) || code === 0xFEFF) {
      i += 1;
      continue;
    }
    const ch = text[i];

    // Comments are a common copy-paste leftover from JS / JSONC.
    if (ch === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      const block = text[i + 1] === '*';
      let end = block ? text.indexOf('*/', i + 2) : text.indexOf('\n', i + 2);
      end = end < 0 ? n : end + (block ? 2 : 0);
      return issue({
        message: 'JSON doesn\'t allow comments',
        hint: 'Remove the comment; JSON has no comment syntax.',
        from: i,
        to: end,
        fix: { label: 'Remove the comment', changes: [{ from: i, to: end, insert: '' }] },
      });
    }

    if (ch === '{' || ch === '[') {
      if (expectingKey()) {
        return issue({
          message: 'Property name expected',
          hint: 'Inside { } every value needs a name in double quotes, like "name": value.',
          from: i,
          to: i + 1,
        });
      }
      const problem = checkValueAllowed(i);
      if (problem) return problem;
      if (!top() && rootStart < 0) rootStart = i;
      if (top()) top().lastComma = -1;
      stack.push({ ch, at: i, state: ch === '{' ? 'key-or-end' : 'value-or-end', lastComma: -1 });
      i += 1;
      continue;
    }

    if (ch === '}' || ch === ']') {
      const ctx = top();
      if (!ctx) {
        return issue({
          message: `Extra ${ch} with nothing to close`,
          hint: 'Remove it, or check that the opening bracket was not deleted.',
          from: i,
          to: i + 1,
          fix: { label: `Remove the ${ch}`, changes: [{ from: i, to: i + 1, insert: '' }] },
        });
      }
      const expected = JSON_CLOSER[ctx.ch];
      if (ch !== expected) {
        const opened = lineColumn(text, ctx.at).line;
        const outer = stack[stack.length - 2];
        // `[{"a":1]`: the inner { was never closed; the ] belongs to the [.
        if (outer && JSON_CLOSER[outer.ch] === ch) {
          return issue({
            message: `Missing ${expected} to close the ${ctx.ch} opened on line ${opened}`,
            hint: `Add ${expected} before this ${ch}.`,
            from: i,
            to: i + 1,
            fix: { label: `Add ${expected}`, changes: [{ from: i, to: i, insert: expected }] },
          });
        }
        return issue({
          message: `This ${ch} doesn't match the ${ctx.ch} opened on line ${opened}`,
          hint: `It should be ${expected}.`,
          from: i,
          to: i + 1,
          fix: { label: `Change it to ${expected}`, changes: [{ from: i, to: i + 1, insert: expected }] },
        });
      }
      if ((ctx.state === 'key' || ctx.state === 'value') && ctx.lastComma >= 0) {
        return issue({
          message: `Extra comma before ${ch}`,
          hint: 'JSON doesn\'t allow a comma after the last item.',
          from: ctx.lastComma,
          to: ctx.lastComma + 1,
          fix: { label: 'Remove the comma', changes: [{ from: ctx.lastComma, to: ctx.lastComma + 1, insert: '' }] },
        });
      }
      if (ctx.state === 'colon' || (ctx.ch === '{' && ctx.state === 'value')) {
        return issue({
          message: `Missing value after ${snippet(text.slice(lastStart, lastEnd))}`,
          hint: 'Every property needs a value. Use null if it is empty.',
          from: i,
          to: i + 1,
          fix: ctx.state === 'value'
            ? { label: 'Use null', changes: [{ from: i, to: i, insert: 'null' }] }
            : { label: 'Use null', changes: [{ from: lastEnd, to: lastEnd, insert: ': null' }] },
        });
      }
      stack.pop();
      valueDone(ctx.at, i + 1);
      i += 1;
      continue;
    }

    if (ch === ',') {
      const ctx = top();
      if (!ctx) {
        return issue({
          message: 'Unexpected comma',
          hint: rootDone ? 'Wrap several values in [ ] to make a list.' : 'Remove the comma.',
          from: i,
          to: i + 1,
          fix: { label: 'Remove the comma', changes: [{ from: i, to: i + 1, insert: '' }] },
        });
      }
      if (ctx.state !== 'comma-or-end') {
        const doubled = ctx.lastComma >= 0 && (ctx.state === 'key' || ctx.state === 'value');
        return issue({
          message: doubled ? 'Two commas in a row' : 'Unexpected comma',
          hint: ctx.state === 'colon' ? 'A property name needs a colon and a value after it.' : 'Remove the extra comma.',
          from: i,
          to: i + 1,
          fix: ctx.state === 'colon' ? undefined : { label: 'Remove the comma', changes: [{ from: i, to: i + 1, insert: '' }] },
        });
      }
      ctx.state = ctx.ch === '{' ? 'key' : 'value';
      ctx.lastComma = i;
      i += 1;
      continue;
    }

    if (ch === ':') {
      const ctx = top();
      if (!ctx || ctx.state !== 'colon') {
        return issue({
          message: 'Unexpected colon',
          hint: ctx && ctx.ch === '[' ? 'Lists hold plain values; use { } for "name": value pairs.' : 'A colon only follows a property name.',
          from: i,
          to: i + 1,
        });
      }
      ctx.state = 'value';
      ctx.lastComma = -1;
      i += 1;
      continue;
    }

    if (ch === '"' || ch === '\'') {
      const quote = ch;
      let j = i + 1;
      let bad = null;
      while (j < n) {
        const c = text[j];
        if (c === '\\') {
          const next = text[j + 1];
          if (quote === '"' && next !== undefined && !'"\\/bfnrtu'.includes(next) && !bad) {
            bad = { kind: 'escape', at: j, next };
          }
          if (quote === '"' && next === 'u' && !/^[0-9a-fA-F]{4}$/.test(text.slice(j + 2, j + 6)) && !bad) {
            bad = { kind: 'unicode', at: j };
          }
          j += 2;
          continue;
        }
        if (c === quote) break;
        if (c === '\n' || c === '\r') break;
        if (quote === '"' && c.charCodeAt(0) < 0x20 && !bad) bad = { kind: 'control', at: j, c };
        j += 1;
      }
      const closed = j < n && text[j] === quote;
      const start = i;
      const end = closed ? j + 1 : j;

      if (!closed) {
        // Close before a trailing comma on the line, if there is one.
        let insertAt = j;
        while (insertAt > start + 1 && /[ \t]/.test(text[insertAt - 1])) insertAt -= 1;
        if (text[insertAt - 1] === ',' && insertAt - 1 > start + 1) insertAt -= 1;
        return issue({
          message: 'This text is never closed',
          hint: `Add the closing ${quote} on line ${lineColumn(text, start).line}.`,
          from: start,
          to: j,
          fix: { label: `Add the closing ${quote}`, changes: [{ from: insertAt, to: insertAt, insert: quote }] },
        });
      }

      const keyPosition = expectingKey();
      if (!keyPosition) {
        const problem = checkValueAllowed(start);
        if (problem) return problem;
      }

      if (quote === '\'') {
        const inner = text.slice(start + 1, j).replace(/\\'/g, '\'').replace(/(^|[^\\])"/g, '$1\\"');
        return issue({
          message: 'JSON text needs double quotes',
          hint: `Use "…" instead of '…'.`,
          from: start,
          to: end,
          fix: { label: 'Use double quotes', changes: [{ from: start, to: end, insert: `"${inner}"` }] },
        });
      }

      if (bad) {
        if (bad.kind === 'control') {
          const named = { '\t': '\\t', '\b': '\\b', '\f': '\\f' }[bad.c]
            || `\\u${bad.c.charCodeAt(0).toString(16).padStart(4, '0')}`;
          return issue({
            message: bad.c === '\t' ? 'A tab character inside text' : 'An invisible control character inside text',
            hint: `JSON text can't contain it raw; write it as ${named}.`,
            from: bad.at,
            to: bad.at + 1,
            fix: { label: `Replace it with ${named}`, changes: [{ from: bad.at, to: bad.at + 1, insert: named }] },
          });
        }
        if (bad.kind === 'unicode') {
          return issue({
            message: 'Incomplete \\u escape',
            hint: 'A \\u escape needs exactly four hex digits, like \\u00e9.',
            from: bad.at,
            to: Math.min(n, bad.at + 6),
          });
        }
        const removeSlash = bad.next === '\'';
        return issue({
          message: `\\${bad.next} isn't a valid escape in JSON`,
          hint: removeSlash ? 'An apostrophe needs no backslash in JSON text.' : 'Write a literal backslash as \\\\.',
          from: bad.at,
          to: bad.at + 2,
          fix: removeSlash
            ? { label: 'Remove the backslash', changes: [{ from: bad.at, to: bad.at + 1, insert: '' }] }
            : { label: 'Escape the backslash', changes: [{ from: bad.at, to: bad.at + 1, insert: '\\\\' }] },
        });
      }

      if (keyPosition) keyDone(start, end);
      else {
        if (!top() && rootStart < 0) rootStart = start;
        valueDone(start, end);
      }
      i = end;
      continue;
    }

    // Numbers, including the near-misses people paste from other languages.
    if (/[-+.\d]/.test(ch)) {
      const match = /^[-+]?(?:0[xX][0-9a-fA-F]+|\d*\.?\d*(?:[eE][-+]?\d+)?)/.exec(text.slice(i, i + 400));
      const raw = match ? match[0] : ch;
      const end = i + Math.max(1, raw.length);
      if (expectingKey()) {
        return issue({
          message: 'Property names need double quotes',
          hint: `Write "${raw}" instead of ${raw}.`,
          from: i,
          to: end,
          fix: { label: 'Add the quotes', changes: [{ from: i, to: end, insert: `"${raw}"` }] },
        });
      }
      const problem = checkValueAllowed(i);
      if (problem) return problem;
      let fixed = null;
      let why = '';
      if (/^[-+]?0[xX]/.test(raw)) {
        fixed = String(Number.parseInt(raw.replace(/^\+/, ''), 16));
        why = 'JSON numbers are decimal';
      } else if (raw.startsWith('+')) {
        fixed = raw.slice(1);
        why = 'JSON numbers can\'t start with +';
      } else if (/^-?\./.test(raw)) {
        fixed = raw.replace('.', '0.');
        why = 'JSON needs a digit before the decimal point';
      } else if (/\.(?:[eE]|$)/.test(raw)) {
        fixed = raw.replace('.', '');
        why = 'JSON needs a digit after the decimal point';
      } else if (/^-?0\d/.test(raw)) {
        fixed = raw.replace(/^(-?)0+(?=\d)/, '$1');
        why = 'JSON numbers can\'t have leading zeros';
      } else if (raw === '-' || raw === '.' || raw === '+') {
        return issue({ message: `Unexpected ${raw}`, hint: 'Expected a value here.', from: i, to: end });
      }
      if (fixed !== null && fixed !== raw) {
        return issue({
          message: `${raw} isn't a valid JSON number`,
          hint: `${why}: write ${fixed}.`,
          from: i,
          to: end,
          fix: { label: `Use ${fixed}`, changes: [{ from: i, to: end, insert: fixed }] },
        });
      }
      if (!top() && rootStart < 0) rootStart = i;
      valueDone(i, end);
      i = end;
      continue;
    }

    if (isWordStart(ch)) {
      const word = /^[A-Za-z_$][\w$-]*/.exec(text.slice(i, i + 200))[0];
      const end = i + word.length;
      if (expectingKey()) {
        let k = end;
        while (k < n && isSpace(text.charCodeAt(k))) k += 1;
        return issue({
          message: 'Property names need double quotes',
          hint: `Write "${word}" instead of ${word}.`,
          from: i,
          to: end,
          fix: text[k] === ':'
            ? { label: 'Add the quotes', changes: [{ from: i, to: end, insert: `"${word}"` }] }
            : undefined,
        });
      }
      const problem = checkValueAllowed(i);
      if (problem) return problem;
      if (word === 'true' || word === 'false' || word === 'null') {
        if (!top() && rootStart < 0) rootStart = i;
        valueDone(i, end);
        i = end;
        continue;
      }
      if (WORD_FIXES[word]) {
        const fixed = WORD_FIXES[word];
        return issue({
          message: `${word} isn't valid in JSON`,
          hint: `JSON writes it as ${fixed}.`,
          from: i,
          to: end,
          fix: { label: `Use ${fixed}`, changes: [{ from: i, to: end, insert: fixed }] },
        });
      }
      if (word === 'NaN' || word === 'Infinity') {
        return issue({
          message: `${word} isn't valid in JSON`,
          hint: 'JSON has no NaN or Infinity; use null or a string.',
          from: i,
          to: end,
          fix: { label: 'Use null', changes: [{ from: i, to: end, insert: 'null' }] },
        });
      }
      return issue({
        message: 'Text values need double quotes',
        hint: `Write "${word}" instead of ${word}.`,
        from: i,
        to: end,
        fix: { label: 'Add the quotes', changes: [{ from: i, to: end, insert: `"${word}"` }] },
      });
    }

    if (ch === '-' && text[i + 1] === 'I') {
      // -Infinity
      const end = i + 9;
      return issue({
        message: '-Infinity isn\'t valid in JSON',
        hint: 'JSON has no infinity; use null or a string.',
        from: i,
        to: Math.min(n, end),
        fix: { label: 'Use null', changes: [{ from: i, to: Math.min(n, end), insert: 'null' }] },
      });
    }

    return issue({
      message: `Unexpected character ${JSON.stringify(ch)}`,
      hint: expectingValue() ? 'Expected a value: text in "quotes", a number, true, false, null, { } or [ ].' : 'Remove it or check the line around it.',
      from: i,
      to: i + 1,
    });
  }

  // End of text with containers still open.
  if (stack.length) {
    const ctx = top();
    if ((ctx.state === 'key' || ctx.state === 'value') && ctx.lastComma >= 0) {
      return makeIssue(text, {
        message: 'The text ends after a comma',
        hint: 'Remove the trailing comma and close the brackets.',
        from: ctx.lastComma,
        to: ctx.lastComma + 1,
        fix: {
          label: 'Remove the comma and close',
          changes: [
            { from: ctx.lastComma, to: ctx.lastComma + 1, insert: '' },
            { from: n, to: n, insert: closersFor(stack) },
          ],
        },
      });
    }
    if (ctx.state === 'colon' || (ctx.ch === '{' && ctx.state === 'value')) {
      return makeIssue(text, {
        message: `Missing value after ${snippet(text.slice(lastStart, lastEnd))}`,
        hint: 'The text ends before this property gets a value.',
        from: Math.max(0, n - 1),
        to: n,
      });
    }
    const closers = closersFor(stack);
    const opened = lineColumn(text, ctx.at).line;
    return makeIssue(text, {
      message: stack.length === 1
        ? `The ${ctx.ch} opened on line ${opened} is never closed`
        : `${stack.length} brackets are never closed`,
      hint: `Add ${closers.split('').join(' ')} at the end.`,
      from: ctx.at,
      to: ctx.at + 1,
      fix: { label: `Add ${closers}`, changes: [{ from: n, to: n, insert: closers }] },
    });
  }
  return null;
}

function closersFor(stack) {
  return stack.slice().reverse().map((ctx) => JSON_CLOSER[ctx.ch]).join('');
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

const XML_NAME = /^[A-Za-z_:][\w.:-]*/;

export function diagnoseXml(text) {
  const n = text.length;
  const stack = []; // { name, at, nameFrom, nameTo }
  let rootClosed = false;
  let i = 0;
  const issue = (spec) => makeIssue(text, spec);

  while (i < n) {
    const lt = text.indexOf('<', i);
    const textEnd = lt < 0 ? n : lt;

    // Text content: bare & is the classic break.
    for (let j = i; j < textEnd; j += 1) {
      if (text[j] !== '&') continue;
      if (/^&(?:[A-Za-z][\w.-]*|#\d+|#x[0-9a-fA-F]+);/.test(text.slice(j, j + 40))) continue;
      return issue({
        message: 'A bare & in text',
        hint: 'In XML, write & as &amp;.',
        from: j,
        to: j + 1,
        fix: { label: 'Use &amp;', changes: [{ from: j, to: j + 1, insert: '&amp;' }] },
      });
    }
    if (stack.length === 0 && textEnd > i && text.slice(i, textEnd).trim() && (rootClosed || i > 0 || lt >= 0)) {
      const from = i + (text.slice(i, textEnd).length - text.slice(i, textEnd).trimStart().length);
      return issue({
        message: rootClosed ? 'Text after the closing root tag' : 'Text before the first tag',
        hint: 'Everything must sit inside the single top-level element.',
        from,
        to: Math.min(textEnd, from + 1),
      });
    }
    if (lt < 0) break;
    i = lt;

    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end < 0) {
        return issue({
          message: 'This comment is never closed',
          hint: 'End the comment with -->.',
          from: i,
          to: i + 4,
          fix: { label: 'Close the comment', changes: [{ from: n, to: n, insert: ' -->' }] },
        });
      }
      i = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i + 9);
      if (end < 0) {
        return issue({ message: 'This CDATA section is never closed', hint: 'End it with ]]>.', from: i, to: i + 9 });
      }
      i = end + 3;
      continue;
    }
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2);
      if (end < 0) return issue({ message: 'This <? … ?> instruction is never closed', hint: 'End it with ?>.', from: i, to: i + 2 });
      i = end + 2;
      continue;
    }
    if (text.startsWith('<!', i)) {
      // DOCTYPE, possibly with an internal [ … ] subset.
      let depth = 0;
      let j = i + 2;
      for (; j < n; j += 1) {
        if (text[j] === '[') depth += 1;
        else if (text[j] === ']') depth -= 1;
        else if (text[j] === '>' && depth <= 0) break;
      }
      if (j >= n) return issue({ message: 'This <! … > declaration is never closed', hint: 'End it with >.', from: i, to: i + 2 });
      i = j + 1;
      continue;
    }

    if (text[i + 1] === '/') {
      const nameMatch = XML_NAME.exec(text.slice(i + 2, i + 202));
      const gt = text.indexOf('>', i + 2);
      if (!nameMatch || gt < 0) {
        return issue({ message: 'Broken closing tag', hint: 'A closing tag looks like </name>.', from: i, to: Math.min(n, i + 2) });
      }
      const name = nameMatch[0];
      const nameFrom = i + 2;
      const nameTo = nameFrom + name.length;
      const end = gt + 1;
      if (!stack.length) {
        return issue({
          message: `</${name}> has no matching opening tag`,
          hint: 'Remove it, or add the opening tag it belongs to.',
          from: i,
          to: end,
          fix: { label: `Remove </${name}>`, changes: [{ from: i, to: end, insert: '' }] },
        });
      }
      const open = stack[stack.length - 1];
      if (open.name !== name) {
        const deeper = stack.map((entry) => entry.name).lastIndexOf(name);
        const openLine = lineColumn(text, open.at).line;
        if (deeper >= 0) {
          const missing = stack.slice(deeper + 1).reverse().map((entry) => `</${entry.name}>`).join('');
          return issue({
            message: `<${open.name}> on line ${openLine} is never closed`,
            hint: `Add ${missing} before </${name}>.`,
            from: i,
            to: end,
            fix: { label: `Add ${missing}`, changes: [{ from: i, to: i, insert: missing }] },
          });
        }
        return issue({
          message: `</${name}> doesn't match <${open.name}> opened on line ${openLine}`,
          hint: `It should be </${open.name}>.`,
          from: i,
          to: end,
          fix: { label: `Change it to </${open.name}>`, changes: [{ from: nameFrom, to: nameTo, insert: open.name }] },
        });
      }
      stack.pop();
      if (!stack.length) rootClosed = true;
      i = end;
      continue;
    }

    // Opening or self-closing tag.
    const nameMatch = XML_NAME.exec(text.slice(i + 1, i + 201));
    if (!nameMatch) {
      const isSpaceAfter = /[\s\d=]/.test(text[i + 1] || '');
      return issue({
        message: isSpaceAfter ? 'A bare < in text' : 'Invalid tag name',
        hint: isSpaceAfter ? 'In XML, write < as &lt;.' : 'Tag names start with a letter or _.',
        from: i,
        to: i + 1,
        fix: isSpaceAfter ? { label: 'Use &lt;', changes: [{ from: i, to: i + 1, insert: '&lt;' }] } : undefined,
      });
    }
    const name = nameMatch[0];
    if (rootClosed && !stack.length) {
      return issue({
        message: 'XML allows only one top-level element',
        hint: `Wrap everything in one element, e.g. <root> … </root>.`,
        from: i,
        to: i + 1 + name.length,
      });
    }
    let j = i + 1 + name.length;
    const seen = new Set();
    let selfClosing = false;
    let closedTag = false;
    while (j < n) {
      while (j < n && isSpace(text.charCodeAt(j))) j += 1;
      if (text[j] === '>') { closedTag = true; j += 1; break; }
      if (text.startsWith('/>', j)) { closedTag = true; selfClosing = true; j += 2; break; }
      if (text[j] === '<' || j >= n) break;
      const attr = XML_NAME.exec(text.slice(j, j + 200));
      if (!attr) {
        return issue({ message: `Unexpected ${JSON.stringify(text[j])} in <${name}>`, hint: 'Attributes look like name="value".', from: j, to: j + 1 });
      }
      const attrName = attr[0];
      const attrFrom = j;
      j += attrName.length;
      if (seen.has(attrName)) {
        return issue({ message: `Attribute ${attrName} appears twice in <${name}>`, hint: 'Keep one of them.', from: attrFrom, to: j });
      }
      seen.add(attrName);
      let k = j;
      while (k < n && isSpace(text.charCodeAt(k))) k += 1;
      if (text[k] !== '=') {
        return issue({
          message: `Attribute ${attrName} has no value`,
          hint: `XML attributes always have a value, like ${attrName}="…".`,
          from: attrFrom,
          to: j,
          fix: { label: 'Add an empty value', changes: [{ from: j, to: j, insert: '=""' }] },
        });
      }
      k += 1;
      while (k < n && isSpace(text.charCodeAt(k))) k += 1;
      const q = text[k];
      if (q === '"' || q === '\'') {
        const close = text.indexOf(q, k + 1);
        if (close < 0) {
          return issue({ message: `The value of ${attrName} is never closed`, hint: `Add the closing ${q}.`, from: k, to: k + 1 });
        }
        const value = text.slice(k + 1, close);
        const lt2 = value.indexOf('<');
        if (lt2 >= 0) {
          return issue({
            message: `A < inside the value of ${attrName}`,
            hint: 'In XML, write < as &lt;.',
            from: k + 1 + lt2,
            to: k + 2 + lt2,
            fix: { label: 'Use &lt;', changes: [{ from: k + 1 + lt2, to: k + 2 + lt2, insert: '&lt;' }] },
          });
        }
        const amp = /&(?![A-Za-z][\w.-]*;|#\d+;|#x[0-9a-fA-F]+;)/.exec(value);
        if (amp) {
          const at = k + 1 + amp.index;
          return issue({
            message: `A bare & in the value of ${attrName}`,
            hint: 'In XML, write & as &amp;.',
            from: at,
            to: at + 1,
            fix: { label: 'Use &amp;', changes: [{ from: at, to: at + 1, insert: '&amp;' }] },
          });
        }
        j = close + 1;
        continue;
      }
      const bare = /^[^\s>"'/]+/.exec(text.slice(k, k + 400));
      const value = bare ? bare[0] : '';
      return issue({
        message: `The value of ${attrName} needs quotes`,
        hint: `Write ${attrName}="${value}".`,
        from: k,
        to: k + Math.max(1, value.length),
        fix: value
          ? { label: 'Add the quotes', changes: [{ from: k, to: k + value.length, insert: `"${value}"` }] }
          : undefined,
      });
    }
    if (!closedTag) {
      return issue({
        message: `<${name}> is missing its >`,
        hint: 'Every tag ends with > (or /> when it has no content).',
        from: i,
        to: i + 1 + name.length,
        fix: j >= n || text[j] === '<'
          ? { label: 'Add the >', changes: [{ from: trimEnd(text, j), to: trimEnd(text, j), insert: '>' }] }
          : undefined,
      });
    }
    if (!selfClosing) stack.push({ name, at: i });
    else if (!stack.length) rootClosed = true;
    i = j;
  }

  if (stack.length) {
    const open = stack[stack.length - 1];
    const missing = stack.slice().reverse().map((entry) => `</${entry.name}>`).join('');
    return makeIssue(text, {
      message: stack.length === 1
        ? `<${open.name}> on line ${lineColumn(text, open.at).line} is never closed`
        : `${stack.length} tags are never closed`,
      hint: `Add ${missing} at the end.`,
      from: open.at,
      to: open.at + 1 + open.name.length,
      fix: { label: `Add ${missing}`, changes: [{ from: n, to: n, insert: missing }] },
    });
  }
  return null;
}

function trimEnd(text, at) {
  let k = at;
  while (k > 0 && isSpace(text.charCodeAt(k - 1))) k -= 1;
  return k;
}
