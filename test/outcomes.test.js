// Judging whether computer-use requests worked, from the computer-use log and the conversation log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zonedToUtc, transcriptLines, requestsFromLog, judgeRequest, judgeAll, isRepeat } from '../lib/outcomes.js';

const TZ = 'America/New_York';
const BASE = Date.parse('2026-10-01T18:00:00Z'); // 2:00:00 PM in New York
const at = (s) => new Date(BASE + s * 1000).toISOString();
/** A conversation log line at `s` seconds past BASE, as server.js writes it. */
const line = (s, who, text) => `**[${new Date(BASE + s * 1000).toLocaleTimeString('en-US', { timeZone: TZ })}] ${who}:** ${text}\n\n`;
const linesOf = (...ls) => transcriptLines(ls.join(''), '2026-10-01', TZ);

test('wall-clock times in a time zone become UTC, across daylight saving', () => {
  assert.equal(zonedToUtc('2026-10-01', '14:00:00', TZ), BASE);
  assert.equal(zonedToUtc('2026-12-01', '14:00:00', TZ), Date.parse('2026-12-01T19:00:00Z'), 'EST in winter');
  assert.equal(zonedToUtc('2026-10-01', '00:30:05', 'UTC'), Date.parse('2026-10-01T00:30:05Z'));
});

test('the conversation log is read line by line with times', () => {
  const ls = linesOf(line(0, 'User', 'Open the report'), line(3, 'Assistant', 'Opening it.'), line(9, 'Event', 'Task 7 finished'));
  assert.deepEqual(ls.map((l) => [l.at - BASE, l.who, l.text]), [[0, 'User', 'Open the report'], [3000, 'Assistant', 'Opening it.'], [9000, 'Event', 'Task 7 finished']]);
});

test('a run splits into requests, and confirmation answers go with the request that asked', () => {
  const reqs = requestsFromLog([
    { at: at(1), event: 'run_started', run: 'r1', app: 'Mail' },
    { at: at(2), event: 'action', run: 'r1', action: 'click', verified: true, ok: true },
    { at: at(3), event: 'confirm_asked', run: 'r1', id: 'c1' },
    { at: at(20), event: 'confirm_allowed', id: 'c1' },
    { at: at(40), event: 'session_continued', run: 'r1', request: 2, app: 'Mail' },
    { at: at(41), event: 'action', run: 'r1', action: 'type_text', verified: true, ok: true },
    { at: at(100), event: 'run_ended', run: 'r1', reason: 'idle' },
  ]);
  assert.deepEqual(reqs.map((r) => [r.id, r.actions.length, r.events.length]), [['r1#1', 1, 4], ['r1#2', 1, 3]]);
  assert.equal(reqs[1].ended.reason, 'idle');
});

const run = (...events) => requestsFromLog([{ at: at(1), event: 'run_started', run: 'r', app: 'Notes' }, ...events]);
const step = (s, more = {}) => ({ at: at(s), event: 'action', run: 'r', action: 'click', ok: true, verified: true, ...more });

test('a confirmed last step with "done" from Echo is a clear success; an idle ending changes nothing', () => {
  const [r] = run(step(3), { at: at(90), event: 'run_ended', run: 'r', reason: 'idle' });
  const o = judgeRequest(r, linesOf(line(0, 'User', 'Make a new note called groceries'), line(5, 'Assistant', "Done, it's open."), line(30, 'User', 'Thanks!')));
  assert.equal(o.label, 'success');
  assert.equal(o.strength, 'strong');
  assert.equal(o.asked, 'Make a new note called groceries');
});

test('what the user says next can overturn a confirmed step', () => {
  const [r] = run(step(3));
  const o = judgeRequest(r, linesOf(line(0, 'User', 'Move the file to the desktop'), line(5, 'Assistant', 'Moved it.'), line(20, 'User', "It's not moved, it's still in Downloads.")));
  assert.equal(o.label, 'failed');
  assert.ok(o.why.includes('you sounded unhappy next'));
});

test('taking over, a failed last step, or the same request again is a failure', () => {
  const [a] = run(step(3), { at: at(5), event: 'took_over', run: 'r', reason: 'used the mouse' });
  assert.equal(judgeRequest(a, []).label, 'failed');
  const [b] = run(step(3, { ok: false, verified: undefined }));
  assert.ok(judgeRequest(b, []).why.includes('the last step failed'));
  const reqs = run(step(3), { at: at(30), event: 'session_continued', run: 'r', request: 2 }, step(32));
  const ls = linesOf(line(0, 'User', 'Turn on dark mode in settings please'), line(29, 'User', 'Turn on dark mode in settings'));
  assert.ok(judgeAll(reqs.flatMap((r) => r.events), ls)[0].outcome.why.includes('you asked again'));
});

test('Echo admitting a miss is a failure, but a handoff by design is not', () => {
  const [r] = run(step(3));
  const ask = line(0, 'User', 'Sign me up');
  assert.equal(judgeRequest(r, linesOf(ask, line(5, 'Assistant', "I couldn't find the Sign up button."))).label, 'failed');
  const handoff = judgeRequest(r, linesOf(ask, line(5, 'Assistant', "Name and email are in. You'll need to type the password yourself.")));
  assert.equal(handoff.label, 'success', 'Echo never types passwords: not a failure');
  assert.equal(judgeRequest(r, linesOf(ask, line(5, 'Assistant', "Done. If you can't see my pointer, tell me."))).label, 'success');
});

test('saying no to a confirmation is "stopped"; no steps is "looked"; an unchecked step is "unclear"', () => {
  const [a] = run({ at: at(2), event: 'confirm_asked', run: 'r', id: 'c9' }, { at: at(9), event: 'confirm_denied', id: 'c9' });
  assert.equal(judgeRequest(a, []).label, 'stopped');
  const [b] = run();
  assert.equal(judgeRequest(b, linesOf(line(0, 'User', "What's next?"))).label, 'looked');
  const [c] = run(step(3, { verified: undefined }));
  assert.equal(judgeRequest(c, []).label, 'unclear', 'older Mac apps did not check steps');
});

test('time Echo worked is kept apart from time spent waiting on a confirmation', () => {
  const [r] = run({ at: at(2), event: 'confirm_asked', run: 'r', id: 'c2' }, { at: at(22), event: 'confirm_allowed', id: 'c2' }, step(25));
  const o = judgeRequest(r, []);
  assert.equal(o.waitedMs, 20_000);
  assert.equal(o.workMs, 4_000);
});

test('a retry needs most of the words, and at least four', () => {
  assert.equal(isRepeat('Can you repeat the steps one by one?', 'Can you repeat the steps one by one?'), true);
  assert.equal(isRepeat('Okay, go ahead.', 'Okay, go ahead.'), false, 'short confirmations are not retries');
  assert.equal(isRepeat('Now open the calendar app', 'Can you search for flights'), false);
});
