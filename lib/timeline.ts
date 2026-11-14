// The flight recorder: one timeline the server, the page and the Mac app all write to, so a slow or
// broken session can be read second by second afterwards (`npm run timeline -- --since 10m`).
//
// One JSON line per event in <data>/timeline/YYYY-MM-DD.jsonl (the day in config.timezone):
//   {"ts": ISO ms, "seq": n, "src": "app"|"page"|"server", "type", "trace"?, "f": {...}, "cts"?, "cseq"?}
// `ts`/`seq` are the server's clock and order; `cts`/`cseq` are the sender's own (the app and the
// page send theirs in batches, so their `ts` is when the batch arrived, not when it happened).
//
// What may be written is decided HERE, not by the caller: each event type has a list of field names
// it may carry, anything else is dropped, and strings are cut to 80 characters. So it holds names,
// counts, durations and reasons, and never audio, what was said or answered, what a tool was given
// or returned, what was on the screen, a window's title or a web address.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export type Src = 'app' | 'page' | 'server';
export type Row = { ts: string; seq: number; src: Src; type: string; trace?: string; f: Record<string, string | number | boolean>; cts?: number; cseq?: number };

/** Days kept, and the most one day's file may grow to. (An object, so a test can shrink them.) */
export const limits = { days: 14, maxBytes: 20 * 1024 * 1024 };
const MAX_STRING = 80;
/** The most events taken from one message of the app's or the page's. */
export const MAX_BATCH = 200;

/** The field names each event type may carry. */
const FIELDS: Record<string, readonly string[]> = {
  // The Mac app (macos/Sources).
  'ptt.down': [],
  'ptt.up': ['ms'],
  'ptt.spoiled': [],
  'mic.open': ['aec'],
  'mic.close': [],
  'mic.error': ['code', 'domain'],
  // One of these two ends every sentence: dropped (mic.cancel: why, and how it came in) or delivered (gate.end).
  'mic.cancel': ['reason', 'arm'],
  'gate.onset': ['label', 'manual', 'echo'],
  'gate.end': ['seconds', 'peak', 'arm', 'voicedMs'],
  'overlay.show': ['name', 'reason'],
  'overlay.hide': ['name', 'reason'],
  'body.retry': ['delay'],
  'perm.state': ['screen', 'screenSupported', 'accessibility', 'input', 'microphone'],
  // A Mac permission changed while the app was open: which, and its new state (allowed, notyet, denied).
  'perm.change': ['screen', 'accessibility', 'input', 'microphone', 'speech'],
  // A look at the screen that finished after its deadline: how long each half took (numbers only).
  'look.late': ['captureMs', 'readMs'],
  // The page (public/).
  'page.ws.reconnect': ['ms'],
  'page.error': ['kind'],
  'play.start': ['chars', 'ms', 'soft', 'ctx', 'gain'],
  'audio.fresh': ['why', 'before', 'after', 'idleS'],
  'play.end': [],
  // A new turn of the user's cut off what was still being read out from the one before (how many pieces were waiting).
  'play.cut': ['queued'],
  // The listening state changed (lib/listenmode.js): to what, and why (asked, name, quiet, key, pearl, menu, lock…).
  'listen.mode': ['mode', 'why'],
  // "Keep an eye on it" (lib/watch.js): a watch began (how many phrases it waits for, whether it also waits for quiet) or
  // ended (why, after how long and how many looks). Never what the window said.
  'watch.start': ['phrases', 'quiet'],
  'watch.end': ['why', 'ms', 'checks'],
  'play.stalled': [],
  // The server's view of its two lines.
  'body.connect': [],
  'body.drop': ['code', 'ms'],
  'body.refused': ['reason'],
  // The Echo Chrome extension's line (lib/browser.js): it connected, dropped (why), or was turned
  // away (why: code, unpaired, origin; said once per run of refusals). Never the pairing code.
  'browser.connected': [],
  'browser.disconnected': ['why'],
  'browser.refused': ['why'],
  'page.ws.open': [],
  'page.ws.close': ['code', 'ms'],
  'timeline.truncated': [],
  // The user dropped Echo's light on something (POST /api/computer/pointed): the kind of thing and
  // the app it is in. Never its name, the window's, or what is next to it.
  'point.back': ['role', 'app'],
  // Echo's light left the pearl, or landed on what a request asked for (how long the flight took;
  // `still`: no travel, Reduce Motion). And a step's words that were spoken without the light
  // having said it landed (which kind of step, and how long they waited).
  // `from`: the pearl, the last thing it showed, or turning round on its way back. `light.home`:
  // it went back to the pearl (how long it was out, how many things it showed, why, and whether
  // Echo was still in the middle of a job). `speech.synced`: a step's words went with a landing
  // (the voice lines' names, never the words; `npm run light` reads them back together).
  'light.departed': ['id', 'ms', 'from'],
  'light.arrived': ['id', 'ms', 'still'],
  'light.home': ['ms', 'stops', 'why', 'working'],
  'speech.unsynced': ['kind', 'ms', 'light'],
  'speech.synced': ['kind', 'ms', 'light', 'line', 'lead'],
  // A line of Echo's voice ended (lib/voicestate.js): its length, how long from asking for it to its
  // end, and to its first sound. `voice.unheard`: the page took a line and never said it ended.
  // Never the words.
  'voice.line': ['id', 'chars', 'ms', 'startMs'],
  'voice.unheard': ['id', 'chars', 'ms'],
  // Two clips were one thought ("I just think" … and the rest): how many parts, words and the wait. Never the words.
  'speech.joined': ['parts', 'words', 'ms'],
  'speech.second': ['why', 'ms', 'outcome'],
  // The page said "probably done" before the sentence ended and the server got ahead (lib/server/speech.js
  // probablyDone): how long before the sentence came in (leadMs), and how much of the wait for the
  // local judge was already over by then (savedMs) against what was still waited (waitMs). Never the words.
  'speech.head_start': ['leadMs', 'savedMs', 'waitMs'],
  // A lesson step moved on the help ladder (lib/ladder.js): which step, the rung it left and the
  // one it is on (0 to 5), and what caused it ('start', 'idle', 'wrong', 'done', 'stuck', 'do',
  // 'frustrated'). Never what was said.
  'lesson.rung': ['step', 'rung', 'from', 'trigger'],
  // A lesson changed its mode ('guide', 'show' or 'do'), and a step that carried a story passed:
  // which step, and whether the story was told. Never the story.
  'lesson.mode': ['step', 'mode'],
  'lesson.story': ['step', 'told'],
  // A turn's milestones (lib/trace.ts logEvent). Never slow_notice's `text`.
  'turn.start': ['source', 'model'],
  'turn.first_speech': ['ms'],
  'turn.first_sound': ['ms'],
  'turn.merged': ['into'],
  'turn.repeat_held': [],
  'turn.next_dropped': ['count'],
  'turn.catch_up': ['count'],
  'turn.slow_notice': [],
  // Echo said a short word at once because the turn began with a tool: how far in, and which tool.
  'turn.ack': ['ms', 'tool'],
  'turn.status_answer': [],
  'turn.end': ['ms', 'requests', 'ctx', 'spoke', 'spokenChars', 'textChars', 'brief', 'quiet', 'folded', 'into'],
  'turn.dropped': ['reason'],
  // Model calls (lib/rotation.js logTiming).
  // textMs: from sending the call to its first words; thinkMs: how long it thought before them.
  'model.request': ['model', 'ctx', 'cacheRead', 'cacheWrite', 'input', 'firstMs', 'textMs', 'thinkMs', 'ms'],
  'model.turn': ['ms', 'requests', 'ctx', 'maxCtx', 'turns', 'model', 'spokenChars', 'textChars', 'firstSpeakMs', 'brief', 'handoff'],
  'model.rotate': ['reason', 'fromCtx', 'turns', 'summaryChars'],
  'model.turn_lost.drop': [],
  'model.api_retry.error': ['attempt', 'status', 'delayMs'],
  'model.rate_limit': ['status', 'limit', 'utilization'],
  'model.read': [],
  'model.local': ['kind', 'ok', 'ms'],
  'model.pick': ['model', 'weight'],
  'model.quick_blocked': ['tool'],
};
/**
 * Whole families with one list: the computer log and the screen log (never a target, a window, typed text or a goal).
 * A spreadsheet tool (mac.sheet) is its name and how many cells it covered (`tool`, `cells`), never what a cell holds.
 * An everyday-app tool (mac.app: Finder, Notes, Mail, …) is its name and how many things it read or touched (`tool`, `count`),
 * never a file's name, a subject or a word of a note.
 */
const FAMILY: Array<[string, readonly string[]]> = [
  ['mac.', ['run', 'step', 'steps', 'action', 'role', 'via', 'ok', 'verified', 'ms', 'score', 'why', 'category', 'by', 'kind', 'chars', 'found', 'pass', 'points', 'reached', 'done', 'request', 'details', 'reason', 'weak', 'tool', 'cells', 'count', 'fallback', 'checked', 'pageFocus']],
  ['screen.', ['source', 'via', 'found', 'reason', 'image', 'redactions', 'kind', 'ms', 'attempt']],
];
/** A type nobody listed (another part of Echo added it later) still shows when it happened and how long it took. */
const UNLISTED: readonly string[] = ['ms', 'ok', 'count', 'tool', 'name'];
const TYPE_OK = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;
const TOKEN = /^[\w.:-]{1,80}$/;
const TRACE_OK = /^[\w-]{1,40}$/;
/** Types that still get written once the day's file is full: the things that went wrong. */
const PROBLEM = /\.(error|drop|timeout)$/;
/** What the report for a helper shows (lib/diagnostics.js recentProblems). */
const REPORTED = /\.(error|drop|timeout|refused)$/;

export const timelineDir = (dataDir: string = config.dataDir): string => path.join(dataDir, 'timeline');
const dayOf = (now: number): string => new Date(now).toLocaleDateString('en-CA', { timeZone: config.timezone });

/** The fields of `raw` this type may carry, made safe. */
export function safeFields(type: string, raw: unknown): Row['f'] {
  const out: Row['f'] = {};
  if (!raw || typeof raw !== 'object') return out;
  const listed = FIELDS[type] ?? FAMILY.find(([prefix]) => type.startsWith(prefix))?.[1];
  for (const k of listed ?? UNLISTED) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string' && v) {
      const s = v.replace(/\s+/g, ' ').trim().slice(0, MAX_STRING);
      // On a type nobody listed, a string must be one word (a name), so a sentence can't ride along.
      if (s && (listed || TOKEN.test(s))) out[k] = s;
    }
  }
  return out;
}

/** Where today's file stands. Read from the file once a day (and at start-up), then kept here. */
let state: { dir: string; day: string; bytes: number; truncated: boolean } | null = null;
let seq = 0;

/** The last `seq` written to a file, from its final line. */
function lastSeq(file: string, size: number): number {
  if (!size) return 0;
  const fd = fs.openSync(file, 'r');
  try {
    const len = Math.min(size, 4096);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const n = Number(JSON.parse(lines[i] as string).seq);
        if (Number.isFinite(n)) return n;
      } catch {}
    }
  } finally {
    fs.closeSync(fd);
  }
  return 0;
}

/** Delete day files older than the days kept. Returns how many went. */
export function prune(dataDir: string = config.dataDir, now: number = Date.now()): number {
  let gone = 0;
  try {
    const oldest = dayOf(now - (limits.days - 1) * 86_400_000);
    for (const name of fs.readdirSync(timelineDir(dataDir))) {
      const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
      if (m && (m[1] as string) < oldest) {
        fs.rmSync(path.join(timelineDir(dataDir), name), { force: true });
        gone++;
      }
    }
  } catch {}
  return gone;
}

/** Today's file ready to append to: made, measured, and old days pruned (at start-up and each new day). */
function open(now: number): NonNullable<typeof state> {
  const dir = timelineDir();
  const day = dayOf(now);
  if (state && state.dir === dir && state.day === day) return state;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${day}.jsonl`);
  const bytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
  // A new day's empty file carries on counting; after a restart it carries on from the last line.
  seq = Math.max(state && state.dir === dir ? seq : 0, lastSeq(file, bytes));
  prune(config.dataDir, now);
  state = { dir, day, bytes, truncated: bytes >= limits.maxBytes };
  return state;
}

/**
 * Add one event. Never throws: recording must not get in the way of what it records.
 * @param extra the sender's own clock and count (the app and the page), and `now` for tests
 */
export function record(src: Src, type: string, fields?: unknown, trace?: string, extra: { cts?: unknown; cseq?: unknown; now?: number } = {}): void {
  try {
    if (!['app', 'page', 'server'].includes(src) || typeof type !== 'string' || type.length > 60 || !TYPE_OK.test(type)) return;
    const now = extra.now ?? Date.now();
    const st = open(now);
    const write = (row: Row) => {
      const line = JSON.stringify(row) + '\n';
      fs.appendFileSync(path.join(st.dir, `${st.day}.jsonl`), line);
      st.bytes += Buffer.byteLength(line);
    };
    const full = st.bytes >= limits.maxBytes;
    if (full && !st.truncated) {
      st.truncated = true;
      write({ ts: new Date(now).toISOString(), seq: ++seq, src: 'server', type: 'timeline.truncated', f: {} });
    }
    // A full day keeps only what went wrong, and even that stops at twice the size.
    if (full && (!PROBLEM.test(type) || st.bytes >= limits.maxBytes * 2)) return;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined);
    const cts = num(extra.cts);
    const cseq = num(extra.cseq);
    write({
      ts: new Date(now).toISOString(),
      seq: ++seq,
      src,
      type,
      ...(typeof trace === 'string' && TRACE_OK.test(trace) ? { trace } : {}),
      f: safeFields(type, fields),
      ...(cts !== undefined ? { cts } : {}),
      ...(cseq !== undefined ? { cseq } : {}),
    });
  } catch {}
}

/**
 * Events the app or the page sent over its socket: `[{ type, f, cts, cseq, trace? }]`, at most
 * MAX_BATCH of them. Returns how many were taken.
 */
export function ingest(src: 'app' | 'page', events: unknown): number {
  if (!Array.isArray(events)) return 0;
  let n = 0;
  for (const e of events.slice(0, MAX_BATCH)) {
    if (!e || typeof e !== 'object' || typeof e.type !== 'string') continue;
    record(src, e.type, e.f, e.trace, { cts: e.cts, cseq: e.cseq });
    n++;
  }
  return n;
}

/* ---------- the older logs feed it too (safe fields only) ---------- */

const TURN_TYPES: Record<string, string> = { turn_start: 'turn.start', turn_end: 'turn.end' };
const TIMING_TYPES: Record<string, string> = { turn_lost: 'model.turn_lost.drop', api_retry: 'model.api_retry.error', model: 'model.pick' };
const named = (prefix: string, raw: unknown, map: Record<string, string> = {}): string => {
  const t = String(raw || '');
  return map[t] ?? `${prefix}.${t}`;
};
type Entry = Record<string, unknown> | null | undefined;
const traceOf = (e: Entry): string | undefined => (typeof e?.trace === 'string' ? e.trace : undefined);

/** A turn's milestone (lib/trace.ts logEvent). */
export const fromEvent = (e: Entry): void => record('server', named('turn', e?.type, TURN_TYPES), e, traceOf(e));
/** A model call, a turn or a rotation (lib/rotation.js logTiming). */
export const fromTiming = (e: Entry): void => record('server', named('model', e?.type, TIMING_TYPES), e, traceOf(e));
/** A line of the computer log (lib/computer.js record). A step that didn't happen is an error. */
export const fromComputer = (e: Entry): void => record('server', `${named('mac', e?.event)}${e?.ok === false ? '.error' : ''}`, e, traceOf(e));
/**
 * A line of the screen log (lib/screen.js record). `screen_look_failed` becomes `.error` and
 * `screen_timeout` becomes `.timeout`, so both count as things that went wrong (PROBLEM, REPORTED).
 */
export const fromScreen = (e: Entry): void => record('server', named('screen', String(e?.event || '').replace(/_failed$/, '.error').replace(/_timeout$/, '.timeout')), e);

/* ---------- reading it back ---------- */

/** The time an event happened: the sender's own clock when it gave one. */
export const when = (r: Row): number => (typeof r.cts === 'number' ? r.cts : Date.parse(r.ts));

/** Rows from `since` to `until` (ms), in the order they happened. */
export function readTimeline(dataDir: string = config.dataDir, since: number = 0, until: number = Date.now()): Row[] {
  const rows: Row[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(timelineDir(dataDir)).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();
  } catch {}
  // A day either side, so no time zone can hide a row.
  const from = new Date(since - 2 * 86_400_000).toISOString().slice(0, 10);
  for (const name of names) {
    if (name.slice(0, 10) < from) continue;
    let text = '';
    try {
      text = fs.readFileSync(path.join(timelineDir(dataDir), name), 'utf8');
    } catch {}
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const r = JSON.parse(line) as Row;
        if (!r || typeof r.type !== 'string' || typeof r.ts !== 'string') continue;
        const t = when(r);
        if (t >= since && t <= until) rows.push({ ...r, f: r.f && typeof r.f === 'object' ? r.f : {} });
      } catch {}
    }
  }
  return rows.sort((a, b) => when(a) - when(b) || a.seq - b.seq);
}

/** The last things that went wrong, for the report (lib/diagnostics.js). */
export function recentProblems(dataDir: string = config.dataDir, max: number = 60, now: number = Date.now()): Array<Pick<Row, 'ts' | 'src' | 'type' | 'f'> & { trace?: string }> {
  return readTimeline(dataDir, now - limits.days * 86_400_000, now)
    .filter((r) => REPORTED.test(r.type))
    .slice(-max)
    .map((r) => ({ ts: r.ts, src: r.src, type: r.type, ...(r.trace ? { trace: r.trace } : {}), f: r.f }));
}
