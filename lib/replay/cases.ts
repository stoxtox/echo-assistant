// Every sentence Echo has ever heard, rebuilt as a replay case: what was said, the situation it was
// said in (which mic, whether Echo was working on the Mac, the conversation just before), what Echo
// decided then, and a label for what it should have decided. The label comes from evidence in the
// logs, so nobody has to sit and label recordings:
//
//   repeated   it was set aside, and the user said it again within 2 minutes and that got through  → for Echo
//   noise      a sound token ("*sad*") or a lone filler ("um", "Th.")                              → not for Echo
//   answered   it reached Echo, Echo answered, and the user carried on the conversation           → for Echo
//   addressed  set aside, but worded to Echo ("can you…", "why did you…", "keep going")           → for Echo (weaker)
//   (none)     not clear: left out of the score rather than guessed
//
// A labelled set the user corrects later (data/listening/labels.json) takes precedence.
import fs from 'node:fs';
import path from 'node:path';

export type Label = 'for_echo' | 'not_for_echo';
export type LabelSource = 'user' | 'repeated' | 'noise' | 'answered' | 'addressed';
export type Decision = 'deliver' | 'drop' | 'hold';

export type ReplayCase = {
  at: string;
  text: string;
  mode: string;
  clarity: 'ok' | 'low' | 'unknown';
  loud: unknown;
  quiet: boolean | undefined;
  mediaPlaying: boolean;
  sinceReplyMs?: number;
  /** What Echo decided at the time. */
  logged: Decision;
  /** The situation then. */
  recent: string[];
  driving: boolean;
  label?: Label;
  labelSource?: LabelSource;
  rec?: string;
};

type Line = Record<string, any> & { at: string };

function readJsonl(file: string): Line[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').flatMap((l) => {
    try {
      const v = JSON.parse(l);
      return v && typeof v === 'object' && typeof v.at === 'string' ? [v as Line] : [];
    } catch {
      return [];
    }
  });
}

const STOP = new Set("a an the to and of is it i you me my this that in on for be do can just so we what with at are was yeah okay ok um uh like it's i'm".split(' '));
export const words = (s: string): string[] => String(s || '').toLowerCase().match(/[a-z0-9']+/g) || [];
const content = (s: string) => new Set(words(s).filter((w) => !STOP.has(w)));
/** Share of the first sentence's content words that are in the second. */
export function overlap(a: string, b: string): number {
  const A = content(a);
  if (A.size < 2) return 0;
  const B = content(b);
  return [...A].filter((w) => B.has(w)).length / A.size;
}

/** A sound the recognizer wrote down ("*sad*", "[music]"), not words. */
const NOISE = /^\s*[*[(].*[*\])]\s*$/;
/** One word that's only a filler or a cut-off fragment ("um", "Th.", "Or..."); real one-word replies ("yes", "stop") aren't. */
const FILLERS = new Set(['um', 'uh', 'hmm', 'mm', 'mhm', 'ah', 'oh', 'eh', 'th', 'or', 'so', 'the', 'and', 'a', 'but', 'gloss']);
/** Worded to Echo: a request, a question to "you", a reply to its work. */
export const ADDRESSED = /\b(can you|could you|would you|will you|please|open|close|click|go|send|show|tell|find|search|play|pause|stop|make|check|why|how|where|did you|do you|are you|let'?s|i want|i need|try|fix|review|look|scroll|type|delete|keep going|continue|next|echo|you)\b/i;

/** The conversation, as "User: …"/"Assistant: …" lines with their times (data/conversations/*.md). */
export function conversationLines(dir: string): Array<{ t: number; line: string }> {
  if (!fs.existsSync(dir)) return [];
  const out: Array<{ t: number; line: string }> = [];
  for (const f of fs.readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.md$/.test(x)).sort()) {
    const day = f.slice(0, 10);
    const re = /^\*\*\[(\d{1,2}):(\d{2}):(\d{2}) ([AP]M)\] (User|Assistant):\*\*\s*(.*)$/;
    for (const raw of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      const m = re.exec(raw);
      if (!m) continue;
      let h = Number(m[1]) % 12;
      if (m[4] === 'PM') h += 12;
      const t = new Date(`${day}T${String(h).padStart(2, '0')}:${m[2]}:${m[3]}`).getTime();
      out.push({ t, line: `${m[5]}: ${m[6]}` });
    }
  }
  return out;
}

/** When Echo was working on the Mac: [start, end] of each computer-use run (computer-log.jsonl). */
export function drivingWindows(lines: Line[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const open = new Map<string, number>();
  for (const l of lines) {
    if (l.event === 'run_started' && l.run) open.set(l.run, Date.parse(l.at));
    if (l.event === 'run_ended' && l.run && open.has(l.run)) {
      out.push([open.get(l.run) as number, Date.parse(l.at)]);
      open.delete(l.run);
    }
  }
  return out;
}

/**
 * Build the cases from a data folder (copies of Echo's logs work too).
 * @param opts.userLabels rec id → label, from the user's own labelling (wins over everything)
 */
export function buildCases(dataDir: string, { userLabels = {} as Record<string, { forEcho: boolean }> } = {}): ReplayCase[] {
  const stt = readJsonl(path.join(dataDir, 'stt-log.jsonl'));
  const convo = conversationLines(path.join(dataDir, 'conversations'));
  const windows = drivingWindows(readJsonl(path.join(dataDir, 'computer-log.jsonl')));
  const cases: ReplayCase[] = [];
  for (const l of stt) {
    const isEntry = !l.event && typeof l.raw === 'string';
    const decision: Decision | null = isEntry ? 'deliver' : l.event === 'run_ignored' || l.event === 'not_for_echo' ? 'drop' : l.event === 'run_held' ? 'hold' : null;
    const text = String(isEntry ? l.raw : l.text || '').trim();
    if (!decision || !text) continue;
    const t = Date.parse(l.at);
    const mode = String(isEntry ? l.audio?.mode || '' : l.mode || '');
    // Whisper's own text is clear; the live preview's isn't measured.
    const clarity: ReplayCase['clarity'] = isEntry ? (l.stages?.source === 'live' ? 'unknown' : 'ok') : l.clarity || 'unknown';
    const prior = convo.filter((c) => c.t < t - 500);
    const before = prior.slice(-6).map((c) => c.line);
    // When Echo finished speaking, roughly: its reply was logged as the text ended, and speaking it
    // takes about a second per 15 characters.
    const lastReply = prior.findLast((c) => c.line.startsWith('Assistant: '));
    const estSince = lastReply ? t - (lastReply.t + ((lastReply.line.length - 11) / 15) * 1000) : NaN;
    cases.push({
      at: l.at,
      text,
      mode,
      clarity,
      loud: isEntry ? l.audio?.loud ?? null : l.loud ?? null,
      quiet: isEntry ? l.audio?.quiet : undefined,
      mediaPlaying: Boolean(isEntry ? l.audio?.mediaPlaying : l.mediaPlaying),
      ...(typeof l.sinceReplyMs === 'number' ? { sinceReplyMs: l.sinceReplyMs } : Number.isFinite(estSince) && estSince >= 0 && estSince < 600_000 ? { sinceReplyMs: Math.round(estSince) } : {}),
      logged: decision,
      recent: before,
      driving: windows.some(([a, b]) => t >= a && t <= b + 1000),
      ...(l.rec ? { rec: l.rec } : {}),
    });
  }
  labelCases(cases, convo, userLabels);
  return cases;
}

/** Give each case a label from the evidence (see the top of this file). */
export function labelCases(cases: ReplayCase[], convo: Array<{ t: number; line: string }> = [], userLabels: Record<string, { forEcho: boolean }> = {}): void {
  for (const [i, c] of cases.entries()) {
    const t = Date.parse(c.at);
    const user = c.rec ? userLabels[c.rec] : undefined;
    if (user) {
      c.label = user.forEcho ? 'for_echo' : 'not_for_echo';
      c.labelSource = 'user';
      continue;
    }
    const w = words(c.text);
    if (NOISE.test(c.text) || w.length === 0 || (w.length === 1 && FILLERS.has(w[0] as string))) {
      c.label = 'not_for_echo';
      c.labelSource = 'noise';
      continue;
    }
    if (c.logged !== 'deliver') {
      // Said again within 2 minutes (not the same sentence logged twice by two mics), and then it got through.
      const again = cases.slice(i + 1).find((d) => {
        const dt = Date.parse(d.at) - t;
        return dt > 3000 && dt <= 120_000 && d.logged === 'deliver' && overlap(c.text, d.text) >= 0.5;
      });
      if (again) {
        c.label = 'for_echo';
        c.labelSource = 'repeated';
      } else if (w.length >= 3 && ADDRESSED.test(c.text) && !c.mediaPlaying) {
        c.label = 'for_echo';
        c.labelSource = 'addressed';
      }
      continue;
    }
    // Delivered: Echo answered within a minute, and the user's next words (within 3 minutes) weren't "that wasn't for you".
    const reply = convo.find((x) => x.t >= t - 1000 && x.t <= t + 60_000 && x.line.startsWith('Assistant: '));
    const next = convo.find((x) => x.t > t + 1000 && x.t <= t + 180_000 && x.line.startsWith('User: '));
    if (reply && next && !/\b(not (talking )?(to|for) you|wasn'?t (talking )?(to|for) you|ignore that|never ?mind)\b/i.test(next.line)) {
      c.label = 'for_echo';
      c.labelSource = 'answered';
    }
  }
}
