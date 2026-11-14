// A report for whoever helps you with Echo (Stage 9, for testers): what version, which new ways of
// working are on, how the last week went (the scorecard's numbers), and the recent errors, with
// secrets and home folders blacked out and nothing anyone said in it. It's shown in full before it's
// saved, it's saved to the Downloads folder, and it's never sent anywhere: you choose who gets it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, APP_DIR } from './config.js';
import { LOG } from './legacy.js';
import { allFlags } from './flags.ts';
import { redactText } from './screen.js';
import { scorecard } from './scorecard.ts';
import { recentProblems } from './timeline.ts';

/** Log lines worth a look: errors and warnings, not what was said. */
const PROBLEM = /\b(error\w*|failed|failure|exception|timed? ?out|refused|denied|crash\w*|abort(ed)?|unhandled|ECONN\w*|ENOENT|EADDRINUSE)\b/i;
/** Log lines that carry what someone said or typed: never in the report (listening's own lines, [stt] and [wake], quote it). */
const SPEECH = /\b(heard|said|user[:_ ]|text[=:]|transcript|utterance:|"text")\b|\[(stt|wake|speech|heard)\]/i;

/** A line made safe to share: secrets blacked out, the home folder as ~, kept short. */
export function safeLine(line) {
  const home = os.homedir();
  // Anything in quotes may be someone's words (a file name, a message, a sentence): left out.
  const unquoted = String(line).replace(/"(?:[^"\\]|\\.)*"|“[^”]*”|‘[^’]*’/g, '"…"');
  return redactText(unquoted.split(home).join('~')).text.replace(/\/Users\/[^/\s]+/g, '/Users/…').slice(0, 300);
}

/**
 * The report.
 * @param {{ dataDir?: string, logDir?: string, now?: number }} [o]
 */
export function buildReport({ dataDir = config.dataDir, logDir = config.logDir, now = Date.now() } = {}) {
  let version = '';
  try {
    version = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
  } catch {}
  let errors = [];
  try {
    errors = fs.readFileSync(path.join(logDir, LOG), 'utf8').split('\n').filter((l) => PROBLEM.test(l) && !SPEECH.test(l)).slice(-60).map(safeLine);
  } catch {}
  let week = null;
  try {
    const r = scorecard(dataDir, now - 7 * 86_400_000, now);
    week = { days: r.days, spokenTurns: r.spokenTurns, metrics: r.metrics.map((m) => ({ id: m.id, name: m.name, value: m.shown, target: m.target, met: m.met })) };
  } catch {}
  // What went wrong lately on the timeline (lib/timeline.ts): kinds, counts and durations, no words.
  let problems = [];
  try {
    problems = recentProblems(dataDir, 60, now).map((r) => ({ ...r, f: Object.fromEntries(Object.entries(r.f).map(([k, v]) => [k, typeof v === 'string' ? safeLine(v) : v])) }));
  } catch {}
  return {
    kind: 'echo-report',
    made: new Date(now).toISOString(),
    echo: version,
    macOS: os.release(),
    node: process.versions.node,
    arch: process.arch,
    flags: allFlags().map((f) => ({ name: f.name, on: f.on, source: f.source })),
    lastWeek: week,
    recentErrors: errors,
    recentProblems: problems,
  };
}

/** Where a report is saved: the Downloads folder (the home folder if there's none). */
export function reportFile(now = Date.now(), home = os.homedir()) {
  const dir = fs.existsSync(path.join(home, 'Downloads')) ? path.join(home, 'Downloads') : home;
  return path.join(dir, `Echo report ${new Date(now).toISOString().slice(0, 16).replace('T', ' ').replace(':', '.')}.json`);
}
