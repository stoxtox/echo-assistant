// Keeping your voice to measure how well Echo listens (lib/recordings.js, scripts/listen-*.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sandbox, serverSource } from './helpers.js';

const dirs = sandbox('recordings');
const { keepRecording, pruneRecordings, recordingsOn, recordingId, recordingFate, recordingsDir, labelsFile, wordErrors, words, RECORDINGS_MAX } = await import('../lib/recordings.js');
const root = path.resolve(import.meta.dirname, '..');
const wav = Buffer.from('RIFF....WAVEfmt fake clip');

test('recording is on by default only in the developer copy; your choice wins either way', () => {
  assert.equal(recordingsOn(null, true), true);
  assert.equal(recordingsOn(undefined, false), false);
  assert.equal(recordingsOn(false, true), false);
  assert.equal(recordingsOn(true, false), true);
});

test('a kept clip lands in data/listening/clips with an id that sorts by time', () => {
  const at = new Date('2026-10-02T03:14:15.123Z');
  const id = keepRecording(wav, { enabled: true, now: at });
  assert.match(id, /^2026-10-02T03-14-15-123Z-[0-9a-f]{4}$/);
  assert.equal(recordingsDir(), path.join(dirs.data, 'listening', 'clips'));
  assert.deepEqual(fs.readFileSync(path.join(recordingsDir(), `${id}.wav`)), wav);
  assert.ok(recordingId(new Date('2026-10-03T00:00:00Z')) > id);
});

test('nothing is kept when recording is off or the clip is empty, and a failed write never throws', () => {
  const dir = path.join(dirs.root, 'off');
  assert.equal(keepRecording(wav, { enabled: false, dir }), '');
  assert.equal(keepRecording(Buffer.alloc(0), { enabled: true, dir }), '');
  assert.equal(fs.existsSync(dir), false);
  const file = path.join(dirs.root, 'a-file');
  fs.writeFileSync(file, 'x');
  assert.equal(keepRecording(wav, { enabled: true, dir: path.join(file, 'clips') }), '');
});

test('clips older than 30 days go, then the oldest beyond the cap', () => {
  const dir = path.join(dirs.root, 'prune');
  const now = new Date('2026-10-02T12:00:00Z');
  const day = 86400000;
  for (const d of [45, 31, 29, 2, 1, 0]) keepRecording(wav, { enabled: true, dir, now: new Date(now.getTime() - d * day), pruneEvery: 1e9 });
  assert.equal(pruneRecordings({ dir, now }), 2);
  assert.equal(fs.readdirSync(dir).length, 4);
  assert.equal(pruneRecordings({ dir, now, max: 3 }), 1);
  const left = fs.readdirSync(dir).sort();
  assert.equal(left.length, 3);
  assert.ok(left[0].startsWith('2026-09-30'), 'the oldest one went');
  assert.equal(pruneRecordings({ dir: path.join(dirs.root, 'none'), now }), 0);
  assert.equal(RECORDINGS_MAX, 3000);
});

test('keeping a clip prunes now and then on its own', () => {
  const dir = path.join(dirs.root, 'auto');
  const now = new Date('2026-10-02T12:00:00Z');
  keepRecording(wav, { enabled: true, dir, now: new Date('2026-08-01T00:00:00Z'), pruneEvery: 1e9 });
  keepRecording(wav, { enabled: true, dir, now, pruneEvery: 1 });
  assert.equal(fs.readdirSync(dir).length, 1);
});

const at = '2026-10-02T03:14:15.000Z';
test('a recording that reached Echo: what it heard, at each stage, and how long it took', () => {
  const f = recordingFate([
    { at, event: 'blank_final', used: 'live', live: 'check the build' },
    { at, raw: 'Check the bild.', text: 'Check the build.', sttMs: 1400, fixMs: 900, audio: { mode: 'handsfree' }, stages: { whisper: '.', live: 'check the build', source: 'live' } },
  ]);
  assert.equal(f.fate, 'reached');
  assert.equal(f.heard, 'Check the build.');
  assert.equal(f.raw, 'Check the bild.');
  assert.equal(f.whisper, '.');
  assert.equal(f.live, 'check the build');
  assert.equal(f.source, 'live');
  assert.equal(f.mode, 'handsfree');
  assert.equal(f.sttMs, 1400);
  assert.equal(f.fixMs, 900);
  // Instant commands and held lines reached Echo without the usual entry.
  assert.equal(recordingFate([{ at, event: 'run_stop', text: 'stop' }]).fate, 'reached');
  assert.equal(recordingFate([{ at, event: 'local', text: 'pause' }]).heard, 'pause');
});

test('set aside as not for Echo, with why and how sure', () => {
  const f = recordingFate([{ at, event: 'run_ignored', text: 'open the settings page', mode: 'driving', why: 'talking to someone else', confidence: 0.62 }]);
  assert.deepEqual([f.fate, f.heard, f.mode, f.why, f.confidence], ['set_aside', 'open the settings page', 'driving', 'talking to someone else', 0.62]);
  const n = recordingFate([{ at, event: 'not_for_echo', mode: 'answer', text: 'yeah do it' }]);
  assert.deepEqual([n.fate, n.why, n.mode], ['set_aside', 'not_for_echo', 'answer']);
});

test('no words, its own voice, a duplicate, just the wake word, or nothing logged', () => {
  assert.equal(recordingFate([{ at, event: 'no_text', reason: 'blank' }]).fate, 'no_text');
  assert.equal(recordingFate([{ at, event: 'low_confidence_final', cause: 'quiet', live: 'mm' }]).why, 'quiet');
  assert.equal(recordingFate([{ at, event: 'own_voice', text: 'Done.' }]).fate, 'own_voice');
  assert.equal(recordingFate([{ at, event: 'heard_twice' }]).fate, 'heard_twice');
  assert.equal(recordingFate([{ at, event: 'wake_only' }]).fate, 'wake_only');
  assert.equal(recordingFate([]).fate, 'unknown');
  // A line that's only a note (got through without the wake word) doesn't decide the fate.
  assert.equal(recordingFate([{ at, event: 'no_wake_turn' }, { at, raw: 'hi', text: 'Hi.' }]).fate, 'reached');
});

test('word errors: substitutions, insertions and deletions, ignoring case and punctuation', () => {
  assert.deepEqual(words("I'll text Mira, OK?"), ["i'll", 'text', 'mira', 'ok']);
  assert.deepEqual(wordErrors('text Mira the plan', 'Text Mira the plan.'), { errors: 0, said: 4 });
  assert.deepEqual(wordErrors('text Mira the plan', 'text Myra the plan'), { errors: 1, said: 4 });
  assert.deepEqual(wordErrors('open adobe xd', 'open auto biopsy x d'), { errors: 4, said: 3 });
  assert.deepEqual(wordErrors('check the build', ''), { errors: 3, said: 3 });
  assert.deepEqual(wordErrors('', 'uh'), { errors: 1, said: 0 });
});

test('the report counts lost and wrongly answered sentences from your labels, and exports for stt-bench', () => {
  const clips = recordingsDir();
  const ids = ['2026-10-02T10-00-00-000Z-aaaa', '2026-10-02T10-01-00-000Z-bbbb', '2026-10-02T10-02-00-000Z-cccc'];
  for (const id of ids) fs.writeFileSync(path.join(clips, `${id}.wav`), wav);
  const log = [
    { at: '2026-10-02T10:00:00.000Z', rec: ids[0], raw: 'text Myra', text: 'Text Myra.', sttMs: 1200, fixMs: 800, audio: { mode: 'handsfree' }, stages: { whisper: 'text Myra', live: 'text ria' } },
    { at: '2026-10-02T10:01:00.000Z', rec: ids[1], event: 'run_ignored', text: 'open settings', mode: 'driving', why: 'unclear' },
    { at: '2026-10-02T10:02:00.000Z', rec: ids[2], raw: 'the game is on', text: 'The game is on.', sttMs: 1600, audio: { mode: 'handsfree' } },
  ];
  fs.writeFileSync(path.join(dirs.data, 'stt-log.jsonl'), log.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(labelsFile(), JSON.stringify({
    [ids[0]]: { forEcho: true, said: 'text Mira' },
    [ids[1]]: { forEcho: true, said: 'open settings' },
    [ids[2]]: { forEcho: false, said: 'the game is on' },
  }));
  const out = path.join(dirs.root, 'bench');
  const text = execFileSync(process.execPath, [path.join(root, 'scripts/listen-report.js'), '--export', out], { encoding: 'utf8', env: process.env });
  assert.match(text, /3 recordings, 3 labelled/);
  assert.match(text, /meant for Echo, but it never got them\s+1 of 2\s+50%/);
  assert.match(text, /not meant for Echo, but it answered\s+1 of 1\s+100%/);
  assert.match(text, /lost: “open settings” \(set_aside, unclear, driving\)/);
  assert.match(text, /word error rate, what Echo used\s+13%/, '1 wrong word of 8 said');
  assert.match(text, /speech to text\s+p50 1\.60 s/);
  const rows = fs.readFileSync(path.join(out, 'clips.txt'), 'utf8').trim().split('\n');
  assert.equal(rows.length, 3);
  assert.equal(rows[0], `${ids[0]}|handsfree|text Mira`);
  assert.ok(fs.existsSync(path.join(out, `${ids[1]}.wav`)));
});

test('the review tool refuses to run without a terminal instead of hanging', () => {
  let code = 0, err = '';
  try {
    execFileSync(process.execPath, [path.join(root, 'scripts/listen-review.js'), '--no-play'], { encoding: 'utf8', env: process.env, input: '', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) { code = e.status; err = String(e.stderr); }
  // The report test above labelled everything, so it may also just say so.
  assert.ok(code === 2 ? /run it in a terminal/.test(err) : code === 0, `exit ${code}: ${err}`);
});

test('the server keeps every clip and tags every line it writes about it', () => {
  const src = serverSource();
  const start = src.indexOf("'POST /api/utterance': async");
  const handler = src.slice(start, src.indexOf("\n    'POST /api/wake'", start + 10));
  assert.match(handler, /const rec = keepRecording\(wav, \{ enabled: recordingOn\(\) \}\)/);
  assert.equal((handler.match(/fs\.appendFileSync\(sttLog/g) || []).length, 1, 'only the logStt helper writes the log');
  assert.match(handler, /event: 'no_text'/);
  assert.match(fs.readFileSync(path.join(root, 'lib/pipeline/utterance.ts'), 'utf8'), /event: 'wake_only'/);
  assert.match(src, /audio, stages, rec, trace, mayNotBeForEcho: Boolean\(verdict\.mayNotBeForEcho\), soft: /);
  assert.match(src, /async function handleUtterance\([^)]*rec = ''/);
  assert.match(src, /keepRecordingsOn: speech\.recordingOn\(\)/);
  const settings = fs.readFileSync(path.join(root, 'lib/settings.js'), 'utf8');
  assert.match(settings, /keepRecordings: null/);
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  assert.match(html, /id="setKeepRecordings"/);
  assert.match(html, /stays on this Mac for 30 days/);
});
