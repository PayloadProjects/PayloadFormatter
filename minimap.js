// Minimap: a slim column beside the text editor with one bar per sampled
// line (width follows the line's indent and length, color its content), a
// tint for the visible region, and the cursor line in the accent color.
// Click or drag to scroll. Huge documents are sampled, never walked whole,
// so drawing costs the same at 2 KB and 20 MB.
const ROW_STEP = 6;
const BAR_HEIGHT = 3;
const MAX_CHARS = 120;
const REDRAW_DEBOUNCE_MS = 120;

function lineKind(text) {
  if (/^\s*"(?:[^"\\]|\\.)*"\s*:\s*"/.test(text)) return 'str';
  if (/:\s*(?:-?\d|true\b|false\b|null\b)/.test(text) || /^\s*(?:-?\d|true\b|false\b|null\b)/.test(text)) return 'num';
  return 'key';
}

export function createMinimap({ view, container }) {
  const box = document.createElement('div');
  box.className = 'minimap';
  box.setAttribute('aria-hidden', 'true');
  const canvas = document.createElement('canvas');
  box.append(canvas);
  container.append(box);

  const scroller = view.scrollDOM;
  let timer = 0;
  let frame = 0;
  let dragging = false;

  function colors() {
    const style = getComputedStyle(box);
    const read = (name) => style.getPropertyValue(name).trim();
    return {
      key: read('--mini-key'), str: read('--mini-str'), num: read('--mini-num'),
      cursor: read('--accent'), view: read('--mini-view'), edge: read('--mini-view-edge'),
    };
  }

  function draw() {
    frame = 0;
    const width = box.clientWidth;
    const height = box.clientHeight;
    if (!width || !height) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const doc = view.state.doc;
    if (!doc.length) return;

    const palette = colors();
    const pad = 10;
    const usable = width - pad * 2;
    const rows = Math.max(1, Math.min(doc.lines, Math.floor((height - pad * 2) / ROW_STEP)));
    const cursorLine = doc.lineAt(view.state.selection.main.head).number;
    let cursorRow = -1;
    const bars = [];
    let widest = 24;
    for (let row = 0; row < rows; row += 1) {
      const first = Math.floor((row * doc.lines) / rows) + 1;
      const next = Math.floor(((row + 1) * doc.lines) / rows) + 1;
      if (cursorLine >= first && cursorLine < next) cursorRow = row;
      const line = doc.line(first);
      const text = line.length > 400 ? doc.sliceString(line.from, line.from + 400) : line.text;
      const indent = Math.min(text.length - text.trimStart().length, MAX_CHARS);
      const length = Math.min(text.trim().length, MAX_CHARS);
      if (!length) continue;
      widest = Math.max(widest, indent + length);
      bars.push({ row, indent, length, kind: lineKind(text) });
    }
    // Bars scale to the widest sampled line, so the shape fills the column.
    for (const { row, indent, length, kind } of bars) {
      const x = pad + (indent / widest) * usable;
      const w = Math.max(3, (length / widest) * usable);
      ctx.fillStyle = palette[kind];
      roundBar(ctx, x, pad + row * ROW_STEP, Math.min(w, pad + usable - x), BAR_HEIGHT);
    }
    if (cursorRow >= 0) {
      ctx.fillStyle = palette.cursor;
      roundBar(ctx, pad, pad + cursorRow * ROW_STEP, usable, BAR_HEIGHT);
    }

    // Visible region of the editor.
    const total = scroller.scrollHeight;
    if (total > scroller.clientHeight) {
      const top = (scroller.scrollTop / total) * height;
      const size = Math.max(16, (scroller.clientHeight / total) * height);
      ctx.fillStyle = palette.view;
      ctx.fillRect(0, top, width, size);
      ctx.fillStyle = palette.edge;
      ctx.fillRect(0, top, width, 1);
      ctx.fillRect(0, top + size - 1, width, 1);
    }
  }

  function roundBar(ctx, x, y, w, h) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, 1.5);
    else ctx.rect(x, y, w, h);
    ctx.fill();
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(draw);
  }

  function scheduleDebounced() {
    clearTimeout(timer);
    timer = setTimeout(schedule, REDRAW_DEBOUNCE_MS);
  }

  function scrollTo(clientY) {
    const rect = box.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    scroller.scrollTop = fraction * scroller.scrollHeight - scroller.clientHeight / 2;
  }

  box.addEventListener('pointerdown', (event) => {
    dragging = true;
    box.setPointerCapture?.(event.pointerId);
    scrollTo(event.clientY);
  });
  box.addEventListener('pointermove', (event) => { if (dragging) scrollTo(event.clientY); });
  const stop = () => { dragging = false; };
  box.addEventListener('pointerup', stop);
  box.addEventListener('pointercancel', stop);

  scroller.addEventListener('scroll', schedule, { passive: true });
  if (typeof ResizeObserver === 'function') new ResizeObserver(schedule).observe(box);
  // Theme switches change the palette.
  new MutationObserver(schedule).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  schedule();

  return {
    // Document edits and new payloads (debounced); cursor moves.
    refresh: scheduleDebounced,
    cursorMoved: schedule,
  };
}
