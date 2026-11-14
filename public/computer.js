// Computer use in the page (lib/computer.js has the safety rules).
//
// - One small "Driving" status chip at the top of the window, with a Stop button, while Echo uses
//   the computer (the Mac app also draws a thin glowing line around the screen). It stands in for
//   the "Looking at your screen" chip too, so only one state shows at a time.
// - A confirmation card for each risky action (send, pay, delete, submit, sign in, settings):
//   Allow once / Cancel. Nothing happens until one is clicked or the user says yes out loud.
// (A lesson's step, "Step 2 of 3 · Click Wi-Fi", is the activity strip's: public/ui/activity.js.)
import { toApp } from '/screen.js';

/**
 * @param {{ addNode: (node: HTMLElement) => void, send: (msg: object) => void }} deps
 */
export function createComputerClient({ addNode, send }) {
  let banner = null;
  /** @type {Map<string, { card: HTMLElement, left: HTMLElement, buttons: HTMLButtonElement[], timer: any }>} */
  const cards = new Map();

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  };

  function ensureBanner() {
    if (banner) return banner;
    banner = el('div', 'drive-banner');
    banner.setAttribute('role', 'status');
    const dot = el('i');
    dot.setAttribute('aria-hidden', 'true');
    const label = el('span', '', 'Driving');
    const stop = el('button', 'small', 'Stop');
    stop.type = 'button';
    stop.onclick = () => send({ type: 'computer_stop' });
    banner.append(dot, label, stop);
    document.body.append(banner);
    return banner;
  }

  /** The server's run state: { driving, runId, steps, maxSteps, aborted?, reason? }. */
  function state(st) {
    const b = ensureBanner();
    b.classList.toggle('on', Boolean(st.driving));
    const label = /** @type {HTMLElement} */ (b.querySelector('span'));
    label.textContent = st.driving && st.steps ? `Driving · step ${st.steps}` : 'Driving';
    // The full sentence for VoiceOver and on hover; the chip itself stays short.
    const full = `Echo is driving${st.driving && st.steps ? `, step ${st.steps} of up to ${st.maxSteps}` : ''}. Press Esc or move the mouse to take over.`;
    b.setAttribute('aria-label', full);
    b.title = full;
    // The app hides its border (and, after a stop, refuses the rest of that run).
    if (!st.driving) toApp({ type: 'computerStop', abort: Boolean(st.aborted) });
  }

  /** A risky action waiting for the user: { id, what, why, category, app, expiresAt, payload? }. */
  function confirm(r) {
    if (cards.has(r.id)) return;
    const card = el('div', 'msg confirm-card computer-confirm');
    const p = r.payload;
    // The card shows what would actually go out (recipient, subject, first line), not a label.
    const head = el('div', 'confirm-head', p?.to ? `${p.kind === 'email' ? 'Send email' : 'Send'} to ${p.to}` : 'Echo wants to act on your screen');
    const body = p ? payloadView(p) : el('div', 'confirm-text', `${cap(r.what)}.`);
    const why = el('p', 'muted', `This would ${r.why}. Nothing happens unless you allow it.`);
    const foot = el('div', 'confirm-actions');
    const left = el('span', 'muted confirm-left');
    const no = /** @type {HTMLButtonElement} */ (el('button', 'ghost small', 'Cancel'));
    const yes = /** @type {HTMLButtonElement} */ (el('button', 'small', 'Allow once'));
    no.type = yes.type = 'button';
    const answer = (allow) => {
      if (no.disabled) return;
      no.disabled = yes.disabled = true;
      send({ type: 'computer_confirm', id: r.id, allow });
    };
    no.onclick = () => answer(false);
    yes.onclick = () => answer(true);
    foot.append(left, no, yes);
    card.append(head, body, why, foot);
    addNode(card);
    const tick = () => {
      const s = Math.max(0, Math.round((Date.parse(r.expiresAt) - Date.now()) / 1000));
      left.textContent = s ? `Expires in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : 'Expired';
    };
    tick();
    cards.set(r.id, { card, left, buttons: [no, yes], answer, what: p?.to ? `Send to ${p.to}${p.subject ? ` · “${p.subject}”` : ''}` : r.what, timer: setInterval(tick, 1000) });
  }

  /** Subject, the first line of the body, and an attachment's name: the payload, at a glance. */
  function payloadView(p) {
    const box = el('div', 'confirm-payload');
    const row = (label, value) => {
      if (!value) return;
      const line = el('div', 'payload-row');
      line.append(el('span', 'payload-label', label), el('span', 'payload-value', value));
      box.append(line);
    };
    row('Subject', p.subject);
    row('Message', String(p.body || '').split('\n').find((l) => l.trim()) || '');
    row('Attached', p.attachment);
    if (!box.childElementCount) box.append(el('div', 'confirm-text', 'Nothing else in it.'));
    return box;
  }

  /** The newest question still waiting, for the Mac app's caption pill: "Click “Send” in Mail?". */
  function question() {
    const last = [...cards.values()].at(-1);
    return last ? `${cap(last.what)}?` : '';
  }

  /** Yes or No from the caption pill: answers the newest waiting question, like its card's buttons. */
  function answerLatest(allow) {
    const last = [...cards.values()].at(-1);
    if (!last) return false;
    last.answer(Boolean(allow));
    return true;
  }

  /** Answered (here, by voice) or expired: { id, allowed, by }. */
  function resolved(r) {
    const c = cards.get(r.id);
    if (!c) return;
    clearInterval(c.timer);
    c.buttons.forEach((b) => (b.disabled = true));
    c.card.classList.add(r.allowed ? 'is-sent' : 'is-cancelled');
    c.left.textContent = r.allowed ? `Allowed${r.by === 'voice' ? ' by voice' : ''}` : r.by === 'expired' ? 'Expired, not done' : 'Cancelled, not done';
    cards.delete(r.id);
  }

  return { state, confirm, resolved, question, answerLatest };
}

const cap = (s) => String(s || '').replace(/^./, (c) => c.toUpperCase());
