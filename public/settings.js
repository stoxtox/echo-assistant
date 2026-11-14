// The settings view's shell: the section list, the focus trap and Esc. It opens under the
// top bar, over Talk or Workers, and choosing either of those in the top bar closes it. The controls
// themselves are wired in app.js (they save through POST /api/settings as before).
//
//   const panel = createSettingsPanel({ root: $('settings'), blocked: () => !els.modal.hidden });
//   panel.open('voice');   // or panel.open() for the last section (listening, voice, companion, mac, you)
//   panel.close();

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
/** @param {Element} n */
const visible = (n) => n instanceof HTMLElement && !n.closest('[hidden]') && n.getClientRects().length > 0 && !(/** @type {any} */ (n).disabled);

/**
 * @param {{ root: HTMLElement, blocked?: () => boolean, onOpen?: () => void, onClose?: () => void, onSection?: (id: string) => void }} opts
 *   blocked: another dialog sits on top (then Esc and Tab belong to it)
 */
export function createSettingsPanel({ root, blocked = () => false, onOpen, onClose, onSection }) {
  const $ = (sel) => /** @type {HTMLElement} */ (root.querySelector(sel));
  const card = $('.settings');
  const heading = $('#settingsHeading');
  const body = $('#settingsBody');
  const tabs = /** @type {HTMLElement[]} */ ([...root.querySelectorAll('.set-tab')]);
  const sections = /** @type {HTMLElement[]} */ ([...root.querySelectorAll('.set-section')]);
  let current = sections[0]?.dataset.section || '';
  /** @type {HTMLElement | null} */
  let returnTo = null;

  /** Sliders fill up to the thumb (style.css reads --fill). */
  const fill = (/** @type {HTMLInputElement} */ r) => {
    const min = Number(r.min) || 0;
    const max = Number(r.max) || 100;
    r.style.setProperty('--fill', `${((Number(r.value) - min) / (max - min || 1)) * 100}%`);
  };
  const refresh = () => root.querySelectorAll('input[type=range]').forEach((r) => fill(/** @type {HTMLInputElement} */ (r)));
  root.addEventListener('input', (e) => { if (/** @type {HTMLInputElement} */ (e.target).type === 'range') fill(/** @type {HTMLInputElement} */ (e.target)); });

  function show(id, { focusTab = false } = {}) {
    if (!sections.some((s) => s.dataset.section === id)) id = sections[0].dataset.section;
    current = id;
    for (const t of tabs) {
      const on = t.dataset.section === id;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      if (on && focusTab) t.focus();
    }
    for (const s of sections) s.classList.toggle('on', s.dataset.section === id);
    heading.textContent = sections.find((s) => s.dataset.section === id)?.dataset.title || '';
    body.scrollTop = 0;
    onSection?.(id);
  }

  function open(id = current) {
    const wasOpen = !root.hidden;
    if (!wasOpen) returnTo = /** @type {HTMLElement | null} */ (document.activeElement);
    root.hidden = false;
    document.body.classList.add('settings-open');
    show(id);
    refresh();
    if (!wasOpen) {
      onOpen?.();
      // The selected section's tab: arrows move between sections, Tab goes into the settings.
      requestAnimationFrame(() => tabs.find((t) => t.dataset.section === current)?.focus());
    }
  }

  function close() {
    if (root.hidden) return;
    root.hidden = true;
    document.body.classList.remove('settings-open');
    onClose?.();
    if (returnTo?.isConnected) returnTo.focus();
    returnTo = null;
  }

  for (const t of tabs) {
    t.addEventListener('click', () => show(t.dataset.section || ''));
  }
  // Up/Down (and Home/End) move between sections, like a list.
  $('#settingsNav').addEventListener('keydown', (e) => {
    const i = tabs.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    if (i < 0) return;
    const next = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const t = tabs[(next + tabs.length) % tabs.length];
    show(t.dataset.section || '', { focusTab: true });
  });
  // A click on the dimmed backdrop closes; clicks inside the card don't.
  root.addEventListener('mousedown', (e) => { if (e.target === root) close(); });
  $('#closeSettings').addEventListener('click', close);
  // Talk and Workers in the top bar are places too: going to one leaves Settings.
  document.addEventListener('click', (e) => { if (!root.hidden && /** @type {HTMLElement} */ (e.target).closest?.('.segnav .tab')) close(); });

  // Esc closes; Tab stays inside.
  document.addEventListener('keydown', (e) => {
    if (root.hidden || blocked()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    } else if (e.key === 'Tab') {
      const items = [...card.querySelectorAll(FOCUSABLE)].filter(visible);
      if (!items.length) return;
      const first = /** @type {HTMLElement} */ (items[0]);
      const last = /** @type {HTMLElement} */ (items[items.length - 1]);
      const inside = card.contains(document.activeElement);
      if (!inside || (e.shiftKey && document.activeElement === first)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }, true);
  // Focus that wanders out (a click on the page behind, say) comes back in.
  document.addEventListener('focusin', (e) => {
    if (root.hidden || blocked()) return;
    if (!root.contains(/** @type {Node} */ (e.target))) tabs.find((t) => t.dataset.section === current)?.focus();
  });

  show(current);
  return {
    open,
    close,
    isOpen: () => !root.hidden,
    section: () => current,
    refresh,
  };
}
