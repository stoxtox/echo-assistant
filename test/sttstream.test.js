// Transcribe while you talk (build step 4): the page streams each clip as it's recorded
// (public/sttstream.js), the server transcribes at your pauses (lib/sttstream.js), and the finished
// clip reuses that text when it holds all of the clip's speech.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sandbox, serverSource, pageSource } from './helpers.js';

sandbox('sttstream');
const { SpeechStreams, parseAudioMessage, int16Wav, wavPcm, STREAM_RATE } = await import('../lib/sttstream.js');
const { StreamClient, Resampler, downsample, wavBytes, toInt16, audioMessage } = await import('../public/sttstream.js');
const { squeezeSilence, pcmWav } = await import('../lib/heard.js');

/** A voice-like tone (loud) or room noise (quiet), at `rate`. */
function sound(seconds, rate, loud = true, seed = 1) {
  const out = new Float32Array(Math.round(seconds * rate));
  let x = seed;
  for (let i = 0; i < out.length; i++) {
    x = (x * 16807) % 2147483647;
    const noise = (x / 2147483647 - 0.5) * 0.002;
    out[i] = noise + (loud ? 0.2 * Math.sin((2 * Math.PI * 220 * i) / rate) * (0.6 + 0.4 * Math.sin((2 * Math.PI * 3 * i) / rate)) : 0);
  }
  return out;
}
const join = (...parts) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
/** Cut into mic frames like the page's audio tap (1024 samples, a short last one). */
const frames = (pcm, size = 1024) => Array.from({ length: Math.ceil(pcm.length / size) }, (_, i) => pcm.subarray(i * size, (i + 1) * size));
const tick = () => new Promise((r) => setImmediate(r));

/**
 * A page and a server joined by a fake socket; `transcribe` stands in for Whisper.
 * @param {{ rate?: number, transcribe?: (wav: Buffer, opts: object) => Promise<any> }} [o]
 */
function wire({ rate = 48000, transcribe = undefined } = {}) {
  const calls = [];
  const events = [];
  const streams = new SpeechStreams({
    transcribe: async (wav, opts) => {
      calls.push(wav);
      return transcribe ? transcribe(wav, opts) : { text: `heard ${calls.length}`, words: [], uncertain: [], engine: 'whisper', ms: 5, speechMs: squeezeSilence(wav).speechMs };
    },
  });
  streams.on('partial', (e) => events.push(['partial', e.text]));
  streams.on('ready', (e) => events.push(['ready', e.heard.text]));
  const owner = {};
  const sent = [];
  const client = new StreamClient({
    rate,
    sendJson: (m) => {
      sent.push(m);
      const id = /** @type {any} */ (m).id;
      const op = /** @type {any} */ (m).op;
      if (op === 'open') streams.open(owner, id, { mode: /** @type {any} */ (m).mode });
      else streams[op](owner, id);
    },
    sendBinary: (data) => {
      const m = parseAudioMessage(Buffer.from(data));
      if (m) streams.audio(owner, m.id, m.pcm);
    },
  });
  return { streams, client, owner, calls, events, sent };
}

test('the streamed audio is exactly the finished clip, at 48 kHz and 44.1 kHz', () => {
  for (const rate of [48000, 44100, 16000]) {
    const pcm = join(sound(0.3, rate, false), sound(1.1, rate), sound(0.5, rate, false));
    const whole = toInt16(downsample(pcm, rate, 16000));
    const r = new Resampler(rate, 16000);
    // Odd frame sizes too: the resampler carries its position across frames.
    const parts = [...frames(pcm.subarray(0, 5000), 1024), ...frames(pcm.subarray(5000), 777)].map((f) => toInt16(r.push(f)));
    const streamed = Buffer.concat(parts.map((p) => Buffer.from(p)));
    assert.ok(streamed.length <= whole.length && whole.length - streamed.length <= 2, `${rate}: the stream is the clip, give or take its last sample`);
    assert.ok(Buffer.from(whole).subarray(0, streamed.length).equals(streamed), `${rate}: byte for byte`);
    const wav = Buffer.from(wavBytes(downsample(pcm, rate, 16000), 16000));
    assert.ok(wavPcm(wav).equals(Buffer.from(whole)), 'the uploaded WAV holds the same samples');
  }
});

test('audio messages carry the stream id and the PCM', () => {
  const pcm = toInt16(new Float32Array([0, 0.5, -0.5, 1]));
  const m = parseAudioMessage(Buffer.from(audioMessage('s1abc', pcm)));
  assert.equal(m.id, 's1abc');
  assert.ok(m.pcm.equals(Buffer.from(pcm)));
  assert.equal(parseAudioMessage(Buffer.from([0])), null, 'no id');
  assert.equal(parseAudioMessage(Buffer.from([3, 0x2f, 0x2e, 0x2e, 1, 2])), null, 'only a plain id');
  assert.equal(parseAudioMessage(Buffer.from([40, 1, 2])), null, 'id too long');
});

test('squeezeSilence says where the last speech ends', () => {
  const pcm = join(sound(0.5, 16000, false), sound(1, 16000), sound(0.8, 16000, false));
  const sq = squeezeSilence(pcmWav(pcm, 16000));
  assert.ok(Math.abs(sq.speechEndSec - 1.5) <= 0.04, String(sq.speechEndSec));
  assert.equal(squeezeSilence(pcmWav(sound(1, 16000, false), 16000)).speechEndSec, 0, 'no speech');
});

test('the page marks pauses, carries on after them, and asks for partials while you talk', () => {
  const rate = 48000;
  const { client, sent } = wire({ rate });
  const ops = () => sent.map((m) => /** @type {any} */ (m).op);
  client.begin('hands-free', frames(sound(0.3, rate, false)));
  assert.deepEqual(ops(), ['open'], 'the pre-roll goes in without pause detection');
  for (const f of frames(sound(2.2, rate))) client.feed(f);
  assert.equal(ops().filter((o) => o === 'tick').length, 2, 'a partial about every second of speech');
  for (const f of frames(sound(0.2, rate, false))) client.feed(f);
  assert.ok(!ops().includes('pause'), 'a 200 ms breath is not a pause');
  for (const f of frames(sound(0.15, rate, false))) client.feed(f);
  assert.equal(ops().at(-1), 'pause', 'a pause at 300 ms of quiet');
  assert.ok(client.paused);
  for (const f of frames(sound(0.1, rate))) client.feed(f);
  assert.equal(ops().at(-1), 'resume', 'talking again');
  const id = client.id;
  assert.equal(client.end(), id);
  assert.equal(client.active, false);
  client.begin('push-to-talk');
  client.cancel();
  assert.equal(ops().at(-1), 'close', 'a dropped clip closes its stream');
});

test('a clip transcribed at your pause is used as is when you stop', async () => {
  const rate = 48000;
  const { streams, client, calls, events } = wire({ rate });
  const pcm = join(sound(0.3, rate, false), sound(1.2, rate), sound(1.4, rate, false));
  const all = frames(pcm);
  client.begin('hands-free', all.slice(0, 14)); // ~0.3 s of pre-roll
  for (const f of all.slice(14)) client.feed(f);
  await tick();
  assert.deepEqual(events.at(-1), ['ready', `heard ${calls.length}`], 'transcribed at the pause, still paused: the turn can be prepared');
  const id = client.end();
  const runs = calls.length;
  const r = await streams.final(id, Buffer.from(wavBytes(downsample(pcm, rate, 16000), 16000)));
  assert.ok(r.heard, r.why);
  assert.equal(r.why, 'pause');
  assert.equal(r.heard.text, `heard ${runs}`);
  assert.equal(calls.length, runs, 'no second Whisper run');
  assert.equal(streams.streams.size, 0, 'the stream is gone');
  assert.equal((await streams.final(id, Buffer.alloc(0))).why, 'no_stream');
});

test('speech after the pause means the clip is transcribed whole, as before', async () => {
  const rate = 48000;
  const { streams, client, events } = wire({ rate });
  const pcm = join(sound(1, rate), sound(0.5, rate, false), sound(0.8, rate, false, 7).map((v, i) => v + 0.2 * Math.sin(i / 20)), sound(0.2, rate, false));
  const all = frames(pcm);
  client.begin('push-to-talk');
  // Up to just after the pause: transcribed then.
  const cut = Math.ceil((1.45 * rate) / 1024);
  for (const f of all.slice(0, cut)) client.feed(f);
  await tick();
  assert.equal(events.filter((e) => e[0] === 'ready').length, 1);
  for (const f of all.slice(cut)) client.feed(f);
  await tick();
  assert.equal(events.filter((e) => e[0] === 'ready').length, 1, 'carried on talking: nothing more is prepared from the old pause');
  const r = await streams.final(client.end(), Buffer.from(wavBytes(downsample(pcm, rate, 16000), 16000)));
  assert.equal(r.heard, null);
  assert.equal(r.why, 'speech_after');
});

test('an unsure transcription at the pause is not reused: the whole clip is transcribed', async () => {
  const rate = 16000;
  const { streams, client } = wire({ rate, transcribe: async (wav) => ({ text: 'maybe this', words: [], uncertain: [], engine: 'whisper', ms: 5, segments: [{ text: 'maybe this', lp: -0.8 }], speechMs: squeezeSilence(wav).speechMs }) });
  const pcm = join(sound(0.8, rate), sound(0.6, rate, false));
  client.begin('push-to-talk');
  for (const f of frames(pcm)) client.feed(f);
  await tick();
  const r = await streams.final(client.end(), Buffer.from(wavBytes(pcm, 16000)));
  assert.equal(r.heard, null);
  assert.equal(r.why, 'unsure');
});

test('audio that is not the streamed clip is never matched to its text', async () => {
  const rate = 16000;
  const { streams, client } = wire({ rate });
  const pcm = join(sound(1, rate), sound(0.6, rate, false));
  client.begin('hands-free');
  for (const f of frames(pcm)) client.feed(f);
  await tick();
  const other = join(sound(1, rate, true, 99).map((v) => v * 0.9), sound(0.6, rate, false));
  const r = await streams.final(client.end(), pcmWav(other, 16000));
  assert.equal(r.heard, null);
  assert.equal(r.why, 'audio_differs');
});

test('the finished clip waits for a Whisper run under way rather than starting another', async () => {
  const rate = 16000;
  let release;
  const gate = new Promise((r) => (release = r));
  const { streams, client, calls } = wire({ rate, transcribe: async (wav) => (await gate, { text: 'check the build', words: [], uncertain: [], engine: 'whisper', ms: 700, speechMs: squeezeSilence(wav).speechMs }) });
  const pcm = join(sound(0.8, rate), sound(0.6, rate, false)); // under a second: no partial first
  client.begin('hands-free');
  for (const f of frames(pcm)) client.feed(f);
  const final = streams.final(client.end(), Buffer.from(wavBytes(pcm, 16000)));
  await tick();
  release();
  const r = await final;
  assert.equal(r.heard?.text, 'check the build', r.why);
  assert.equal(calls.length, 1);
  assert.equal(r.specMs, 700);
});

test('one Whisper run at a time per stream; a pause drops a partial under way', async () => {
  const pending = [];
  const streams = new SpeechStreams({
    transcribe: (wav, { signal }) =>
      new Promise((resolve, reject) => {
        pending.push({ resolve, signal });
        signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  });
  const owner = {};
  streams.open(owner, 'a');
  streams.audio(owner, 'a', Buffer.alloc(STREAM_RATE * 2 * 1.2));
  streams.tick(owner, 'a');
  assert.equal(pending.length, 1, 'a partial');
  streams.tick(owner, 'a');
  assert.equal(pending.length, 1, 'one at a time');
  streams.pause(owner, 'a');
  assert.equal(pending.length, 2, 'the pause starts at once');
  assert.equal(pending[0].signal.aborted, true, 'the partial is dropped (Whisper stops it early)');
  // A pause's run is only dropped when you carry on talking; another pause waits for it.
  streams.pause(owner, 'a');
  assert.equal(pending.length, 2, 'the same pause again: nothing new');
  streams.audio(owner, 'a', Buffer.alloc(STREAM_RATE * 2 * 0.1));
  streams.pause(owner, 'a');
  assert.equal(pending.length, 2, 'a pause waits for a pause');
  pending[1].resolve({ text: 'so far', words: [], uncertain: [] });
  await tick();
  await tick();
  assert.equal(pending.length, 3, 'then runs');
  streams.resume(owner, 'a');
  assert.equal(pending[2].signal.aborted, true, 'talking again drops the pause run under way');
  assert.equal(streams.get({}, 'a'), null, "another page can't touch it");
  streams.closeAll(owner);
  assert.equal(streams.streams.size, 0);
});

test('partials are only asked for when nothing else shows your words', () => {
  let want = false;
  const sent = [];
  const client = new StreamClient({ rate: 16000, sendJson: (m) => void sent.push(m), sendBinary: () => {}, wantPartials: () => want });
  client.begin('hands-free');
  for (const f of frames(sound(1.5, 16000))) client.feed(f);
  assert.ok(!sent.some((m) => m.op === 'tick'), "the browser's live preview shows them");
  want = true;
  for (const f of frames(sound(1.5, 16000))) client.feed(f);
  assert.ok(sent.some((m) => m.op === 'tick'));
});

test('streams are limited: only local Whisper, a few per page, a minute of audio, forgotten when idle', () => {
  let now = 0;
  const streams = new SpeechStreams({ transcribe: async () => ({ text: '', words: [], uncertain: [], engine: 'whisper', ms: 0 }), now: () => now });
  const owner = {};
  assert.equal(streams.open(owner, 'dg', { engine: 'deepgram' }), false, 'never a paid engine');
  assert.equal(streams.open(owner, '../x'), false, 'plain ids only');
  for (const id of ['a', 'b', 'c', 'd', 'e']) streams.open(owner, id);
  assert.equal(streams.streams.size, 4);
  assert.equal(streams.get(owner, 'a'), null, 'the oldest goes');
  streams.audio(owner, 'e', Buffer.alloc(STREAM_RATE * 2 * 70));
  assert.equal(streams.get(owner, 'e').bytes, STREAM_RATE * 2 * 60);
  now += 3 * 60 * 1000;
  streams.open(owner, 'f');
  assert.deepEqual([...streams.streams.keys()], ['f']);
});

test('int16Wav and wavPcm round-trip', () => {
  const pcm = Buffer.from(toInt16(new Float32Array([0.1, -0.2, 0.3])));
  assert.ok(wavPcm(int16Wav(pcm)).equals(pcm));
  assert.equal(wavPcm(pcmWav(new Float32Array(10), 8000)), null, 'only 16 kHz');
});

test('the server and the page are wired for it', () => {
  const server = serverSource();
  assert.match(server, /streams\.final\(streamId, wav\)/, 'the clip reuses the early text');
  assert.match(server, /case 'stt_stream'/);
  assert.match(server, /parseAudioMessage/);
  assert.match(server, /streams\.closeAll\(ws\)/, 'a closed page drops its streams');
  assert.match(server, /ECHO_STREAM_STT/, 'it can be turned off');
  assert.match(fs.readFileSync(new URL('../lib/pipeline/utterance.ts', import.meta.url), 'utf8'), /export const SURELY_FOR_ECHO: readonly string\[\] = \['push-to-talk', 'wake'\]/);
  assert.match(server, /if \(!instant && route === 'turn' && SURELY_FOR_ECHO\.includes\(mode\)\) dispatcher\.prepare\(said\);/, 'only speech that is surely for Echo gets its turn ready at the pause; hands-free talk waits for the addressee check');
  const app = pageSource();
  assert.match(app, /X-Echo-Stream/);
  for (const hook of ["streamBegin('push-to-talk'", "streamBegin('wake'", 'sttStream.feed(frame)', 'sttStream.cancel()', 'sttStream.end()']) assert.ok(app.includes(hook), hook);
  assert.doesNotMatch(app, /function downsample/, 'one downsampler, shared with the stream');
});
