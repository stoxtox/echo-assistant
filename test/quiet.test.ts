// Stage 2, the rest (policy flag): background updates wait for a natural moment, several
// approvals are one question, and a plain local commit doesn't ask.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { sandbox, until, serverSource } from './helpers.js';

const dirs = sandbox('quiet');
const { Dispatcher } = await import('../lib/dispatcher.js');
const { TaskManager, plainLocalCommit } = await import('../lib/tasks.js');
const { ApprovalRelay } = await import('../lib/approvals.js');

const withPolicy = async (fn: () => Promise<void> | void) => {
  process.env.ECHO_FLAG_POLICY = '1';
  try {
    await fn();
  } finally {
    delete process.env.ECHO_FLAG_POLICY;
  }
};

function rig() {
  fs.rmSync(path.join(dirs.data, 'state.json'), { force: true });
  const quick: any = { favorites: () => [], pendingList: () => [], osa: async () => '', mediaControl: async () => ({}) };
  const d: any = new Dispatcher(new TaskManager({ queryFn: async function* () {} }), null, quick);
  const sent: string[] = [];
  d.queryFn = ({ prompt }: { prompt: AsyncIterable<any> }) => {
    const q = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's1' };
      for await (const m of prompt) {
        sent.push(JSON.stringify(m));
        yield { type: 'result', subtype: 'success', session_id: 's1', total_cost_usd: 0 };
      }
    })();
    return Object.assign(q, { setModel: async () => {}, close() {} });
  };
  return { d, sent };
}

test('a background update waits for the user\'s next turn, then rides along in one line', () =>
  withPolicy(async () => {
    const { d, sent } = rig();
    d.start();
    await until(() => d.q, 1000, 'session');
    d.lastSpeechEnd = Date.now(); // Echo just finished speaking
    d.notify('Task 5 (Foodbar) finished. Spoken summary: the site builds.', { fyi: true });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(sent.length, 0, 'not said right away');
    d.send('tell me something about Mars');
    await until(() => sent.length > 0, 1000, 'sent');
    assert.match(sent[0] ?? '', /Meanwhile, in the background: Task 5 \(Foodbar\) finished/);
    assert.match(sent[0] ?? '', /ONE short sentence/);
    assert.equal(d.background.length, 0, 'said once');
    d.input.close();
  }));

test('if nobody says anything for a while, the updates come as one digest, without "Oh, and"', () =>
  withPolicy(async () => {
    const { d, sent } = rig();
    d.start();
    await until(() => d.q, 1000, 'session');
    d.lastSpeechEnd = Date.now() - 10 * 60_000;
    d.lastUserAt = Date.now() - 10 * 60_000;
    d.notify('Task 6 (Notes) finished.', { fyi: true });
    d.notify('Task 7 (Site) failed.', { fyi: true });
    await until(() => sent.length > 0, 3000, 'digest');
    assert.match(sent[0] ?? '', /Task 6 \(Notes\) finished\.[\s\S]*Task 7 \(Site\) failed\./, 'both in one message');
    assert.match(sent[0] ?? '', /Background updates from while it was quiet/);
    assert.doesNotMatch(sent[0] ?? '', /like \\"Oh, and\\"/);
    d.input.close();
  }));

test('without the flag, a task update is relayed as before', async () => {
  const { d, sent } = rig();
  d.start();
  await until(() => d.q, 1000, 'session');
  d.notify('Task 8 finished.', { fyi: true });
  await until(() => sent.length > 0, 2000, 'relayed');
  assert.match(sent[0] ?? '', /\[event\] Task 8 finished\./);
  d.input.close();
});

function relayRig() {
  const tasks: any = new EventEmitter();
  const waiting = new Set<string>();
  tasks.isApprovalPending = (taskId: number, id: string) => waiting.has(`${taskId}:${id}`);
  const said: string[] = [];
  const relay = new ApprovalRelay(tasks, (t: string) => said.push(t), { delayMs: 10, maxDelayMs: 20 });
  const ask = (id: number, reason: string) => {
    waiting.add(`${id}:a${id}`);
    tasks.emit('approval', { id, project: `p${id}`, pendingApproval: { id: `a${id}`, level: 'risky', reason } });
  };
  return { relay, ask, said };
}

test('several approvals waiting at once are ONE question (each still has its card)', () =>
  withPolicy(async () => {
    const { ask, said } = relayRig();
    ask(12, 'git push');
    ask(13, 'recursive delete');
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(said.length, 1);
    assert.match(said[0] ?? '', /2 tasks need the user's OK: task 12 \(p12\) wants to git push; task 13 \(p13\) wants to recursive delete/);
    assert.match(said[0] ?? '', /task_ids \[12, 13\]/);
    assert.match(said[0] ?? '', /Never approve one they didn't clearly agree to/);
  }));

test('switched off in Labs, each risky approval is still its own question', async (t) => {
  process.env.ECHO_FLAG_POLICY = '0';
  t.after(() => delete process.env.ECHO_FLAG_POLICY);
  const { ask, said } = relayRig();
  ask(12, 'git push');
  ask(13, 'recursive delete');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(said.length, 2);
});

test('a plain local commit is routine; amending, skipping hooks, pushing or leaving the folder is not', () => {
  const passes = (c: string) => !/\brm\b|curl/.test(c);
  for (const c of ['git add -A && git commit -m "Fix the header"', "git commit -am 'wip'", 'git commit -m "x" && git log --oneline -1']) assert.equal(plainLocalCommit(c, { passes }), true, c);
  for (const c of ['git commit --amend -m x', 'git commit --no-verify -m x', 'git commit -n -m x', 'git commit -m x && git push', 'cd ~/ProjectX/VoiceOps && git commit -m x', 'git commit -m x && rm -rf build', 'git reset --hard && git commit -m x']) assert.equal(plainLocalCommit(c, { passes }), false, c);
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'lib', 'tasks.js'), 'utf8');
  assert.match(src, /verdict\.reason === 'git commit' && flagOn\('policy'\) && plainLocalCommit\(command, \{ passes \}\)/);
});

test("the server marks a task's finish as just for the user's information", () => {
  const src = serverSource();
  assert.match(src, /' Full details are available with get_task\.',\n\s+\/\/ Just for the user's information[^\n]*\n\s+\{ fyi: true \},/);
});
