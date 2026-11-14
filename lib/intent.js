// The local intent router: short, unambiguous commands are done right here in well under a
// second, with no model call at all ("pause", "next song", "volume up", "mute", "scroll down",
// "go back", "what time is it"). Everything else goes to the assistant as before.
//
// It only takes the whole utterance when it's clearly one of these (a handful of words, nothing
// else in it), so "pause the video and open Spotify" or "what time is my meeting" still go to the
// assistant. While Echo drives, "scroll"/"go back" act in the app being driven; otherwise media
// commands go to whatever is playing (Spotify, Music, or a YouTube tab in Chrome).
import { nowString } from './text.js';
import { isStopCommand } from './computer.js';

const clean = (s) => String(s || '').toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim()
  .replace(/^(?:(?:hey|ok|okay|echo|please|can you|could you|just|now)\s+)+/, '').replace(/\s+(?:please|now|echo|thanks|thank you)$/, '');

/**
 * @typedef {{ kind: 'media', action: 'play' | 'pause' | 'toggle' | 'next' | 'previous', onlyIfPlaying?: boolean }
 *   | { kind: 'volume', action: 'up' | 'down' | 'mute' | 'unmute' | 'set', level?: number }
 *   | { kind: 'scroll', direction: 'up' | 'down' }
 *   | { kind: 'back' }
 *   | { kind: 'time' }
 *   | { kind: 'stop' }
 *   | { kind: 'mode', mode: 'do' | 'show' }} Intent
 */

/**
 * Is this one of the instant commands? Pure.
 * @param {string} text
 * @param {{ driving?: boolean, canDrive?: boolean }} [o] canDrive: computer use is on and the Mac
 *   app is there, so "scroll down" and "go back" can act in the front app without a session
 * @returns {Intent | null}
 */
export function localIntent(text, { driving = false, canDrive = false } = {}) {
  const t = clean(text);
  if (!t || t.split(' ').length > 7) return null;
  if (isHushCommand(text)) return { kind: 'stop' };
  if (/^(pause|pause it|pause (the )?(music|song|video|spotify|track)|stop the music)$/.test(t)) return { kind: 'media', action: 'pause' };
  if (/^(resume|play|play it|resume (the )?(music|song|video)|unpause|keep playing|play the music)$/.test(t)) return { kind: 'media', action: 'play' };
  if (/^(next|skip|skip (it|this|this song|this one|the song|the track)|next (song|track|one|video)|play the next (song|track|one))$/.test(t)) return { kind: 'media', action: 'next' };
  if (/^(previous|previous (song|track|one|video)|last (song|track)|go back a song|play the (previous|last) (song|track))$/.test(t)) return { kind: 'media', action: 'previous' };
  if (/^(volume up|turn (it|the volume|the sound) up|louder|a bit louder|raise the volume)$/.test(t)) return { kind: 'volume', action: 'up' };
  if (/^(volume down|turn (it|the volume|the sound) down|quieter|softer|a bit quieter|lower the volume)$/.test(t)) return { kind: 'volume', action: 'down' };
  if (/^(mute|mute (it|the sound|the volume|the mac))$/.test(t)) return { kind: 'volume', action: 'mute' };
  if (/^(unmute|unmute (it|the sound|the volume|the mac))$/.test(t)) return { kind: 'volume', action: 'unmute' };
  const set = t.match(/^(?:set (?:the )?)?volume (?:to )?(\d{1,3})(?: percent| %)?$/);
  if (set) return { kind: 'volume', action: 'set', level: Math.min(100, Number(set[1])) };
  if (/^(what time is it|what's the time|what is the time|time|tell me the time)$/.test(t)) return { kind: 'time' };
  // The drive mode, only as these exact phrases ("do it" alone is an answer, not a mode).
  const whole = String(text || '').toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim().replace(/^(?:hey |ok |okay )?echo /, '');
  if (/^(show me how|show me how to do it|just show me|teach me|show me instead)$/.test(whole)) return { kind: 'mode', mode: 'show' };
  if (/^(just do it|you do it|go ahead and do it yourself|stop showing me)$/.test(whole)) return { kind: 'mode', mode: 'do' };
  if (driving || canDrive) {
    const sc = t.match(/^scroll (up|down)(?: a bit| a little| more| some)?$/);
    if (sc) return { kind: 'scroll', direction: /** @type {'up' | 'down'} */ (sc[1]) };
    // A bare "back" is only a command mid-drive; otherwise it needs "go back".
    if (/^(go back|go back a page|previous page)$/.test(t) || (driving && t === 'back')) return { kind: 'back' };
  }
  return null;
}

/**
 * "Stop", "stop talking", "be quiet", "that's enough": Echo stops talking and drops the reply it's
 * working on, with no model call. "Cancel" and "never mind" aren't in it: they can answer a card
 * or a question, so the assistant takes those.
 * @param {string} text
 */
export function isHushCommand(text) {
  const t = clean(text);
  if (!t || /\b(cancel|never ?mind)\b/.test(t)) return false;
  return isStopCommand(t) || /^(?:(?:okay|ok|echo|please) )*(stop talking|be quiet|quiet|shush|hush|shut up|stop speaking|that's enough talking)$/.test(t);
}

/** macOS volume through osascript (0–100). */
const VOLUME = {
  up: 'set volume output volume ((output volume of (get volume settings)) + 12)',
  down: 'set volume output volume ((output volume of (get volume settings)) - 12)',
  mute: 'set volume output muted true',
  unmute: 'set volume output muted false',
};

/**
 * Do it, and say what was done in a few words. Never throws: a failure is said plainly.
 * @param {Intent} intent
 * @param {{ quick: any, computer: import('./computer.js').ComputerUse, recipes?: import('./recipes.js').Recipes, now?: () => string }} deps
 * @returns {Promise<{ ok: boolean, say: string, did: string }>}
 */
export async function runLocalIntent(intent, { quick, computer, recipes, now = nowString }) {
  try {
    switch (intent.kind) {
      case 'mode': {
        // "Show me how" / "just do it": how Echo drives from now on (settings.driveMode).
        const { saveSettings } = await import('./settings.js');
        saveSettings({ driveMode: intent.mode });
        return { ok: true, say: intent.mode === 'show' ? "Okay, I'll show you each step." : "Okay, I'll do it.", did: `switched to ${intent.mode === 'show' ? 'show-me' : 'do-it'} mode` };
      }
      case 'time': {
        const m = now().match(/at (\d{1,2}:\d{2} [AP]M)/);
        return { ok: true, say: m ? `It's ${m[1]}.` : `It's ${now()}.`, did: 'told the time' };
      }
      case 'volume': {
        const script = intent.action === 'set' ? `set volume output volume ${intent.level}` : VOLUME[intent.action];
        await quick.osa(script);
        const say = { up: 'Louder.', down: 'Quieter.', mute: 'Muted.', unmute: 'Sound on.', set: `Volume ${intent.level}.` }[intent.action];
        return { ok: true, say, did: `volume ${intent.action}${intent.level !== undefined ? ` ${intent.level}` : ''}` };
      }
      case 'scroll': {
        const r = await computer.act('scroll', { direction: intent.direction });
        return { ok: Boolean(r?.done), say: r?.done ? '' : "That didn't scroll.", did: `scrolled ${intent.direction}` };
      }
      case 'back': {
        const r = await computer.act('press_keys', { keys: 'cmd+[' });
        return { ok: Boolean(r?.done), say: r?.done ? '' : "Couldn't go back.", did: 'went back' };
      }
      case 'media': {
        // A YouTube video in front (or being driven): its own keys. Otherwise Spotify or Music.
        // onlyIfPlaying (after a bare "stop"): never open a music app just to pause it.
        const youtube = (computer.driving && /chrome|safari|arc|brave|edge/i.test(computer.run?.app || '')) || (await frontYouTube(quick));
        if (youtube && recipes) {
          const control = { play: 'play', pause: 'pause', toggle: 'toggle', next: 'next', previous: 'previous' }[intent.action];
          const r = await recipes.youtube({ control });
          if (r.ok) return { ok: true, say: '', did: `YouTube ${intent.action}` };
        }
        const running = await playingApp(quick);
        if (!running && intent.onlyIfPlaying) return { ok: false, say: '', did: 'nothing playing' };
        const app = running || 'Spotify';
        await quick.mediaControl({ app, action: intent.action });
        const say = { play: 'Playing.', pause: 'Paused.', toggle: 'Okay.', next: 'Next one.', previous: 'Going back one.' }[intent.action];
        return { ok: true, say, did: `${app} ${intent.action}` };
      }
      default:
        return { ok: false, say: '', did: 'nothing' };
    }
  } catch (e) {
    return { ok: false, say: String(e?.message || "That didn't work.").slice(0, 160), did: `failed: ${intent.kind}` };
  }
}

/** Is a YouTube video the front Chrome tab? (Read-only AppleScript; false when unsure.) */
async function frontYouTube(quick) {
  try {
    const out = String(await quick.osa(`tell application "System Events" to set front to name of first process whose frontmost is true
if front is "Google Chrome" then tell application "Google Chrome" to return URL of active tab of front window
return ""`));
    return /youtube\.com\/(watch|shorts)/.test(out);
  } catch {
    return false;
  }
}

/** Which music app is running (Spotify first), from System Events. */
async function playingApp(quick) {
  try {
    const out = String(await quick.osa('tell application "System Events" to get name of every process whose name is in {"Spotify", "Music"}'));
    if (/Spotify/.test(out)) return 'Spotify';
    if (/Music/.test(out)) return 'Music';
  } catch {}
  return '';
}

/** Words that mean real work: the screen, workers, research, files, several steps. */
const OPINION = /\b(what do you think|what('s| is) your (take|opinion|view)|your thoughts|thoughts on|is (it|this|that) (good|solid|right|any good)|does (it|this|that) make sense|do you (agree|like it)|review (it|this|that)|how does (it|this|that) look)\b/;
const HEAVY = /\b(click|type|screen|open|drive|email|gmail|message|text|send|find|search|research|report|build|fix|code|project|task|worker|file|folder|calendar|schedule|book|buy|order|compare|summari[sz]e|write|draft|plan|look|show me|then|and then|after that)\b/;

/**
 * Words that mean a worker job or its control: starting, following up on or stopping a task,
 * project, research or self-improvement, and answering an approval. Always the main model
 * (Oct 1, 2026: the quick model started a self-improvement as a plain task, from guesses).
 */
const JOB = /\b(improve|improvement|self improve|upgrade|change yourself|roadmap|follow ?up|queue|queued|continue|resume|stop|cancel|kill|approve|approval|deny|allow|permission|grant|merge|discard|review|branch|worktree)\b/;

/** What Echo said last asks about, or reports on, a job of that kind. */
const JOB_PREV = /\b(task|project|research|worker|self.?improve\w*|improvement|follow.?up|queue|queued|start|stop|cancel|approv\w*|allow|permission|merge|discard|review|branch|unlock|confirm)\b/;

/** A short answer: yes, no, ok, go ahead… */
const SHORT_ANSWER = /^(y|yes|yeah|yea|yep|yup|ya|sure|ok|okay|k|alright|all right|go|go ahead|do it|please|please do|sounds good|perfect|great|right|correct|exactly|n|no|nope|nah|not now|don't|dont|never mind|nevermind|approve|deny|that one|the first one|the second one|both)\b/;

/**
 * Is this a quick turn (a question or chat the fast model can answer), or a full one?
 * `prev` is Echo's last reply: a short answer to a question about a task, project, research,
 * self-improvement or approval goes to the main model, as does any short answer while an
 * approval or confirmation card is waiting (`pending`).
 * @param {string} text @param {{ driving?: boolean, lesson?: boolean, images?: number, prev?: string, pending?: boolean }} [o]
 * @returns {'quick' | 'full'}
 */
export function turnWeight(text, { driving = false, lesson = false, images = 0, prev = '', pending = false } = {}) {
  const t = clean(text);
  // A lesson needs the main model: on Oct 1 the quick one answered 19 of 40 turns mid-lesson and
  // guessed which step the user was on.
  if (driving || lesson || images || !t) return 'full';
  // "So what do you think?" about a plan or a document: an opinion needs the thing read first.
  if (OPINION.test(t)) return 'full';
  if (t.split(' ').length > 14 || HEAVY.test(t) || JOB.test(t)) return 'full';
  const short = t.split(' ').length <= 8;
  if (short && (SHORT_ANSWER.test(t) || /\?\s*$/.test(String(prev).trim()))) {
    if (pending || JOB_PREV.test(clean(prev))) return 'full';
  }
  return 'quick';
}
