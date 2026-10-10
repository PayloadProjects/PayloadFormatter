import { MAX_HIGHLIGHT_CHARS, MAX_VISIBLE_CHARS, MAX_VISIBLE_SPANS, MAX_WRAP_HIGHLIGHT_CHARS, MAX_WRAP_LINES, MAX_WRAP_SPANS, TOKEN_CLASSES, lineAt } from './syntax-shared.js';

// The native textarea remains the only editable source of truth. This optional,
// aria-hidden mirror paints syntax colors beneath it: a line window in nowrap
// mode, or one wrapping block per source line in wrap mode.
export function createSyntaxEditor(editor) {
  const host = document.querySelector('#textEditor');
  const viewport = document.querySelector('#syntaxViewport');
  const mirror = document.querySelector('#syntaxMirror');
  const gutter = document.querySelector('#syntaxGutter');
  const active = document.querySelector('#syntaxActiveLine');
  const frame = document.querySelector('#editorFrame');
  if (!host || !viewport || !mirror || !gutter || !active) return { refresh() {} };
  let snapshot = '', mode = null, revision = 0, model = null;
  let wrapOn = document.documentElement.dataset.wrap === 'on';
  let worker = null, running = null, pending = null;
  let timer = 0, deadline = 0, paint = 0, composing = false, disposed = false;
  let wrapBuiltFor = -1;
  const visible = () => frame?.dataset.view !== 'tree';

  function plain(reason = 'pending') {
    host.classList.remove('has-syntax');
    host.dataset.syntaxState = reason;
    active.hidden = true;
  }
  function scheduleRender() {
    if (!paint && !disposed) paint = requestAnimationFrame(() => { paint = 0; render(); });
  }
  function fail() {
    clearTimeout(deadline);
    worker?.terminate(); worker = null; running = null; pending = null;
    plain('unavailable');
  }
  function send() {
    if (running || !pending || !visible() || composing || disposed) return;
    try {
      if (!worker) {
        const instance = new Worker(new URL('./syntax-worker.js?v=syntax-v1', import.meta.url), { type: 'module' });
        worker = instance;
        instance.addEventListener('message', ({ data }) => {
          if (worker !== instance || !running || data?.id !== running.id) return;
          const completed = running;
          clearTimeout(deadline); running = null;
          if (completed.id === revision) {
            if (data.ok && data.lines instanceof Uint32Array && data.spans instanceof Uint32Array) {
              model = { text: completed.text, lines: data.lines, spans: data.spans };
              scheduleRender();
            } else plain('unavailable');
          }
          send();
        });
        instance.addEventListener('error', () => { if (worker === instance) fail(); });
        instance.addEventListener('messageerror', () => { if (worker === instance) fail(); });
      }
      running = pending; pending = null;
      // Bad/malformed grammars must never hold up typing or formatting.
      deadline = setTimeout(fail, 2000);
      worker.postMessage(running);
    } catch (_) { fail(); }
  }
  function refresh(nextMode = mode) {
    if (disposed) return;
    const text = editor.value;
    const wrapNow = document.documentElement.dataset.wrap === 'on';
    const changed = text !== snapshot || nextMode !== mode || wrapNow !== wrapOn;
    if (!changed && model && !composing) { scheduleRender(); return; }
    if (changed) {
      snapshot = text; mode = nextMode; wrapOn = wrapNow; revision += 1; model = null;
      pending = null;
    }
    clearTimeout(timer);
    plain(text ? 'pending' : 'empty');
    if (!text) {
      mirror.replaceChildren(); gutter.replaceChildren();
      host.style.removeProperty('--wln-w');
      wrapBuiltFor = -1;
      return;
    }
    if (wrapOn && text.length > MAX_WRAP_HIGHLIGHT_CHARS) {
      // The wrap overlay renders the whole text (not a line window), so it
      // has its own budget: oversized payloads get the plain native editor.
      plain('wrap-size');
      mirror.replaceChildren(); gutter.replaceChildren();
      host.style.removeProperty('--gutter-width');
      host.style.removeProperty('--wln-w');
      wrapBuiltFor = -1;
      return;
    }
    if (text.length > MAX_HIGHLIGHT_CHARS) { plain('size-limit'); return; }
    if (composing || !visible()) return;
    // Only one active request and one replaceable pending snapshot.
    pending = { id: revision, text: snapshot, mode };
    timer = setTimeout(send, 35);
  }

  function render() {
    if (!model || composing || !visible() || disposed) return;
    if (document.documentElement.dataset.wrap === 'on') { renderWrapped(); return; }
    // Clear any wrap-mode inline sizing so the nowrap line window is exact.
    mirror.style.width = ''; mirror.style.left = ''; mirror.style.top = '';
    mirror.style.paddingTop = ''; mirror.style.paddingRight = ''; mirror.style.paddingBottom = '';
    host.style.removeProperty('--wln-w');
    const style = getComputedStyle(editor);
    const height = editor.clientHeight, width = editor.clientWidth;
    if (!height || !width) return;
    const lineHeight = parseFloat(style.lineHeight);
    const top = parseFloat(style.paddingTop);
    const first = Math.max(0, Math.floor((editor.scrollTop - top) / lineHeight) - 2);
    const last = Math.min(model.lines.length, first + Math.ceil(height / lineHeight) + 6);
    const start = model.lines[first] ?? 0;
    const end = last < model.lines.length ? model.lines[last] : model.text.length;
    // A minified megabyte-long line still uses the native editor until formatted.
    if (end - start > MAX_VISIBLE_CHARS) { plain('long-line'); return; }
    const spans = model.spans, count = spans.length / 3;
    let lo = 0, hi = count;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (spans[mid * 3 + 1] <= start) lo = mid + 1;
      else hi = mid;
    }
    const fragment = document.createDocumentFragment();
    let cursor = start, rendered = 0;
    for (let i = lo * 3; i < spans.length && spans[i] < end; i += 3) {
      if (++rendered > MAX_VISIBLE_SPANS) { plain('dense-line'); return; }
      const from = Math.max(start, spans[i]), to = Math.min(end, spans[i + 1]);
      if (from > cursor) fragment.append(document.createTextNode(model.text.slice(cursor, from)));
      const token = document.createElement('span');
      token.className = `syntax-${TOKEN_CLASSES[spans[i + 2]] || 'muted'}`;
      token.textContent = model.text.slice(from, to);
      fragment.append(token); cursor = to;
    }
    if (cursor < end) fragment.append(document.createTextNode(model.text.slice(cursor, end)));
    if (end === model.text.length && model.text.endsWith('\n')) fragment.append(document.createTextNode(' '));
    mirror.replaceChildren(fragment);
    const selectionLine = lineAt(model.lines, editor.selectionStart);
    const numbers = document.createDocumentFragment();
    for (let i = first; i < last; i++) {
      const number = document.createElement('div');
      number.textContent = String(i + 1);
      if (i === selectionLine) number.className = 'current-line';
      numbers.append(number);
    }
    gutter.replaceChildren(numbers);
    const offset = first * lineHeight - editor.scrollTop;
    const gutterWidth = Math.max(4, String(model.lines.length).length + 2);
    host.style.setProperty('--gutter-width', `${gutterWidth}ch`);
    viewport.style.width = `${editor.offsetLeft + width}px`; viewport.style.height = `${height}px`;
    mirror.style.transform = `translate(${-editor.scrollLeft}px, ${offset}px)`;
    gutter.style.transform = `translateY(${offset}px)`;
    active.style.top = `${top + selectionLine * lineHeight - editor.scrollTop}px`;
    active.style.height = `${lineHeight}px`;
    active.hidden = document.activeElement !== editor || editor.selectionStart !== editor.selectionEnd;
    host.classList.add('has-syntax'); host.dataset.syntaxState = 'ready';
  }

  // Wrap-mode highlighting: the mirror wraps exactly like the textarea
  // (same box, font, and wrap properties), so colors track wrapped text.
  // Unlike the nowrap line window, this renders the whole payload once per
  // revision and only repositions on scroll — hence the tighter budgets.
  function renderWrapped() {
    // Kill any stale nowrap gutter reservation; wrap mode reserves its own
    // number width via --wln-w instead.
    host.style.removeProperty('--gutter-width');
    const width = editor.clientWidth, height = editor.clientHeight;
    if (!width || !height) return;
    const style = getComputedStyle(editor);
    mirror.style.left = `${editor.offsetLeft}px`;
    mirror.style.top = '0px';
    mirror.style.width = `${width}px`;
    mirror.style.paddingTop = style.paddingTop;
    mirror.style.paddingRight = style.paddingRight;
    mirror.style.paddingBottom = style.paddingBottom;
    viewport.style.width = ''; viewport.style.height = '';
    if (wrapBuiltFor !== revision) {
      // Mark first so a budget breach does not rebuild on every scroll frame.
      wrapBuiltFor = revision;
      if (!buildWrapMirror()) {
        mirror.replaceChildren();
        host.style.removeProperty('--wln-w');
        return;
      }
    }
    mirror.style.transform = `translate(${-editor.scrollLeft}px, ${-editor.scrollTop}px)`;
    active.hidden = true;
    host.classList.add('has-syntax');
    host.dataset.syntaxState = 'ready';
  }

  // One block per source line: its line number plus token spans. The number
  // rides on the block's first wrapped row. Returns false when the payload
  // exceeds the wrap overlay's budgets (caller stands down to plain text).
  function buildWrapMirror() {
    const text = model.text, lines = model.lines, spans = model.spans;
    if (lines.length > MAX_WRAP_LINES) { plain('wrap-size'); return false; }
    const digits = String(lines.length).length;
    host.style.setProperty('--wln-w', `${Math.max(4, digits + 1)}ch`);
    const fragment = document.createDocumentFragment();
    const spanCount = spans.length / 3;
    let s = 0, built = 0;
    for (let li = 0; li < lines.length; li++) {
      const lineStart = lines[li];
      let lineEnd = li + 1 < lines.length ? lines[li + 1] : text.length;
      if (lineEnd > lineStart && text[lineEnd - 1] === '\n') lineEnd--;
      if (lineEnd > lineStart && text[lineEnd - 1] === '\r') lineEnd--;
      const div = document.createElement('div');
      div.className = 'syntax-wline';
      const number = document.createElement('span');
      number.className = 'syntax-wln';
      number.textContent = String(li + 1);
      number.setAttribute('aria-hidden', 'true');
      div.append(number);
      while (s < spanCount && spans[s * 3 + 1] <= lineStart) s++;
      let cursor = lineStart;
      for (let i = s; i < spanCount && spans[i * 3] < lineEnd; i++) {
        if (++built > MAX_WRAP_SPANS) { plain('wrap-size'); return false; }
        const from = Math.max(lineStart, spans[i * 3]);
        const to = Math.min(lineEnd, spans[i * 3 + 1]);
        if (from > cursor) div.append(document.createTextNode(text.slice(cursor, from)));
        const token = document.createElement('span');
        token.className = `syntax-${TOKEN_CLASSES[spans[i * 3 + 2]] || 'muted'}`;
        token.textContent = text.slice(from, to);
        div.append(token);
        cursor = to;
      }
      if (cursor < lineEnd) div.append(document.createTextNode(text.slice(cursor, lineEnd)));
      fragment.append(div);
    }
    mirror.replaceChildren(fragment);
    return true;
  }

  editor.addEventListener('scroll', scheduleRender, { passive: true });
  editor.addEventListener('select', scheduleRender);
  editor.addEventListener('keyup', scheduleRender);
  editor.addEventListener('pointerup', scheduleRender);
  editor.addEventListener('focus', scheduleRender);
  editor.addEventListener('blur', scheduleRender);
  editor.addEventListener('compositionstart', () => { composing = true; plain('composing'); });
  editor.addEventListener('compositionend', () => { composing = false; refresh(); });
  // Synchronous invalidation means native text is never hidden behind stale colors.
  editor.addEventListener('beforeinput', () => plain());
  const resize = new ResizeObserver(scheduleRender);
  resize.observe(editor);
  const view = new MutationObserver(() => { if (visible()) refresh(); });
  if (frame) view.observe(frame, { attributes: true, attributeFilter: ['data-view'] });
  addEventListener('pagehide', () => {
    clearTimeout(timer); clearTimeout(deadline);
    worker?.terminate(); worker = null; running = null; pending = null;
  });
  addEventListener('pageshow', () => refresh());
  return {
    refresh,
    destroy() {
      disposed = true; clearTimeout(timer); clearTimeout(deadline); cancelAnimationFrame(paint);
      worker?.terminate(); resize.disconnect(); view.disconnect(); plain('disabled');
    },
  };
}
