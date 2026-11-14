// Quick-model routing (Oct 1, 2026): turns that could start, steer or stop a job, or answer an
// approval, go to the main model; a short "yes" after Echo asked about one does too; and if the
// quick model calls a job tool anyway, the call is blocked and the turn moves to the main model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.js';

sandbox('quickrouting');
const { Dispatcher, MAIN_ONLY_TOOLS, FAST_NOTE, FAST_PROMPT } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');
const { turnWeight } = await import('../lib/intent.js');
const { DEFAULT_FAST_MODEL, saveSettings } = await import('../lib/settings.js');

function rig() {
  let started = 0;
  const tasks = new TaskManager({ queryFn: async function* () {} });
  /** @type {any} */ (tasks).start = () => {
    started++;
    return { id: 7, status: 'queued' };
  };
  const d = new Dispatcher(tasks);
  const sent = [];
  d.input = /** @type {any} */ ({ push: (body) => sent.push(typeof body === 'string' ? body : body.at(-1).text), size: 0, close() {} });
  const models = [];
  d.q = /** @type {any} */ ({ setModel: async (m) => models.push(m), setMaxThinkingTokens: async () => {}, interrupt: async () => {} });
  return { d, tasks, sent, models, started: () => started };
}

test('router: job words always go to the main model', () => {
  for (const t of ['improve how you route quick turns', 'follow up on that', 'stop it', 'cancel the roadmap one', 'approve it', 'allow that', 'queue that for later', 'merge the review']) {
    assert.equal(turnWeight(t), 'full', t);
  }
  assert.equal(turnWeight('how are you doing'), 'quick');
  assert.equal(turnWeight('what is the capital of France'), 'quick');
});

test('router: a short answer to a question about a job goes to the main model', () => {
  const asked = 'Want me to start a self-improvement task for that?';
  for (const t of ['yes', 'y', 'ok', 'Okay.', 'yeah go ahead', 'sure', 'no', 'the roadmap one']) {
    assert.equal(turnWeight(t, { prev: asked }), 'full', t);
  }
  assert.equal(turnWeight('yes', { prev: 'Task 12 wants to open a page. Should I let it?' }), 'full');
  assert.equal(turnWeight('ok', { prev: 'I can follow up on the research. Shall I?' }), 'full');
  // A waiting approval or confirmation card: any short yes is the main model's.
  assert.equal(turnWeight('yes', { prev: 'Anything else?', pending: true }), 'full');
  // Chat stays quick.
  assert.equal(turnWeight('yes', { prev: 'Did you sleep well?' }), 'quick');
  assert.equal(turnWeight('yes'), 'quick');
  assert.equal(turnWeight('thanks', { prev: 'The weather is sunny today.' }), 'quick');
});

test('a "yes" after a task question goes to the main model in a real turn', async () => {
  const { d, sent, models } = rig();
  d.lastReply = 'Should I start a task for that in the roadmap folder?';
  d.send('yes');
  assert.equal(models.includes(DEFAULT_FAST_MODEL), false, 'never switched to the quick model');
  assert.ok(!sent.at(-1).includes(FAST_NOTE), 'no quick-model note');
  // The same word after chat stays quick.
  const r = rig();
  r.d.lastReply = 'Did you have a good weekend?';
  r.d.send('yes');
  assert.equal(r.models.at(-1), DEFAULT_FAST_MODEL);
});

test('the reply that ends a turn is remembered for routing the next one', () => {
  const { d } = rig();
  d.busy = true;
  d.replyText = 'Want me to start a project for that?';
  d.onMessage(/** @type {any} */ ({ type: 'result', subtype: 'success', usage: {}, total_cost_usd: 0 }));
  assert.equal(d.lastReply, 'Want me to start a project for that?');
  assert.equal(d.weighTurn('yes'), 'full');
});

test('tool block: the quick model cannot start, steer or stop a job; the turn moves to the main model', async () => {
  assert.deepEqual([...MAIN_ONLY_TOOLS].sort(), ['confirm_action', 'follow_up', 'lesson_control', 'resolve_approval', 'start_project', 'start_research', 'start_self_improvement', 'start_task', 'stop_task', 'teach']);
  const { d, models, started } = rig();
  // confirm_action is offered only with computer use on (the tools that act on the screen).
  saveSettings({ computerUse: true });
  const tools = Object.fromEntries(d.toolList().map((t) => [t.name, /** @type {any} */ (t)]));
  for (const name of MAIN_ONLY_TOOLS) assert.ok(tools[name], `${name} is a tool`);
  d.send('how are you?');
  assert.equal(models.at(-1), DEFAULT_FAST_MODEL, 'on the quick model');
  const r = await tools.start_task.handler({ project: 'roadmap', instruction: 'guess' }, {});
  const out = /** @type {any} */ (r.content[0]).text;
  assert.match(out, /NOT DONE/);
  assert.match(out, /you are the main model now/);
  assert.match(out, /start_self_improvement/);
  assert.equal(started(), 0, 'nothing was started');
  assert.equal(models.at(-1), undefined, 'switched to the main model');
  assert.equal(d.turn?.handoff, true);
  assert.equal(d.onQuickModel(), false);
  // On the main model the same tool runs (here it fails on the made-up project, not the block).
  const again = await tools.start_task.handler({ project: 'roadmap', instruction: 'x' }, {});
  assert.doesNotMatch(/** @type {any} */ (again.content[0]).text, /NOT DONE/);
  // Every main-only tool is blocked on the quick model.
  for (const name of MAIN_ONLY_TOOLS) {
    d.routeModel('quick');
    const b = await tools[name].handler({}, {});
    assert.match(/** @type {any} */ (b.content[0]).text, /NOT DONE/, name);
  }
  // Other tools still work on the quick model.
  d.routeModel('quick');
  const fine = await tools.list_tasks.handler({}, {});
  assert.doesNotMatch(/** @type {any} */ (fine.content[0]).text, /NOT DONE/);
});

test('the quick model is told never to claim what it did not do', () => {
  // The rule is in the system prompt once; a quick turn's message carries only a short tag.
  assert.equal(FAST_NOTE, '(quick turn)');
  assert.match(FAST_PROMPT, /Never say you queued, saved, remembered, scheduled/);
  assert.match(FAST_PROMPT, /Always hand_off to start, follow up on or stop a task/);
  const { d } = rig();
  assert.ok(d.systemPrompt().includes(FAST_PROMPT));
  assert.match(d.systemPrompt(), /That line is the only truth about models/);
});
