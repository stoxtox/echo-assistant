#!/usr/bin/env node
// Which voice should Echo talk with? Each voice says the same Echo-like lines, on this Mac, the way
// Echo asks for them (one sentence at a time): how long until the sentence's audio is ready (Echo
// can start speaking), and, with --listen, how natural it sounds to you, rated blind.
//
//   node --env-file-if-exists=.env scripts/voice-bench.js [--listen] [--only kokoro,cartesia]
//        [--eleven-voice <id>] [--cartesia-voice <id>] [--kokoro-voice af_heart]
//
// Kokoro always; ElevenLabs and Cartesia when their keys are set. The premium voices spend about
// 500 of their free characters a run, counted like Echo's own speech (data/voice-budget.json), and
// a voice out of free characters is skipped, never charged. The audio is kept in
// data/listening/voice-bench/ and the results in results.json there.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { config } from '../lib/config.js';
import { getSettings } from '../lib/settings.js';
import { synthesize, listVoices, voiceBudget } from '../lib/voice.js';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const listen = args.includes('--listen');
const only = flag('--only')?.split(',');

const LINES = [
  'On it.',
  "Done. I opened the draft in Gmail and left it for you to check before it's sent.",
  'You have three things today: the dentist at 9:30, lunch with Sam at noon, and the website review at 4.',
  "Hmm, I couldn't find that file. Do you mean the one called Echo notes, from last Tuesday?",
  "Good news: the build is green and all 214 tests pass. Want me to open a pull request?",
  "Okay, click the blue Share button in the top right corner. I'll wait.",
];

const s = getSettings();
const catalog = await listVoices();
const pick = (id, want) => {
  const voices = catalog.find((p) => p.id === id)?.voices || [];
  return voices.find((v) => v.id === want)?.id || (s.ttsProvider === id && voices.find((v) => v.id === s.voice)?.id) || voices[0]?.id;
};
const voices = [
  { provider: 'kokoro', voice: flag('--kokoro-voice') || (s.ttsProvider === 'kokoro' ? s.voice : s.fallbackVoice) || 'af_heart' },
  { provider: 'elevenlabs', voice: pick('elevenlabs', flag('--eleven-voice')) },
  { provider: 'cartesia', voice: pick('cartesia', flag('--cartesia-voice')) },
].filter((v) => v.voice && (!only || only.includes(v.provider)));

const out = path.join(config.dataDir, 'listening', 'voice-bench');
fs.mkdirSync(out, { recursive: true });
const q = (xs, p) => { const a = [...xs].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };
const chars = LINES.join('').length;
console.log(`${voices.length} voices, ${LINES.length} lines (${chars} characters each for the premium voices).\n`);

/** @type {Record<string, { voice: string, ms: number[], files: string[], error?: string }>} */
const results = {};
for (const v of voices) {
  const r = (results[v.provider] = { voice: v.voice, ms: [], files: [] });
  try {
    // One untimed line first: Kokoro loads its model, the others open a connection.
    await synthesize({ text: 'Okay.', provider: v.provider, voice: v.voice, speed: s.speed, strict: true });
    for (const [i, text] of LINES.entries()) {
      const t0 = performance.now();
      const audio = await synthesize({ text, provider: v.provider, voice: v.voice, speed: s.speed, previousText: LINES[i - 1], strict: true });
      r.ms.push(Math.round(performance.now() - t0));
      const file = path.join(out, `${v.provider}-${i + 1}.${audio.mime === 'audio/mpeg' ? 'mp3' : 'wav'}`);
      fs.writeFileSync(file, audio.data);
      r.files.push(file);
    }
    console.log(`${v.provider.padEnd(11)} ready in  p50 ${String(q(r.ms, 0.5)).padStart(5)} ms   slowest ${String(Math.max(...r.ms)).padStart(5)} ms   (${v.voice})`);
  } catch (e) {
    r.error = e.message;
    console.log(`${v.provider.padEnd(11)} skipped: ${e.message}`);
  }
}
const left = voiceBudget.status();
for (const p of ['elevenlabs', 'cartesia']) {
  if (left[p].hasKey && left[p].limit) console.log(`  ${p}: ${left[p].left?.toLocaleString()} of ${left[p].limit.toLocaleString()} free credits left`);
}

/** @type {Record<string, number[]>} */
const scores = {};
const ok = voices.filter((v) => !results[v.provider].error);
if (listen && ok.length && process.stdin.isTTY) {
  console.log('\nBlind: each line in each voice, in a shuffled order. Rate how natural it sounds, 1 (robotic) to 5 (a person). r replays, q stops.\n');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rate: for (const [i, text] of LINES.entries()) {
    console.log(`“${text}”`);
    const order = ok.map((v) => v.provider).sort(() => Math.random() - 0.5);
    for (const [k, p] of order.entries()) {
      const file = results[p].files[i];
      for (;;) {
        spawnSync('afplay', [file], { stdio: 'ignore' });
        const a = (await rl.question(`  voice ${'ABC'[k]}: 1-5? `)).trim().toLowerCase();
        if (a === 'q') break rate;
        if (/^[1-5]$/.test(a)) { (scores[p] ??= []).push(Number(a)); break; }
      }
    }
  }
  rl.close();
  console.log('\nHow natural (your ratings):');
  for (const [p, xs] of Object.entries(scores)) console.log(`  ${p.padEnd(11)} ${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1)} / 5  (${xs.length} lines)`);
} else if (listen) {
  console.log('\n--listen needs a terminal and at least one voice that worked.');
}

fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ at: new Date().toISOString(), lines: LINES, results, scores }, null, 1));
console.log(`\nAudio and results: ${out}`);
