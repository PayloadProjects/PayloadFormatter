// Presentation only. No parsing, payload access, clipboard access, or persistence.
const action = document.querySelector('#pasteFormatBtn');
const label = action?.querySelector('.button-label');
if (action && label) {
  // Keep the label's own nodes: narrow layouts hide part of it with CSS.
  const idleLabel = [...label.childNodes];
  const syncBusy = () => {
    const busy = document.body.classList.contains('busy');
    if (busy) label.textContent = 'Working\u2026';
    else label.replaceChildren(...idleLabel);
    action.setAttribute('aria-busy', String(busy));
  };
  // Observe only the existing busy class, never the potentially large editor or tree DOM.
  new MutationObserver(syncBusy).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  syncBusy();
}
