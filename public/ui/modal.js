// The one modal dialog (split out of public/app.js): a fixed title and buttons over a body that
// scrolls, Enter for the main action, Escape to dismiss unless it's locked.
import { $, el } from './dom.js';

const els = { modal: $('modal'), modalTitle: $('modalTitle'), modalBody: $('modalBody'), modalActions: $('modalActions') };

// Modals keep their title and buttons fixed and scroll only the body, so the buttons stay
// reachable in a small window. `onEnter` runs on Enter (except in a multi-line field).
let modalEnter = null;
let modalLocked = false; // Esc doesn't dismiss the unlock prompt; use Cancel
let modalKind = ''; // 'unlock' while the self-improve confirmation is showing
export function openModal(title, bodyNodes, actions, { narrow = false, onEnter = null, locked = false, hint = '', kind = '' } = {}) {
  modalKind = kind;
  els.modalTitle.textContent = title;
  els.modalBody.replaceChildren(...bodyNodes);
  els.modalActions.replaceChildren(...(hint ? [el('span', { className: 'key-hint' }, hint)] : []), ...actions);
  $('modalCard').classList.toggle('narrow', narrow);
  modalEnter = onEnter;
  modalLocked = locked;
  els.modal.hidden = false;
  els.modalBody.scrollTop = 0;
}
// Whoever asked to hear of it is told which dialog closed (a self-improve confirmation that's
// still waiting comes back once another dialog closes: public/ui/selfimprove.js).
export function closeModal() {
  const was = modalKind;
  els.modal.hidden = true;
  modalEnter = null;
  modalLocked = false;
  modalKind = '';
  for (const fn of closedHooks) fn(was);
}
els.modal.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !modalEnter || e.isComposing || /** @type {HTMLElement} */ (e.target).tagName === 'TEXTAREA') return;
  if (/** @type {HTMLElement} */ (e.target).tagName === 'BUTTON') return; // let the focused button act
  e.preventDefault();
  modalEnter();
});
// Esc closes the dialog on top and nothing else: not Settings beneath it, not Echo's reply.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || els.modal.hidden || modalLocked) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  closeModal();
});

/** @type {Array<(was: string) => void>} */
const closedHooks = [];
/** Call `fn(kind)` whenever a dialog closes. */
export const onModalClosed = (fn) => void closedHooks.push(fn);
/** The kind of dialog showing ('unlock', 'reset', …), or '' when none is. */
export const modalShowing = () => (els.modal.hidden ? '' : modalKind || 'other');
