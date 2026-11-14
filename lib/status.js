// "Can you hear me?" always gets an answer (Oct 2: asked about ten times in one evening while Echo
// was busy and silent). While a reply is under way, a question about Echo itself is answered at
// once from what Echo knows (what it's on, for how long, what it's waiting for, what's next),
// never queued behind the slow reply it's asking about. Pure: the dispatcher calls these.

/** "Can you hear me?", "what's happening?", "where did you go?", "why aren't you answering?" */
const STATUS = [
  /\b(can|could|do)\s+you\s+(?:able\s+to\s+|even\s+)?hear\s+me\b/i,
  /\bare\s+you\s+(?:still\s+)?(?:there|listening|working|awake|alive|ok|okay)\b/i,
  /\bwhat'?s\s+(?:happening|going\s+on|taking\s+so\s+long|the\s+hold\s*up)\b/i,
  /\bwhere\s+(?:did\s+)?you\s+go\b/i,
  /\bwhy\s+(?:are(?:n'?t)?\s+you\s+(?:not\s+)?|aren'?t\s+you\s+|is\s+it\s+(?:not\s+)?|did\s+you\s+(?:not\s+)?)(?:answer|respond|repl|talk|listen|say)/i,
  /\bwhat\s+are\s+you\s+(?:doing|up\s+to|working\s+on)\b/i,
  /^\W*(?:hey\s+|hello\s+)?(?:echo\W*)?(?:hello|hey|hi)?\W*(?:are\s+you\s+there|you\s+there)\W*$/i,
];

/**
 * Is this just a question about Echo itself (nothing else asked in it)?
 * @param {string} text
 */
export function isStatusQuestion(text) {
  const t = String(text || '').trim();
  if (!t || t.split(/\s+/).length > 16) return false;
  return STATUS.some((r) => r.test(t));
}

/** "1 minute 5 seconds" / "40 seconds". @param {number} ms */
export function howLong(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} seconds`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m} minute${m === 1 ? '' : 's'}${r >= 10 ? ` ${r} seconds` : ''}`;
}

/** A request, shortened to say back. @param {string} text */
export function gist(text) {
  const t = String(text || '').replace(/\s+/g, ' ').replace(/^\W+/, '').trim();
  const words = t.split(' ');
  return words.length <= 10 ? t.replace(/[.?!]+$/, '') : `${words.slice(0, 9).join(' ')}…`;
}

/**
 * What Echo says when asked while it's busy.
 * @param {{ busy: boolean, request?: string, sinceMs?: number, activity?: string, driving?: { app?: string, steps?: number } | null,
 *   waitingForModel?: boolean, retry?: { attempt: number, error?: string } | null, waiting?: number, limited?: { resetsAt?: number } | null }} s
 */
export function statusLine(s) {
  if (!s.busy) return "Yes, I hear you. I'm not working on anything right now. What do you need?";
  const parts = ['Yes, I hear you.'];
  const on = s.request ? `I'm still on "${gist(s.request)}"` : "I'm still on your last request";
  let doing = '';
  if (s.limited) doing = `, held up by your Claude plan's usage limit${s.limited.resetsAt ? ` until ${new Date(s.limited.resetsAt * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}`;
  else if (s.retry) doing = `, and the model is ${s.retry.error === 'rate_limit' ? 'rate limited' : 'busy'}, so I'm retrying (try ${s.retry.attempt})`;
  else if (s.waitingForModel) doing = ', waiting for the model to answer';
  else if (s.driving?.app) doing = `, working in ${s.driving.app}${s.activity ? `: ${s.activity}` : ''}`;
  else if (s.activity) doing = `: ${s.activity}`;
  parts.push(`${on}${doing}${s.sinceMs ? `, ${howLong(s.sinceMs)} so far` : ''}.`);
  if (s.waiting) parts.push(`${s.waiting === 1 ? 'Your next message is' : `${s.waiting} of your messages are`} next.`);
  parts.push('Say stop to cancel it.');
  return parts.join(' ');
}
