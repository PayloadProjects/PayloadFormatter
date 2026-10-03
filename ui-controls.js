// Presentation only. No parsing, payload access, clipboard access, or persistence.
const action = document.querySelector('#pasteFormatBtn');
const label = action?.querySelector('.button-label');
if (action && label) {
  const idleLabel = label.textContent;
  const syncBusy = () => {
    const busy = document.body.classList.contains('busy');
    label.textContent = busy ? 'Working\u2026' : idleLabel;
    action.setAttribute('aria-busy', String(busy));
  };
  // Observe only the existing busy class, never the potentially large editor or tree DOM.
  new MutationObserver(syncBusy).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  syncBusy();
}
