// "Delete it" is its own yes: when the user's own words in this turn clearly name a risky action
// and its target, the confirmation card that follows is pre-approved (lib/computer.js askFirst),
// so Echo doesn't ask a second time. It still shows an Undo chip.
//
// Deliberately strict. Only two kinds of action can be pre-approved: deleting one thing and
// sending. Everything else still asks, whatever was said: payments and purchases, sign-ins and
// passwords, submitting forms, system settings, Terminal (git push, deploys), deleting several
// things or a whole folder, and anything where Echo would be filling in the target itself.
//
// The intent comes only from what the user said or typed to Echo this turn (lib/dispatcher.js
// send, after the addressee check in server.js), never from text on a page or from Echo's own
// words. It's good for one action, this turn only, and the same target.

/** Kinds of risky action a spoken command can pre-approve. Everything else always asks. */
export const PREAPPROVABLE = ['delete', 'send'];

/** An intent is dropped after this long, even inside one turn. */
export const INTENT_TTL_MS = 90 * 1000;
/** A thing Echo pointed at or acted on counts as "it" for this long. */
export const REFERENT_TTL_MS = 3 * 60 * 1000;

const norm = (s) => String(s || '').toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}'@. ]+/gu, ' ').replace(/[.]+(\s|$)/g, ' ').replace(/\s+/g, ' ').trim();

// Said first, then dropped: "okay", "Echo,", "yes", "please", "can you", "go ahead and".
const LEAD = /^(?:(?:hey|ok|okay|so|and|now|please|echo|yes|yeah|yep|sure|alright|all right|right|actually|i mean|just|go ahead and|can you|could you|would you|will you|you can)\s+)+/;
// Not a plain command: negations, conditions, questions, hesitation, more than one action.
const HEDGE = /\b(don'?t|do not|not|never|no|nope|wait|stop|cancel|undo|if|when|whether|unless|after|before|later|tomorrow|maybe|should|shall|how|why|what|which|where|and|then|also|or)\b/;
// Several things at once, or a whole folder: always asks.
const MULTI = /\b(all|every|everything|each|both|these|those|them|they|folders?|directory|directories|files|emails|messages|photos|pictures|images|items|drafts|screenshots|documents|notes|everyone|everybody|group|whole|entire|rest|others|few|several|many|multiple|two|three|four|five|six|seven|eight|nine|ten|[2-9]|\d{2,})\b/;
// Money, accounts, installs, commands: never pre-approved (checked on the whole sentence).
const NEVER = /\b(buy|purchase|pay|payment|order|checkout|check out|subscribe|donate|transfer|money|card|sign in|log in|login|sign out|log out|password|account|install|uninstall|update|restart|shut ?down|push|deploy|publish|settings?|terminal|command|sudo|erase|wipe|reset|format|empty)\b/;

const VERBS = /** @type {Array<[string, RegExp]>} */ ([
  ['delete', /^(?:delete|trash|remove|discard|bin|throw away|throw out|get rid of)\b/],
  ['send', /^(?:send|reply to|reply)\b/],
  // Saving and closing the open document (lib/policy.ts tier 2): "save it", "close the window", "quit XD".
  ['save', /^(?:save)\b/],
  ['close', /^(?:close|quit)\b/],
]);
// "move it to the trash", "move the screenshot to the bin"
const MOVE_TO_TRASH = /^move (.+?) to (?:the )?(?:trash|bin|recycle bin)$/;

// Words that point but don't name: "it", "this one", "the file".
const POINTING = new Set(['it', 'this', 'that', 'one', 'the', 'a', 'an', 'my', 'here', 'there', 'now', 'please', 'right', 'away', 'for', 'me', 'out', 'off', 'again']);
// Kinds of thing: fine to say, but they don't say which one ("delete the file" needs a clear "it").
const KINDS = new Set(['file', 'email', 'mail', 'message', 'draft', 'note', 'photo', 'picture', 'image', 'document', 'doc', 'item', 'thing', 'text', 'reply', 'chat', 'dm', 'post', 'comment', 'event', 'reminder', 'screenshot', 'recording', 'video', 'song', 'track', 'tab', 'page', 'attachment']);

/**
 * @typedef {{ category: 'delete' | 'send' | 'save' | 'close', target: string[], pronoun: boolean, to: string[], text: string }} Command
 */

/**
 * What the user's words ask for, when they plainly name a delete or a send of one thing.
 * Pure: the tests call it directly. Anything unclear returns null (Echo asks as usual).
 * "Buy it", "delete them all", "don't send it", "should I delete it?" are all null.
 * @param {string} text
 * @returns {Command | null}
 */
export function commandIntent(text) {
  let t = norm(text);
  // "Delete it?" is a question back to Echo; "Can you delete it?" is a request.
  if (!t || (/\?/.test(String(text)) && !/^(?:\S+\s+)*?(?:can|could|would|will) you\b/.test(t))) return null;
  t = t.replace(LEAD, '').replace(/\s+(?:please|now|right now|echo|for me)$/g, '').trim();
  if (!t || t.split(' ').length > 9) return null;
  if (HEDGE.test(t) || NEVER.test(t) || MULTI.test(t)) return null;
  let category = /** @type {'delete' | 'send' | 'save' | 'close' | ''} */ ('');
  let rest = '';
  const move = t.match(MOVE_TO_TRASH);
  if (move) {
    category = 'delete';
    rest = move[1];
  } else {
    for (const [c, re] of VERBS) {
      const m = t.match(re);
      if (m) {
        category = /** @type {'delete' | 'send' | 'save' | 'close'} */ (c);
        rest = t.slice(m[0].length).trim();
        break;
      }
    }
  }
  if (!category) return null;
  let to = /** @type {string[]} */ ([]);
  if (category === 'send') {
    // "send it to Sam", "reply to Sam", "send Sam the file" is too loose: only "to <name>".
    const m = rest.match(/^(?:(.*?)\s+)?to\s+(.+)$/) || (/^reply to\b/.test(t) ? [rest, '', rest] : null);
    if (m) {
      to = significant(m[2]);
      if (!to.length) return null;
      rest = m[1] || '';
    }
  } else if (/\bto\b/.test(rest)) return null;
  const words = rest.split(' ').filter(Boolean);
  const target = words.filter((w) => !POINTING.has(w) && !KINDS.has(w) && w.length >= 2);
  const pronoun = target.length === 0;
  // "delete" alone, with nothing after it, doesn't say what: that's Echo filling it in. ("Save"
  // and "quit" alone are clear: there's one open document, one app in front.)
  if (pronoun && !words.length && !to.length && (category === 'delete' || category === 'send')) return null;
  return { category, target, pronoun, to, text: t };
}

/** The words that name something ("sam", "invoice"), without the pointing ones. */
function significant(s) {
  return norm(s).split(' ').filter((w) => w && !POINTING.has(w) && !KINDS.has(w) && w.length >= 2);
}

/** Every word shows up in the evidence, as a whole word (so "email" isn't found in "gmail"). */
function allIn(words, evidence) {
  const split = (s) => norm(s).split(/[\s@._-]+/).filter(Boolean);
  const have = new Set(split(evidence.join(' ')));
  const want = words.flatMap(split).map((w) => w.replace(/'s$/, ''));
  return want.length > 0 && want.every((w) => have.has(w));
}

const MULTI_TARGET = /\b(all|every|everything|empty|selected items|\d+ items|items selected|folder)\b/i;
// A Finder item that doesn't look like a file (no extension) may be a folder: that always asks.
const LOOKS_LIKE_FILE = /\.[a-z0-9]{1,8}$/i;

/**
 * @typedef {{ label: string, app: string, at: number, turn: number }} Referent
 * @typedef {Command & { turn: number, at: number }} Intent
 */

/**
 * Does this intent pre-approve this risky action? Pure: the tests call it directly.
 * - Same kind of action (a "delete it" never pre-approves a send), and only a delete or a send.
 * - This turn only, within INTENT_TTL_MS.
 * - Same target: the named words show up in what Echo found (the thing it pointed at or acted
 *   on, the button, the conversation or recipient). "It" needs a clear it: one thing Echo pointed
 *   at or acted on in the same app *before* the user spoke. Otherwise Echo would be choosing.
 * @param {Intent | null} intent
 * @param {{ category?: string, turn: number, now: number, app?: string, label?: string, window?: string, to?: string,
 *   referent?: Referent | null, prior?: Referent | null }} a
 * @param {{ preapprovable?: readonly string[] }} [o] which kinds may be pre-approved (lib/policy.ts SAY_SO_CATEGORIES with the policy flag)
 * @returns {{ ok: true, why: string } | { ok: false, why: string }}
 */
export function intentMatches(intent, a, { preapprovable = PREAPPROVABLE } = {}) {
  const no = (why) => ({ ok: /** @type {false} */ (false), why });
  if (!intent) return no('no_intent');
  if (!preapprovable.includes(String(a.category))) return no('always_asks');
  if (intent.category !== a.category) return no('different_action');
  if (intent.turn !== a.turn) return no('other_turn');
  if (a.now - intent.at > INTENT_TTL_MS) return no('stale');
  if (MULTI_TARGET.test(String(a.label || ''))) return no('several');
  const app = String(a.app || '').toLowerCase();
  const fresh = (r) => r && r.label && app && String(r.app || '').toLowerCase() === app && a.now - r.at <= REFERENT_TTL_MS && !MULTI_TARGET.test(r.label) ? r : null;
  const finderFolder = (r) => app === 'finder' && r && !LOOKS_LIKE_FILE.test(r.label.trim());
  const prior = fresh(a.prior);
  const current = fresh(a.referent);
  if (a.category === 'save' || a.category === 'close') {
    // "Save it", "quit": the document or app in front. A name has to be the app or the window ("quit XD").
    if (!intent.target.length) return { ok: true, why: 'it' };
    return allIn(intent.target, [a.app || '', a.window || '', a.label || '']) ? { ok: true, why: 'named' } : no('different_target');
  }
  if (a.category === 'delete') {
    if (intent.pronoun) {
      // "Delete it": the one thing Echo showed the user before they said it.
      if (!prior) return no('unclear_it');
      if (finderFolder(prior)) return no('maybe_folder');
      return { ok: true, why: 'it' };
    }
    // "Delete the screenshot": what Echo selected, or the button itself, says so.
    const seen = [current, prior].filter(Boolean);
    const hit = seen.find((r) => allIn(intent.target, [r.label]));
    if (hit) return finderFolder(hit) ? no('maybe_folder') : { ok: true, why: 'named' };
    if (app !== 'finder' && allIn(intent.target, [a.label || ''])) return { ok: true, why: 'named' };
    return no('different_target');
  }
  // send
  const evidence = [a.to || '', a.window || '', a.label || '', current?.label || '', prior?.label || ''];
  if (intent.to.length && !allIn(intent.to, evidence)) return no('different_recipient');
  if (intent.target.length && !allIn(intent.target, evidence)) return no('different_target');
  // "Send it" with no name: the draft Echo wrote (or the thing it showed) before the user spoke.
  if (!intent.to.length && intent.pronoun && !prior) return no('unclear_it');
  return { ok: true, why: intent.to.length ? 'recipient' : 'it' };
}
