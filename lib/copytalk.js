// "Copy this conversation": the talk so far, as plain text on the clipboard, from the conversation
// log (lib/transcript.ts), which is kept only while "Keep a conversation log" is on. Nothing leaves
// the Mac: it goes to the clipboard and nowhere else.
import { spawn } from 'node:child_process';
import { readTranscript } from './transcript.ts';

/** A gap this long between two lines starts a new session. */
export const SESSION_GAP_MS = 30 * 60 * 1000;

/**
 * The lines of the session under way: back from now to the last long silence, or `minutes` back.
 * @param {Array<{ ts: string, who: string, kind: string, text: string }>} lines oldest first
 * @param {{ now?: number, minutes?: number }} [o]
 */
export function sessionLines(lines, { now = Date.now(), minutes } = {}) {
  const all = lines.filter((l) => l.kind !== 'unanswered' && l.kind !== 'shown' && String(l.text || '').trim());
  if (minutes) return all.filter((l) => now - Date.parse(l.ts) <= minutes * 60_000);
  let from = all.length;
  for (let i = all.length - 1; i >= 0; i--) {
    const next = i === all.length - 1 ? now : Date.parse(/** @type {any} */ (all[i + 1]).ts);
    if (next - Date.parse(/** @type {any} */ (all[i]).ts) > SESSION_GAP_MS) break;
    from = i;
  }
  return all.slice(from);
}

/** The conversation as text: "You: …" and "Echo: …", one line each, pieces of one reply joined. @param {ReturnType<typeof sessionLines>} lines */
export function asText(lines) {
  /** @type {string[]} */
  const out = [];
  let last = '';
  for (const l of lines) {
    const who = l.who === 'you' ? 'You' : 'Echo';
    const text = String(l.text).replace(/\s+/g, ' ').trim();
    if (who === last && who === 'Echo') out[out.length - 1] += ` ${text}`;
    else out.push(`${who}: ${text}`);
    last = who;
  }
  return out.join('\n');
}

/** Put text on the Mac's clipboard. @param {string} text @returns {Promise<boolean>} */
export function toClipboard(text) {
  return new Promise((resolve) => {
    try {
      const p = spawn('/usr/bin/pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] });
      p.on('error', () => resolve(false));
      p.on('close', (code) => resolve(code === 0));
      p.stdin.end(text);
    } catch {
      resolve(false);
    }
  });
}

/**
 * Copy the session so far. @param {{ minutes?: number, copy?: (text: string) => Promise<boolean>, now?: number }} [o]
 * @returns {Promise<{ ok: boolean, lines: number, chars: number, why?: string }>}
 */
export async function copyConversation({ minutes, copy = toClipboard, now = Date.now() } = {}) {
  const lines = sessionLines(readTranscript(undefined, now - 24 * 3_600_000, now), { now, ...(minutes ? { minutes } : {}) });
  if (!lines.length) return { ok: false, lines: 0, chars: 0, why: 'nothing_kept' };
  const text = asText(lines);
  const ok = await copy(text);
  return { ok, lines: text.split('\n').length, chars: text.length, ...(ok ? {} : { why: 'clipboard' }) };
}
