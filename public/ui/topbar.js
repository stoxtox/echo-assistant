// The top bar's "more" menu (hands-free, new chat, what happened, a report): a <details> that closes like a menu should,
// on a click anywhere else, on Esc, and once something in it was chosen.
import { $ } from './dom.js';

const menu = /** @type {HTMLDetailsElement | null} */ ($('moreMenu'));
if (menu) {
  const close = () => { menu.open = false; };
  document.addEventListener('click', (e) => { if (menu.open && !menu.contains(/** @type {Node} */ (e.target))) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !menu.open) return;
    close();
    menu.querySelector('summary')?.focus();
  });
  // A button in the menu does its job and the menu goes; the hands-free switch stays to be seen.
  menu.addEventListener('click', (e) => { if (/** @type {HTMLElement} */ (e.target).closest('button')) close(); });
}
