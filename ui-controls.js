// Presentation only. No parsing, payload access, clipboard access, or persistence.
// Disclosure pattern: https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/
const toggle = document.querySelector('#treeMoreBtn');
const menu = document.querySelector('#treeMenu');
const options = document.querySelector('.tree-options');

function closeMenu(restoreFocus = false) {
  if (!menu || !toggle) return;
  menu.hidden = true;
  toggle.setAttribute('aria-expanded', 'false');
  if (restoreFocus) toggle.focus();
}

if (toggle && menu && options) {
  toggle.addEventListener('click', () => {
    const opening = menu.hidden;
    menu.hidden = !opening;
    toggle.setAttribute('aria-expanded', String(opening));
  });
  options.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
    }
  });
  options.addEventListener('focusout', (event) => {
    if (!options.contains(event.relatedTarget)) closeMenu();
  });
  menu.addEventListener('click', (event) => {
    const action = event.target.closest('button');
    if (action && !action.disabled) closeMenu(true);
  });
  document.addEventListener('pointerdown', (event) => {
    if (!options.contains(event.target)) closeMenu();
  });
  for (const id of ['viewTextBtn', 'viewTreeBtn']) {
    document.getElementById(id)?.addEventListener('click', () => closeMenu());
  }
}

const action = document.querySelector('#pasteFormatBtn');
const label = action?.querySelector('.button-label');
if (action && label) {
  const idleLabel = label.textContent;
  const syncBusy = () => {
    const busy = document.body.classList.contains('busy');
    label.textContent = busy ? 'Working\u2026' : idleLabel;
    action.setAttribute('aria-busy', String(busy));
    if (busy) closeMenu();
  };
  // Observe only the existing busy class, never the potentially large editor or tree DOM.
  new MutationObserver(syncBusy).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  syncBusy();
}
