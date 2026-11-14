// Did each computer-use request actually work? A drive is a session (docs/computer-use.md): it
// stays open for follow-ups and normally ends "idle" or when the user says stop, so how a run
// ended says almost nothing about whether the user got what they asked for. This reads the logs
// after the fact and judges each request (the first one in a run, then each `session_continued`)
// from evidence:
//
// - the steps: was the last one confirmed on screen (`verified`), did any fail or get refused;
// - the user: a confirmation they turned down, taking over with the mouse, and what they said
//   next ("no, that's wrong", the same request again, or "thanks");
// - Echo's own last words ("Done, it's sent" or "I couldn't find the button").
//
// Nothing here runs live or calls a model. scripts/outcome-report.js prints the scoreboard and
// lets you label the unclear ones (data/outcome-labels.json), which also measures these rules.

/** @typedef {{ at: number, who: 'User' | 'Assistant' | 'Event', text: string }} Line */
/**
 * @typedef {{ id: string, run: string, n: number, start: number, end: number, app: string,
 *   events: any[], actions: any[], ended: any | null }} Request
 */
/**
 * @typedef {{ label: 'success' | 'failed' | 'stopped' | 'unclear' | 'looked',
 *   strength: 'strong' | 'weak' | null, why: string[], asked: string, said: string, next: string,
 *   steps: number, verified: number, waitedMs: number, workMs: number }} Outcome
 */

/** UTC milliseconds for a wall-clock time on a day in a time zone ("2026-10-01", "14:05:09"). */
export function zonedToUtc(day, time24, timeZone) {
  const [y, mo, d] = day.split('-').map(Number);
  const [h, mi, s] = time24.split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi, s || 0);
  // The zone's offset at that moment, found by formatting a guess back into the zone (twice, for DST edges).
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
        .formatToParts(new Date(guess))
        .map((x) => [x.type, x.value]),
    );
    const shown = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
    guess += wall - shown;
  }
  return guess;
}

/** "2:05:09 PM" -> "14:05:09". */
function to24(t) {
  const m = String(t).match(/(\d+):(\d+)(?::(\d+))?\s*(AM|PM)?/i);
  if (!m) return '00:00:00';
  let h = Number(m[1]);
  if (m[4]) h = (h % 12) + (/pm/i.test(m[4]) ? 12 : 0);
  return `${String(h).padStart(2, '0')}:${m[2]}:${m[3] || '00'}`;
}

/**
 * Every line of a day's conversation log (data/conversations/<day>.md, written by server.js),
 * with its time in UTC milliseconds.
 * @param {string} md @param {string} day e.g. 2026-10-01 @param {string} timeZone
 * @returns {Line[]}
 */
export function transcriptLines(md, day, timeZone) {
  /** @type {Line[]} */
  const out = [];
  for (const m of String(md || '').matchAll(/^\*\*\[([^\]]+)\] (User|Assistant|Event):\*\* (.*)$/gm)) {
    out.push({ at: zonedToUtc(day, to24(m[1]), timeZone), who: /** @type {Line['who']} */ (m[2]), text: m[3] });
  }
  return out;
}

/**
 * The computer-use log split into requests: a run's first request, then one per
 * `session_continued`. Confirmation answers (logged by card id, not run) go with the request
 * that asked.
 * @param {any[]} events data/computer-log.jsonl, oldest first
 * @returns {Request[]}
 */
export function requestsFromLog(events) {
  /** @type {Request[]} */
  const out = [];
  /** @type {Map<string, Request>} */
  const current = new Map();
  /** @type {Map<string, Request>} */
  const byCard = new Map();
  const open = (run, n, at, app) => {
    const r = { id: `${run}#${n}`, run, n, start: at, end: at, app: app || '', events: [], actions: [], ended: null };
    out.push(r);
    current.set(run, r);
    return r;
  };
  for (const e of events) {
    const at = Date.parse(e.at);
    if (!Number.isFinite(at)) continue;
    let r = e.run ? current.get(e.run) : byCard.get(e.id);
    if (e.event === 'run_started') r = open(e.run, 1, at, e.app);
    else if (e.event === 'session_continued') r = open(e.run, e.request || (r ? r.n + 1 : 2), at, e.app || r?.app);
    else if (e.run && !r) r = open(e.run, 1, at, e.app); // a run that began before the log window
    if (!r) continue;
    r.events.push(e);
    r.end = Math.max(r.end, at);
    if (e.app && !r.app) r.app = e.app;
    if (e.event === 'action') r.actions.push(e);
    if (e.event === 'confirm_asked' && e.id) byCard.set(e.id, r);
    if (e.event === 'run_ended') {
      r.ended = e;
      current.delete(e.run);
    }
  }
  return out;
}

// Echo saying it couldn't do a step: "I couldn't find the Compose button", "Still stuck". Not a
// handoff by design ("you'll need to type the password yourself", "I can't type codes for you"),
// what the user can't do ("if you can't see my pointer"), or what Echo can't do in general
// ("I can't watch your screen continuously yet").
const SAID_FAILED = /\b(I (couldn'?t|could not|can'?t|cannot|wasn'?t able to|was unable to|didn'?t manage to) (find|click|get to|open|reach|see|select|load|press|locate|focus)|still (stuck|no luck|can'?t)|no luck|i'?m stuck|nothing (happened|changed)|didn'?t (work|go through|land|take)|(it|that) failed|gave up)\b/i;
// Echo saying it's done (only counted when the screen check agrees).
const SAID_DONE = /\b(done|sent|opened|it'?s (open|in|up|there|on|playing)|there you go|all set|added|created|typed|saved|posted|playing|paused|filled( in)?|submitted|switched|moved|signed (in|up)|finished|went through)\b/i;
// The user, right after: unhappy, or happy.
const USER_UNHAPPY = /^(no\b|nope\b|wrong\b|stop\b|undo\b|cancel\b|wait\b)|\b(that'?s (not|wrong)|it'?s not|it is not|it isn'?t|it wasn'?t|it hasn'?t|not (that|this) one|wrong (one|place|field|cell|button|file|folder|app)|try (it )?again|i don'?t (want|see)|not what i (asked|wanted|said|meant)|the other (one|email|file|tab|window)|you didn'?t|it didn'?t|didn'?t work|not working|nothing (happened|changed)|still (not|nothing|the same|there)|you missed|what are you doing|why did you)\b/i;
const USER_HAPPY = /\b(thanks|thank you|perfect|great|nice|awesome|good job|that works|it worked|love it|amazing|exactly)\b/i;

const words = (s) => new Set(String(s).toLowerCase().match(/[\p{L}\p{N}']+/gu) || []);
/** The same request said again: most of its words, and at least four ("okay, go ahead" twice isn't a retry). */
export function isRepeat(next, asked) {
  const a = words(asked);
  const b = words(next);
  if (a.size < 4 || b.size < 4) return false;
  let same = 0;
  for (const w of b) if (a.has(w)) same++;
  return same >= 4 && same / Math.min(a.size, b.size) >= 0.6;
}

/**
 * Judge one request from its events and the conversation around it.
 * @param {Request} r
 * @param {Line[]} lines the conversation, oldest first (any days; only nearby lines are used)
 * @param {Request | undefined} following the next request in the same run, if any
 * @returns {Outcome}
 */
export function judgeRequest(r, lines = [], following = undefined) {
  const why = [];
  // What was asked: the user's last line before the request started (logged just before dispatch).
  const askedLine = [...lines].reverse().find((l) => l.who === 'User' && l.at <= r.start + 2000 && l.at >= r.start - 180_000);
  const asked = askedLine?.text || '';
  const lastStep = r.actions.at(-1);
  const after = lastStep ? Date.parse(lastStep.at) : r.start;
  const nextUserLine = lines.find((l) => l.who === 'User' && l.at > after + 1000 && l.at <= Math.max(r.end, after) + 120_000);
  const next = nextUserLine?.text || '';
  const said = lines
    .filter((l) => l.who === 'Assistant' && l.at >= after - 1000 && l.at <= (nextUserLine?.at ?? Math.max(r.end, after) + 30_000))
    .map((l) => l.text)
    .join(' ')
    .slice(0, 600);

  const ev = (name) => r.events.filter((e) => e.event === name);
  const verified = r.actions.filter((a) => a.verified === true).length;
  // Time the user spent answering confirmation cards, and time Echo spent getting to its last step.
  let waitedMs = 0;
  for (const ask of ev('confirm_asked')) {
    const answer = r.events.find((e) => (e.event === 'confirm_allowed' || e.event === 'confirm_denied') && e.id === ask.id);
    if (answer) waitedMs += Date.parse(answer.at) - Date.parse(ask.at);
  }
  const workMs = Math.max(0, after - r.start - waitedMs);
  const base = { asked, said, next, steps: r.actions.length, verified, waitedMs, workMs };

  const refused = ev('refused').length > 0;
  const tookOver = ev('took_over').length > 0;
  const denied = ev('confirm_denied');
  const lastDenied = denied.length && Date.parse(denied.at(-1).at) >= after;
  const echoFailed = SAID_FAILED.test(said);
  const unhappy = USER_UNHAPPY.test(next.trim());
  // Asked again: in the next thing said, or as the next request in the same session.
  const askedNext = following ? [...lines].reverse().find((l) => l.who === 'User' && l.at <= following.start + 2000 && l.at > (askedLine?.at ?? r.start))?.text || '' : '';
  const repeated = isRepeat(next, asked) || isRepeat(askedNext, asked);
  const stepFailed = lastStep?.ok === false;
  const stepUnconfirmed = lastStep?.verified === false;

  // No steps: a look, a point, an answer or just conversation ("what's next?"). Not judged as a
  // computer-use outcome, but a sign of trouble is noted.
  if (!r.actions.length) {
    if (refused) return { label: 'failed', strength: 'strong', why: ['Echo refused the step'], ...base };
    if (lastDenied) return { label: 'stopped', strength: 'strong', why: ['you said no to the confirmation'], ...base };
    const trouble = echoFailed ? 'Echo said it couldn\'t' : unhappy ? 'you sounded unhappy next' : repeated ? 'you asked again' : ev('not_found').length ? 'a target wasn\'t found' : '';
    return { label: 'looked', strength: null, why: [trouble ? `no steps; ${trouble}` : 'no steps (a look, a point, an answer, or conversation)'], ...base };
  }

  if (refused) why.push('Echo refused a step');
  if (tookOver) why.push('you took over');
  if (stepFailed) why.push('the last step failed');
  if (stepUnconfirmed) why.push('the last step wasn\'t confirmed on screen');
  if (echoFailed) why.push('Echo said it couldn\'t');
  if (unhappy) why.push('you sounded unhappy next');
  if (repeated) why.push('you asked again');
  if (lastDenied && !why.length) return { label: 'stopped', strength: 'strong', why: ['you said no to the confirmation'], ...base };
  if (why.length) return { label: 'failed', strength: why.length > 1 || tookOver || unhappy || repeated ? 'strong' : 'weak', why, ...base };

  if (lastStep?.verified === true) {
    const happy = USER_HAPPY.test(next);
    const doneSaid = SAID_DONE.test(said);
    if (happy) why.push('you sounded happy next');
    if (doneSaid) why.push('Echo said it was done');
    why.unshift('last step confirmed on screen');
    return { label: 'success', strength: happy || doneSaid ? 'strong' : 'weak', why, ...base };
  }
  return { label: 'unclear', strength: null, why: ['the last step wasn\'t checked (older Mac app)'], ...base };
}

/**
 * Judge every request.
 * @param {any[]} events @param {Line[]} lines
 * @returns {Array<Request & { outcome: Outcome }>}
 */
export function judgeAll(events, lines) {
  const reqs = requestsFromLog(events);
  return reqs.map((r, i) => {
    const following = reqs.slice(i + 1).find((x) => x.run === r.run);
    return { ...r, outcome: judgeRequest(r, lines, following) };
  });
}
