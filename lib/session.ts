// The conversation window (ECHO_CORE_PLAN.md §7, decided Oct 2 2026, modelled on Alexa+ Follow-Up
// Mode, Google Nest and Gemini Live, Meta glasses, Copilot Voice and ChatGPT Voice). While it's
// open, what you say goes to Echo with the conversation in view: no "Echo" needed, and a sentence
// meant for Echo is never silently set aside. It's open:
//
//   - while Echo is working on something for you (on the Mac, a lesson, a card waiting for a yes);
//   - for 8 s after Echo finishes speaking, 15 s if its reply ended with a question;
//   - in Talk mode ("let's talk"): until 30 s pass with nothing said to Echo, 30 minutes at most.
//
// It closes at once on "thanks", "that's all", "goodbye", "go to sleep", "never mind", and stays
// closed (Echo's "you're welcome" doesn't reopen it) until push-to-talk or "Hey Echo".

import { windowState, FOLLOW_MS, FOLLOW_QUESTION_MS, TALK_IDLE_MS, TALK_MAX_MS } from '../public/convwindow.js';

// The numbers live with the page's copy of the window (public/convwindow.js), so both agree.
export { FOLLOW_MS, FOLLOW_QUESTION_MS, TALK_IDLE_MS, TALK_MAX_MS };
/** "That was for you" re-sends the last set-aside sentence from this long ago. */
export const RECALL_MS = 2 * 60_000;

/** Ends the conversation ("thanks", "that's all"…), when that's the whole point of what was said. */
export const CLOSING = /^\s*(?:ok(?:ay)?[,.]?\s+)?(?:thanks?(?: you)?(?: so much| a lot)?|thank you(?: echo)?|that'?s (?:all|it)(?: for now)?|good ?bye|bye(?: bye)?|go to sleep|never ?mind|we'?re done|i'?m done|(?:(?:alright|all right|now)[,.]?\s+)*(?:now[,.]?\s+)?(?:go|be|stay|keep) quiet(?: now| please)?|quiet now|stop listening|that'?s enough)(?:,? echo)?[.!]*\s*$/i;
/** Starts Talk mode. */
export const TALK_START = /\b(?:let'?s (?:talk|chat)|talk mode|conversation mode|keep listening)\b/i;
/** "That was for you": the last sentence Echo set aside was meant for it. */
export const RECALL = /\b(?:that|it|this) was (?:meant )?for you\b|\bi was (?:talking|speaking) to you\b|\bthat one was for you\b/i;

export type Talk = { since: number; lastAt: number } | null;
export type SessionState = {
  /** Echo is working for the user (computer use, a lesson, a confirmation waiting). */
  working: boolean;
  /** Since Echo last finished speaking (ms), if known. */
  sinceReplyMs?: number;
  /** Echo's last reply ended with a question. */
  asked: boolean;
  talk: Talk;
  /** The user closed it ("thanks", "that's all") after Echo last spoke. */
  closed: boolean;
  now: number;
};
export type Window = { open: boolean; why: 'working' | 'question' | 'follow' | 'talk' | 'closed' };

/** Is the conversation window open, and why. */
export function sessionWindow(s: SessionState): Window {
  const w = windowState({ working: s.working, ...(s.sinceReplyMs !== undefined ? { sinceReplyMs: s.sinceReplyMs } : {}), asked: s.asked, talk: s.talk, closed: s.closed, now: s.now });
  return { open: w.open, why: w.why };
}

/** A sound the recognizer wrote down ("*sad*", "[music]") or a lone filler ("um", "Th."): never a turn. */
export function isNoise(text: string): boolean {
  const t = String(text || '').trim();
  if (/^[*[(].*[*\])]$/.test(t)) return true;
  const w = t.toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
  return w.length === 0 || (w.length === 1 && /^(?:um+|uh+|hm+|mm+|mhm|ah+|oh+|eh|th|or|so|the|and|a|but)$/.test(w[0] as string));
}

/** What the window remembers between sentences: Talk mode, a "thanks" that closed it, the last sentence set aside. */
export type ListenState = { talk: Talk; closed: boolean; lastSetAside: { text: string; at: number } | null };
export const freshListenState = (): ListenState => ({ talk: null, closed: false, lastSetAside: null });

/**
 * The window after a sentence: "let's talk" starts Talk mode and anything said to Echo keeps it
 * going; "thanks" / "that's all" closes the window; push-to-talk or "Hey Echo" opens it again; a
 * sentence set aside is kept for "that was for you"; recalling it uses it up.
 */
export function afterSentence(
  st: ListenState,
  v: { kind: 'deliver' | 'hold' | 'drop'; said: string; recalled?: boolean },
  { surely = false, now = Date.now() }: { surely?: boolean; now?: number } = {},
): ListenState {
  const next: ListenState = { talk: st.talk ? { ...st.talk } : null, closed: st.closed, lastSetAside: st.lastSetAside };
  const words = (v.said.match(/[\p{L}\p{N}']+/gu) || []).length;
  if (v.kind === 'drop') {
    if (words >= 2 && !isNoise(v.said)) next.lastSetAside = { text: v.said, at: now };
    return next;
  }
  if (v.recalled) next.lastSetAside = null;
  if (surely) next.closed = false;
  if (TALK_START.test(v.said)) {
    next.talk = { since: now, lastAt: now };
    next.closed = false;
  } else if (next.talk) next.talk.lastAt = now;
  if (CLOSING.test(v.said)) {
    next.closed = true;
    next.talk = null;
  }
  return next;
}
