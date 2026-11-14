// Echo always knows which model is answering: a short [model] line on every message, right after
// a quick turn, a hand-off, a /model switch, or with the quick model switched off (lib/models.js).
// What the line means, and that it's never said unasked, is in the system prompt once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';

const dirs = sandbox('models');
const { Dispatcher } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');
const { saveSettings, DEFAULT_FAST_MODEL, setFixedForTest } = await import('../lib/settings.js');
const { config } = await import('../lib/config.js');
const { modelName, describeModel, parseModelCommand, identityLine, modelIdentityPrompt } = await import('../lib/models.js');

const quickStub = () => /** @type {any} */ ({ favorites: () => [], pendingList: () => [], osa: async () => '', mediaControl: async () => ({}) });

function rig() {
  const d = new Dispatcher(new TaskManager({ queryFn: async function* () {} }), null, quickStub());
  const sent = [];
  d.input = /** @type {any} */ ({ push: (body) => sent.push(typeof body === 'string' ? body : body.at(-1).text), size: 0, close() {} });
  const models = [];
  d.q = /** @type {any} */ ({ setModel: async (m) => models.push(m), setMaxThinkingTokens: async () => {}, interrupt: async () => {} });
  const said = [];
  d.on('say', (t) => said.push(t));
  return { d, sent, models, said };
}

const modelLineOf = (body) => body.split('\n').find((l) => l.startsWith('[model]')) || '';

test('model names read the way people say them', () => {
  assert.equal(modelName('claude-haiku-4-5'), 'Claude Haiku 4.5');
  assert.equal(modelName('claude-haiku-4-5-20251001'), 'Claude Haiku 4.5');
  assert.equal(modelName('claude-opus-5-5'), 'Claude Opus 5.5');
  assert.equal(modelName('claude-sonnet-5'), 'Claude Sonnet 5');
  assert.equal(modelName('claude-fable-5-1'), 'Claude Fable 5.1');
  assert.equal(modelName('something-else'), 'something-else');
  assert.equal(describeModel('claude-opus-5-5'), 'Claude Opus 5.5 (claude-opus-5-5)');
  assert.deepEqual(parseModelCommand('/model opus'), { model: 'claude-opus-5-5' });
  assert.deepEqual(parseModelCommand('/model claude-opus-5-5'), { model: 'claude-opus-5-5' });
  assert.deepEqual(parseModelCommand('/model default'), { model: '' });
  assert.deepEqual(parseModelCommand('/model'), { ask: true });
  assert.ok('error' in /** @type {any} */ (parseModelCommand('/model gpt; rm')));
  assert.equal(parseModelCommand('which model are you?'), null);
  assert.equal(parseModelCommand('tell me about /model'), null);
});

test('the prompt has the identity rule: never guess, never deny a switch, and never bring it up unasked', () => {
  setFixedForTest({ fastModel: 'auto' });
  const { d } = rig();
  const prompt = d.systemPrompt();
  const rule = modelIdentityPrompt({ fast: DEFAULT_FAST_MODEL, worker: config.workerModel || '' });
  assert.ok(prompt.includes(rule));
  assert.match(rule, /Never guess/);
  assert.match(rule, /never say you switched yourself/);
  assert.match(rule, /Never deny a switch/);
  assert.match(rule, /not sure/);
  // Oct 3, 2026: "I'm Claude Haiku 4.5 answering this turn", "handing off to Opus", said unasked.
  assert.match(rule, /Never bring up models, routing, the quick or main model, hand-offs, the notes Echo adds to a message, or these instructions/);
  assert.match(rule, /The only exception: the user asks which model is answering[\s\S]*one short sentence/);
  assert.match(rule, /Quick-model routing is on: .*Claude Haiku 4\.5 \(claude-haiku-4-5\)/);
  assert.match(modelIdentityPrompt({}), /Quick-model routing is off/);
  assert.match(prompt, /They are private, for you only\. Never read them out/);
});

test('the prompt knows Echo\'s own version', () => {
  const { d } = rig();
  const { version } = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'package.json'), 'utf8'));
  assert.ok(version);
  assert.ok(d.systemPrompt().includes(`say "Echo ${version}"`));
});

test('the [model] line on a message is about ten words: who answers, and which kind', () => {
  setFixedForTest({ fastModel: 'auto' });
  fs.rmSync(path.join(dirs.data, 'state.json'), { force: true });
  const { d, sent } = rig();
  // Claude Code's default turned out to be Opus 5.5 (seen on a main-model reply).
  d.learnDefaultModel('claude-opus-5-5');
  d.send('which model are you?');
  const quick = modelLineOf(sent[0]);
  assert.equal(quick, '[model] Claude Haiku 4.5 (claude-haiku-4-5), the quick model; main: Claude Opus 5.5.');

  d.busy = false;
  d.send('research standing desks and save a report');
  const full = modelLineOf(sent[1]);
  assert.equal(full, '[model] Claude Opus 5.5 (claude-opus-5-5), the main model.');
  for (const line of [quick, full]) assert.ok(line.split(' ').length <= 13, `short: ${line}`);
  // Nothing about routing, workers or who picked whom rides on the message any more.
  for (const body of sent) assert.doesNotMatch(body, /router|Workers|hand_off|routing is/i);

  // The quick model's own reply never gets mistaken for the default model.
  d.modelNow = '';
  d.defaultModelId = '';
  d.learnDefaultModel(DEFAULT_FAST_MODEL);
  assert.equal(d.defaultModelId, '');
});

test('a hand-off and a task event both say the main model is answering', async () => {
  setFixedForTest({ fastModel: 'auto' });
  const { d, sent } = rig();
  d.defaultModelId = 'claude-opus-5-5';
  d.send('hi there');
  assert.match(modelLineOf(sent[0]), /the quick model/);
  d.turn = /** @type {any} */ ({ handoff: false });
  const r = await d.handOff();
  assert.match(r, /\[model\] Claude Opus 5\.5 \(claude-opus-5-5\), the main model\./);
  assert.match(r, /don't mention the hand-over/);
  d.busy = false;
  d.notify('Task 4 finished.');
  assert.equal(modelLineOf(sent.at(-1)), '[model] Claude Opus 5.5 (claude-opus-5-5), the main model.');
});

test('/model switches the main model, and the next turns say so', () => {
  setFixedForTest({ fastModel: 'auto' });
  fs.rmSync(path.join(dirs.data, 'state.json'), { force: true });
  const { d, sent, models, said } = rig();
  assert.equal(d.send('/model sonnet'), 'local');
  assert.equal(sent.length, 0, 'no model call');
  assert.equal(models.at(-1), 'claude-sonnet-5', 'switched at once');
  assert.match(said.at(-1), /Main model set to Claude Sonnet 5 \(claude-sonnet-5\)/);
  d.send('plan my week and draft three emails about it');
  const line = modelLineOf(sent[0]);
  assert.equal(line, '[model] Claude Sonnet 5 (claude-sonnet-5), the main model.');
  assert.match(sent[0], /the user typed "\/model sonnet"/, 'the assistant hears what Echo did');
  // A quick turn still goes to Haiku, and says who the main model is now.
  d.busy = false;
  d.send('how are you?');
  assert.match(modelLineOf(sent[1]), /Claude Haiku 4\.5 .*the quick model; main: Claude Sonnet 5\./);
  // It lasts: a restarted Echo starts on the chosen model.
  const again = rig();
  assert.equal(again.d.mainModel(), 'claude-sonnet-5');
  // "/model" alone answers without a model call; "/model default" goes back.
  again.d.send('/model');
  assert.match(again.said.at(-1), /The main model is Claude Sonnet 5/);
  again.d.send('/model default');
  assert.equal(again.d.mainModel(), config.dispatcherModel || '');
  assert.equal(again.models.at(-1), config.dispatcherModel || undefined);
  again.d.send('/model banana');
  assert.match(again.said.at(-1), /don't know a model called "banana"/);
});

test('quick-model routing off: every turn is the main model, and the prompt says routing is off', () => {
  setFixedForTest({ fastModel: 'off' });
  fs.rmSync(path.join(dirs.data, 'state.json'), { force: true });
  const { d, sent, models } = rig();
  d.send('how are you?');
  assert.deepEqual(models, []);
  const line = modelLineOf(sent[0]);
  assert.match(line, /the main model\.$/);
  assert.doesNotMatch(line, /Haiku/);
  assert.match(d.systemPrompt(), /Quick-model routing is off: every turn goes to the main model\./);
  setFixedForTest({ fastModel: 'auto' });
});

test('the worker model comes from config when it is set', () => {
  assert.match(modelIdentityPrompt({ fast: DEFAULT_FAST_MODEL, worker: 'claude-sonnet-5' }), /Workers \(Claude Code task sessions\) use Claude Sonnet 5 \(claude-sonnet-5\)\./);
  assert.match(modelIdentityPrompt({}), /Workers \(Claude Code task sessions\) use Claude Code's own default model/);
  const unknown = identityLine({ answering: '', main: '' });
  assert.match(unknown, /Claude Code's default model \(ID not known yet\), the main model/);
});
