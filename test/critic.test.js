// The critic (lib/agent/critic.js, the critic flag): a job's goal and its points, judged from the
// screen by a separate model that never sees what the assistant claimed. Done only when all pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { sandbox } from './helpers.js';

const dirs = sandbox('critic');
const { contract, readVerdict, critique, CRITIC_SYSTEM } = await import('../lib/agent/critic.js');
const { ComputerUse } = await import('../lib/computer.js');
const { ScreenBridge } = await import('../lib/screen.js');
const { saveSettings, setFixedForTest } = await import('../lib/settings.js');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);

/** A stand-in for the critic's model: answers with `reply`, and keeps what it was sent. */
function fakeModel(reply) {
  const calls = [];
  const queryFn = ({ prompt, options }) =>
    (async function* () {
      const sent = [];
      for await (const m of prompt) sent.push(m);
      calls.push({ sent, options });
      yield { type: 'result', subtype: 'success', result: reply, total_cost_usd: 0.004 };
    })();
  return { calls, queryFn };
}

test('the contract, and the verdict read strictly: a point it did not answer is not met', () => {
  assert.deepEqual(contract('  Make the hero section  ', []), { goal: 'Make the hero section', points: ['Make the hero section'] });
  assert.equal(contract('x', Array.from({ length: 12 }, (_, i) => `p${i}`)).points.length, 8);
  const points = ['Title centred', 'Buttons the same size'];
  assert.deepEqual(readVerdict('{"points":[{"point":"Title centred","met":true,"why":"It is."},{"point":"Buttons the same size","met":true,"why":"Both 120 wide."}]}', points).pass, true);
  const partial = readVerdict('Sure! {"points":[{"point":"Title centred","met":true,"why":"ok"}]}', points);
  assert.equal(partial.pass, false);
  assert.equal(partial.points[1].met, false);
  assert.match(partial.points[1].why, /no answer/);
  assert.equal(readVerdict('not json at all', points).pass, false);
  assert.match(CRITIC_SYSTEM, /never see what the assistant said/);
  assert.match(CRITIC_SYSTEM, /Be skeptical/);
});

test('the critic sees the picture, the screen text, the goal and the points, and nothing the assistant said', async () => {
  const m = fakeModel('{"points":[{"point":"Title centred","met":false,"why":"It sits left of centre."}]}');
  const v = await critique({ goal: 'Hero section', points: ['Title centred'], look: { text: 'Welcome', image: JPEG.toString('base64'), mime: 'image/jpeg', app: 'Adobe XD' }, queryFn: m.queryFn });
  assert.equal(v.pass, false);
  assert.equal(v.usd, 0.004);
  const content = m.calls[0].sent[0].message.content;
  assert.equal(content[0].type, 'image');
  assert.match(content[1].text, /Goal: Hero section[\s\S]*1\. Title centred[\s\S]*Adobe XD[\s\S]*Welcome/);
  assert.equal(m.calls[0].options.maxTurns, 1);
  assert.deepEqual(m.calls[0].options.tools, []);
});

/** A Mac app stand-in that answers looks. */
function fakeApp() {
  const bridge = new ScreenBridge({ logFile: path.join(dirs.data, 'screen-log.jsonl'), timeoutMs: 500, browserTimeoutMs: 500 });
  bridge.nativeClients = () => 1;
  bridge.on('request', (r) => {
    if (r.kind === 'look') setImmediate(() => bridge.deliver(r.id, { ok: true, source: 'native', text: 'Hero · Get started', image: JPEG.toString('base64'), mime: 'image/jpeg', width: 800, height: 600, app: 'Adobe XD', window: 'Landing' }));
  });
  return bridge;
}

test('check_done: done only when every point passes; otherwise what is left', async () => {
  (setFixedForTest({ screenAware: true }), saveSettings({ computerUse: true }));
  const c = new ComputerUse({ bridge: fakeApp(), logFile: path.join(dirs.data, 'computer-log.jsonl') });
  assert.equal((await c.checkDone()).error, 'no_goal');
  assert.match(c.setGoal('Landing hero', ['Title centred', 'Button below the title']).note, /Say the goal back/);
  c.criticQueryFn = fakeModel('{"points":[{"point":"Title centred","met":true,"why":"Centred."},{"point":"Button below the title","met":false,"why":"The button overlaps the title."}]}').queryFn;
  const no = await c.checkDone();
  assert.equal(no.pass, false);
  assert.match(no.note, /NOT done: Button below the title \(The button overlaps the title\.\)[\s\S]*Don't say it's done/);
  c.criticQueryFn = fakeModel('{"points":[{"point":"Title centred","met":true,"why":"Centred."},{"point":"Button below the title","met":true,"why":"Below it."}]}').queryFn;
  const yes = await c.checkDone();
  assert.equal(yes.pass, true);
  setFixedForTest({ screenAware: false });
  assert.equal(c.goal, null, 'checked done: the goal is finished');
  assert.equal((await c.checkDone({ goal: 'Landing hero', points: ['Title centred'] })).verdict, 'unchecked', 'no look, no claim');
  setFixedForTest({ screenAware: true });
});

test('the tools and the instructions come with the switch (on unless turned off in Labs)', async () => {
  const { Dispatcher } = await import('../lib/dispatcher.js');
  const { TaskManager } = await import('../lib/tasks.js');
  saveSettings({ computerUse: true });
  const names = () => new Dispatcher(new TaskManager({ queryFn: async function* () {} })).toolList().map((t) => t.name);
  assert.ok(names().includes('set_goal') && names().includes('check_done'), 'on by default');
  process.env.ECHO_FLAG_CRITIC = '0';
  assert.ok(!names().includes('check_done') && !names().includes('set_goal'), 'switched off');
  process.env.ECHO_FLAG_CRITIC = '1';
  try {
    assert.ok(names().includes('set_goal') && names().includes('check_done'));
    assert.match(new Dispatcher(new TaskManager({ queryFn: async function* () {} })).systemPrompt(), /call check_done: say it's done only if it passes/);
  } finally {
    delete process.env.ECHO_FLAG_CRITIC;
  }
});
