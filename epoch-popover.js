// Epoch converter popover: DOM wiring around the pure epoch-converter.js
// logic. Owns the header button, the popover panel, live conversion,
// and per-row copy buttons.
import {
  EPOCH_UNITS,
  detectUnit,
  convertTimestamp,
  dateToUnitStrings,
} from './epoch-converter.js';

async function copyText(text, button) {
  const done = (ok) => {
    if (!button) return;
    const original = button.dataset.label || 'Copy';
    button.textContent = ok ? 'Copied' : 'Failed';
    button.disabled = true;
    setTimeout(() => {
      button.textContent = original;
      button.disabled = false;
    }, 1200);
  };
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      done(true);
      return;
    }
    throw new Error('no clipboard api');
  } catch (_) {
    // Fallback for blocked clipboard access: manual selection.
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      done(ok);
    } catch (_) {
      done(false);
    }
  }
}

export function initEpochPopover() {
  const button = document.querySelector('#epochBtn');
  const popover = document.querySelector('#epochPopover');
  if (!button || !popover) return;

  const tabToDate = popover.querySelector('#epochTabToDate');
  const tabToEpoch = popover.querySelector('#epochTabToEpoch');
  const paneToDate = popover.querySelector('#epochPaneToDate');
  const paneToEpoch = popover.querySelector('#epochPaneToEpoch');
  const input = popover.querySelector('#epochInput');
  const unitSelect = popover.querySelector('#epochUnitSelect');
  const nowBtn = popover.querySelector('#epochNowBtn');
  const liveBtn = popover.querySelector('#epochLiveBtn');
  const detected = popover.querySelector('#epochDetected');
  const error = popover.querySelector('#epochError');
  const dateInput = popover.querySelector('#epochDateInput');
  const targetUnit = popover.querySelector('#epochTargetUnit');
  const dateOutput = popover.querySelector('#epochDateOutput');

  // Every row that convert() can fill; cleared together on empty input or error.
  const OUTPUT_ROWS = ['utc', 'local', 'relative', 'unit-s', 'unit-ms', 'unit-us', 'unit-ns'];

  // Live mode: re-timestamps the input every second until the user types,
  // switches tab, or closes the popover.
  let liveTimer = null;
  const currentUnit = () =>
    unitSelect.value === 'auto' ? detectUnit(String(Date.now())) || 'ms' : unitSelect.value;
  const tickLive = () => {
    input.value = dateToUnitStrings(new Date(), currentUnit());
    convert();
  };
  const paintLive = () => {
    const on = liveTimer !== null;
    liveBtn.classList.toggle('is-active', on);
    liveBtn.setAttribute('aria-pressed', String(on));
  };
  const setLive = (on) => {
    if (on && !liveTimer) {
      tickLive();
      liveTimer = setInterval(tickLive, 1000);
    } else if (!on && liveTimer) {
      clearInterval(liveTimer);
      liveTimer = null;
    }
    paintLive();
  };

  const showError = (message) => {
    error.textContent = message || '';
    error.hidden = !message;
  };

  const setRow = (name, value) => {
    const valueEl = popover.querySelector(`[data-epoch-value="${name}"]`);
    const copyBtn = popover.querySelector(`[data-epoch-copy="${name}"]`);
    if (valueEl) valueEl.textContent = value;
    if (copyBtn) {
      copyBtn.disabled = !value;
      if (!value) copyBtn.textContent = copyBtn.dataset.label || 'Copy';
      copyBtn.onclick = value ? () => copyText(value, copyBtn) : null;
    }
  };

  const renderUnits = (units) => {
    setRow('unit-s', units.s);
    setRow('unit-ms', units.ms);
    setRow('unit-us', units.us);
    setRow('unit-ns', units.ns);
  };

  const convert = () => {
    const raw = input.value;
    if (!raw.trim()) {
      showError('');
      for (const name of OUTPUT_ROWS) setRow(name, '');
      detected.textContent = '';
      return;
    }
    const auto = detectUnit(raw);
    const unit = unitSelect.value === 'auto' ? auto : unitSelect.value;
    detected.textContent = unit
      ? `Detected: ${EPOCH_UNITS[unit].label.toLowerCase()}${unitSelect.value === 'auto' ? ' (auto)' : ''}`
      : '';
    if (!unit) {
      showError('Enter a numeric timestamp.');
      for (const name of OUTPUT_ROWS) setRow(name, '');
      return;
    }
    const result = convertTimestamp(raw, unit);
    if (result.error) {
      showError(result.error);
      for (const name of OUTPUT_ROWS) setRow(name, '');
      return;
    }
    showError('');
    setRow('utc', result.utc);
    setRow('local', result.local);
    setRow('relative', result.relative);
    renderUnits(result.units);
  };

  const convertDate = () => {
    const value = dateInput.value;
    if (!value) {
      setRow('epoch', '');
      return;
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      setRow('epoch', '');
      return;
    }
    setRow('epoch', dateToUnitStrings(date, targetUnit.value));
  };

  const selectTab = (toDate) => {
    if (!toDate) setLive(false);
    tabToDate.setAttribute('aria-selected', String(toDate));
    tabToEpoch.setAttribute('aria-selected', String(!toDate));
    tabToDate.classList.toggle('is-active', toDate);
    tabToEpoch.classList.toggle('is-active', !toDate);
    paneToDate.hidden = !toDate;
    paneToEpoch.hidden = toDate;
  };

  const close = (refocus = true) => {
    if (popover.hidden) return;
    setLive(false);
    popover.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    if (refocus) button.focus();
  };

  const onOutside = (event) => {
    if (!popover.contains(event.target) && !button.contains(event.target)) close(false);
  };

  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close(true);
    }
  };

  const open = () => {
    popover.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    input.focus();
    convert();
  };

  button.addEventListener('click', () => {
    if (popover.hidden) open();
    else close(false);
  });
  tabToDate.addEventListener('click', () => selectTab(true));
  tabToEpoch.addEventListener('click', () => selectTab(false));
  input.addEventListener('input', () => {
    // Typing by hand takes over from live mode; programmatic ticks don't
    // fire input events, so this only triggers on real keystrokes/pastes.
    setLive(false);
    convert();
  });
  input.addEventListener('focus', () => {
    // Clicking/tabbing into the box means copy or edit: freeze live mode so
    // the value stops changing under the cursor, keeping the last tick as a
    // snapshot. pointerdown covers clicks when the input is already focused
    // (focus would not re-fire); focus covers keyboard tabbing.
    setLive(false);
  });
  input.addEventListener('pointerdown', () => setLive(false));
  unitSelect.addEventListener('change', () => {
    if (liveTimer) tickLive();
    else convert();
  });
  dateInput.addEventListener('input', convertDate);
  targetUnit.addEventListener('change', convertDate);
  nowBtn.addEventListener('click', () => {
    setLive(false);
    input.value = dateToUnitStrings(new Date(), currentUnit());
    convert();
    input.focus();
  });
  liveBtn.addEventListener('click', () => setLive(liveTimer === null));

  selectTab(true);
}
