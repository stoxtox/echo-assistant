// "What did I miss?" (the catchUp flag). Coming back to the Mac after a while, the first thing
// anyone wants is what happened meanwhile: which tasks finished or failed, what's waiting for an
// OK, what job on the Mac is still open, what came in. Echo answers that at once from what it
// knows, with no model call, in a sentence or two, then hands the rest to the conversation.
// Pure: the dispatcher calls these with its tasks, background notes and job.

/** "What did I miss?", "catch me up", "any updates?", "I'm back", "what happened while I was out?" */
const ASK = "what (?:did i|have i|i) miss(?:ed)?|catch me up|fill me in|any (?:news|updates?)|anything new|what s new|whats new|what (?:happened|went on) while i was (?:away|out|gone)|i m back|im back|i am back|back now";
const AWAY = '(?: while i was (?:away|out|gone)| since i left)?';
const TAIL = '(?: (?:today|so far|please|echo|for me|then|now))*';
const CATCH_UP = new RegExp(`^(?:(?:hey|hi|ok|okay|so|and) )*(?:echo )?(?:${ASK})${AWAY}${TAIL}$`);

/**
 * Is this asking what happened meanwhile, and nothing else? The whole sentence must be the ask:
 * "what's new in iOS 26?" and "any updates to install?" are questions for the assistant.
 * @param {string} text
 */
export function isCatchUpQuestion(text) {
  const t = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return Boolean(t) && CATCH_UP.test(t);
}

/** "Deck for the launch", shortened to say. @param {string} s */
const short = (s) => {
  const w = String(s || '').replace(/\s+/g, ' ').trim().split(' ');
  return w.length <= 6 ? w.join(' ').replace(/[.?!]+$/, '') : `${w.slice(0, 6).join(' ')}…`;
};

/** "A, B and C" (at most three named, then "and 2 more"). @param {string[]} names */
const listed = (names) => {
  const n = names.map(short);
  const shown = n.slice(0, 3);
  const more = n.length - shown.length;
  if (more > 0) return `${shown.join(', ')} and ${more} more`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown[0] || '';
};

/** "8:40 pm", or "how long ago" when it's within the hour. @param {number} at @param {number} now @param {string} [timeZone] */
const when = (at, now, timeZone) => {
  const mins = Math.max(1, Math.round((now - at) / 60_000));
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', ...(timeZone ? { timeZone } : {}) });
};

/**
 * What Echo says: what happened since `since`, most useful first.
 * @param {{ tasks?: Array<{ title?: string, project?: string, status: string, finishedAt?: string | null, updatedAt?: string }>,
 *   since: number, now?: number, news?: number, job?: { goal: string, app?: string } | null, busy?: boolean, sinceRestart?: boolean, timeZone?: string }} o
 *   sinceRestart: Echo restarted since the user last talked, so `since` is a guess (the last six hours)
 *   news: how many background notes are waiting for a good moment (the assistant tells them next)
 * @returns {{ line: string, count: number }} count: how many things it told
 */
export function catchUpLine({ tasks = [], since, now = Date.now(), news = 0, job = null, busy = false, sinceRestart = false, timeZone = undefined }) {
  const from = sinceRestart ? 'in the last few hours' : `since ${when(since, now, timeZone)}`;
  const after = (t) => Date.parse(String(t.finishedAt || t.updatedAt || '')) >= since;
  const name = (t) => t.title || t.project || 'a task';
  const done = tasks.filter((t) => t.status === 'done' && after(t));
  const failed = tasks.filter((t) => (t.status === 'failed' || t.status === 'interrupted') && after(t));
  const waiting = tasks.filter((t) => t.status === 'waiting_approval');
  const running = tasks.filter((t) => t.status === 'running' || t.status === 'queued');
  const parts = [];
  if (done.length) parts.push(`${done.length === 1 ? 'one task finished' : `${done.length} tasks finished`}: ${listed(done.map(name))}`);
  if (failed.length) parts.push(`${failed.length === 1 ? 'one task' : `${failed.length} tasks`} didn't finish (${listed(failed.map(name))})`);
  if (waiting.length) parts.push(`${waiting.length === 1 ? `${short(name(waiting[0]))} is` : `${waiting.length} are`} waiting for your OK`);
  if (running.length) parts.push(`${running.length === 1 ? `${short(name(running[0]))} is` : `${running.length} are`} still going`);
  const sentences = [];
  if (parts.length) {
    const head = parts.join(', ');
    sentences.push(`${from}, ${head}.`);
  }
  if (news) sentences.push(`${news === 1 ? 'One update' : `${news} updates`} came in too; ask and I'll go through ${news === 1 ? 'it' : 'them'}.`);
  if (job) sentences.push(`Your job on the Mac${job.app ? ` in ${job.app}` : ''} is still open: ${short(job.goal)}. Say "carry on" to pick it up.`);
  if (busy) sentences.push("I'm still working on your last request.");
  const count = done.length + failed.length + waiting.length + running.length + news + (job ? 1 : 0);
  if (!sentences.length) return { line: `Nothing new ${from}. All quiet. What's next?`, count: 0 };
  // Spoken, so the first letter is a capital and the line reads as one breath.
  const line = sentences.join(' ');
  return { line: line[0].toUpperCase() + line.slice(1), count };
}
