// Echo's timeline (lib/timeline.ts) in plain English: the wording of each event, what counts as slow
// or wrong, and where a turn's time went. Shared by the terminal viewer (scripts/timeline.ts) and the
// window's "What happened" view (GET /api/timeline), so both tell the same story. It only ever reads
// what the timeline holds: names, counts, durations and reasons, never words or what was on screen.
import { config } from './config.js';
import { when, type Row } from './timeline.ts';

/** A stretch with nothing on the timeline that's worth a line of its own. */
export const GAP_MS = 3000;
/** How long a step may take before it's marked slow (ms), by the field that holds its time. */
const SLOW: Record<string, [field: string, ms: number]> = {
  'model.request': ['firstMs', 2500],
  'turn.first_speech': ['ms', 3000],
  'turn.first_sound': ['ms', 4000],
  'turn.end': ['ms', 15000],
  'play.start': ['ms', 800],
  'page.ws.reconnect': ['ms', 3000],
  'model.local': ['ms', 1500],
};
/** Any other step with a time: slow past this. */
const SLOW_STEP_MS = 3000;
const WRONG = /\.(error|drop|timeout|refused)$|^(play\.stalled|timeline\.truncated|page\.error)$/;
/** The same turn written twice (lib/trace.ts and lib/rotation.js): shown once. */
export const HIDDEN = new Set(['model.turn', 'model.read']);

export const secs = (ms: unknown): string => {
  const n = Number(ms);
  return !Number.isFinite(n) ? '?' : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`;
};
type F = Row['f'];
const yes = (v: unknown, word: string): string => (v ? word : '');
const list = (...parts: string[]): string => {
  const p = parts.filter(Boolean);
  return p.length ? ` (${p.join(', ')})` : '';
};
const PERMISSIONS: Record<string, string> = { screen: 'screen recording', accessibility: 'accessibility', input: 'input monitoring', microphone: 'microphone' };
const PERMISSION_STATES: Record<string, string> = { allowed: 'allowed', notyet: 'not allowed yet', denied: 'denied' };

/** One event in plain English. */
const SAY: Record<string, (f: F) => string> = {
  'ptt.down': () => 'Key held (push-to-talk)',
  'ptt.up': (f) => `Key let go after ${secs(f.ms)}`,
  'ptt.spoiled': () => 'Key press was a shortcut, not talking',
  'mic.open': (f) => `Microphone opened${list(f.aec === false ? 'no echo cancelling' : '')}`,
  'mic.close': () => 'Microphone closed',
  'mic.error': (f) => `Microphone failed to start${list(String(f.domain || ''), f.code !== undefined ? `code ${f.code}` : '')}`,
  'mic.cancel': (f) => `Speech thrown away: ${String(f.reason || 'no reason given').replace(/_/g, ' ')}`,
  'gate.onset': (f) => `Speech started${list(String(f.label || ''), yes(f.echo, 'while Echo was speaking'))}`,
  'gate.end': (f) => `Speech ended: ${f.seconds ?? '?'} s long, peak ${f.peak ?? '?'}`,
  'overlay.show': (f) => `Overlay shown: ${f.name || '?'}${list(String(f.reason || ''))}`,
  'overlay.hide': (f) => `Overlay hidden: ${f.name || '?'}${list(String(f.reason || ''))}`,
  'body.retry': (f) => `Mac app is retrying its line to the server in ${f.delay ?? '?'} s`,
  'look.late': (f) => `A look at the screen finished late: taking the picture ${f.captureMs ?? '?'} ms, reading it ${f.readMs ?? '?'} ms`,
  'perm.state': (f) => {
    const off = Object.keys(PERMISSIONS).filter((k) => f[k] === false).map((k) => PERMISSIONS[k] as string);
    return off.length ? `Mac app started WITHOUT: ${off.join(', ')}` : 'Mac app started with every permission it needs';
  },
  'perm.change': (f) => {
    const now = [...Object.keys(PERMISSIONS), 'speech'].filter((k) => PERMISSION_STATES[String(f[k])])
      .map((k) => `${PERMISSIONS[k] ?? 'speech recognition'} ${PERMISSION_STATES[String(f[k])]}`);
    return `Mac permission changed: ${now.join(', ') || 'no details'}`;
  },
  'body.connect': () => "Mac app's line to the server is up",
  'body.drop': (f) => `Mac app's line to the server dropped after ${secs(f.ms)}`,
  'body.refused': (f) => `A connection posing as the Mac app was refused${list(f.reason === 'origin' ? 'came from a web page' : 'wrong token')}`,
  'page.ws.open': () => 'Page connected',
  'page.ws.close': (f) => `Page disconnected after ${secs(f.ms)}`,
  'page.ws.reconnect': (f) => `Page reconnected after ${secs(f.ms)} offline`,
  'page.error': (f) => `Error in the page${list(String(f.kind || ''))}`,
  'play.start': (f) => `Voice started playing${list(f.chars !== undefined ? `${f.chars} characters` : '', Number(f.ms) > 0 ? `audible in ${secs(f.ms)}` : '', yes(f.soft, 'soft'))}`,
  'play.end': () => 'Voice finished a piece',
  'play.stalled': () => 'Voice playback stalled and was cut off',
  'audio.fresh': (f) => `Sound output opened afresh${list(f.why ? `because: ${f.why}` : '', f.idleS !== undefined ? `quiet for ${f.idleS} s` : '', f.before !== f.after ? `${f.before} → ${f.after}` : '')}`,
  'timeline.truncated': () => "Today's timeline is full: only problems are kept from here",
  'turn.start': (f) => `Turn started${list(f.source === 'speech' ? 'spoken' : String(f.source || ''), f.model && f.model !== 'default' ? String(f.model) : '')}`,
  'turn.first_speech': (f) => `First words ready to speak, ${secs(f.ms)} into the turn`,
  'turn.first_sound': (f) => `Voice audible, ${secs(f.ms)} into the turn`,
  'turn.merged': () => 'Sentence joined the turn that was waiting',
  'turn.repeat_held': () => 'A repeat of the waiting sentence was held back',
  'turn.next_dropped': (f) => `Waiting sentences dropped${list(`${f.count ?? '?'}`)}`,
  'turn.catch_up': (f) => `Catch-up said${list(`${f.count ?? '?'} things`)}`,
  'turn.slow_notice': () => 'Echo said the reply is taking a while',
  'turn.ack': (f) => `Echo said a short word while its first tool started${list(String(f.tool || ''), f.ms !== undefined ? `${secs(f.ms)} into the turn` : '')}`,
  'speech.head_start': (f) => `Judging had a head start${list(f.leadMs !== undefined ? `began ${secs(f.leadMs)} before the sentence came in` : '', f.savedMs !== undefined ? `saved ${secs(f.savedMs)}` : '')}`,
  'turn.status_answer': () => 'Answered "can you hear me?" at once',
  'turn.tool_start': (f) => `Tool started: ${f.name || '?'}`,
  'turn.tool_end': (f) => `Tool finished: ${f.name || '?'}${list(f.ms !== undefined ? secs(f.ms) : '', f.ok === false ? 'failed' : '')}`,
  'turn.end': (f) => `Turn ended after ${secs(f.ms)}${list(`${f.requests ?? '?'} model calls`, f.spoke ? `spoke ${f.spokenChars ?? '?'} characters` : 'said nothing')}`,
  'model.request': (f) => `Model call finished${list(String(f.model || ''), `first word ${secs(f.firstMs)}`, `whole call ${secs(f.ms)}`, f.ctx !== undefined ? `${f.ctx} tokens of context` : '')}`,
  'model.rotate': (f) => `Fresh session started${list(String(f.reason || ''), f.fromCtx !== undefined ? `was ${f.fromCtx} tokens` : '')}`,
  'model.turn_lost.drop': () => 'A turn was lost before the model read it',
  'model.api_retry.error': (f) => `Model call failed and is being retried${list(f.attempt !== undefined ? `attempt ${f.attempt}` : '', f.status !== undefined ? `status ${f.status}` : '', f.delayMs !== undefined ? `waiting ${secs(f.delayMs)}` : '')}`,
  'model.rate_limit': (f) => `Rate limit notice${list(String(f.status || ''), String(f.limit || ''))}`,
  'model.local': (f) => `Handled without the big model${list(String(f.kind || ''), f.ok === false ? 'failed' : '', f.ms !== undefined ? secs(f.ms) : '')}`,
  'model.pick': (f) => `Model chosen: ${f.model || '?'}${list(String(f.weight || ''))}`,
  'model.quick_blocked': (f) => `A tool was held back from the quick model${list(String(f.tool || ''))}`,
  'mac.run_started': () => 'Echo started using the computer',
  'mac.run_ended': (f) => `Echo stopped using the computer${list(String(f.reason || ''), f.steps !== undefined ? `${f.steps} steps` : '')}`,
  'mac.action': (f) => `Computer step ${f.step ?? '?'}: ${String(f.action || 'action').replace(/_/g, ' ')}${list(f.ms !== undefined ? secs(f.ms) : '', f.verified === false ? 'not confirmed on screen' : '')}`,
  'mac.action.error': (f) => `Computer step ${f.step ?? '?'} did not happen: ${String(f.action || 'action').replace(/_/g, ' ')}`,
  'light.departed': (f) => `The light left ${f.from === 'target' ? 'for the next thing' : f.from === 'turned' ? 'again, turning round on its way home' : 'the pearl'}${list(f.ms !== undefined ? `flight ${secs(f.ms)}` : '')}`,
  'light.arrived': (f) => `The light landed${list(f.still ? 'no flight' : f.ms !== undefined ? secs(f.ms) : '')}`,
  'light.home': (f) => `The light went home${list(yes(f.working, 'in the middle of a job'), f.ms !== undefined ? `out for ${secs(f.ms)}` : '', f.stops !== undefined ? `showed ${f.stops}` : '')}`,
  'speech.synced': (f) => `A step's words went with the light${list(f.ms !== undefined ? `waited ${secs(f.ms)}` : '')}`,
  'screen.screen_looked': (f) => `Looked at the screen${list(String(f.source || ''))}`,
  'screen.screen_look.error': (f) => `Could not look at the screen${list(String(f.reason || ''))}`,
  'screen.pointed': (f) => `Pointed at something on screen${list(f.found === false ? 'not found' : '')}`,
  'screen.point.error': (f) => `Could not point${list(String(f.reason || ''))}`,
};

/** A type with no line of its own: its name in words, and whatever safe fields it carries. */
function fallback(r: Row): string {
  const [family = '', ...rest] = r.type.split('.');
  const what = rest.join(' ').replace(/_/g, ' ');
  const who = ({ mac: 'Computer use', screen: 'Screen', model: 'Model', turn: 'Turn', page: 'Page', body: 'Mac app line' } as Record<string, string>)[family] ?? family;
  const tool = typeof r.f.tool === 'string' ? r.f.tool : typeof r.f.name === 'string' ? r.f.name : '';
  const detail = Object.entries(r.f).filter(([k]) => !['tool', 'name', 'run', 'ms'].includes(k)).map(([k, v]) => `${k} ${v}`);
  return `${who}: ${what || 'event'}${tool ? ` ${tool}` : ''}${list(r.f.ms !== undefined ? secs(r.f.ms) : '', ...detail)}`;
}

export const describe = (r: Row): string => (SAY[r.type] ?? (() => fallback(r)))(r.f);

/** Is this step slow, or something that went wrong? */
export function mark(r: Row): string {
  if (WRONG.test(r.type)) return '  !! problem';
  // How long a key was held or a page stayed connected is not a step that took too long.
  if (r.type === 'ptt.up' || r.type === 'page.ws.close') return '';
  const [field, limit] = SLOW[r.type] ?? ['ms', SLOW_STEP_MS];
  const n = Number(r.f[field]);
  return Number.isFinite(n) && n > limit ? '  << slow' : '';
}

export const clock = (ms: number): string => {
  const d = new Date(ms);
  const t = d.toLocaleTimeString('en-GB', { timeZone: config.timezone, hour12: false });
  return `${t}.${String(d.getUTCMilliseconds()).padStart(3, '0')}`;
};

/** The last sentence heard in the half minute before a turn started: what the turn was made from. */
function heardBefore(start: Row, rows: Row[]): Row | undefined {
  // A typed turn was not made from speech, whatever the microphone heard just before it.
  if (start.f.source === 'typed' || start.f.source === 'event') return undefined;
  const t0 = when(start);
  return rows.filter((r) => (r.type === 'gate.end' || r.type === 'ptt.up') && when(r) <= t0 && t0 - when(r) < 30_000).pop();
}

/**
 * Where one turn's time went, part by part, from every row read (listening happens before the turn
 * has an id, so it is the speech that ended just before the turn started).
 */
export function turnParts(trace: string, rows: Row[]): { parts: string[]; total: number } {
  const mine = rows.filter((r) => r.trace === trace);
  const start = mine.find((r) => r.type === 'turn.start');
  const end = mine.find((r) => r.type === 'turn.end');
  const parts: string[] = [];
  const heard = start && heardBefore(start, rows);
  if (start && heard) {
    // How long you spoke, then how long it took to become a turn (speech recognition and the checks around it).
    const spoke = heard.type === 'gate.end' ? Number(heard.f.seconds) * 1000 : Number(heard.f.ms);
    if (Number.isFinite(spoke)) parts.push(`listening ${secs(spoke)}`);
    parts.push(`speech recognition ${secs(when(start) - when(heard))}`);
  }
  const requests = mine.filter((r) => r.type === 'model.request');
  const firstSpeech = mine.find((r) => r.type === 'turn.first_speech');
  const firstWord = firstSpeech ? Number(firstSpeech.f.ms) : Number(requests[0]?.f.firstMs);
  if (Number.isFinite(firstWord)) parts.push(`model first word ${secs(firstWord)}`);
  // Tools: their own timings when the turn logged them; otherwise the part of the turn spent
  // outside model calls, which is where tools run.
  const toolRows = mine.filter((r) => /tool/.test(r.type) || r.type.startsWith('mac.action') || r.type === 'model.local');
  const toolMs = toolRows.reduce((sum, r) => sum + (Number(r.f.ms) || 0), 0);
  const modelMs = requests.reduce((sum, r) => sum + (Number(r.f.ms) || 0), 0);
  const total = Number(end?.f.ms);
  if (toolMs > 0) parts.push(`tools ${secs(toolMs)}`);
  else if (requests.length && Number.isFinite(total)) parts.push(`tools ${secs(Math.max(0, total - modelMs))}`);
  const firstSound = mine.find((r) => r.type === 'turn.first_sound');
  if (firstSound && firstSpeech) parts.push(`voice ${secs(Math.max(0, Number(firstSound.f.ms) - Number(firstSpeech.f.ms)))}`);
  else if (firstSpeech) parts.push('voice never became audible');
  return { parts, total };
}

/** The same as one line, as the terminal viewer prints it after each turn. */
export function turnSummary(trace: string, rows: Row[]): string {
  const { parts, total } = turnParts(trace, rows);
  return `Where the time went: ${parts.join(', ') || 'nothing was timed'}${Number.isFinite(total) ? ` (turn ${secs(total)})` : ''}`;
}

/* ---------- the window's "What happened" view ---------- */

/** One line of a turn: an event in plain English, or a quiet stretch (`src` empty). `ms` is counted from the turn's start. */
export type Line = { time: string; ms: number; src: Row['src'] | ''; text: string; mark: '' | 'slow' | 'problem' };
export type Turn = {
  trace: string;
  /** When it started: ISO for the page's own use, and the clock time in Echo's time zone. */
  at: string;
  time: string;
  /** From the end of your sentence (a typed turn: from when it was sent) to Echo's first sound; null when it never spoke. */
  firstSoundMs: number | null;
  firstSound: string;
  summary: string;
  total: string;
  slow: boolean;
  problem: boolean;
  lines: Line[];
};

const flagOf = (r: Row): Line['mark'] => (mark(r).includes('problem') ? 'problem' : mark(r) ? 'slow' : '');

/**
 * The turns in these rows, newest first, each with its lines: everything carrying the turn's id,
 * plus what the Mac app and the page noted without one from the moment you started talking until
 * the turn's last event.
 * @param trace only this turn
 */
export function turnsView(all: Row[], trace?: string): Turn[] {
  const rows = all.filter((r) => !HIDDEN.has(r.type));
  const starts = rows.filter((r) => r.type === 'turn.start' && r.trace && (!trace || r.trace === trace));
  const turns: Turn[] = [];
  for (const start of starts) {
    const id = start.trace as string;
    const mine = rows.filter((r) => r.trace === id);
    const t0 = when(start);
    const heard = heardBefore(start, rows);
    // Listening began at the speech that led to this turn: its start, or a held key, just before it ended.
    const began = heard && rows.filter((r) => (r.type === 'gate.onset' || r.type === 'ptt.down') && when(r) <= when(heard) && when(heard) - when(r) < 60_000).pop();
    const from = Math.min(t0, heard ? when(began ?? heard) : t0);
    const to = Math.max(...mine.map(when));
    const shown = rows.filter((r) => r.trace === id || (!r.trace && when(r) >= from && when(r) <= to));
    const lines: Line[] = [];
    let last = NaN;
    for (const r of shown) {
      const t = when(r);
      if (t - last >= GAP_MS) lines.push({ time: '', ms: Math.round(last - t0), src: '', text: `${secs(t - last)} with nothing happening`, mark: '' });
      last = t;
      lines.push({ time: clock(t), ms: Math.round(t - t0), src: r.src, text: describe(r), mark: flagOf(r) });
    }
    const sound = mine.find((r) => r.type === 'turn.first_sound');
    const firstSoundMs = sound && Number.isFinite(Number(sound.f.ms)) ? Math.round(Number(sound.f.ms) + (heard ? t0 - when(heard) : 0)) : null;
    const { parts, total } = turnParts(id, all);
    // Only its own events make a turn slow or broken: a dropped line nearby is not this turn's doing.
    const flags = mine.map(flagOf);
    turns.push({
      trace: id,
      at: new Date(t0).toISOString(),
      time: clock(t0).slice(0, 8),
      firstSoundMs,
      firstSound: firstSoundMs === null ? 'No sound' : `First sound after ${secs(firstSoundMs)}`,
      summary: parts.join(', ') || 'nothing was timed',
      total: Number.isFinite(total) ? secs(total) : '',
      slow: flags.includes('slow'),
      problem: flags.includes('problem'),
      lines,
    });
  }
  return turns.reverse();
}

/** "10m", "30s", "2h", "1d" as milliseconds (a bare number is minutes). */
export function span(text: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([smhd]?)$/.exec(String(text).trim());
  if (!m) return NaN;
  return Number(m[1]) * ({ s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] || 'm'] as number);
}

/** The start of today in Echo's time zone (ms). */
export function todayStart(now: number = Date.now()): number {
  const [h = 0, m = 0, s = 0] = new Date(now).toLocaleTimeString('en-GB', { timeZone: config.timezone, hour12: false }).split(':').map(Number);
  return now - ((h % 24) * 3_600_000 + m * 60_000 + s * 1000) - (now % 1000);
}

/** Where a view starts: "today", or a span back from now ("10m", "1h"). NaN when it is neither. */
export const sinceWhen = (text: string, now: number = Date.now()): number => (text === 'today' ? todayStart(now) : now - span(text));
