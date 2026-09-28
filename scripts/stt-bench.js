#!/usr/bin/env node
// Measures local Whisper on recorded clips: word error rate, names, made-up turns and latency,
// for each prompt, with and without Echo's clean-up (silence squeezed out, inventions dropped).
//
//   node scripts/stt-bench.js --clips DIR/clips.txt [--model FILE] [--beam N] [--prompts FILE.json | --prompt TEXT | --vocab-prompt] [--runs 1] [--raw-only | --echo-only]
//
// clips.txt has one clip per line: "<name>|<anything>|<what was said>", with <name>.wav (16 kHz
// mono) next to it. Leave <what was said> empty for a clip where nothing was said (a click, a
// breath, the room): any text for it is a made-up turn. --prompts is a JSON object of named
// prompts ({ "none": "", "short": "Glossary: ..." }). A throwaway whisper-server runs on a free
// port and is stopped at the end. --vocab-prompt uses Echo's own prompt (lib/vocab.js), built
// from VOICEOPS_DATA_DIR. Make test clips with macOS voices, for example:
//   say -v Rishi --file-format=WAVE --data-format=LEI16@16000 -o c1.wav "Check the Marigold project"
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { squeezeSilence, cleanHeard, MIN_SPEECH_MS } from '../lib/heard.js';
import { whisperSegments } from '../lib/stt.js';

const arg = (name, dflt = undefined) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? dflt : process.argv[i + 1] ?? true;
};
const clipsFile = arg('clips');
if (!clipsFile) {
  console.error('Usage: node scripts/stt-bench.js --clips DIR/clips.txt [--model FILE] [--beam N] [--prompts FILE.json | --prompt TEXT | --vocab-prompt] [--runs 1] [--raw-only | --echo-only]');
  process.exit(2);
}
const model = arg('model', path.resolve('models', 'ggml-large-v3-turbo-q5_0.bin'));
const beam = Number(arg('beam', -1));
const runs = Number(arg('runs', 1));
/** @type {Record<string, string>} */
let prompts = { none: '' };
if (arg('prompts')) prompts = JSON.parse(fs.readFileSync(String(arg('prompts')), 'utf8'));
else if (arg('prompt')) prompts = { given: String(arg('prompt')) };
else if (process.argv.includes('--vocab-prompt')) prompts = { echo: (await import('../lib/vocab.js')).whisperPrompt() };
const pipelines = process.argv.includes('--raw-only') ? ['raw'] : process.argv.includes('--echo-only') ? ['echo'] : ['raw', 'echo'];

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = /** @type {net.AddressInfo} */ (s.address());
      s.close(() => resolve(port));
    });
  });

const words = (s) => String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
/** Word-level edit distance. */
function edits(ref, hyp) {
  const a = words(ref);
  const b = words(hyp);
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return { errors: d[a.length][b.length], length: a.length };
}
/** Capitalized words after the first: the names the clip is testing. */
const names = (s) => String(s).split(/\s+/).slice(1).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter((w) => /^\p{Lu}/u.test(w) && w !== 'I');

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

async function whisper(wav, prompt) {
  const form = new FormData();
  form.append('file', new Blob([/** @type {BlobPart} */ (wav)], { type: 'audio/wav' }), 'speech.wav');
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  form.append('language', 'en');
  if (beam > 0) form.append('beam_size', String(beam));
  if (prompt) form.append('prompt', prompt);
  const res = await fetch(`http://127.0.0.1:${port}/inference`, { method: 'POST', body: form });
  return res.json();
}

/** One clip through one pipeline: raw = the whole clip, text as Whisper gave it (Echo before this fix). */
async function run(pipeline, wav, prompt) {
  const t0 = Date.now();
  if (pipeline === 'raw') return { text: String((await whisper(wav, prompt)).text || '').trim(), ms: Date.now() - t0 };
  const squeezed = squeezeSilence(wav);
  if (squeezed.speechMs < MIN_SPEECH_MS) return { text: '', ms: Date.now() - t0 };
  const body = await whisper(squeezed.wav, prompt);
  const text = cleanHeard({ text: String(body.text || '').trim(), segments: whisperSegments(body), speechMs: squeezed.speechMs }).text;
  return { text, ms: Date.now() - t0 };
}

const dir = path.dirname(clipsFile);
const clips = fs.readFileSync(clipsFile, 'utf8').split('\n').filter((l) => l.trim()).map((l) => l.split('|')).map(([name, , said = '']) => ({ name, said: said.trim() }));
console.log(`model ${path.basename(model)}, beam ${beam}, ${clips.length} clips`);
const summary = [];
for (const [pname, prompt] of Object.entries(prompts)) {
  for (const pipeline of pipelines) {
    let hits = 0;
    let total = 0;
    let errors = 0;
    let refWords = 0;
    let invented = 0;
    let silent = 0;
    let missed = 0;
    const times = [];
    console.log(`\n== prompt ${pname} (${prompt ? `${prompt.length} chars` : 'none'}), ${pipeline}`);
    for (const c of clips) {
      const wav = fs.readFileSync(path.join(dir, `${c.name}.wav`));
      let out = { text: '', ms: 0 };
      for (let r = 0; r < runs; r++) out = await run(pipeline, wav, prompt);
      times.push(out.ms);
      const said = words(c.said).length > 0;
      if (!said) {
        silent++;
        if (words(out.text).length) invented++;
        console.log(`${words(out.text).length ? 'MADE' : 'ok  '} ${c.name} ${out.ms}ms  "${out.text}"`);
        continue;
      }
      if (!words(out.text).length) missed++;
      const e = edits(c.said, out.text);
      errors += e.errors;
      refWords += e.length;
      const want = names(c.said);
      const got = want.filter((n) => out.text.toLowerCase().includes(n.toLowerCase()));
      hits += got.length;
      total += want.length;
      console.log(`${e.errors ? 'ERR ' : 'ok  '} ${c.name} ${out.ms}ms  wer ${((e.errors / e.length) * 100).toFixed(0)}%  "${out.text.replace(/\n/g, ' ')}"`);
    }
    times.sort((a, b) => a - b);
    const row = { prompt: pname, pipeline, wer: refWords ? +((errors / refWords) * 100).toFixed(1) : 0, names: `${hits}/${total}`, madeUp: `${invented}/${silent}`, missed, medianMs: times[Math.floor(times.length / 2)] ?? 0, maxMs: times.at(-1) ?? 0 };
    summary.push(row);
  }
}
console.log('\nprompt | pipeline | WER (all words) | names | made-up turns | spoken clips lost | median | max');
for (const r of summary) console.log(`${r.prompt} | ${r.pipeline} | ${r.wer}% | ${r.names} | ${r.madeUp} | ${r.missed} | ${r.medianMs} ms | ${r.maxMs} ms`);
server.kill();
process.exit(0);
