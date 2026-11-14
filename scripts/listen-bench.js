#!/usr/bin/env node
// From the moment you stop talking to the start of Echo's reply, with and without transcribing
// while you talk (lib/sttstream.js, public/sttstream.js).
//
//   node scripts/listen-bench.js --model <ggml model> [--from <data folder>] [--rounds 2]
//                                [--mode both|batch|stream] [--voice Rishi] [--no-reply]
//                                [--clips <folder of 16 kHz WAVs>] [--only chat|hard|instant|paused] [--partials on|off]
//                                [--json out.json]
//
// Each clip is spoken by a macOS voice (`say`), with room noise before and after, and played in
// real time, 21 ms at a time at 48 kHz, through the page's own end-of-speech detector (the same
// numbers as public/app.js: 1.3 s of quiet ends the clip). Then:
//   batch   what Echo did before: the finished clip goes to Whisper, then the correction pass, then
//           the assistant (the pipeline of POST /api/utterance, push-to-talk, no addressee gates);
//   stream  this change: the audio also streams while it's said, Whisper runs at your pauses,
//           the correction and the model switch start as soon as a pause's text is known, and an
//           instant command ends the clip without waiting out the rest of the pause.
// Timed from the moment the last word has been captured: "text ready" (the words handed to the
// assistant) and "reply starts" (the first piece of the reply goes to the voice; for an instant
// command, the moment it acts). The two modes alternate clip by clip, so the model is equally warm.
//
// Nothing touches the Mac or the live Echo: a throwaway data folder (a copy of memory, settings,
// projects and vocabulary from --from, so the prompts are the real size), every AppleScript call a
// no-op, and a throwaway whisper-server on a free port. It makes real model calls (the assistant
// and the correction pass: a few cents). --no-reply skips the assistant and times "text ready"
// only. --clips replays recorded clips too (any WAVs, 16 kHz mono), with --no-reply, to check that
// both modes give the same text; their words are never printed (BENCH_DEBUG=1 shows the ones
// that differ, on the terminal only).
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const flag = (name) => process.argv.includes(`--${name}`);
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = /** @type {net.AddressInfo} */ (s.address());
      s.close(() => resolve(port));
    });
  });

const model = arg('model', process.env.ECHO_WHISPER_MODEL || path.resolve('models', 'ggml-large-v3-turbo-q5_0.bin'));
if (!fs.existsSync(model)) {
  console.error(`No Whisper model at ${model}. Pass --model <path to ggml-large-v3-turbo-q5_0.bin>.`);
  process.exit(2);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-listen-bench-'));
const data = path.join(tmp, 'data');
const projects = path.join(tmp, 'projects');
for (const d of [data, projects, path.join(tmp, 'logs'), path.join(tmp, 'clips')]) fs.mkdirSync(d, { recursive: true });
const from = arg('from', '');
if (from) {
  for (const f of ['memory.md', 'projects.json', 'settings.json', 'contact-aliases.json', 'vocabulary.json']) {
    try {
      fs.copyFileSync(path.join(from, f), path.join(data, f));
    } catch {}
  }
  try {
    const s = JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'));
    delete s.projectsDir;
    fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify(s, null, 2));
  } catch {}
}
// Never the live Echo's port or its Whisper (which listens on the live port + 1).
Object.assign(process.env, {
  ECHO_PORT: String(await freePort()),
  ECHO_WHISPER_PORT: String(await freePort()),
  ECHO_WHISPER_MODEL: model,
  ECHO_DATA_DIR: data,
  ECHO_LOG_DIR: path.join(tmp, 'logs'),
  ECHO_ROOTS: projects,
  ECHO_RESEARCH_DIR: path.join(projects, '_research'),
  ECHO_WORKTREE_DIR: path.join(tmp, 'worktrees'),
  ECHO_TITLES: 'off',
});

const { transcribe, startWhisper, stopWhisper } = await import('../lib/stt.js');
const { checkHeard, wavSamples, pcmWav, squeezeSilence } = await import('../lib/heard.js');
const { SpeechStreams, parseAudioMessage } = await import('../lib/sttstream.js');
const { StreamClient, downsample, wavBytes } = await import('../public/sttstream.js');
const { hearAsSaid } = await import('../lib/correct.js');

const reply = !flag('no-reply');
let d = null;
if (reply) {
  const { Dispatcher } = await import('../lib/dispatcher.js');
  const { QuickActions } = await import('../lib/quick.js');
  const quick = new QuickActions({ exec: async () => '' });
  const tasks = Object.assign(new (await import('node:events')).EventEmitter(), { list: () => [], get: () => null, isLive: () => false, isApprovalPending: () => false });
  d = new Dispatcher(/** @type {any} */ (tasks), null, quick, null);
  d.computer.act = async () => ({ done: true });
  d.computer.unavailable = () => null; // as if computer use were on ("scroll down" is instant)
  d.on('error', (e) => console.error('[bench] dispatcher error:', e.message));
  d.start();
}
process.stdout.write('starting Whisper… ');
await startWhisper();
console.log('ready');

/* ---------- clips ---------- */
const RATE = 48000; // the page's mic
const voice = arg('voice', 'Rishi');
const PHRASES = [
  { kind: 'chat', parts: ["What's the capital of Australia?"] },
  { kind: 'chat', parts: ['Any tasks running right now?'] },
  { kind: 'chat', parts: ['Give me a one line pep talk.'] },
  { kind: 'chat', parts: ['How many ounces are in a cup?'] },
  { kind: 'hard', parts: ['Compare renting versus buying a home, in two sentences.'] },
  { kind: 'paused', parts: ['Tell me a fun fact', 'about octopuses.'] },
  { kind: 'instant', parts: ['Stop.'] },
  { kind: 'instant', parts: ['Scroll down.'] },
  { kind: 'instant', parts: ['Next song.'] },
];
/** Low room noise, so the detectors see a real room rather than digital silence. */
function room(seconds, rate, seed) {
  const out = new Float32Array(Math.round(seconds * rate));
  let x = seed;
  for (let i = 0; i < out.length; i++) {
    x = (x * 16807) % 2147483647;
    out[i] = (x / 2147483647 - 0.5) * 0.003;
  }
  return out;
}
const join = (parts) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
/** 16 kHz to the mic's 48 kHz (linear), plus the room. */
function toMic(pcm16) {
  const out = new Float32Array(pcm16.length * 3);
  for (let i = 0; i < out.length; i++) {
    const p = i / 3;
    const a = Math.floor(p);
    const b = Math.min(pcm16.length - 1, a + 1);
    out[i] = pcm16[a] + (pcm16[b] - pcm16[a]) * (p - a);
  }
  const noise = room(out.length / RATE, RATE, 7);
  for (let i = 0; i < out.length; i++) out[i] += noise[i];
  return out;
}
function spoken(text, n) {
  const file = path.join(tmp, 'clips', `say-${n}.wav`);
  execFileSync('say', ['-v', voice, '--file-format=WAVE', '--data-format=LEI16@16000', '-o', file, text]);
  return /** @type {{ samples: Float32Array }} */ (wavSamples(fs.readFileSync(file))).samples;
}
let n = 0;
const clips = [];
for (const p of PHRASES.filter((x) => !arg('only', '') || x.kind === arg('only', ''))) {
  const parts = [new Float32Array(Math.round(0.6 * 16000))];
  p.parts.forEach((t, i) => {
    if (i) parts.push(new Float32Array(Math.round(0.6 * 16000))); // a pause mid-sentence
    parts.push(spoken(t, n++));
  });
  const speech = join(parts);
  const speechEnd = squeezeSilence(pcmWav(speech, 16000)).speechEndSec;
  parts.push(new Float32Array(Math.round(2.5 * 16000)));
  clips.push({ name: p.parts.join(' … '), kind: p.kind, mic: toMic(join(parts)), speechEndSec: speechEnd, show: true });
}
const recorded = arg('clips', '');
if (recorded) {
  for (const f of fs.readdirSync(recorded).filter((x) => x.endsWith('.wav')).sort()) {
    const s = wavSamples(fs.readFileSync(path.join(recorded, f)));
    if (!s || s.rate !== 16000) continue;
    const pcm = join([new Float32Array(Math.round(0.3 * 16000)), s.samples, new Float32Array(Math.round(2 * 16000))]);
    clips.push({ name: f, kind: 'recorded', mic: toMic(pcm), speechEndSec: 0.3 + squeezeSilence(pcmWav(s.samples, 16000)).speechEndSec, show: false });
  }
}

/* ---------- one clip, played in real time through the page's detector ---------- */
const FRAME = 1024;
const PRE_ROLL_MS = 350;
const END_SILENCE_MS = 1300;
const sleepUntil = (t) => new Promise((r) => setTimeout(r, Math.max(0, t - performance.now())));
const owner = {};
const toOwner = [];
const streams = new SpeechStreams({ transcribe });

// The server's side of a pause (lib/server/speech.js 'ready'): an instant command, or the model made ready.
streams.on('ready', ({ id, heard }) => {
  const said = String(heard.text || '').trim();
  if (!said) return;
  const route = d ? d.routeInput(said) : 'turn';
  const instant = d ? route !== 'turn' || Boolean(d.localIntentFor(said)) : false;
  if (!instant) d?.prepare(said);
  toOwner.push({ type: 'stt_ready', id, instant, words: said.split(/\s+/).length });
});

/** @param {{ mic: Float32Array, speechEndSec: number }} clip @param {'batch' | 'stream'} mode */
async function play(clip, mode) {
  const client = new StreamClient({
    rate: RATE,
    sendJson: (m) => {
      const { op, id } = /** @type {any} */ (m);
      if (op === 'open') streams.open(owner, id, { mode: 'push-to-talk' });
      else streams[op](owner, id);
    },
    sendBinary: (bytes) => {
      const m = parseAudioMessage(Buffer.from(bytes));
      if (m) streams.audio(owner, m.id, m.pcm);
    },
    threshold: () => Math.max(0.01, noiseFloor * 3.5),
    // --partials off: as when the browser's live preview shows your words (no Whisper partials).
    wantPartials: () => arg('partials', 'on') !== 'off',
  });
  let noiseFloor = 0.004;
  let hearing = false;
  let voicedMs = 0;
  let silentMs = 0;
  let preRoll = [];
  let clipFrames = [];
  let stopAt = null;
  const frameMs = (FRAME / RATE) * 1000;
  const stopSample = Math.ceil(clip.speechEndSec * RATE);
  const t0 = performance.now();
  toOwner.length = 0;
  let early = false;
  for (let i = 0; i * FRAME < clip.mic.length; i++) {
    await sleepUntil(t0 + (i + 1) * frameMs); // the frame has been captured
    const frame = clip.mic.subarray(i * FRAME, (i + 1) * FRAME);
    if (stopAt === null && (i + 1) * FRAME >= stopSample) stopAt = performance.now();
    preRoll.push(frame);
    while (preRoll.length * frameMs > PRE_ROLL_MS) preRoll.shift();
    // public/app.js detectSpeech
    let sum = 0;
    for (let k = 0; k < frame.length; k++) sum += frame[k] * frame[k];
    const level = Math.sqrt(sum / frame.length);
    const threshold = Math.max(0.01, noiseFloor * 3.5);
    if (!hearing && level < threshold) noiseFloor = noiseFloor * 0.995 + level * 0.005;
    if (level > threshold) {
      voicedMs += frameMs;
      silentMs = 0;
      if (!hearing && voicedMs > 120) {
        hearing = true;
        clipFrames = [...preRoll];
        if (mode === 'stream') client.begin('push-to-talk', clipFrames);
      }
    } else {
      voicedMs = Math.max(0, voicedMs - frameMs);
      if (hearing) silentMs += frameMs;
    }
    if (!hearing) continue;
    clipFrames.push(frame);
    if (mode === 'stream') client.feed(frame);
    // public/app.js onStreamReady: an instant command ends the clip at once.
    const ready = toOwner.find((m) => m.id === client.id && m.instant && m.words <= 4);
    if (ready && client.paused) early = true;
    if (early || silentMs >= END_SILENCE_MS) break;
  }
  stopAt ??= performance.now();
  const pcm = join(clipFrames);
  const wav = Buffer.from(wavBytes(downsample(pcm, RATE, 16000), 16000));
  const id = mode === 'stream' ? client.end() : null;
  const clipSentAt = performance.now();
  const streamed = id ? await streams.final(id, wav) : null;
  const heard = streamed?.heard || (await transcribe(wav, { engine: 'whisper' }));
  const { pick } = checkHeard({ wav, heard, live: '', page: { mode: 'push-to-talk' }, clipDir: path.join(tmp, 'blank') });
  const said = pick.text;
  const out = { clipSentAfter: clipSentAt - stopAt, sttAfter: performance.now() - stopAt, waitedMs: streamed?.waitedMs, text: said, reused: Boolean(streamed?.heard), why: streamed?.why, early, textReady: null, replyStart: null, route: '' };
  if (process.env.BENCH_DEBUG) console.log('   ', JSON.stringify({ clipSent: Math.round(out.clipSentAfter), stt: Math.round(out.sttAfter), waited: out.waitedMs, spec: streamed?.specMs, runs: streamed?.runs }));
  if (!said) return out;
  const route = d ? d.routeInput(said) : 'turn';
  if (d && (route !== 'turn' || d.localIntentFor(said))) {
    out.textReady = performance.now() - stopAt;
    out.route = d.send(said) || '';
    out.replyStart = out.textReady; // it acts now
    await new Promise((r) => setTimeout(r, 300));
    return out;
  }
  d?.heard();
  const fixed = hearAsSaid(said, { uncertain: heard.uncertain || [] });
  out.textReady = performance.now() - stopAt;
  out.text = fixed.text;
  if (!d) return out;
  const first = new Promise((resolve) => {
    const on = (t) => String(t || '').trim() && resolve(performance.now());
    d.once('speak', on);
    d.once('say', on);
    setTimeout(() => resolve(null), 60_000);
  });
  const end = new Promise((resolve) => {
    d.once('reply_end', resolve);
    setTimeout(resolve, 90_000);
  });
  out.route = d.send(fixed.text, { raw: said, unsure: fixed.unsure }) || '';
  const at = await first;
  out.replyStart = at === null ? null : at - stopAt;
  await end;
  d.removeAllListeners('speak');
  d.removeAllListeners('say');
  await new Promise((r) => setTimeout(r, 400));
  return out;
}

/* ---------- run ---------- */
const median = (xs) => {
  const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const sec = (ms) => (ms === null || ms === undefined ? '  -  ' : `${(ms / 1000).toFixed(2)}s`);
const modes = arg('mode', 'both') === 'both' ? ['batch', 'stream'] : [arg('mode', 'both')];

if (d) {
  // Warm up: the first turn of a fresh session writes the prompt cache (a real session is warm).
  process.stdout.write('warming up… ');
  await new Promise((r) => setTimeout(r, 1500));
  const warm = new Promise((r) => d.once('reply_end', r));
  d.send('hi, just checking you can hear me. one word answer please.');
  await warm;
  console.log('done');
}
await transcribe(Buffer.from(wavBytes(new Float32Array(16000).map((_, i) => 0.2 * Math.sin(i / 5)), 16000)), { engine: 'whisper' }).catch(() => {});

const rounds = Number(arg('rounds', '2'));
const results = [];
for (let r = 0; r < rounds; r++) {
  for (const c of clips) {
    // Alternate which mode goes first, so neither is always the warmer one.
    const order = (r + clips.indexOf(c)) % 2 ? [...modes].reverse() : modes;
    for (const mode of order) {
      const res = await play(c, mode);
      results.push({ clip: c.name, kind: c.kind, mode, round: r + 1, ...res, text: c.show ? res.text : undefined, textKey: res.text });
      console.log(`${mode.padEnd(6)} ${c.kind.padEnd(8)} text ready ${sec(res.textReady)}  reply starts ${sec(res.replyStart)}  ${res.reused ? 'early text' : `whole clip${res.why ? ` (${res.why})` : ''}`}${res.early ? ', ended early' : ''}  ${c.show ? `"${c.name}" -> "${res.text}"` : c.name}`);
      await new Promise((ok) => setTimeout(ok, 300));
    }
  }
}

console.log('\nMedians, from the moment you stop talking:');
const summary = {};
for (const kind of ['chat', 'hard', 'paused', 'instant', 'recorded', 'all']) {
  for (const mode of modes) {
    const rs = results.filter((x) => (kind === 'all' ? x.kind !== 'recorded' : x.kind === kind) && x.mode === mode);
    if (!rs.length) continue;
    const row = { n: rs.length, textReady: median(rs.map((x) => x.textReady)), replyStart: median(rs.map((x) => x.replyStart)), reused: rs.filter((x) => x.reused).length };
    summary[`${kind}/${mode}`] = row;
    console.log(`  ${kind.padEnd(9)} ${mode.padEnd(6)} text ready ${sec(row.textReady)}  reply starts ${sec(row.replyStart)}  early text ${row.reused}/${row.n}`);
  }
}
if (modes.length === 2) {
  // The same clip, the same round: did streaming change what was heard?
  let same = 0;
  let total = 0;
  for (const b of results.filter((x) => x.mode === 'batch')) {
    const s = results.find((x) => x.mode === 'stream' && x.clip === b.clip && x.round === b.round);
    if (!s) continue;
    total++;
    const norm = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').trim();
    if (norm(s.textKey) === norm(b.textKey)) same++;
    else if (process.env.BENCH_DEBUG) console.log(`  differs: ${b.clip}\n    batch:  ${b.textKey}\n    stream: ${s.textKey}`);
  }
  summary.sameText = { same, total };
  console.log(`\nSame text with and without streaming: ${same} of ${total}`);
}
const outFile = arg('json', '');
if (outFile) fs.writeFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), voice, summary, results: results.map(({ textKey, ...x }) => x) }, null, 2));
stopWhisper();
d?.input?.close();
d?.q?.close?.();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
