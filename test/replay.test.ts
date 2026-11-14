// The replay (lib/replay): past sentences rebuilt with their situation, labelled from the evidence,
// and run through the real decision.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sandbox } from './helpers.js';

const dirs = sandbox('replay');
const { buildCases, overlap, conversationLines, drivingWindows } = await import('../lib/replay/cases.ts');
const { replay, score } = await import('../lib/replay/run.ts');

const D = path.join(dirs.root, 'logs-copy');
fs.mkdirSync(path.join(D, 'conversations'), { recursive: true });
const iso = (min: number, sec = 0) => new Date(2026, 9, 1, 22, min, sec).toISOString();
const hhmm = (min: number, sec = 0) => {
  const d = new Date(2026, 9, 1, 22, min, sec);
  return `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')} ${d.getHours() >= 12 ? 'PM' : 'AM'}`;
};
const stt = [
  // Echo working on the Mac from 22:10 to 22:30.
  { at: iso(12), event: 'run_ignored', text: 'What is this blue line in the middle of the page?', mode: 'hands-free', clarity: 'ok', confidence: 0.1, why: 'not_for_echo' },
  { at: iso(12, 20), raw: 'What is this blue line in the middle of the page?', text: 'What is this blue line in the middle of the page?', audio: { mode: 'push-to-talk' } },
  { at: iso(14), event: 'run_ignored', text: 'Why did you save it, cancel that', mode: 'hands-free', clarity: 'ok', confidence: 0.1 },
  { at: iso(15), event: 'run_ignored', text: '*sad*', mode: 'hands-free', clarity: 'low', confidence: 0.1 },
  { at: iso(16), raw: '*gunshot*', text: '*gunshot*', audio: { mode: 'hands-free' } },
  { at: iso(40), raw: 'what time is it', text: 'What time is it?', audio: { mode: 'push-to-talk' } },
  { at: iso(41), event: 'not_for_echo', text: 'and the score tonight was three to one', mode: 'hands-free', clarity: 'ok', confidence: 0.1, words: 8 },
];
fs.writeFileSync(path.join(D, 'stt-log.jsonl'), stt.map((l) => JSON.stringify(l)).join('\n') + '\n');
fs.writeFileSync(path.join(D, 'computer-log.jsonl'), [
  { at: iso(10), event: 'run_started', run: 'r1' },
  { at: iso(30), event: 'run_ended', run: 'r1', reason: 'idle' },
].map((l) => JSON.stringify(l)).join('\n') + '\n');
fs.writeFileSync(path.join(D, 'conversations', '2026-10-01.md'), [
  `**[${hhmm(11)}] User:** make the page look better`,
  `**[${hhmm(11, 30)}] Assistant:** I added shadows to the cards. Want me to keep going?`,
  `**[${hhmm(12, 21)}] User:** What is this blue line in the middle of the page?`,
  `**[${hhmm(12, 25)}] Assistant:** That's XD's viewport marker; it doesn't export.`,
  `**[${hhmm(13)}] User:** okay remove it`,
  `**[${hhmm(40, 1)}] User:** What time is it?`,
  `**[${hhmm(40, 3)}] Assistant:** It's 10:40.`,
  `**[${hhmm(41, 30)}] User:** thanks`,
].join('\n\n'));

test('the conversation and when Echo was working are rebuilt from the logs', () => {
  const lines = conversationLines(path.join(D, 'conversations'));
  assert.equal(lines.length, 8);
  assert.equal(lines[0]?.line, 'User: make the page look better');
  assert.equal(lines[0]?.t, new Date(2026, 9, 1, 22, 11).getTime());
  assert.deepEqual(drivingWindows([{ at: iso(10), event: 'run_started', run: 'x' }, { at: iso(30), event: 'run_ended', run: 'x' }]), [[Date.parse(iso(10)), Date.parse(iso(30))]]);
  assert.equal(overlap('what is this blue line', 'What is this blue line in the page?'), 1);
  assert.equal(overlap('ok', 'ok'), 0, 'too few words to call it a repeat');
});

test('labels come from the evidence: repeated, noise, answered, addressed', () => {
  const cases = buildCases(D);
  const by = (t: string) => cases.find((c) => c.text.startsWith(t));
  assert.equal(by('What is this blue line')?.logged, 'drop');
  assert.equal(by('What is this blue line')?.labelSource, 'repeated', 'said again 20 s later and it got through');
  assert.equal(by('What is this blue line')?.driving, true);
  assert.deepEqual(by('What is this blue line')?.recent, ['User: make the page look better', 'Assistant: I added shadows to the cards. Want me to keep going?']);
  assert.equal(by('Why did you save it')?.labelSource, 'addressed');
  assert.equal(by('*sad*')?.labelSource, 'noise');
  assert.equal(by('*gunshot*')?.label, 'not_for_echo');
  assert.equal(by('what time is it')?.labelSource, 'answered', 'Echo answered and the user carried on');
  assert.equal(by('and the score tonight')?.label, undefined, 'unclear: left out, not guessed');
  // The user's own labels win.
  const withUser = buildCases(D, { userLabels: {} });
  assert.equal(withUser.length, cases.length);
});

test('replayed through the real decision: what was said while Echo worked now reaches it', async () => {
  const out = await replay(buildCases(D), { wakeWord: false });
  const s = score(out);
  assert.equal(s.cases, 7);
  assert.equal(s.labelled, 6);
  // Left alone on Oct 1 (logged: drop); with the conversation window as the only way of listening, delivered.
  const blue = out.find((o) => o.text.startsWith('What is this blue line') && o.logged === 'drop');
  assert.equal(blue?.decided, 'deliver', 'the Oct 1 problem, gone');
  assert.ok(!s.falseDrops.some((d) => d.text.startsWith('Why did you save it')), 'said while it worked: delivered');
  assert.equal(out.find((o) => o.text === '*sad*')?.decided, 'drop', 'noise is still left alone');
  assert.equal(s.byMode['push-to-talk']?.dropped, 0, 'push-to-talk always reaches Echo');
  assert.ok(s.fidelity < 1, 'it no longer decides as it did on Oct 1');
  assert.ok(s.counts.notForEcho >= 2);
});

test('the report runs from the command line, saves a baseline and checks against it', () => {
  const run = (...a: string[]) => execFileSync(process.execPath, [path.resolve(import.meta.dirname, '..', 'scripts', 'replay.ts'), '--data', D, ...a], { encoding: 'utf8', env: { ...process.env, ECHO_APP_DIRS: '' } });
  const out = run('--save');
  assert.match(out, /Replayed 7 sentences; 6 have a label/);
  assert.match(out, /false drops/);
  assert.ok(fs.existsSync(path.join(D, 'listening', 'replay-baseline.json')));
  assert.match(run('--check'), /Not worse\./);
});
