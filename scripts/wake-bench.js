#!/usr/bin/env node
// Measures the "Hey Echo" wake word on recorded clips: how often it wakes when called, how often
// it wakes when it wasn't (other speech, a TV), how fast a check is, and what it costs in CPU.
// Runs the page's own listener (public/wake.js) and the server's matcher (lib/wake.js) against a
// throwaway whisper-server on a free port.
//
//   node scripts/wake-bench.js --make DIR                         make synthetic test clips (macOS `say` + ffmpeg)
//   node scripts/wake-bench.js --clips DIR/clips.txt [--model FILE] [--sensitivity 0.5] [--prompt TEXT|--no-prompt] [--tv DIR/tv.wav]
//                              [--speakers Name1,Name2]   more speakers whose clips count as Indian English
//
// clips.txt: one clip per line, "<name>|wake|<note>" for a clip that calls Echo, "<name>|none|<note>"
// for one that doesn't. <name>.wav is 16 kHz mono next to it. --tv: a long background recording
// (talk shows, other people) to count false wakes per hour and CPU while it plays.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { wavSamples, pcmWav, squeezeSilence, cleanHeard } from '../lib/heard.js';
import { whisperSegments, WAKE_PROMPT } from '../lib/stt.js';
import { matchWake, stripWake } from '../lib/wake.js';
import { WakeListener } from '../public/wake.js';

const arg = (name, dflt = undefined) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? dflt : process.argv[i + 1] ?? true;
};

/* ---------- making test clips ---------- */
if (arg('make')) {
  const dir = path.resolve(String(arg('make')));
  fs.mkdirSync(dir, { recursive: true });
  const say = (voice, text, file) => execFileSync('say', ['-v', voice, '--file-format=WAVE', '--data-format=LEI16@16000', '-o', file, text]);
  const voices = { in: ['Rishi', 'Aman', 'Tara'], other: ['Samantha', 'Daniel', 'Karen', 'Moira'] };
  const wake = [
    'Hey Echo', 'Echo', 'Hey Echo, what is the weather today?', 'Hey Echo, check the Marigold project.', 'Hay Echo, open Bluebird.',
    'Okay Echo, remind me at eight.', 'Echo, are you there?',
  ];
  const none = [
    'The echo of the canyon was loud.', 'Hey everyone, welcome back to the show.', 'Tonight on the news, the economy keeps growing.',
    'Hey, can you pass the salt?', 'Eggs and toast for breakfast again.', 'I will check it out later.', 'Hey Ethan, how are you doing?',
    'Let us go and see the gecko exhibit.', 'A long time ago, in a small town.', 'Excellent, that was a great goal.', 'Hello, is anybody home?',
    'Can you launch that project?', 'Okay, go ahead and do that.', 'Thank you.',
  ];
  const lines = [];
  let n = 0;
  for (const v of [...voices.in, ...voices.other]) {
    for (const t of wake) {
      const name = `w${String(++n).padStart(3, '0')}`;
      say(v, t, path.join(dir, `${name}.wav`));
      lines.push(`${name}|wake|${v}: ${t}`);
    }
  }
  n = 0;
  for (const v of [...voices.in, ...voices.other]) {
    for (const t of none) {
      const name = `n${String(++n).padStart(3, '0')}`;
      say(v, t, path.join(dir, `${name}.wav`));
      lines.push(`${name}|none|${v}: ${t}`);
    }
  }
  // Wake words over a TV: each Indian-English "Hey Echo, ..." mixed with other speech and noise.
  const tvText = 'And in other news tonight, the city council met to discuss the new budget, which includes money for parks and roads.';
  say('Daniel', tvText, path.join(dir, 'tvbed.wav'));
  n = 0;
  for (const v of voices.in) {
    for (const t of wake.slice(0, 4)) {
      const name = `m${String(++n).padStart(3, '0')}`;
      say(v, t, path.join(dir, `${name}-dry.wav`));
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', path.join(dir, `${name}-dry.wav`), '-i', path.join(dir, 'tvbed.wav'), '-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.02:sample_rate=16000:duration=8',
        '-filter_complex', '[0]adelay=800|800,volume=1.0[a];[1]volume=0.25[b];[a][b][2]amix=inputs=3:duration=first:normalize=0,apad=pad_dur=1', '-ar', '16000', '-ac', '1', path.join(dir, `${name}.wav`)]);
      fs.rmSync(path.join(dir, `${name}-dry.wav`));
      lines.push(`${name}|wake|${v} over TV + noise: ${t}`);
    }
  }
  // Background only: a long "TV" of many voices reading news and chat, with pauses between lines.
  const tvLines = [...none, 'Echoes of the past come back to haunt the team.', 'Coming up after the break, the weather.', 'Hey guys, it is me again.', 'Eco friendly homes are selling fast.', tvText];
  const parts = [];
  let k = 0;
  for (let r = 0; r < 3; r++) for (const t of tvLines) {
    const f = path.join(dir, `tv-${k++}.wav`);
    say([...voices.in, ...voices.other][k % 7], t, f);
    parts.push(f);
  }
  const list = path.join(dir, 'tv-list.txt');
  fs.writeFileSync(list, parts.map((f) => `file '${f}'\nfile '${path.join(dir, 'gap.wav')}'`).join('\n'));
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.01:sample_rate=16000:duration=0.7', '-ac', '1', path.join(dir, 'gap.wav')]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-ar', '16000', '-ac', '1', path.join(dir, 'tv.wav')]);
  for (const f of [...parts, list, path.join(dir, 'gap.wav'), path.join(dir, 'tvbed.wav')]) fs.rmSync(f, { force: true });
  fs.writeFileSync(path.join(dir, 'clips.txt'), lines.join('\n') + '\n');
  console.log(`${lines.length} clips and tv.wav in ${dir}`);
  process.exit(0);
}

/* ---------- measuring ---------- */
const clipsFile = arg('clips');
if (!clipsFile) {
  console.error('Usage: node scripts/wake-bench.js --make DIR | --clips DIR/clips.txt [--model FILE] [--sensitivity 0.5] [--prompt TEXT | --no-prompt] [--tv FILE.wav]');
  process.exit(2);
}
const model = String(arg('model', path.resolve('models', 'ggml-large-v3-turbo-q5_0.bin')));
const sensitivity = Number(arg('sensitivity', 0.5));
const prompt = process.argv.includes('--no-prompt') ? '' : String(arg('prompt', WAKE_PROMPT));

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = /** @type {net.AddressInfo} */ (s.address());
      s.close(() => resolve(port));
    });
  });
const bin = ['/opt/homebrew/bin/whisper-server', '/usr/local/bin/whisper-server'].find((p) => fs.existsSync(p)) || execFileSync('which', ['whisper-server'], { encoding: 'utf8' }).trim();
const port = await freePort();
const server = spawn(bin, ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-l', 'en', '-t', '6', '-nt'], { stdio: ['ignore', 'ignore', 'ignore'] });
process.on('exit', () => server.kill());
for (let i = 0; i < 200; i++) {
  try {
    await fetch(`http://127.0.0.1:${port}/`);
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 300));
  }
}
const cpuSeconds = (pid) => {
  const t = execFileSync('ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf8' }).trim(); // [[dd-]hh:]mm:ss.ss
  return t.split(':').reduce((s, p) => s * 60 + Number(p), 0);
};

async function whisper(wav, p) {
  const form = new FormData();
  form.append('file', new Blob([/** @type {BlobPart} */ (wav)], { type: 'audio/wav' }), 'speech.wav');
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  form.append('language', 'en');
  if (p) form.append('prompt', p);
  const res = await fetch(`http://127.0.0.1:${port}/inference`, { method: 'POST', body: form });
  return res.json();
}

const latencies = [];
/** The server's check (server.js POST /api/wake), against the bench's whisper-server. */
async function check(samples, seen) {
  const t0 = Date.now();
  const squeezed = squeezeSilence(pcmWav(samples, 16000));
  let text = '';
  let lp;
  if (squeezed.speechMs >= 150) {
    const body = await whisper(squeezed.wav, prompt);
    text = String(body.text || '').trim();
    lp = whisperSegments(body)[0]?.lp;
    latencies.push(Date.now() - t0);
  }
  const m = matchWake(text, { sensitivity, lp });
  seen.push(`${m.wake ? 'WAKE' : 'no'} "${text}" (${m.score})`);
  return m;
}

let listenCpuUs = 0;
let audioSeconds = 0;
/** Run a clip through the page's listener, 20 ms frames, with silence around it. */
async function listen(samples) {
  const seen = [];
  let pending = null;
  let woke = false;
  let turn = null;
  const l = new WakeListener({
    rate: 16000,
    check: (s) => (pending = check(s, seen)),
    onWake: () => (woke = true),
    onTurn: (s, info) => (turn = { samples: s, ...info }),
  });
  const pad = new Float32Array(16000 * 0.6);
  const tail = new Float32Array(16000 * 7);
  for (let i = 0; i < pad.length; i++) pad[i] = (Math.random() - 0.5) * 0.002;
  for (let i = 0; i < tail.length; i++) tail[i] = (Math.random() - 0.5) * 0.002;
  const all = new Float32Array(pad.length + samples.length + tail.length);
  all.set(pad);
  all.set(samples, pad.length);
  all.set(tail, pad.length + samples.length);
  audioSeconds += all.length / 16000;
  for (let i = 0; i + 320 <= all.length; i += 320) {
    const c0 = process.cpuUsage();
    l.feed(all.subarray(i, i + 320));
    const c = process.cpuUsage(c0);
    listenCpuUs += c.user + c.system;
    if (pending) {
      await pending;
      pending = null;
    }
    if (turn) break;
  }
  return { woke, turn, seen };
}

/** The full request, as POST /api/utterance would hear it (turbo, short prompt skipped here). */
async function request(samples) {
  const squeezed = squeezeSilence(pcmWav(samples, 16000));
  const body = await whisper(squeezed.wav, '');
  const heard = cleanHeard({ text: String(body.text || '').trim(), segments: whisperSegments(body), speechMs: squeezed.speechMs });
  return stripWake(heard.text);
}

const dir = path.dirname(String(clipsFile));
const clips = fs.readFileSync(String(clipsFile), 'utf8').split('\n').filter((l) => l.trim()).map((l) => l.split('|')).map(([name, label, note = '']) => ({ name, label, note }));
console.log(`model ${path.basename(model)}, sensitivity ${sensitivity}, prompt ${JSON.stringify(prompt)}, ${clips.length} clips`);
const groups = {};
const indianSpeakers = ['Rishi', 'Aman', 'Tara', ...String(arg('speakers', '')).split(',').map((n) => n.trim()).filter(Boolean)];
const isIndianSpeaker = (note) => indianSpeakers.some((n) => note.includes(n));
const whisperCpu0 = cpuSeconds(server.pid);
for (const c of clips) {
  const pcm = wavSamples(fs.readFileSync(path.join(dir, `${c.name}.wav`)));
  if (!pcm) continue;
  const r = await listen(pcm.samples);
  const group = c.label === 'wake' ? (/over TV/.test(c.note) ? 'wake over TV' : isIndianSpeaker(c.note) ? 'wake, Indian English' : 'wake, other accents') : 'not for Echo';
  const g = (groups[group] ||= { n: 0, woke: 0 });
  g.n++;
  if (r.woke) g.woke++;
  let asked = '';
  if (r.turn && /,/.test(c.note.split(': ')[1] || '')) asked = ` -> request "${await request(r.turn.samples)}"`;
  const ok = (c.label === 'wake') === r.woke;
  console.log(`${ok ? 'ok  ' : 'MISS'} ${c.name} ${c.label} ${c.note}  [${r.seen.join('; ')}]${asked}`);
}
const clipWhisperCpu = cpuSeconds(server.pid) - whisperCpu0;

let tv = null;
if (arg('tv')) {
  const pcm = wavSamples(fs.readFileSync(String(arg('tv'))));
  if (pcm) {
    const seen = [];
    let wakes = 0;
    let pending = null;
    const l = new WakeListener({ rate: 16000, check: (s) => (pending = check(s, seen)), onWake: () => wakes++, onTurn: () => {}, onCancel: () => {} });
    const w0 = cpuSeconds(server.pid);
    const c0 = process.cpuUsage();
    for (let i = 0; i + 320 <= pcm.samples.length; i += 320) {
      l.feed(pcm.samples.subarray(i, i + 320));
      if (pending) {
        await pending;
        pending = null;
      }
    }
    const c = process.cpuUsage(c0);
    const seconds = pcm.samples.length / 16000;
    tv = { seconds: +seconds.toFixed(0), checks: l.checks, wakes, perHour: +((wakes / seconds) * 3600).toFixed(1), whisperCpuPct: +(((cpuSeconds(server.pid) - w0) / seconds) * 100).toFixed(1), listenerCpuPct: +(((c.user + c.system) / 1e6 / seconds) * 100).toFixed(2) };
    console.log(`\nTV: ${seen.filter((s) => s.startsWith('WAKE')).join('; ') || 'no false wakes'}`);
  }
}

latencies.sort((a, b) => a - b);
console.log('\ngroup | clips | woke');
for (const [k, g] of Object.entries(groups)) console.log(`${k} | ${g.n} | ${g.woke} (${((g.woke / g.n) * 100).toFixed(0)}%)`);
console.log(`check latency: median ${latencies[Math.floor(latencies.length / 2)]} ms, slowest ${latencies.at(-1)} ms, ${latencies.length} checks`);
console.log(`listener (page side) CPU: ${((listenCpuUs / 1e6 / audioSeconds) * 100).toFixed(3)}% of one core over ${audioSeconds.toFixed(0)} s of audio; whisper-server ${clipWhisperCpu.toFixed(1)} CPU-s for the clips`);
if (tv) console.log(`TV only: ${tv.seconds} s, ${tv.checks} checks, ${tv.wakes} false wakes (${tv.perHour}/hour), whisper-server ${tv.whisperCpuPct}% of one core, listener ${tv.listenerCpuPct}%`);
server.kill();
process.exit(0);
