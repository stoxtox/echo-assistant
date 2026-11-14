// Apple's on-device speech to text in the Mac app (macos/Sources/AppleSpeech.swift): the server
// takes its text as a transcription (lib/stt.js appleHeard), and on a Mac with macOS 26 or later
// and the Swift tools, a sentence spoken by `say` goes through the app's code and comes out right,
// a moment after it ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { sandbox } from './helpers.js';

sandbox('applespeech');
const { appleHeard } = await import('../lib/stt.js');
const root = path.resolve(import.meta.dirname, '..');
const run = promisify(execFile);

test('the app\'s text becomes a transcription: words with confidences, the unsure ones flagged', () => {
  const h = appleHeard({ text: ' Send it to Priya ', ms: 38.6, words: [{ word: 'Send', p: 0.99 }, { word: 'it', p: 0.98 }, { word: 'to', p: 0.97 }, { word: 'Priya', p: 0.41 }, { word: 'bad' }] });
  assert.equal(h?.text, 'Send it to Priya');
  assert.equal(h?.engine, 'apple');
  assert.equal(h?.ms, 39);
  assert.equal(h?.words.length, 4, 'a word without a confidence is left out');
  assert.deepEqual(h?.uncertain, [{ word: 'Priya', confidence: 0.41 }], 'a low-confidence name is flagged, like Whisper\'s');
  for (const bad of [null, undefined, 'text', { text: '' }, { text: '   ' }, { ms: 3 }]) assert.equal(appleHeard(bad), null, JSON.stringify(bad));
});

const macos = (() => {
  try {
    return Number(execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).split('.')[0]);
  } catch {
    return 0;
  }
})();
const swift = (() => {
  try {
    execFileSync('/usr/bin/xcrun', ['--sdk', 'macosx', '--find', 'swiftc'], { stdio: 'ignore', timeout: 20000 });
    return fs.existsSync('/usr/bin/say');
  } catch {
    return false;
  }
})();

test('a spoken sentence through the app\'s code: right words, names it was given, done within a moment', { skip: !(macos >= 26 && swift) && 'needs macOS 26+ and the Swift tools' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-applespeech-'));
  const bin = path.join(dir, 'check');
  const wav = path.join(dir, 's.wav');
  const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  await run('/usr/bin/xcrun', ['--sdk', 'macosx', 'swiftc', '-O', '-swift-version', '5', '-target', `${arch}-apple-macos26.0`, path.join(root, 'macos/Sources/AppleSpeech.swift'), path.join(root, 'macos/Tests/AppleSpeechCheck/main.swift'), '-o', bin], { timeout: 300000 });
  await run('/usr/bin/say', ['-o', wav, '--data-format=LEF32@16000', 'Send a message to Priya saying I will be late']);
  let out;
  try {
    out = JSON.parse((await run(bin, [wav, 'en-US', 'Priya,Foodbowl', 'dictation'], { timeout: 120000 })).stdout);
  } catch (e) {
    // Exit 2: the model isn't on this Mac (and couldn't be fetched): nothing to check here.
    if (/** @type {any} */ (e).code === 2) return;
    throw e;
  }
  assert.match(out.text, /send a message to priya saying i will be late/i);
  assert.ok(out.ms < 1000, `finished ${out.ms} ms after the sentence ended`);
  assert.ok(out.partials > 0, 'live words while it was said');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('finishing a sentence: early audio kept, late words dropped, never stuck, nothing carried over', () => {
  const src = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const apple = src('macos/Sources/AppleSpeech.swift');
  const finish = apple.slice(apple.indexOf('func finish() async'));
  assert.ok(finish.indexOf('try await started?.value') < finish.indexOf('input.finish()'), 'audio from while the model got ready goes in before the input ends');
  assert.match(finish, /catch \{[\s\S]*?await analyzer\.cancelAndFinishNow\(\)/, 'a failed finish lets go of the analyzer');
  assert.match(apple, /cancelled \|\| finishing/, 'no live words once the sentence is being finished');
  const mic = src('macos/Sources/NativeMic.swift');
  // Apple slow to finish: the clip goes after 2 s with no text at all and marked as timed out, so
  // the server transcribes it itself. (An empty text used to go, which read as "nothing was said".)
  assert.match(mic, /asyncAfter\(deadline: \.now\(\) \+ 2\) \{ once\(nil\) \}/);
  assert.match(mic, /sendOnce\(final, final == nil\)/);
  assert.doesNotMatch(mic, /"text": ""/);
  // One way out for every sentence that isn't sent (the machine's `dropped`), and it drops the transcription.
  assert.match(mic, /case \.dropped\(let why, let s\):[\s\S]{0,160}cancelApple\(\)/, 'a dropped sentence never carries its transcription into the next one');
  // Not a Labs switch any more: Apple's text is used whenever the app sends it.
  const speech = src('lib/server/speech.js');
  assert.match(speech, /const apple = appleHeard\(page\.final\);/);
  assert.doesNotMatch(speech + src('lib/flags.ts') + src('public/app.js'), /appleSpeech/);
  assert.match(speech, /const appleBlank = appleOnly && page\.final[\s\S]{0,4000}if \(appleBlank\) return dropped\('blank'/, 'Apple understood nothing, the browser engine picked: blank, not an error');
});
