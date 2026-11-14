#!/usr/bin/env node
// Time to first spoken word, measured on the real model with representative turns.
//
//   node scripts/latency-bench.js [--from <data folder>] [--rounds 2] [--tts] [--only chat|hard|instant]
//                                 [--fast auto|off|<model>] [--json out.json]
//
// It runs the dispatcher on its own, in a throwaway data folder (a copy of memory, projects,
// settings and contact favorites from --from, so the prompt is the real size), and never touches
// the Mac: every AppleScript or shell call is a no-op and there is no screen bridge. For each turn
// it records how long from the moment the words go in to the first piece handed to the voice
// ("first piece"), and with --tts how long the local voice then takes to render it ("first
// audio"). Speech to text happens before this and isn't changed by the speed work, so it's left
// out. Needs a signed-in Claude Code (it makes real model calls, a few cents a run).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const flag = (name) => process.argv.includes(`--${name}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-bench-'));
const data = path.join(tmp, 'data');
const projects = path.join(tmp, 'projects');
for (const d of [data, projects, path.join(tmp, 'logs')]) fs.mkdirSync(d, { recursive: true });
const from = arg('from', '');
if (from) {
  for (const f of ['memory.md', 'projects.json', 'settings.json', 'contact-aliases.json', 'vocabulary.json']) {
    try {
      fs.copyFileSync(path.join(from, f), path.join(data, f));
    } catch {}
  }
  // The bench's own folder is the projects folder, whatever the copied settings say.
  try {
    const s = JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'));
    delete s.projectsDir;
    fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify(s, null, 2));
  } catch {}
}
Object.assign(process.env, {
  ECHO_DATA_DIR: data,
  ECHO_LOG_DIR: path.join(tmp, 'logs'),
  ECHO_ROOTS: projects,
  ECHO_RESEARCH_DIR: path.join(projects, '_research'),
  ECHO_WORKTREE_DIR: path.join(tmp, 'worktrees'),
  ECHO_TITLES: 'off',
});
if (arg('fast', null) !== null) {
  const f = path.join(data, 'settings.json');
  let s = {};
  try {
    s = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {}
  fs.writeFileSync(f, JSON.stringify({ ...s, fastModel: arg('fast', '') }, null, 2));
}

const { Dispatcher } = await import('../lib/dispatcher.js');
const { QuickActions } = await import('../lib/quick.js');

// Nothing reaches the Mac: every osascript or command returns empty.
const quick = new QuickActions({ exec: async () => '' });
const tasks = Object.assign(new (await import('node:events')).EventEmitter(), {
  list: () => [],
  get: () => null,
  isLive: () => false,
  isApprovalPending: () => false,
});
const d = new Dispatcher(/** @type {any} */ (tasks), null, quick, null);
d.computer.act = async () => ({ done: true });
// As if the Mac app were open with computer use on (nothing is really driven: act is a no-op).
d.computer.unavailable = () => null;
d.on('error', (e) => console.error('[bench] dispatcher error:', e.message));
d.start();

const ALL_TURNS = [
  { kind: 'chat', text: "hey, how's your day going?" },
  { kind: 'chat', text: "what's the capital of Australia?" },
  { kind: 'chat', text: 'any tasks running right now?' },
  { kind: 'chat', text: 'give me a one line pep talk' },
  { kind: 'chat', text: 'how many ounces are in a cup?' },
  { kind: 'hard', text: 'compare renting versus buying a home, in two sentences' },
  { kind: 'hard', text: 'plan a simple three step morning routine for me' },
  { kind: 'instant', text: 'pause' },
  { kind: 'instant', text: 'next song' },
  { kind: 'instant', text: 'stop' },
  { kind: 'instant', text: 'scroll down' },
];

// --only chat|hard|instant: just that kind (more rounds of it for a steadier median).
const TURNS = ALL_TURNS.filter((t) => !arg('only', '') || t.kind === arg('only', ''));
const timing = path.join(data, 'dispatcher-timing.jsonl');
const logLines = () => {
  try {
    return fs.readFileSync(timing, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

let tts = null;
if (flag('tts')) {
  const voice = await import('../lib/voice.js');
  tts = (text) => voice.synthesize({ text, provider: 'kokoro', voice: 'af_heart', speed: 1 });
  await tts('Ready.'); // load and warm the voice first
}

/** One turn: send, wait for the first thing said and the end of the turn. */
async function one(text) {
  const before = logLines().length;
  const t0 = performance.now();
  let first = null;
  let firstText = '';
  const onFirst = (t) => {
    if (first === null && String(t || '').trim()) {
      first = performance.now() - t0;
      firstText = String(t);
    }
  };
  d.on('speak', onFirst);
  d.on('say', onFirst);
  const done = new Promise((resolve) => {
    const end = () => {
      d.off('reply_end', end);
      resolve();
    };
    d.on('reply_end', end);
    setTimeout(end, 90_000);
  });
  const route = d.send(text);
  await done;
  const total = performance.now() - t0;
  // An instant command that answers with silence ("stop"): done is the moment it acted.
  if (first === null && route === 'local') first = total;
  d.off('speak', onFirst);
  d.off('say', onFirst);
  // Let the turn's log lines land.
  await new Promise((r) => setTimeout(r, 300));
  const lines = logLines().slice(before);
  const reqs = lines.filter((l) => l.type === 'request');
  let audio = null;
  if (tts && firstText) {
    const a0 = performance.now();
    await tts(firstText).catch(() => null);
    audio = first + (performance.now() - a0);
  }
  return { route, first, audio, total, firstText, models: [...new Set(reqs.map((r) => r.model))], ctx: reqs[0]?.ctx ?? null, requests: reqs.length };
}

const median = (xs) => {
  const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const sec = (ms) => (ms === null || ms === undefined ? '  -  ' : `${(ms / 1000).toFixed(2)}s`);

// Warm up: the first turn of a fresh session writes the prompt cache (a real session is warm).
await new Promise((r) => setTimeout(r, 1500));
process.stdout.write('warming up… ');
await one('hi, just checking you can hear me. one word answer please.');
console.log('done');

const rounds = Number(arg('rounds', '2'));
const results = [];
for (let r = 0; r < rounds; r++) {
  for (const t of TURNS) {
    const res = await one(t.text);
    results.push({ ...t, round: r + 1, ...res });
    console.log(`${t.kind.padEnd(7)} ${sec(res.first)} first piece  ${sec(res.audio)} first audio  ${sec(res.total)} turn  ${String(res.route).padEnd(5)} ${res.models.join('+') || 'no model'}  ctx ${res.ctx ?? '-'}  "${t.text}" -> "${res.firstText.slice(0, 50)}"`);
    await new Promise((res2) => setTimeout(res2, 400));
  }
}

console.log('\nMedians (time from the words going in to the first piece going to the voice):');
const summary = {};
for (const kind of ['chat', 'hard', 'instant', 'all']) {
  const rs = results.filter((x) => kind === 'all' || x.kind === kind);
  summary[kind] = { n: rs.length, first: median(rs.map((x) => x.first)), audio: median(rs.map((x) => x.audio)), turn: median(rs.map((x) => x.total)), ctx: median(rs.map((x) => x.ctx)) };
  console.log(`  ${kind.padEnd(8)} first piece ${sec(summary[kind].first)}  first audio ${sec(summary[kind].audio)}  whole turn ${sec(summary[kind].turn)}  context ${summary[kind].ctx ?? '-'} tokens  (n=${rs.length})`);
}
const out = arg('json', '');
if (out) fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), summary, results }, null, 2));
d.input?.close();
d.q?.close?.();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
