#!/usr/bin/env node
// Label your own recordings (lib/recordings.js), so Echo's listening is measured on your voice
// (scripts/listen-report.js). Each clip plays on this Mac, then two questions:
//   1. Was it meant for Echo?            y / n   (r replays, s skips, q quits)
//   2. Did Echo get the words right?     Enter if yes, or type what you actually said
//                                        ("-" if nothing was said: a cough, the room, the TV)
// Labels are saved after every answer, in data/listening/labels.json. Clips Echo set aside or
// couldn't transcribe come first, then the rest, newest first.
//
//   node scripts/listen-review.js [--since 2026-10-02] [--limit 40] [--redo] [--no-play]
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { config } from '../lib/config.js';
import { recordingsDir, labelsFile, recordingFate } from '../lib/recordings.js';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const since = flag('--since') ? Date.parse(flag('--since')) : 0;
const limit = Number(flag('--limit')) || 40;
const play = !args.includes('--no-play');

const lines = fs.existsSync(path.join(config.dataDir, 'stt-log.jsonl'))
  ? fs.readFileSync(path.join(config.dataDir, 'stt-log.jsonl'), 'utf8').trim().split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
  : [];
/** @type {Map<string, any[]>} */
const byRec = new Map();
for (const l of lines) if (l.rec && Date.parse(l.at) >= since) byRec.set(l.rec, [...(byRec.get(l.rec) || []), l]);

let labels = {};
try { labels = JSON.parse(fs.readFileSync(labelsFile(), 'utf8')); } catch {}
const save = () => { fs.mkdirSync(path.dirname(labelsFile()), { recursive: true }); fs.writeFileSync(labelsFile(), JSON.stringify(labels, null, 1)); };

const FIRST = ['set_aside', 'no_text'];
const todo = [...byRec.entries()]
  .map(([rec, ls]) => ({ rec, file: path.join(recordingsDir(), `${rec}.wav`), ...recordingFate(ls) }))
  .filter((r) => fs.existsSync(r.file) && (args.includes('--redo') || !labels[r.rec]))
  .sort((a, b) => (FIRST.includes(b.fate) ? 1 : 0) - (FIRST.includes(a.fate) ? 1 : 0) || b.rec.localeCompare(a.rec))
  .slice(0, limit);

if (!byRec.size) {
  console.log('No recordings yet. Turn on Settings → Privacy & safety → "Keep voice recordings on this Mac" (on by default in the developer copy), talk to Echo for a while, then run this again.');
  process.exit(0);
}
if (!todo.length) {
  console.log('Every recording here is labelled. See the numbers: node scripts/listen-report.js');
  process.exit(0);
}
if (!process.stdin.isTTY) {
  console.error('This asks you about each recording; run it in a terminal.');
  process.exit(2);
}

const FATE = {
  reached: 'reached Echo', set_aside: 'set aside as not for Echo', no_text: 'no words came out',
  own_voice: 'taken for Echo\'s own voice', heard_twice: 'dropped as a duplicate', wake_only: 'just "Hey Echo"', unknown: 'unclear',
};
const when = (iso) => new Date(iso).toLocaleString('en-US', { timeZone: config.timezone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
const listen = (file) => { if (play) spawnSync('afplay', [file], { stdio: 'ignore' }); };

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log(`${todo.length} recordings to label. y/n: meant for Echo? · r: play again · s: skip · q: quit. Saved as you go.\n`);
let done = 0;
review: for (const [i, r] of todo.entries()) {
  console.log(`[${i + 1}/${todo.length}] ${when(r.at)} · ${r.mode || 'unknown mic'} · ${FATE[r.fate] || r.fate}${r.why ? ` (${r.why}${r.confidence !== undefined ? `, ${Math.round(r.confidence * 100)}% sure` : ''})` : ''}`);
  console.log(`  Echo heard: ${r.heard ? `“${r.heard}”` : '(nothing)'}`);
  if (r.live && r.live !== r.heard) console.log(`  live preview: “${r.live}”`);
  listen(r.file);
  let forEcho = null;
  while (forEcho === null) {
    const a = (await rl.question('  Meant for Echo? [y/n/r/s/q] ')).trim().toLowerCase();
    if (a === 'q') break review;
    if (a === 's') { console.log(''); continue review; }
    if (a === 'r') listen(r.file);
    if (a === 'y' || a === 'n') forEcho = a === 'y';
  }
  const q = r.heard ? '  Words right? Enter if yes, or type what you said ("-" if nothing): ' : '  What did you say? Type it, or Enter if nothing was said: ';
  const w = (await rl.question(q)).trim();
  const said = w === '-' ? '' : w || (r.heard ? r.heard : '');
  labels[r.rec] = { forEcho, said, heard: r.heard || '', fate: r.fate, at: new Date().toISOString() };
  save();
  done++;
  console.log('');
}
rl.close();
console.log(`Labelled ${done}. See the numbers: node scripts/listen-report.js`);
