// Replays the cases (lib/replay/cases.ts) through the real decision (lib/pipeline/utterance.ts) and
// scores it: of the sentences meant for Echo, how many it would leave alone (false drops); of
// those not meant for it, how many it would take as a turn (false accepts). Also how often the
// replay reproduces what Echo actually decided at the time (fidelity): low fidelity means the
// rebuilt situation is missing something, and the scores can't be trusted.
//
// The judge is the rule-based one (lib/addressed.js). Live, an "unsure" verdict can still be
// settled by a local model; here it stays unsure (the "Was that for me?" chip), which counts as a drop.
import { decideUtterance, type Conversation, type Judge } from '../pipeline/utterance.ts';
import { judgeAddressee } from '../addressed.js';
import type { Decision, ReplayCase } from './cases.ts';

export type Outcome = ReplayCase & { decided: Decision };

const ruleJudge: Judge = async (o) => judgeAddressee(o as any);

export async function replay(cases: ReplayCase[], { wakeWord = true, judge = ruleJudge }: { wakeWord?: boolean; judge?: Judge } = {}): Promise<Outcome[]> {
  const out: Outcome[] = [];
  for (const c of cases) {
    const conv: Conversation = {
      recent: c.recent, driving: c.driving, busy: false, pendingCards: 0, pendingMessages: 0, lessonActive: false, wakeWord,
      now: Date.parse(c.at), ...(c.sinceReplyMs !== undefined ? { sinceReplyMs: c.sinceReplyMs } : {}),
    };
    const v = await decideUtterance(
      { text: c.text, page: { mode: c.mode, ...(c.sinceReplyMs !== undefined ? { sinceReplyMs: c.sinceReplyMs } : {}) }, clarity: c.clarity, loud: c.loud, quiet: c.quiet, mediaPlaying: c.mediaPlaying },
      conv,
      { judge },
    );
    out.push({ ...c, decided: v.kind });
  }
  return out;
}

type Counts = { forEcho: number; dropped: number; notForEcho: number; accepted: number };
const rate = (n: number, d: number) => (d ? n / d : 0);

export type Score = {
  cases: number;
  labelled: number;
  falseDropRate: number;
  falseAcceptRate: number;
  fidelity: number;
  counts: Counts;
  byMode: Record<string, Counts>;
  bySource: Record<string, Counts>;
  driving: Counts;
  falseDrops: Array<{ at: string; text: string; mode: string; driving: boolean }>;
};

function tally(xs: Outcome[]): Counts {
  const c: Counts = { forEcho: 0, dropped: 0, notForEcho: 0, accepted: 0 };
  for (const o of xs) {
    if (o.label === 'for_echo') {
      c.forEcho++;
      if (o.decided !== 'deliver') c.dropped++;
    } else if (o.label === 'not_for_echo') {
      c.notForEcho++;
      if (o.decided === 'deliver') c.accepted++;
    }
  }
  return c;
}

export function score(outcomes: Outcome[]): Score {
  const labelled = outcomes.filter((o) => o.label);
  const counts = tally(labelled);
  const group = (key: (o: Outcome) => string) => {
    const g: Record<string, Outcome[]> = {};
    for (const o of labelled) (g[key(o)] ||= []).push(o);
    return Object.fromEntries(Object.entries(g).map(([k, v]) => [k, tally(v)]));
  };
  // Fidelity: delivered vs not, compared with what Echo decided then (held counts as not delivered).
  const same = outcomes.filter((o) => (o.decided === 'deliver') === (o.logged === 'deliver')).length;
  return {
    cases: outcomes.length,
    labelled: labelled.length,
    falseDropRate: rate(counts.dropped, counts.forEcho),
    falseAcceptRate: rate(counts.accepted, counts.notForEcho),
    fidelity: rate(same, outcomes.length),
    counts,
    byMode: group((o) => o.mode || 'unknown'),
    bySource: group((o) => o.labelSource || 'none'),
    driving: tally(labelled.filter((o) => o.driving)),
    falseDrops: labelled.filter((o) => o.label === 'for_echo' && o.decided !== 'deliver').map((o) => ({ at: o.at, text: o.text.slice(0, 120), mode: o.mode, driving: o.driving })),
  };
}
