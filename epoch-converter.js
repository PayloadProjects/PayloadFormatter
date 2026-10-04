// Epoch converter: pure logic, no DOM. Timestamps <-> human dates.
// Dependency-free so it unit-tests without a browser.
export const EPOCH_UNITS = {
  s: { label: 'Seconds', digits: 10 },
  ms: { label: 'Milliseconds', digits: 13 },
  us: { label: 'Microseconds', digits: 16 },
  ns: { label: 'Nanoseconds', digits: 19 },
};

const UNIT_ORDER = ['s', 'ms', 'us', 'ns'];

// Matches an optional sign, integer digits, and an optional fraction.
const TIMESTAMP_RE = /^[+-]?(\d+)(?:\.(\d+))?$/;

export function cleanTimestamp(raw) {
  return String(raw ?? '').trim().replace(/[,_\s]/g, '');
}

// Guess the unit from the digit count: 10 -> s, 13 -> ms, 16 -> us,
// 19 -> ns. In-between counts round up to the next unit. Returns null for
// non-numeric input. Ambiguous counts are why the UI offers an override.
export function detectUnit(raw) {
  const text = cleanTimestamp(raw);
  const match = TIMESTAMP_RE.exec(text);
  if (!match) return null;
  const digits = match[1].replace(/^0+/, '').length || 1;
  for (const unit of UNIT_ORDER) {
    if (digits <= EPOCH_UNITS[unit].digits) return unit;
  }
  return 'ns';
}

export function timestampToMs(raw, unit) {
  const text = cleanTimestamp(raw);
  const match = TIMESTAMP_RE.exec(text);
  if (!match || !EPOCH_UNITS[unit]) return NaN;
  const sign = text.startsWith('-') ? -1 : 1;
  const intPart = match[1];
  const fracPart = match[2] || '';
  // Integer math where possible so nanoseconds keep full precision.
  const factors = { s: 1000, ms: 1, us: 0.001, ns: 0.000001 };
  const intMs = Number(intPart) * factors[unit];
  const fracMs = fracPart ? Number(`0.${fracPart}`) * factors[unit] : 0;
  const ms = sign * (intMs + fracMs);
  return Number.isFinite(ms) ? ms : NaN;
}

export function msToUnitStrings(ms) {
  const trim = (n) => {
    if (!Number.isFinite(n)) return '—';
    return String(Number(n.toFixed(6)));
  };
  const out = { s: trim(ms / 1000), ms: trim(ms) };
  if (Number.isInteger(ms) && Math.abs(ms) < 9e12) {
    const big = BigInt(Math.trunc(ms));
    out.us = (big * 1000n).toString();
    out.ns = (big * 1000000n).toString();
  } else {
    out.us = trim(ms * 1000);
    out.ns = trim(ms * 1e6);
  }
  return out;
}

export function dateToUnitStrings(date, unit) {
  const ms = date.getTime();
  if (!EPOCH_UNITS[unit]) return '—';
  if (unit === 's') return String(Math.floor(ms / 1000));
  if (unit === 'ms') return String(Math.trunc(ms));
  const big = BigInt(Math.trunc(ms));
  if (unit === 'us') return (big * 1000n).toString();
  return (big * 1000000n).toString();
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

export function formatUtc(date) {
  const iso = date.toISOString();
  // Drop the .000 when there are no sub-second parts: cleaner to copy.
  return iso.endsWith('.000Z') ? iso.slice(0, -5) + 'Z' : iso;
}

export function timeZoneName() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
  } catch (_) {
    return 'local time';
  }
}

function timeZoneShort(date) {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
      .formatToParts(date)
      .find((p) => p.type === 'timeZoneName');
    return part ? ` ${part.value}` : '';
  } catch (_) {
    return '';
  }
}

export function formatLocal(date) {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}` +
    timeZoneShort(date)
  );
}

const RELATIVE_STEPS = [
  [365 * 86400000, 'year'],
  [30 * 86400000, 'month'],
  [86400000, 'day'],
  [3600000, 'hour'],
  [60000, 'minute'],
  [1000, 'second'],
];

export function formatRelative(date, nowMs = Date.now()) {
  const diff = date.getTime() - nowMs;
  const abs = Math.abs(diff);
  if (abs < 1000) return 'just now';
  for (const [size, name] of RELATIVE_STEPS) {
    if (abs >= size) {
      const n = Math.floor(abs / size);
      const label = `${n} ${name}${n === 1 ? '' : 's'}`;
      return diff > 0 ? `in ${label}` : `${label} ago`;
    }
  }
  return 'just now';
}

// Full conversion result for one timestamp input, or { error } when the
// input isn't usable.
export function convertTimestamp(raw, unit) {
  const ms = timestampToMs(raw, unit);
  if (!Number.isFinite(ms)) return { error: 'Enter a numeric timestamp.' };
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return { error: 'That timestamp is out of range.' };
  return {
    date,
    unit,
    utc: formatUtc(date),
    local: formatLocal(date),
    relative: formatRelative(date),
    units: msToUnitStrings(ms),
  };
}
