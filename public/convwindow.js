// The conversation window (ECHO_CORE_PLAN.md §7), shared by the server (lib/session.ts decides
// with it) and the page (shows it: the ring, the countdown, the chimes), so what you see is what
// Echo does. Pure, no DOM.
//
// Open while Echo works for you; for 8 s after it finishes speaking, 15 s if it asked you
// something; in Talk mode until 30 s pass with nothing said to Echo (30 minutes at most).
// "Thanks" / "that's all" closes it until push-to-talk or "Hey Echo".

export const FOLLOW_MS = 8_000;
export const FOLLOW_QUESTION_MS = 15_000;
export const TALK_IDLE_MS = 30_000;
export const TALK_MAX_MS = 30 * 60_000;

/**
 * @typedef {{ since: number, lastAt: number } | null} Talk
 * @typedef {{ open: boolean, why: 'working' | 'question' | 'follow' | 'talk' | 'closed', leftMs: number, totalMs: number }} WindowState
 */

/**
 * Is the window open, why, and how long it has left (leftMs of totalMs; 0 when it doesn't run out).
 * @param {{ working?: boolean, sinceReplyMs?: number, asked?: boolean, talk?: Talk, closed?: boolean, now?: number }} s
 * @returns {WindowState}
 */
export function windowState({ working = false, sinceReplyMs, asked = false, talk = null, closed = false, now = Date.now() }) {
  if (working) return { open: true, why: 'working', leftMs: 0, totalMs: 0 };
  if (closed) return { open: false, why: 'closed', leftMs: 0, totalMs: 0 };
  // Talk mode first: its window is the longer one.
  if (talk && now - talk.lastAt <= TALK_IDLE_MS && now - talk.since <= TALK_MAX_MS) {
    return { open: true, why: 'talk', leftMs: Math.min(TALK_IDLE_MS - (now - talk.lastAt), TALK_MAX_MS - (now - talk.since)), totalMs: TALK_IDLE_MS };
  }
  if (typeof sinceReplyMs === 'number' && Number.isFinite(sinceReplyMs) && sinceReplyMs >= 0) {
    const total = asked ? FOLLOW_QUESTION_MS : FOLLOW_MS;
    if (sinceReplyMs <= total) return { open: true, why: asked ? 'question' : 'follow', leftMs: total - sinceReplyMs, totalMs: total };
  }
  return { open: false, why: 'closed', leftMs: 0, totalMs: 0 };
}

/**
 * When the open window runs out, on the wall clock (ms; 0: it doesn't run out, or it's closed).
 * The Mac app's mic is told, so it closes the window by itself even if the page is asleep.
 * @param {WindowState} w @param {{ replyAt?: number, talk?: Talk }} o replyAt: when Echo finished speaking
 */
export function windowEndsAt(w, { replyAt, talk = null } = {}) {
  if (!w.open || !w.totalMs) return 0;
  if (w.why === 'talk') return talk ? Math.min(talk.lastAt + TALK_IDLE_MS, talk.since + TALK_MAX_MS) : 0;
  return typeof replyAt === 'number' && Number.isFinite(replyAt) ? replyAt + w.totalMs : 0;
}

/**
 * The words next to the ring.
 * @param {WindowState} w
 */
export function windowLabel(w) {
  if (!w.open) return '';
  if (w.why === 'working') return 'Listening while I work · just talk';
  if (w.why === 'talk') return 'Talk mode · just talk';
  const s = Math.max(1, Math.ceil(w.leftMs / 1000));
  return w.why === 'question' ? `Your turn · ${s} s` : `Listening · ${s} s`;
}
