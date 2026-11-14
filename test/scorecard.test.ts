// The scorecard (lib/scorecard.ts): the 15 numbers, from a data folder of logs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';

const dirs = sandbox('scorecard');
const { scorecard, scorecardTable, sentenceKind, percentile } = await import('../lib/scorecard.ts');

const day = '2026-10-05';
const at = (h: number, m: number, s = 0) => new Date(`${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`).toISOString();
const jsonl = (name: string, rows: object[]) => fs.writeFileSync(path.join(dirs.data, name), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const clock = (h: number, m: number, s = 0) => new Date(`${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`).toLocaleTimeString('en-US');

test('what each sentence was: a request, or overhead', () => {
  const t0 = Date.parse(at(10, 0));
  assert.equal(sentenceKind('keep going', t0, []), 'keep_going');
  assert.equal(sentenceKind('Yes, please.', t0, []), 'approval');
  assert.equal(sentenceKind('No, I said the blue one', t0, []), 'correction');
  assert.equal(sentenceKind('make the header text bigger please', t0 + 30_000, [{ text: 'make the header text bigger', at: t0 }]), 'repeat');
  assert.equal(sentenceKind('make the header text bigger please', t0 + 5 * 60_000, [{ text: 'make the header text bigger', at: t0 }]), 'request', 'minutes later it is a new request');
  assert.equal(sentenceKind('open my calendar for tomorrow', t0, []), 'request');
  assert.equal(percentile([5, 1, 3, 2, 4], 0.5), 3);
  assert.equal(percentile([], 0.5), null);
});

test('the card, from logs', () => {
  jsonl('stt-log.jsonl', [
    { at: at(10, 0), trace: 'a', engine: 'whisper', sttMs: 1000, fixMs: 0, raw: 'open my calendar', text: 'open my calendar' },
    { at: at(10, 1), trace: 'b', engine: 'whisper', sttMs: 400, fixMs: 0, raw: 'keep going', text: 'keep going' },
    { at: at(10, 2), event: 'heard_twice', engine: 'whisper', mode: 'push-to-talk', ms: 300 },
    { at: at(10, 3), event: 'own_voice', engine: 'whisper', text: 'sure' },
  ]);
  jsonl('events.jsonl', [
    { at: at(10, 0), type: 'turn_start', trace: 'a', source: 'speech' },
    { at: at(10, 0), type: 'first_speech', trace: 'a', ms: 800 },
    { at: at(10, 1), type: 'turn_start', trace: 'b', source: 'speech' },
    { at: at(10, 1), type: 'first_speech', trace: 'b', ms: 600 },
    { at: at(10, 5), type: 'turn_start', trace: 'c', source: 'event' },
  ]);
  jsonl('dispatcher-timing.jsonl', [
    { at: at(10, 0), type: 'turn', maxCtx: 40_000 },
    { at: at(10, 1), type: 'turn', maxCtx: 70_000 },
  ]);
  jsonl('computer-log.jsonl', [
    { at: at(10, 0), event: 'action', changes: ['value'] },
    { at: at(10, 0), event: 'action', changes: [] },
    { at: at(10, 0), event: 'confirm_asked' },
  ]);
  fs.writeFileSync(path.join(dirs.data, 'tasks.json'), JSON.stringify([{ id: 1, log: [{ t: at(10, 4), kind: 'ask', text: 'git push' }, { t: '2026-09-01T00:00:00Z', kind: 'ask', text: 'old' }] }]));
  fs.writeFileSync(path.join(dirs.data, 'costs.json'), JSON.stringify({ days: { [day]: { assistant: 0.3, dispatcher: 0.2, workers: 0.1 }, '2026-09-01': { assistant: 50, workers: 50 } } }));
  fs.mkdirSync(path.join(dirs.data, 'conversations'), { recursive: true });
  fs.writeFileSync(
    path.join(dirs.data, 'conversations', `${day}.md`),
    [
      `**[${clock(10, 0)}] User:** open my calendar`,
      `**[${clock(10, 0, 5)}] Assistant:** Done, it's open.`,
      `**[${clock(10, 1)}] User:** keep going`,
      `**[${clock(10, 2)}] Assistant:** I've changed the color to blue.`,
      `**[${clock(10, 2, 30)}] User:** no it's not done, nothing changed`,
    ].join('\n\n') + '\n',
  );
  const r = scorecard(dirs.data, Date.parse(`${day}T00:00:00`), Date.parse(`${day}T23:59:59`));
  const m: Record<number, any> = Object.fromEntries(r.metrics.map((x) => [x.id, x]));
  assert.equal(r.spokenTurns, 2);
  assert.equal(m[5].value?.toFixed(3), (1 / 3).toFixed(3), 'one turn of three was started by Echo');
  assert.equal(m[6].value, 400, 'nearest-rank median of 1.0 s and 0.4 s');
  assert.equal(m[7].value, 1000, 'speech to text plus the time to the first words: 1.8 s and 1.0 s (nearest-rank median)');
  assert.equal(m[8].value, 2, 'one worker approval and one card that day (the old one is outside the range)');
  assert.equal(m[9].value, 0.5);
  assert.equal(m[10].shown, '1 of 2 (50.0%)', 'the second "done" was disputed');
  assert.equal(m[11].value, 1);
  assert.equal(m[12].value, 0.2, '$0.40 that day over two spoken turns');
  assert.equal(m[13].value, 70_000);
  assert.equal(m[14].shown, '1 / 1');
  assert.equal(m[15].value, null);
  assert.equal(m[15].met, null);
  assert.match(scorecardTable(r), /\| 14 \| Heard twice \/ own voice \| 1 \/ 1 \| 23 \/ 9 \| 0 \/ 0 \| ✗ \|/);
});

test('golden tasks: a task passes only when all its runs pass; simulated runs say so', () => {
  fs.mkdirSync(path.join(dirs.data, 'golden'), { recursive: true });
  const rows = [
    ...[1, 2, 3].map((run) => ({ at: at(11, 0), task: 'gmail-send', run, pass: true, where: 'simulated' })),
    ...[1, 2, 3].map((run) => ({ at: at(11, 0), task: 'finder-move', run, pass: run !== 2, where: 'simulated' })),
  ];
  jsonl('golden/results.jsonl', rows);
  const r = scorecard(dirs.data, Date.parse(`${day}T00:00:00`), Date.parse(`${day}T23:59:59`));
  const g: any = r.metrics.find((x) => x.id === 15);
  assert.equal(g.value, 0.5);
  assert.equal(g.shown, '50.0% of 2');
  assert.match(g.note, /simulated Mac/);
});

test('a day is the user\'s day: a late evening is not two days in UTC', () => {
  jsonl('stt-log.jsonl', [
    // New York (the tests' ECHO_TZ): 23:30 there is 03:30 the next day in UTC.
    { at: '2026-10-05T12:00:00.000Z', trace: 'm', engine: 'whisper', sttMs: 500, fixMs: 0, raw: 'good morning', text: 'good morning' },
    { at: '2026-10-06T03:30:00.000Z', trace: 'n', engine: 'whisper', sttMs: 500, fixMs: 0, raw: 'one more thing', text: 'one more thing' },
  ]);
  const r = scorecard(dirs.data, Date.parse('2026-10-05T04:00:00Z'), Date.parse('2026-10-06T04:00:00Z'));
  assert.equal(r.days, 1);
});
