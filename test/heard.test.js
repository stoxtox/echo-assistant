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
