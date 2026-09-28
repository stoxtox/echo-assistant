// What Whisper hears: silence squeezed out of a clip, its silence inventions dropped ("Thank you",
// "you"), low-confidence guesses dropped, and only speech meant for Echo taken as a turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.js';

const dirs = sandbox('sttclean');
const { squeezeSilence, wavSamples, pcmWav, cleanHeard, isInvented, pickTranscript, checkHeard, addressesEcho, echoesReply, MIN_SPEECH_MS } = await import('../lib/heard.js');
const { transcribe, whisperSegments } = await import('../lib/stt.js');

const R = 16000;
const silence = (s) => new Float32Array(Math.round(s * R));
const tone = (s, amp = 0.1) => Float32Array.from({ length: Math.round(s * R) }, (_, i) => Math.sin(i / 6) * amp);
const clicks = (s, n) => {
  const x = silence(s);
  for (let k = 1; k <= n; k++) for (let i = 0; i < 40; i++) x[Math.floor((k * x.length) / (n + 1)) + i] = 0.3 * (1 - i / 40);
  return x;
};
const cat = (...parts) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, (o += p.length) - p.length);
  return out;
};

test('long pauses are squeezed out; the speech is all kept', () => {
  // Like the clips Echo kept: seconds of silence before, between and after two sentences.
  const wav = pcmWav(cat(silence(5), tone(1.5), silence(6), tone(1), silence(20)), R);
  const r = squeezeSilence(wav);
  assert.equal(r.seconds, 33.5);
  assert.ok(r.speechMs >= 2400 && r.speechMs <= 2600, `speech ${r.speechMs}`);
  assert.ok(r.keptSeconds > 2.5 && r.keptSeconds < 4.5, `kept ${r.keptSeconds}s`);
  const back = wavSamples(r.wav);
  assert.equal(back.rate, R);
  assert.equal(back.samples.length, Math.round(r.keptSeconds * R));
});

test('clicks and room noise are not speech', () => {
  assert.ok(squeezeSilence(pcmWav(clicks(1.2, 3), R)).speechMs < MIN_SPEECH_MS);
  assert.equal(squeezeSilence(pcmWav(silence(8), R)).speechMs, 0);
  const room = Float32Array.from({ length: 3 * R }, (_, i) => Math.sin(i * 1.3) * 0.004);
  assert.ok(squeezeSilence(pcmWav(room, R)).speechMs < MIN_SPEECH_MS);
  assert.equal(squeezeSilence(Buffer.from('nope')).speechMs, 0);
});

test('a clip with no speech never reaches Whisper and comes back empty', async () => {
  // No whisper-server runs in tests: this only passes because Whisper isn't asked.
  const r = await transcribe(pcmWav(clicks(1, 2), R), { engine: 'whisper' });
  assert.equal(r.text, '');
  assert.ok(r.speechMs < MIN_SPEECH_MS);
});

test("Whisper's silence phrases are recognized", () => {
  for (const t of ['Thank you.', 'thanks for watching!', ' you', 'Thanks.', 'Please subscribe.']) assert.equal(isInvented(t), true, t);
  for (const t of ['Thank you, now open FitApp.', 'Yes.', 'Okay.', 'you there?']) assert.equal(isInvented(t), false, t);
});

test('clean-up: invented tails, lone inventions and low-confidence guesses are dropped', () => {
  // The turn from Sep 27: a trailing "you" that was never said.
  const tail = cleanHeard({ text: 'x', speechMs: 9000, segments: [{ text: 'Hey, this is a problem.', lp: -0.3 }, { text: 'Which is messing up my words.', lp: -0.5 }, { text: 'you', lp: -0.6 }] });
  assert.equal(tail.text, 'Hey, this is a problem. Which is messing up my words.');
  assert.deepEqual(tail.dropped, ['you']);
  // A trailing "Thank you." the live listener heard too stays.
  assert.equal(cleanHeard({ text: 'x', speechMs: 3000, segments: [{ text: 'Send it.', lp: -0.2 }, { text: 'Thank you.', lp: -0.3 }] }, { live: 'send it thank you' }).text, 'Send it. Thank you.');
  // Phantom "Thank you" turns: barely any sound in the clip.
  assert.deepEqual(cleanHeard({ text: 'Thank you.', speechMs: 280 }), { text: '', dropped: ['Thank you.'], reason: 'invented' });
  // A real, clearly spoken "Thank you" is kept, unless the live listener was on and heard nothing.
  assert.equal(cleanHeard({ text: 'Thank you.', speechMs: 460 }).text, 'Thank you.');
  assert.equal(cleanHeard({ text: 'Thank you.', speechMs: 460 }, { livePreview: true, live: '' }).reason, 'invented');
  assert.equal(cleanHeard({ text: 'Thank you.', speechMs: 460 }, { livePreview: true, live: 'thank you' }).text, 'Thank you.');
  // "you" alone is never a turn.
  assert.equal(cleanHeard({ text: 'you', speechMs: 2000 }).reason, 'invented');
  // Real short answers are never treated as inventions.
  assert.equal(cleanHeard({ text: 'Yes.', speechMs: 300 }).text, 'Yes.');
  // No speech at all.
  assert.deepEqual(cleanHeard({ text: 'Yeah.', speechMs: 60 }), { text: '', dropped: ['Yeah.'], reason: 'no_speech' });
  // A guessed segment goes; if every segment was a guess, nothing was caught.
  assert.equal(cleanHeard({ text: 'x', speechMs: 4000, segments: [{ text: 'Open the budget.', lp: -0.4 }, { text: 'Phase of the world.', lp: -1.4 }] }).text, 'Open the budget.');
  assert.deepEqual(cleanHeard({ text: 'x', speechMs: 4000, segments: [{ text: 'Data of the bodies.', lp: -1.3 }] }), { text: '', dropped: ['Data of the bodies.'], reason: 'low_confidence' });
  // Engines without segments (Deepgram) keep their text.
  assert.equal(cleanHeard({ text: 'Check the build.' }).text, 'Check the build.');
});

test("Whisper's segments carry their confidence", () => {
  assert.deepEqual(whisperSegments({ segments: [{ text: ' Hi there.', avg_logprob: -0.31234, no_speech_prob: 1e-10 }, { text: ' you' }] }), [{ text: 'Hi there.', lp: -0.312 }, { text: 'you', lp: undefined }]);
  assert.deepEqual(whisperSegments({}), []);
});

test('a final that is a different sentence from the live text loses to it; a misspelled name does not', () => {
  const live = 'hey this is a problem you cannot listen me properly anymore';
  assert.equal(pickTranscript('Also ready for this number of days, the phase of the world.', live).reason, 'disagree');
  assert.equal(pickTranscript('Hey, this is a problem. You cannot listen to me properly anymore.', live).source, 'final');
  assert.equal(pickTranscript('Check what is going on on the Acme project.', 'check what is going on on the acne project').source, 'final');
});

test('checkHeard: a phantom "Thank you" sends nothing and is logged with its cause', () => {
  const r = checkHeard({ wav: pcmWav(clicks(1.2, 2), R), heard: { text: 'Thank you.', engine: 'whisper', speechMs: 0 }, live: '', clipDir: `${dirs.data}/stt-blank-clips` });
  assert.equal(r.pick.source, 'none');
  assert.equal(r.entry.event, 'no_speech_final');
  assert.deepEqual(r.entry.dropped, ['Thank you.']);
  assert.match(r.entry.cause, /no speech/);
});

test('hands-free: speech for Echo says her name', () => {
  for (const t of ['Echo, check the build.', 'Hey Echo what time is it', 'OK, Eko, open FitApp.', 'What is the status, Echo?']) assert.equal(addressesEcho(t), true, t);
  for (const t of ['I told him the echo in that room was bad and we should leave.', 'Can you pass the salt?', '']) assert.equal(addressesEcho(t), false, t);
});

test("Echo's own reply heard back by the mic is recognized", () => {
  const reply = 'I found twelve roles, and three of them look strong for you.';
  assert.equal(echoesReply('three of them look strong for you', reply), true);
  assert.equal(echoesReply('which three look strong?', reply), false);
  assert.equal(echoesReply('yes', reply), false);
  assert.equal(echoesReply('three of them look strong for you', ''), false);
});
