// The conversation log (lib/transcript.ts): what was said and answered, word for word, with its
// time, kept apart from the timeline (which never holds words), only while the setting is on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';

const dirs = sandbox('transcript');
const { said, readTranscript, fromBroadcast, transcriptDir, prune, limits } = await import('../lib/transcript.ts');
const { saveSettings } = await import('../lib/settings.js');
const { record, readTimeline } = await import('../lib/timeline.ts');
const { render } = await import('../scripts/transcript.ts');

const T0 = Date.parse('2026-10-04T15:00:00.000Z');

test('what the window is sent is written down with who said it, and read back in order', () => {
  let reply = 'The sheet is open in Preview.';
  const send = (msg: any) => fromBroadcast(msg, () => reply);
  send({ type: 'heard', text: 'now, what next?', engine: 'apple', trace: 't-1' });
  send({ type: 'speak', id: 'v1', text: 'The sheet is open in Preview.', trace: 't-1' });
  send({ type: 'say_end' });
  send({ type: 'heard', text: 'open the folder', typed: true });
  send({ type: 'say', id: 'v2', text: 'Opening Finder…' });
  send({ type: 'busy', busy: true });
  const lines = readTranscript(dirs.data, 0, Date.now() + 1000);
  assert.deepEqual(lines.map((l) => `${l.who}/${l.kind}`), ['you/said', 'echo/spoke', 'echo/shown', 'you/typed', 'echo/step']);
  assert.equal(lines[0]?.text, 'now, what next?');
  assert.equal(lines[0]?.trace, 't-1');
  assert.equal(lines[2]?.text, reply);
  reply = '';
  send({ type: 'say_end' });
  assert.equal(readTranscript(dirs.data, 0, Date.now() + 1000).length, 5, 'no words, no line');
});

test('nothing is written while the setting is off, and the timeline never gets the words', () => {
  const before = readTranscript(dirs.data, 0, Date.now() + 1000).length;
  saveSettings({ keepTranscript: false });
  said('you', 'said', 'this must not be kept');
  assert.equal(readTranscript(dirs.data, 0, Date.now() + 1000).length, before);
  saveSettings({ keepTranscript: true });
  said('you', 'unanswered', 'a sentence from the television', { reason: 'media', trace: 't-2' });
  const last = readTranscript(dirs.data, 0, Date.now() + 1000).at(-1)!;
  assert.equal(last.reason, 'media');
  record('server', 'turn.first_sound', { ms: 900, text: 'a sentence from the television' }, 't-2');
  const tl = fs.readdirSync(path.join(dirs.data, 'timeline')).map((f) => fs.readFileSync(path.join(dirs.data, 'timeline', f), 'utf8')).join('');
  assert.doesNotMatch(tl, /television/);
});

test('old days are deleted, and the file is readable only by the user', () => {
  const dir = transcriptDir(dirs.data);
  fs.writeFileSync(path.join(dir, '2020-01-01.jsonl'), '{}\n');
  assert.equal(prune(dirs.data, Date.now()), 1);
  assert.equal(fs.existsSync(path.join(dir, '2020-01-01.jsonl')), false);
  assert.ok(limits.days >= 14);
  const today = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl'))!;
  assert.equal(fs.statSync(path.join(dir, today)).mode & 0o077, 0);
});

test('read back as a conversation, with how long Echo took and when each line was heard', () => {
  const lines: any[] = [
    { ts: new Date(T0).toISOString(), who: 'you', kind: 'said', text: 'put a hundred rows in', trace: 't-9', mode: 'hands-free' },
    { ts: new Date(T0 + 1200).toISOString(), who: 'echo', kind: 'spoke', text: 'Adding a hundred rows.', trace: 't-9', id: 'v1' },
    { ts: new Date(T0 + 9000).toISOString(), who: 'echo', kind: 'shown', text: 'Adding a hundred rows.\n\nDone.', trace: 't-9' },
    { ts: new Date(T0 + 20_000).toISOString(), who: 'you', kind: 'unanswered', text: 'in other news', reason: 'media' },
  ];
  const row = (type: string, f: any, at: number): any => ({ ts: new Date(at).toISOString(), seq: 1, src: 'server', type, trace: 't-9', f });
  const rows = [row('turn.tool_start', { name: 'sheet_write' }, T0 + 1300), row('turn.first_sound', { ms: 1500 }, T0 + 1500), row('play.start', { chars: 22, ms: 300 }, T0 + 4500), row('turn.end', { ms: 9000 }, T0 + 9000)];
  const out = render(lines, rows).join('\n');
  assert.match(out, /You \(hands-free\): put a hundred rows in/);
  assert.match(out, /first sound after 1\.5 s · tools: sheet_write · turn took 9\.0 s/);
  assert.match(out, /Echo: Adding a hundred rows\. {3}\[heard \d\d:\d\d:\d\d, 3\.3 s later\]/);
  assert.match(out, /You \(not passed on: media\): in other news/);
  assert.doesNotMatch(out, /Echo showed/);
  assert.match(render(lines, rows, { full: true }).join('\n'), /Echo showed: Adding a hundred rows\. ⏎ Done\./);
  assert.ok(readTimeline);
});
