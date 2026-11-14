// The activity strip: one line above the composer that says what Echo is doing right now, how far
// along it is, and Stop. It stands in for the old "→ tool" rows in the chat, the "Driving" chip
// and the guide's step pill, so only one thing ever says "working".
//
// The strip's mark and status words are the hero's own (public/index.html #hero); this module
// only fills the three parts that belong to work in progress: the words, the line, and Stop.
import { $ } from './dom.js';
import { send } from './socket.js';

/** A finished guide's last words ("All steps shown") stay this long. */
const DONE_MS = 2500;
/** The guide's line goes after this long with no update (each step waits 60 s for the user). */
const STALE_MS = 75_000;

/**
 * What the strip shows.
 * @param {{ activity?: string, driving?: boolean, app?: string, steps?: number, guide?: { step: number, total: number, say?: string, finished?: boolean, done?: boolean } | null }} s
 * @returns {{ text: string, progress: number | null, stop: boolean }} progress: 0..1 when the
 *   number of steps is known, null when it isn't (the line then just moves)
 */
export function stripLine({ activity = '', driving = false, app = '', steps = 0, guide = null } = {}) {
  if (guide && guide.finished) return { text: guide.done ? 'All steps shown' : `Stopped at step ${guide.step} of ${guide.total}`, progress: guide.done ? 1 : null, stop: false };
  if (guide && guide.total > 0) {
    const where = `step ${guide.step} of ${guide.total}`;
    const text = app ? `${app} · ${where}` : guide.say ? `Step ${guide.step} of ${guide.total} · ${guide.say}` : `Step ${guide.step} of ${guide.total}`;
    return { text, progress: Math.max(0, Math.min(1, guide.step / guide.total)), stop: true };
  }
  // Driving has no known last step (only a cap), so it never pretends to a fraction.
  if (driving) return { text: `${app || 'Working on your Mac'}${steps ? ` · step ${steps}` : ''}`, progress: null, stop: true };
  return { text: String(activity || ''), progress: null, stop: false };
}

/** @type {{ activity: string, driving: boolean, app: string, steps: number, guide: any }} */
const now = { activity: '', driving: false, app: '', steps: 0, guide: null };
/** @type {any} */
let guideTimer = 0;

function render() {
  const text = $('actText'), prog = $('actProg'), stop = $('actStop');
  if (!text || !prog || !stop) return;
  const line = stripLine(now);
  text.textContent = line.text;
  text.title = line.text;
  prog.hidden = !(line.stop || line.progress !== null);
  prog.classList.toggle('moving', line.progress === null);
  /** @type {HTMLElement} */ (prog.firstElementChild).style.width = line.progress === null ? '' : `${Math.round(line.progress * 100)}%`;
  stop.hidden = !line.stop;
  stop.onclick = () => {
    send({ type: 'computer_stop' });
    // Stop always works on screen, even if the Mac app or the server is slow to answer.
    now.guide = null;
    now.driving = false;
    render();
  };
}

export const activity = {
  /** What a tool is doing ("Reading notes"); empty when the turn is over. @param {string} text */
  say(text) { now.activity = String(text || ''); render(); },
  /** The server's run state: { driving, steps, app? }. @param {{ driving?: boolean, steps?: number, app?: string }} st */
  driving(st) {
    now.driving = Boolean(st?.driving);
    now.steps = Number(st?.steps) || 0;
    if (st?.app !== undefined) now.app = String(st.app || '');
    if (!now.driving) now.steps = 0;
    render();
  },
  /** Guide mode: { step, total, say?, finished?, done? }. */
  guide(g) {
    clearTimeout(guideTimer);
    now.guide = g || null;
    const clear = () => { now.guide = null; render(); };
    if (g) guideTimer = setTimeout(clear, g.finished ? DONE_MS : STALE_MS);
    render();
  },
};
