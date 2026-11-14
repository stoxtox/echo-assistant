// The speed work: a slimmer prompt (trimmed memory with recall, only Echo's own tools, a digest
// that isn't repeated), the fast model for quick turns with a hand-off, "stop" and scrolling with
// no model call, read-only tools that run in parallel, and the timing log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, until } from './helpers.js';

const dirs = sandbox('speed');
const { Dispatcher, READ_ONLY_TOOLS, BUILTIN_TOOLS, FAST_NOTE, FAST_PROMPT } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');
const { coreMemory, recallMemory, memoryFacts, CORE_BUDGET } = await import('../lib/memory.js');
const { digestKey } = await import('../lib/digest.js');
const { localIntent, isHushCommand, runLocalIntent } = await import('../lib/intent.js');
const { saveSettings, DEFAULT_FAST_MODEL, setFixedForTest } = await import('../lib/settings.js');

const quickStub = (over = {}) => /** @type {any} */ ({ favorites: () => [], pendingList: () => [], osa: async () => '', mediaControl: async () => ({}), ...over });

/** A dispatcher whose model input is captured instead of sent. */
function rig({ quick = quickStub() } = {}) {
  const tasks = new TaskManager({ queryFn: async function* () {} });
  const d = new Dispatcher(tasks, null, quick);
  const sent = [];
  d.input = /** @type {any} */ ({ push: (body) => sent.push(typeof body === 'string' ? body : body.at(-1).text), size: 0, close() {} });
  const models = [];
  d.q = /** @type {any} */ ({ setModel: async (m) => models.push(m), setMaxThinkingTokens: async (n) => models.push(`think:${n}`), interrupt: async () => models.push('interrupted') });
  return { d, tasks, sent, models };
}

test('memory: a trimmed core in the prompt, newest first, stable, and recall has the rest', () => {
  const lines = [
    '# Memory',
    ...Array.from({ length: 120 }, (_, i) => `- Note ${i}: the user mentioned topic${i} and likes it ${'quite a lot '.repeat(4)}`),
    `- Long story about the Hoboken apartment search. ${'More detail about the lease and the landlord. '.repeat(20)}`,
    '- Their sister is called Mira and loves Thai food.',
  ];
  const text = lines.join('\n');
  const core = coreMemory(text);
  assert.ok(core.text.length <= CORE_BUDGET + 120, `within budget (${core.text.length})`);
  assert.ok(core.kept < core.total, 'not everything fits');
  assert.match(core.text, /Mira and loves Thai food/, 'the newest facts are kept');
  assert.match(core.text, /Hoboken apartment search\. \(more with recall\)/, 'a long note is cut to its first sentence');
  assert.doesNotMatch(core.text, /Note 0:/, 'the oldest drop out first');
  assert.match(core.text, /older notes not shown: call recall/);
  assert.equal(coreMemory(text).text, core.text, 'the same file gives the same text (the prompt cache keeps hitting)');
  // Shown in file order, not newest-first.
  assert.ok(core.text.indexOf('Hoboken') < core.text.indexOf('Mira'));
  // A small memory goes in whole.
  assert.equal(coreMemory('- one\n- two').text, '- one\n- two');
  assert.deepEqual(memoryFacts('# h\n\n- a\n* b\nc'), ['a', 'b', 'c']);
  // Recall finds what the core left out, in full.
  assert.deepEqual(recallMemory(text, 'what about topic3?'), [lines[4].slice(2).trim()]);
  assert.match(recallMemory(text, 'the lease and landlord')[0], /Long story about the Hoboken apartment search\. More detail/);
  assert.deepEqual(recallMemory(text, 'the of and'), [], 'stop words alone match nothing');
});

test('the prompt carries the trimmed memory, and recall reads the whole file', async () => {
  const facts = Array.from({ length: 400 }, (_, i) => `- Fact number ${i} about something the user said once, kept for later.`);
  fs.writeFileSync(path.join(dirs.data, 'memory.md'), `${facts.join('\n')}\n- Favourite coffee is a flat white.\n`);
  const { d } = rig();
  const [, context] = d.systemPromptBlocks();
  assert.ok(context.length < CORE_BUDGET + 1000, `context stays small (${context.length})`);
  assert.match(context, /Favourite coffee is a flat white/);
  assert.match(context, /the newest; recall has the rest/);
  const recall = d.toolList().find((t) => t.name === 'recall');
  const r = await recall.handler({ topic: 'fact number 3' }, {});
  assert.match(/** @type {any} */ (r.content[0]).text, /Fact number 3 about/);
  fs.rmSync(path.join(dirs.data, 'memory.md'));
});

test('only Echo\'s own tools go to the model, and the read-only ones run in parallel', async () => {
  const { d } = rig();
  const tools = d.toolList();
  for (const t of tools) {
    const ro = Boolean(t.annotations?.readOnlyHint);
    assert.equal(ro, READ_ONLY_TOOLS.has(t.name), `${t.name}: read-only ${ro}`);
  }
  for (const name of ['get_task', 'list_tasks', 'find_contact', 'recall']) assert.ok(READ_ONLY_TOOLS.has(name), name);
  for (const name of ['send_imessage', 'start_task', 'click', 'remember', 'resolve_approval', 'stop_task']) assert.ok(!READ_ONLY_TOOLS.has(name), `${name} acts, so it never runs alongside another`);
  assert.ok(tools.some((t) => t.name === 'hand_off'));
  // The session: a short list of built-in tools, no account connectors, all Echo's tools allowed.
  let options = null;
  d.queryFn = /** @type {any} */ (({ options: o }) => {
    options = o;
    return (async function* () {})();
  });
  await d.run(undefined);
  assert.deepEqual(options.tools, BUILTIN_TOOLS);
  assert.deepEqual(BUILTIN_TOOLS, ['Read', 'Glob', 'Grep', 'WebSearch']);
  assert.equal(options.strictMcpConfig, true);
  assert.equal(options.settings.disableClaudeAiConnectors, true);
  for (const n of ['recall', 'hand_off', 'get_task']) assert.ok(options.allowedTools.includes(`mcp__ops__${n}`), n);
  for (const n of ['Bash', 'Edit', 'Write', 'WebFetch', 'Agent']) assert.ok(options.disallowedTools.includes(n), `${n} stays blocked`);
});

test('the digest is sent once; after that only when something changed', () => {
  const { d, tasks, sent } = rig();
  d.send('anything running?');
  assert.match(sent[0], /\[task digest\]\nNo tasks today\./, 'no tasks is said too, so no tool call is needed');
  d.busy = false;
  d.send('and now?');
  assert.match(sent[1], /\[task digest\] unchanged since the last one$/);
  const now = new Date().toISOString();
  tasks.tasks.set(3, { id: 3, kind: 'code', project: 'Cardz', title: 'Dark mode', status: 'queued', updatedAt: now, lastActivityAt: now, log: [] });
  d.busy = false;
  d.send('what about now?');
  assert.match(sent[2], /\[task digest\]\nTasks \(fresh[\s\S]*#3 queued/);
  d.busy = false;
  d.send('still?');
  assert.match(sent[3], /unchanged since the last one$/);
  // The clock moving on isn't a change.
  assert.equal(digestKey('#3 running · 2 min ago: x\nRecent: just now #3 started'), digestKey('#3 running · 5 min ago: x\nRecent: 3 h ago #3 started'));
  // A fresh session gets the full digest again.
  d.lastDigestKey = '';
  d.busy = false;
  d.send('where are we?');
  assert.match(sent[4], /#3 queued/);
});

test('quick turns go to Haiku with a hand-off note; real work and task events go to the main model', () => {
  setFixedForTest({ fastModel: 'auto' });
  const { d, sent, models } = rig();
  d.send("what's the capital of Australia?");
  assert.deepEqual(models, ['think:0', DEFAULT_FAST_MODEL], 'no thinking before the first word on a quick turn');
  assert.ok(sent[0].includes(FAST_NOTE), 'the fast model is told to hand anything bigger over');
  assert.match(FAST_PROMPT, /call hand_off first, before writing anything/);
  assert.ok(d.systemPrompt().includes(FAST_PROMPT), 'what the tag means is in the system prompt');
  d.busy = false;
  d.send('research the best standing desks and save a report');
  assert.deepEqual(models, ['think:0', DEFAULT_FAST_MODEL, 'think:null', undefined], 'the main model thinks as before');
  assert.ok(!sent[1].includes(FAST_NOTE));
  d.busy = false;
  d.send('how are you?');
  assert.equal(models.at(-1), DEFAULT_FAST_MODEL);
  d.busy = false;
  d.notify('Task 4 wants to git push.');
  assert.equal(models.at(-1), undefined, 'events (approvals, failures) get the main model');
  setFixedForTest({ fastModel: 'off' });
  const r2 = rig();
  r2.d.send('how are you?');
  assert.ok(!r2.sent[0].includes(FAST_NOTE));
  assert.deepEqual(r2.models.filter((m) => !String(m).startsWith('think')), []);
  setFixedForTest({ fastModel: 'auto' });
});

test('"stop" needs no model: it hushes Echo and drops the reply she is working on', async () => {
  for (const s of ['stop', 'Stop.', 'stop talking', 'okay stop', 'be quiet', "that's enough", 'Echo, stop']) assert.ok(isHushCommand(s), s);
  for (const s of ['cancel', 'never mind', 'stop the music', 'stop the task', "don't stop", 'stop and tell me the time']) assert.ok(!isHushCommand(s), s);
  assert.deepEqual(localIntent('stop'), { kind: 'stop' });
  assert.deepEqual(localIntent('stop the music'), { kind: 'media', action: 'pause' });

  const { d, sent, models } = rig();
  const events = [];
  for (const e of ['hush', 'speak', 'say', 'error', 'reply_end']) d.on(e, () => events.push(e));
  d.send('tell me a long story about dragons');
  assert.equal(d.busy, true);
  // Mid-reply, even with a card waiting: still local.
  d.computer.pending.set('x', /** @type {any} */ ({}));
  assert.deepEqual(d.localIntentFor('stop'), { kind: 'stop' });
  assert.equal(d.localIntentFor('yes'), null, 'a yes to the card is the assistant\'s');
  d.computer.pending.clear();
  assert.equal(d.send('stop'), 'local');
  assert.equal(sent.length, 1, 'nothing went to the model');
  await until(() => models.includes('interrupted'), 1000, 'interrupt');
  assert.ok(events.includes('hush'));
  // Whatever the model still streams from that turn is dropped, and its interrupted end isn't an error.
  d.speakPiece('Once upon a time there was a dragon.');
  d.onMessage({ type: 'result', subtype: 'error_during_execution', total_cost_usd: 0 });
  assert.ok(!events.includes('speak'));
  assert.ok(!events.includes('error'));
  assert.equal(d.hushed, false, 'the next turn speaks again');
  await until(() => d.localNotes.length, 1000, 'note for the next turn');
  assert.match(d.localNotes.join(' '), /dropped the reply/);

  // Idle and silent: "stop" pauses what's playing, and never opens a music app to do it.
  const osa = [];
  const idle = rig({ quick: quickStub({ osa: async (s) => { osa.push(s); return ''; }, mediaControl: async () => { throw new Error('should not open Spotify'); } }) });
  const r = await idle.d.hushNow();
  assert.equal(r.did, 'nothing to stop');
  const quiet = await runLocalIntent({ kind: 'media', action: 'pause', onlyIfPlaying: true }, { quick: quickStub(), computer: /** @type {any} */ ({ driving: false }) });
  assert.deepEqual(quiet, { ok: false, say: '', did: 'nothing playing' });
});

test('scroll and go back act at once when Echo can use the computer, even outside a session', () => {
  assert.equal(localIntent('scroll down'), null, 'computer use off: the assistant takes it');
  assert.deepEqual(localIntent('scroll down', { canDrive: true }), { kind: 'scroll', direction: 'down' });
  assert.deepEqual(localIntent('scroll up a bit', { canDrive: true }), { kind: 'scroll', direction: 'up' });
  assert.deepEqual(localIntent('go back', { canDrive: true }), { kind: 'back' });
  assert.equal(localIntent('back', { canDrive: true }), null, 'a bare "back" only mid-drive');
  assert.deepEqual(localIntent('back', { driving: true }), { kind: 'back' });
  assert.equal(localIntent('go back to what we were saying', { canDrive: true }), null);
  const { d } = rig();
  d.computer.unavailable = () => null;
  assert.deepEqual(d.localIntentFor('scroll down'), { kind: 'scroll', direction: 'down' });
  d.computer.unavailable = () => ({ error: 'off', message: 'off' });
  assert.equal(d.localIntentFor('scroll down'), null);
});

test('the timing log says which model answered and when the first words went to the voice', async () => {
  setFixedForTest({ fastModel: 'auto' });
  const log = path.join(dirs.data, 'dispatcher-timing.jsonl');
  fs.rmSync(log, { force: true });
  fs.rmSync(path.join(dirs.data, 'state.json'), { force: true });
  const d = new Dispatcher(new TaskManager({ queryFn: async function* () {} }), null, quickStub());
  d.queryFn = /** @type {any} */ (({ prompt }) => {
    const q = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's1' };
      for await (const _m of prompt) {
        yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'm1', model: DEFAULT_FAST_MODEL, usage: { input_tokens: 5, cache_read_input_tokens: 20_000 } } } };
        yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', content_block: { type: 'text' } } };
        yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Canberra, not Sydney. ' } } };
        await new Promise((r) => setTimeout(r, 30));
        yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Most people guess wrong.' } } };
        yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_stop' } };
        yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } };
        yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'text', text: 'Canberra, not Sydney. Most people guess wrong.' }] } };
        yield { type: 'result', subtype: 'success', session_id: 's1', total_cost_usd: 0 };
      }
    })();
    return Object.assign(q, { setModel: async () => {}, close() {} });
  });
  const spoken = [];
  d.on('speak', (t) => spoken.push(t));
  d.start();
  await until(() => d.q, 1000, 'session');
  d.send("what's the capital of Australia?");
  await until(() => fs.existsSync(log) && /"type":"turn"/.test(fs.readFileSync(log, 'utf8')), 2000, 'turn logged');
  assert.equal(spoken[0], 'Canberra, not Sydney.', 'the first sentence went to the voice before the reply was done');
  const turn = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((l) => l.type === 'turn');
  assert.equal(turn.model, DEFAULT_FAST_MODEL);
  assert.ok(turn.firstSpeakMs >= 0 && turn.firstSpeakMs < turn.ms, JSON.stringify(turn));
  d.input.close();
});

test('hand_off tells the model it is the main model now', async () => {
  const { d, models } = rig();
  d.send('how are you?');
  const r = await d.toolList().find((t) => t.name === 'hand_off').handler({}, {});
  assert.match(/** @type {any} */ (r.content[0]).text, /you are the main model now/);
  assert.equal(models.at(-1), undefined, 'switched back to the main model');
  assert.equal(d.turn?.handoff, true);
});
