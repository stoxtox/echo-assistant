// What happened (the "more" menu in the top bar): the recent turns, newest first, each with how long until Echo's first
// sound, where the time went and a "slow" mark; a click opens the turn's events in plain English.
// The rows come from GET /api/timeline (lib/timelineview.ts): timings and names only, never what
// was said or what was on screen. In the chat, each of Echo's replies gets a quiet "…" on hover
// that opens its turn here. The view's markup is #happenedView (public/index.html); app.js shows it in the dialog.
import { $, el, toast } from './dom.js';

const WHO = { app: 'Mac app', page: 'Window', server: 'Echo' };
const EMPTY = { '10m': 'Nothing in the last 10 minutes.', '1h': 'Nothing in the last hour.', today: 'Nothing yet today.' };

/** A line's time counted from the turn's start: "−2.4 s", "+0.3 s". */
export function offset(ms) {
  const n = Number(ms) || 0;
  return `${n < 0 ? '−' : '+'}${(Math.abs(n) / 1000).toFixed(1)} s`;
}

/** What a turn's mark says: something went wrong, it was slow, or nothing. */
export const flagOf = (t) => (t.problem ? 'Went wrong' : t.slow ? 'Slow' : '');

/** The turns to list: all of them, or only the slow ones (and those where something went wrong). */
export const shownTurns = (turns, onlySlow) => (onlySlow ? turns.filter((t) => t.slow || t.problem) : turns);

/** One turn as text for Copy: its heading, where the time went, then a line per event. */
export function turnText(t) {
  const head = [`Turn at ${t.time}`, t.firstSound, flagOf(t).toLowerCase()].filter(Boolean).join(' · ');
  const lines = t.lines.map((l) => (l.src ? `${l.time}  ${l.src.padEnd(8)}${l.text}${l.mark ? `  (${l.mark})` : ''}` : `${' '.repeat(14)}${'·'.padEnd(8)}${l.text}`));
  return [head, `Where the time went: ${t.summary}${t.total ? ` (turn ${t.total})` : ''}`, `Turn id: ${t.trace}`, '', ...lines].join('\n');
}

/** Put text on the clipboard (the Mac app's web view included). */
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const box = el('textarea', { value: text });
    box.style.cssText = 'position:fixed;opacity:0';
    document.body.append(box);
    box.select();
    document.execCommand('copy');
    box.remove();
  }
}

/** Mark one of Echo's reply bubbles with its turn, so the "…" beside it can open that turn. */
export function tagTurn(bubble, trace) {
  if (bubble && trace) bubble.dataset.trace = trace;
}

/**
 * @param {{ open: () => void }} o open: put the view on screen
 */
export function createTimelineView({ open }) {
  const list = $('tlList');
  const range = $('tlRange');
  const slowBtn = $('tlSlow');
  const transcript = $('transcript');
  /** since: the range chosen; only: one turn asked for from the chat (then no range is chosen); opened: the turn showing its rows */
  const state = { since: '10m', onlySlow: false, only: '', opened: '', turns: /** @type {any[]} */ ([]) };
  let asked = 0;

  function turnNode(t) {
    const isOpen = state.opened === t.trace;
    const flag = flagOf(t);
    const row = el('button', { type: 'button', className: `tl-turn${flag ? ' flagged' : ''}` });
    row.setAttribute('aria-expanded', String(isOpen));
    const text = el('span', { className: 'tl-main' });
    text.append(el('span', { className: 'tl-sound' }, t.firstSound), el('span', { className: 'tl-sum' }, `${t.summary}${t.total ? ` · turn ${t.total}` : ''}`));
    row.append(el('span', { className: 'tl-time' }, t.time), text);
    if (flag) row.append(el('span', { className: 'tl-flag' }, flag));
    row.append(el('span', { className: 'tl-chev' }));
    row.onclick = () => {
      state.opened = isOpen ? '' : t.trace;
      render();
    };
    const item = el('div', { className: 'tl-item' });
    item.append(row);
    if (!isOpen) return item;
    const rows = el('div', { className: 'tl-rows' });
    for (const l of t.lines) {
      const line = el('div', { className: `tl-line${l.src ? '' : ' gap'}${l.mark ? ' marked' : ''}` });
      line.append(
        el('span', { className: 'tl-at' }, l.src ? offset(l.ms) : ''),
        el('span', { className: 'tl-who' }, WHO[l.src] || ''),
        el('span', { className: 'tl-what' }, l.text),
        el('span', { className: 'tl-mark' }, l.mark === 'problem' ? 'went wrong' : l.mark),
      );
      rows.append(line);
    }
    const foot = el('div', { className: 'tl-foot' });
    const copyBtn = el('button', { type: 'button', className: 'ghost small' }, 'Copy');
    copyBtn.onclick = async () => {
      await copy(turnText(t));
      toast('Copied this turn.');
    };
    foot.append(el('span', { className: 'tl-foot-note' }, 'Times are counted from when the turn started.'), copyBtn);
    item.append(rows, foot);
    return item;
  }

  function render() {
    for (const c of range.querySelectorAll('.chip')) {
      const on = !state.only && /** @type {HTMLElement} */ (c).dataset.since === state.since;
      c.classList.toggle('on', on);
      c.setAttribute('aria-pressed', String(on));
    }
    slowBtn.classList.toggle('on', state.onlySlow);
    slowBtn.setAttribute('aria-pressed', String(state.onlySlow));
    const turns = state.only ? state.turns : shownTurns(state.turns, state.onlySlow);
    if (turns.length) return list.replaceChildren(...turns.map(turnNode));
    const none = state.only ? 'Nothing was kept for that reply.' : state.onlySlow && state.turns.length ? 'Nothing slow here.' : EMPTY[state.since];
    list.replaceChildren(el('p', { className: 'tl-empty' }, none));
  }

  async function load() {
    const mine = ++asked;
    const query = state.only ? `turn=${encodeURIComponent(state.only)}` : `since=${state.since}`;
    let turns = [];
    try {
      turns = (await (await fetch(`/api/timeline?${query}`)).json()).turns || [];
    } catch {}
    // A slower, older answer never replaces a newer one.
    if (mine !== asked) return;
    state.turns = turns;
    if (state.only) state.opened = turns[0]?.trace || '';
    render();
  }

  range.addEventListener('click', (e) => {
    const chip = /** @type {HTMLElement} */ (e.target).closest('.chip');
    if (!chip) return;
    state.since = /** @type {HTMLElement} */ (chip).dataset.since || '10m';
    state.only = '';
    load();
  });
  slowBtn.addEventListener('click', () => {
    state.onlySlow = !state.onlySlow;
    // Asking for the slow ones leaves the single turn opened from the chat.
    if (state.only) { state.only = ''; load(); } else render();
  });

  // The chat's "…": one small button, moved beside whichever of Echo's replies the pointer is on
  // (a reply's own contents are rewritten as it is spoken, so the button can't live inside it).
  const more = el('button', { type: 'button', className: 'msg-more', hidden: true }, '…');
  more.setAttribute('aria-label', 'What happened in this turn');
  more.title = 'What happened';
  transcript.append(more);
  transcript.addEventListener('mouseover', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (target === more) return;
    const bubble = /** @type {HTMLElement | null} */ (target.closest('.msg.ai[data-trace]'));
    more.hidden = !bubble;
    if (!bubble) return;
    more.dataset.trace = bubble.dataset.trace;
    more.style.top = `${bubble.offsetTop}px`;
    more.style.left = `${bubble.offsetLeft + bubble.offsetWidth + 6}px`;
  });
  transcript.addEventListener('mouseleave', () => (more.hidden = true));
  /** Put the view on screen and read the timeline again: one turn (from the chat's "…"), or the range last chosen. */
  function show(trace = '') {
    state.only = trace;
    open();
    load();
  }
  more.onclick = () => show(more.dataset.trace || '');

  return { show };
}
