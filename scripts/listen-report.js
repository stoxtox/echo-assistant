#!/usr/bin/env node
// How well Echo hears you, from your own recordings (lib/recordings.js) and your labels
// (scripts/listen-review.js): what happened to each sentence, how many meant for Echo never
// reached it, how many not meant for it were answered, how many words were heard wrong, how long
// it took, and how often the same sentence went through twice.
//
//   node scripts/listen-report.js [--since 2026-10-02] [--export DIR]
//   --export DIR writes the labelled clips for scripts/stt-bench.js (DIR/clips.txt + DIR/<id>.wav),
//   to compare speech engines on your voice.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../lib/config.js';
import { recordingsDir, labelsFile, recordingFate, wordErrors } from '../lib/recordings.js';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const since = flag('--since') ? Date.parse(flag('--since')) : 0;
if (Number.isNaN(since)) { console.error('--since needs a date, like --since 2026-10-02'); process.exit(2); }

const logFile = path.join(config.dataDir, 'stt-log.jsonl');
const lines = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : [];
/** @type {Map<string, any[]>} */
const byRec = new Map();
for (const l of lines) if (l.rec && Date.parse(l.at) >= since) byRec.set(l.rec, [...(byRec.get(l.rec) || []), l]);
let labels = {};
try { labels = JSON.parse(fs.readFileSync(labelsFile(), 'utf8')); } catch {}

const recs = [...byRec.entries()].map(([rec, ls]) => ({ rec, ...recordingFate(ls), label: labels[rec] }));
if (!recs.length) {
  console.log('No recordings yet. Turn on Settings → Privacy & safety → "Keep voice recordings on this Mac", talk to Echo for a while, then label some: node scripts/listen-review.js');
  process.exit(0);
}
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '-');
const q = (xs, p) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const sec = (ms) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(2)} s` : '-');
const count = (xs, f) => xs.filter(f).length;

console.log(`Echo's listening${since ? ` since ${flag('--since')}` : ''}: ${recs.length} recordings, ${count(recs, (r) => r.label)} labelled\n`);
console.log('What happened to each sentence');
for (const [fate, label] of [['reached', 'reached Echo'], ['set_aside', 'set aside as not for Echo'], ['no_text', 'no words came out'], ['own_voice', "taken for Echo's own voice"], ['heard_twice', 'dropped as a duplicate'], ['wake_only', 'just "Hey Echo"'], ['unknown', 'unclear']]) {
  const n = count(recs, (r) => r.fate === fate);
  if (n) console.log(`  ${label.padEnd(28)} ${String(n).padStart(5)}  ${pct(n, recs.length).padStart(4)}`);
}
const modes = [...new Set(recs.map((r) => r.mode || 'unknown'))];
console.log(`  by mic: ${modes.map((m) => { const rs = recs.filter((r) => (r.mode || 'unknown') === m); return `${m} ${count(rs, (r) => r.fate === 'reached')}/${rs.length} reached`; }).join(' · ')}`);

const labelled = recs.filter((r) => r.label);
if (labelled.length) {
  const meant = labelled.filter((r) => r.label.forEcho);
  const notMeant = labelled.filter((r) => !r.label.forEcho);
  const lost = meant.filter((r) => r.fate !== 'reached');
  const answered = notMeant.filter((r) => r.fate === 'reached');
  console.log(`\nFrom your ${labelled.length} labels`);
  console.log(`  meant for Echo, but it never got them   ${String(lost.length).padStart(4)} of ${meant.length}  ${pct(lost.length, meant.length)}   (goal: under 1%)`);
  console.log(`  not meant for Echo, but it answered     ${String(answered.length).padStart(4)} of ${notMeant.length}  ${pct(answered.length, notMeant.length)}   (goal: under 3%)`);
  for (const r of lost.slice(0, 8)) console.log(`    lost: “${r.label.said || r.heard}” (${r.fate}${r.why ? `, ${r.why}` : ''}, ${r.mode})`);
  // Words: only clips where something was said.
  const spoken = labelled.filter((r) => r.label.said);
  const tally = (pick) => spoken.reduce((t, r) => { const e = wordErrors(r.label.said, pick(r) || ''); return { errors: t.errors + e.errors, said: t.said + e.said }; }, { errors: 0, said: 0 });
  const used = tally((r) => r.heard), whisper = tally((r) => r.whisper), live = tally((r) => r.live);
  const exact = count(spoken, (r) => wordErrors(r.label.said, r.heard || '').errors === 0);
  console.log(`\nWords (${spoken.length} clips with speech)`);
  console.log(`  word error rate, what Echo used      ${pct(used.errors, used.said)}   exactly right: ${pct(exact, spoken.length)}`);
  if (whisper.said) console.log(`  word error rate, Whisper alone       ${pct(whisper.errors, whisper.said)}`);
  if (live.said) console.log(`  word error rate, the live preview    ${pct(live.errors, live.said)}`);
}

const reached = recs.filter((r) => r.fate === 'reached');
console.log('\nSpeed (sentences that reached Echo)');
console.log(`  speech to text      p50 ${sec(q(reached.map((r) => r.sttMs), 0.5))}   p90 ${sec(q(reached.map((r) => r.sttMs), 0.9))}   (goal: under 0.3 s)`);
console.log(`  word correction     p50 ${sec(q(reached.map((r) => r.fixMs), 0.5))}   p90 ${sec(q(reached.map((r) => r.fixMs), 0.9))}`);
let twice = 0;
for (let i = 1; i < reached.length; i++) {
  const a = reached[i - 1], b = reached[i];
  if (Date.parse(b.at) - Date.parse(a.at) < 15000 && a.heard && b.heard && wordErrors(a.heard, b.heard).errors <= 1) twice++;
}
console.log(`\nThe same sentence answered twice in a row   ${twice}   (goal: 0)`);

const out = flag('--export');
if (out) {
  fs.mkdirSync(out, { recursive: true });
  const rows = labelled.filter((r) => fs.existsSync(path.join(recordingsDir(), `${r.rec}.wav`)));
  for (const r of rows) fs.copyFileSync(path.join(recordingsDir(), `${r.rec}.wav`), path.join(out, `${r.rec}.wav`));
  fs.writeFileSync(path.join(out, 'clips.txt'), rows.map((r) => `${r.rec}|${r.mode || ''}|${String(r.label.said || '').replace(/[|\n]/g, ' ')}`).join('\n') + '\n');
  console.log(`\nExported ${rows.length} labelled clips to ${out} for scripts/stt-bench.js (--clips ${path.join(out, 'clips.txt')}).`);
}
