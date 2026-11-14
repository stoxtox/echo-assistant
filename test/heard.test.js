// Blank transcriptions: Whisper returning just "." while the live listener showed the words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';

const dirs = sandbox('heard');
const { isBlankText, pickTranscript, wavStats, blankCause, saveBlankClip, checkHeard } = await import('../lib/heard.js');
const { elevenBody } = await import('../lib/voice.js');

/** A 16 kHz mono 16-bit WAV: `seconds` long, a tone at `amp` (0 = silence). */
function wav(seconds, amp = 0, rate = 16000) {
  const n = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 8) * amp * 32767), 44 + i * 2);
  return b;
}

test('blank means no letters or digits: a bare ".", whitespace, punctuation', () => {
  for (const t of ['', '.', ' . ', '...', '?!', '\n', '—', undefined, null]) assert.equal(isBlankText(t), true, JSON.stringify(t));
  for (const t of ['a', 'Yes.', '8:30', 'ok?', 'Всё']) assert.equal(isBlankText(t), false, t);
});

test('the live text is used when the final transcription is blank or much shorter', () => {
  assert.deepEqual(pickTranscript('.', 'check on the website build'), { text: 'check on the website build', source: 'live', reason: 'blank' });
  assert.deepEqual(pickTranscript('  ', 'hello there'), { text: 'hello there', source: 'live', reason: 'blank' });
  assert.deepEqual(pickTranscript('.', ''), { text: '', source: 'none', reason: 'blank' });
  assert.deepEqual(pickTranscript('.', ' . '), { text: '', source: 'none', reason: 'blank' });
  assert.deepEqual(pickTranscript('', undefined), { text: '', source: 'none', reason: 'blank' });
  // Cut short: one word where the live listener heard a whole sentence.
  assert.equal(pickTranscript('So.', 'so what just happened with the transcription').source, 'live');
  assert.equal(pickTranscript('So.', 'so what just happened with the transcription').reason, 'short');
  // Normal cases keep the (better) final transcription.
  assert.deepEqual(pickTranscript('Check on the Cardz build.', 'check on the cards build'), { text: 'Check on the Cardz build.', source: 'final', reason: '' });
  assert.equal(pickTranscript('Yes.', 'yes').source, 'final', 'a short live text never overrides');
  assert.equal(pickTranscript('Open the budget sheet.', 'open the budget sheet for me please now').source, 'final', 'a bit shorter is fine');
});

test('clip stats tell silence from speech, and give a likely cause', () => {
  const silent = wavStats(wav(2, 0));
  assert.equal(silent.rate, 16000);
  assert.equal(silent.seconds, 2);
  assert.equal(silent.peak, 0);
  assert.equal(blankCause(silent), 'digital silence (the mic delivered zeros)');
  const loud = wavStats(wav(1.5, 0.3));
  assert.ok(loud.peak > 0.25 && loud.rms > 0.1 && loud.voicedMs > 1000, JSON.stringify(loud));
  assert.equal(blankCause(loud), 'speech present but not transcribed');
  assert.match(blankCause(wavStats(wav(0.5, 0.3))), /short/);
  assert.match(blankCause(loud, { trackMuted: true }), /muted/);
  assert.match(blankCause(loud, { ctxState: 'interrupted' }), /interrupted/);
  assert.match(blankCause(wavStats(wav(1, 0.3, 48000))), /sample rate 48000/);
  assert.equal(wavStats(Buffer.from('nope')).seconds, 0);
});

test('a simulated empty Whisper result: nothing is sent, the clip is saved and the event logged', () => {
  const clipDir = path.join(dirs.data, 'stt-blank-clips');
  const clip = wav(1.8, 0);
  // Whisper came back with just "." and the live listener had nothing either.
  const none = checkHeard({ wav: clip, heard: { text: '.', engine: 'whisper', ms: 1400 }, live: '', page: { mode: 'push-to-talk', peak: 0 }, clipDir });
  assert.equal(none.pick.source, 'none');
  assert.equal(none.entry.event, 'blank_final');
  assert.equal(none.entry.final, '.');
  assert.equal(none.entry.stats.seconds, 1.8);
  assert.match(none.entry.cause, /silence/);
  assert.ok(fs.existsSync(none.entry.clip), 'the clip is kept');
  assert.deepEqual(fs.readFileSync(none.entry.clip), clip);

  // Whisper came back with "." but the live listener showed the words: they're used instead.
  const rescued = checkHeard({ wav: wav(2, 0.2), heard: { text: '.', engine: 'whisper', ms: 1300 }, live: 'how is the job search going', clipDir });
  assert.deepEqual(rescued.pick, { text: 'how is the job search going', source: 'live', reason: 'blank' });
  assert.equal(rescued.entry.used, 'live');
  assert.ok(rescued.entry.clip, 'a blank final always keeps the clip');

  // A normal transcription: no entry, no clip.
  const ok = checkHeard({ wav: wav(1, 0.2), heard: { text: 'How is the job search going?' }, live: 'how is the job search going', clipDir });
  assert.equal(ok.pick.source, 'final');
  assert.equal(ok.entry, null);
  assert.equal(fs.readdirSync(clipDir).length, 2);
  // A header that isn't a string is ignored.
  assert.equal(checkHeard({ wav: clip, heard: { text: '' }, live: { evil: true }, clipDir }).pick.source, 'none');
});

test('only the newest blank clips are kept', () => {
  const dir = path.join(dirs.root, 'clips');
  for (let i = 0; i < 5; i++) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `2026-01-0${i + 1}.wav`), 'x');
  }
  saveBlankClip(dir, wav(0.1), 3);
  const left = fs.readdirSync(dir).sort();
  assert.equal(left.length, 3);
  assert.ok(!left.includes('2026-01-01.wav') && !left.includes('2026-01-03.wav'));
});

test('ElevenLabs gets the piece before as context, so the intonation carries across pieces', () => {
  const b = elevenBody({ text: 'Three look strong.', speed: 1.25, previousText: 'I found **twelve** roles.' });
  assert.equal(b.previous_text, 'I found twelve roles.');
  assert.equal(b.voice_settings.speed, 1.2);
  assert.equal(b.model_id, 'eleven_flash_v2_5');
  assert.equal('previous_text' in elevenBody({ text: 'Hi.' }), false);
});

test('the same sentence captured twice: two mics, most of BOTH clips shared; a clip holding more is not the same sentence', async () => {
  const { heardTwice, clipOverlap, sameInSubstance, TWICE_MIN_OVERLAP } = await import('../lib/heard.js');
  assert.equal(TWICE_MIN_OVERLAP, 0.6);
  // One 2 s sentence, as each mic heard it (the speech itself: the quiet around it is left out).
  const ptt = { mic: 'app', endAt: 10_000, ms: 2000 };
  const handsFree = { mic: 'page', endAt: 10_150, ms: 2100 };
  assert.ok(clipOverlap(ptt, handsFree) > 0.85);
  assert.equal(heardTwice(ptt, handsFree), true);
  assert.equal(heardTwice(handsFree, ptt), true, 'whichever came in first');
  // Hands-free caught two sentences (5 s); push-to-talk was held for the second (2 s). Measured
  // against the shorter clip that was a full overlap, and the first sentence was thrown away.
  const both = { mic: 'page', endAt: 10_100, ms: 5000 };
  assert.equal(clipOverlap(both, ptt), 0.4);
  assert.equal(heardTwice(both, ptt), false, 'the first sentence is not lost');
  // A short push-to-talk begun just as the hands-free speech ended: said after it, not with it.
  assert.equal(heardTwice(handsFree, { mic: 'app', endAt: 11_000, ms: 800 }), false);
  // Well apart; nothing to compare.
  assert.equal(heardTwice(handsFree, { mic: 'app', endAt: 30_000, ms: 2000 }), false);
  assert.equal(heardTwice(null, ptt), false);
  assert.equal(heardTwice(ptt, { mic: 'page', endAt: 10_000, ms: 0 }), false);
  // By microphone, not by how the clip was started: the window's own push-to-talk (Space) and its
  // hands-free listening are one mic, which can't record two clips at once.
  assert.equal(heardTwice({ mic: 'page', endAt: 10_000, ms: 2000 }, { mic: 'page', endAt: 10_050, ms: 2000 }), false);
  // The same words, as two recognizers write them; and different ones.
  assert.equal(sameInSubstance('Open the budget sheet.', 'open the budgets sheet'), true);
  assert.equal(sameInSubstance('All right, I did.', 'Alright I did'), true);
  assert.equal(sameInSubstance('open the budget sheet', 'no wait, cancel that'), false);
  assert.equal(sameInSubstance('', 'yes'), false);
});

test('voiced sound is measured against the clip\'s own quiet, and loudness over the voiced part alone', () => {
  /** `voiced` s of a tone whose frames sit at `frameRms`, from `lead` s in, over a faint hum. */
  const clip = ({ seconds, lead = 0, voiced, frameRms, hum = 0.001 }) => {
    const rate = 16000;
    const n = Math.round(seconds * rate);
    const b = wav(seconds, 0);
    for (let i = 0; i < n; i++) {
      const on = i >= lead * rate && i < (lead + voiced) * rate;
      b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * (on ? frameRms : hum) * Math.SQRT2 * 32767), 44 + i * 2);
    }
    return b;
  };
  // A soft speaker's long sentence in a quiet room: every frame under the old fixed 0.01, so it
  // counted as no voiced sound at all (a blip).
  const soft = wavStats(clip({ seconds: 4, lead: 0.5, voiced: 2.5, frameRms: 0.008 }));
  assert.ok(soft.voicedMs >= 2400 && soft.voicedMs <= 2600, `a sentence, not a blip (${soft.voicedMs})`);
  // The room alone is not speech, and neither is one click.
  assert.equal(wavStats(clip({ seconds: 2, voiced: 0, frameRms: 0, hum: 0.004 })).voicedMs, 0);
  // The same voice, with and without a second of quiet after it (hands-free and push-to-talk):
  // the whole-clip level differs by several dB, the voiced level doesn't.
  const pushToTalk = wavStats(clip({ seconds: 2, voiced: 2, frameRms: 0.09 }));
  const handsFree = wavStats(clip({ seconds: 3.3, lead: 0.3, voiced: 2, frameRms: 0.09 }));
  const db = (x) => 20 * Math.log10(x);
  assert.ok(db(pushToTalk.rms) - db(handsFree.rms) > 2, 'whole-clip loudness reads the hands-free clip lower');
  assert.ok(Math.abs(db(pushToTalk.voicedRms) - db(handsFree.voicedRms)) < 0.5, `voiced loudness is the same (${pushToTalk.voicedRms} vs ${handsFree.voicedRms})`);
  assert.ok(Math.abs(handsFree.voicedRms - 0.09) < 0.005);
  // Where the speech sits in the clip, for telling one sentence recorded by two mics.
  assert.deepEqual([handsFree.speechStartSec, handsFree.speechEndSec], [0.3, 2.3]);
  assert.deepEqual([wavStats(wav(2, 0)).voicedRms, wavStats(wav(2, 0)).speechEndSec], [0, 0]);
});

test('a near-silent clip yields no text, whatever the recognizer wrote; push-to-talk with real words is kept', async () => {
  const { cleanHeard, nearSilent, MIN_VOICED_MS, NOISE_FLOOR_RMS } = await import('../lib/heard.js');
  assert.deepEqual([MIN_VOICED_MS, NOISE_FLOOR_RMS], [250, 0.003]);
  const said = { text: 'The phase of the world is the data of the bodies.' };
  const breath = { seconds: 1.6, rms: 0.006, voicedMs: 120 };
  const room = { seconds: 2, rms: 0.002, voicedMs: 400 };
  const spoken = { seconds: 2, rms: 0.05, voicedMs: 1400 };
  assert.equal(nearSilent(breath), true);
  assert.equal(nearSilent(room), true);
  assert.equal(nearSilent(spoken), false);
  assert.equal(nearSilent(null), false, 'nothing measured: nothing claimed');
  assert.deepEqual(cleanHeard(said, { stats: breath }), { text: '', dropped: [said.text], reason: 'no_speech' });
  assert.equal(cleanHeard(said, { stats: room }).reason, 'no_speech');
  assert.equal(cleanHeard(said, { stats: spoken }).text, said.text);
  assert.equal(cleanHeard(said).text, said.text, 'as before with no stats');
  // Push-to-talk with a real word in it is always kept, however soft or short the clip: a quick
  // "Yes." on the key (0.3 s) was being thrown away. One of Whisper's stock lines is not a word said.
  assert.equal(cleanHeard({ text: 'open my calendar' }, { stats: breath, sure: true }).text, 'open my calendar');
  assert.equal(cleanHeard({ text: 'Yes.' }, { stats: { seconds: 0.3, rms: 0.004, voicedMs: 120 }, sure: true }).text, 'Yes.');
  assert.equal(cleanHeard({ text: 'open my calendar' }, { stats: { ...breath, seconds: 0.3 }, sure: true }).text, 'open my calendar');
  assert.equal(cleanHeard({ text: 'Thank you.' }, { stats: breath, sure: true }).reason, 'no_speech');
  assert.equal(cleanHeard({ text: 'open my calendar' }, { stats: breath, sure: false }).reason, 'no_speech');
  // Through checkHeard, from the clip itself.
  const clipDir = path.join(dirs.data, 'stt-blank-clips');
  const quiet = checkHeard({ wav: wav(1.5, 0.002), heard: { text: said.text, engine: 'whisper' }, live: '', page: { mode: 'hands-free' }, clipDir });
  assert.equal(quiet.pick.source, 'none');
  assert.equal(quiet.cleaned.reason, 'no_speech');
  assert.equal(quiet.entry.event, 'no_speech_final');
  const held = checkHeard({ wav: wav(1.5, 0.002), heard: { text: 'open my calendar', engine: 'whisper' }, live: '', page: { mode: 'push-to-talk' }, clipDir, sure: true });
  assert.equal(held.pick.text, 'open my calendar');
});
