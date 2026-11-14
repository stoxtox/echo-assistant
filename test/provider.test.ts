// The model behind one interface (lib/brain/provider.ts): the Agent SDK path sends what it always
// did, and the Messages API path runs Echo's tool loop and speaks the same message shapes, so the
// dispatcher reads a turn from either the same way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { sandbox, until } from './helpers.js';

sandbox('provider');
const { AgentSdkProvider, MessagesApiProvider, toolSchema, costOf } = await import('../lib/brain/provider.ts');

const echoTool = (calls: any[], fail = false) => ({
  name: 'look_up',
  description: 'Looks something up.',
  inputSchema: { what: z.string(), count: z.number().optional() },
  handler: async (args: any) => {
    calls.push(args);
    if (fail) throw new Error('lookup broke');
    return { content: [{ type: 'text', text: `found ${args.what}` }] };
  },
});

const prompt = (...texts: string[]) =>
  (async function* () {
    for (const t of texts) yield { type: 'user', message: { role: 'user', content: t }, parent_tool_use_id: null };
  })();

const req = (o: Record<string, unknown> = {}) => ({ prompt: prompt('hi'), rules: 'RULES', context: 'CONTEXT', cwd: '/tmp', additionalDirectories: [], tools: [echoTool([])], builtinTools: ['Read', 'WebSearch'], ...o }) as any;

test('the Agent SDK path: the same options as before, through the query function', () => {
  let got: any;
  const p = new AgentSdkProvider({ queryFn: (o: any) => ((got = o), (async function* () {})() as any) });
  p.start(req({ model: 'm1', resume: 's1' }));
  const o = got.options;
  assert.deepEqual(o.systemPrompt, ['RULES', '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__', 'CONTEXT'], 'rules first, so they stay cached');
  assert.deepEqual(o.allowedTools, ['Read', 'WebSearch', 'mcp__ops__look_up']);
  assert.deepEqual(o.tools, ['Read', 'WebSearch']);
  assert.ok(o.disallowedTools.includes('Bash') && o.disallowedTools.includes('Write'));
  assert.equal(o.strictMcpConfig, true);
  assert.deepEqual(o.settings, { disableClaudeAiConnectors: true });
  assert.equal(o.permissionMode, 'dontAsk');
  assert.equal(o.model, 'm1');
  assert.equal(o.resume, 's1');
  assert.ok(o.mcpServers.ops, "Echo's own tools as one MCP server");
});

/** A stand-in for the API: each call answers with the next scripted message, streamed. */
function fakeClient(script: any[]) {
  const calls: any[] = [];
  return {
    calls,
    stream(params: any, { signal }: { signal: AbortSignal }) {
      calls.push(structuredClone(params));
      const msg = script.shift();
      const events = (async function* () {
        if (msg === 'hang') {
          await new Promise((_r, j) => signal.addEventListener('abort', () => j(new Error('aborted'))));
          return;
        }
        yield { type: 'message_start', message: { id: msg.id, model: params.model, usage: msg.usage } };
        for (const [index, b] of msg.content.entries()) {
          yield { type: 'content_block_start', index, content_block: b.type === 'text' ? { type: 'text', text: '' } : { ...b, input: {} } };
          if (b.type === 'text') for (let i = 0; i < b.text.length; i += 5) yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text.slice(i, i + 5) } };
          yield { type: 'content_block_stop', index };
        }
        yield { type: 'message_delta', delta: { stop_reason: msg.stop_reason }, usage: { output_tokens: msg.usage.output_tokens } };
        yield { type: 'message_stop' };
      })();
      return Object.assign(events, { finalMessage: async () => ({ role: 'assistant', model: params.model, ...msg }) });
    },
  };
}

const usage = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 };

test('the Messages API path: a tool round, then the answer, as SDK-shaped messages with the cost', async () => {
  const calls: any[] = [];
  const client = fakeClient([
    { id: 'm1', content: [{ type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 't1', name: 'look_up', input: { what: 'Mars' } }], stop_reason: 'tool_use', usage },
    { id: 'm2', content: [{ type: 'text', text: 'Mars is red.' }], stop_reason: 'end_turn', usage },
  ]);
  const p = new MessagesApiProvider({ client, prices: { 'claude-test': { input: 1, output: 5 } } });
  const s = p.start(req({ model: 'claude-test-1', tools: [echoTool(calls)] }));
  const got: any[] = [];
  for await (const m of s) got.push(m);
  assert.deepEqual(got.map((m) => m.type).filter((t, i, a) => t !== a[i - 1]), ['system', 'stream_event', 'assistant', 'user', 'stream_event', 'assistant', 'result']);
  assert.deepEqual(calls, [{ what: 'Mars' }], 'the tool ran with what the model asked');
  const toolResult = got.find((m) => m.type === 'user').message.content[0];
  assert.deepEqual(toolResult, { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'found Mars' }] });
  const deltas = got.filter((m) => m.type === 'stream_event' && m.event.type === 'content_block_delta').map((m) => m.event.delta.text).join('');
  assert.equal(deltas, 'Let me look.Mars is red.');
  const result = got.at(-1);
  assert.equal(result.subtype, 'success');
  // Two calls: (1000 in × $1 + 100 out × $5 + 2000 cached × $0.10) / 1M each.
  assert.equal(result.total_cost_usd.toFixed(6), (2 * (1000 + 500 + 200) / 1e6).toFixed(6));
  // The second call carries the whole exchange, and the rules and tools are marked for the cache.
  const second = client.calls[1];
  assert.deepEqual(second.messages.map((m: any) => m.role), ['user', 'assistant', 'user']);
  assert.equal(second.system[0].text, 'RULES');
  assert.deepEqual(second.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(second.system[1].text, 'CONTEXT');
  assert.equal(second.tools[0].name, 'look_up');
  assert.deepEqual(second.tools[0].input_schema.required, ['what']);
  assert.equal(second.tools.at(-1).type, 'web_search_20250305', 'WebSearch becomes the API\'s web search tool');
  assert.deepEqual(second.tools.at(-1).cache_control, { type: 'ephemeral' });
});

test('a tool that fails is an error result the model sees, not a crash', async () => {
  const client = fakeClient([
    { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'look_up', input: { what: 'x' } }], stop_reason: 'tool_use', usage },
    { id: 'm2', content: [{ type: 'text', text: 'Sorry.' }], stop_reason: 'end_turn', usage },
  ]);
  const s = new MessagesApiProvider({ client }).start(req({ tools: [echoTool([], true)] }));
  const got: any[] = [];
  for await (const m of s) got.push(m);
  const r = got.find((m) => m.type === 'user').message.content[0];
  assert.equal(r.is_error, true);
  assert.match(r.content[0].text, /lookup broke/);
});

test('interrupt stops the call under way and ends the turn; setModel applies to the next call', async () => {
  const client = fakeClient(['hang', { id: 'm2', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage }]);
  const s: any = new MessagesApiProvider({ client }).start(req({ prompt: prompt('one', 'two'), model: 'a' }));
  const got: any[] = [];
  const done = (async () => {
    for await (const m of s) got.push(m);
  })();
  await until(() => client.calls.length === 1, 1000, 'first call');
  await s.setModel('b');
  await s.interrupt();
  await done;
  const results = got.filter((m) => m.type === 'result');
  assert.equal(results.length, 2);
  assert.equal(results[0].interrupted, true);
  assert.equal(client.calls[1].model, 'b');
});

test('without an API key it says how to fix it; it never pretends to resume a session', async () => {
  const noKey = new MessagesApiProvider({ apiKey: '' }).start(req());
  await assert.rejects(async () => {
    for await (const _m of noKey);
  }, /API key[\s\S]*messages flag/);
  const resumed = new MessagesApiProvider({ client: fakeClient([]) }).start(req({ resume: 's1' }));
  await assert.rejects(async () => {
    for await (const _m of resumed);
  }, /cannot resume/);
});

test('schemas and prices', () => {
  const s: any = toolSchema(echoTool([]) as any);
  assert.equal(s.$schema, undefined);
  assert.equal(s.type, 'object');
  assert.deepEqual(Object.keys(s.properties), ['what', 'count']);
  assert.equal(costOf('unknown-model', usage, { 'claude-test': { input: 1, output: 5 } }), 0, 'an unknown model costs $0 until it is priced');
});

test('the dispatcher runs a whole turn through the Messages API path', async () => {
  const { Dispatcher } = await import('../lib/dispatcher.js');
  const { TaskManager } = await import('../lib/tasks.js');
  const d: any = new Dispatcher(new TaskManager({ queryFn: async function* () {} } as any), null, { favorites: () => [], pendingList: () => [] } as any);
  const client = fakeClient([{ id: 'm1', content: [{ type: 'text', text: 'Hello there, nice to meet you.' }], stop_reason: 'end_turn', usage }]);
  d.provider = () => new MessagesApiProvider({ client });
  const said: string[] = [];
  let ended = false;
  d.on('say_delta', (t: string) => said.push(t));
  d.on('say_end', () => (ended = true));
  d.start();
  await until(() => d.q, 1000, 'session');
  d.send('hello');
  await until(() => ended && !d.busy, 3000, 'turn done');
  assert.equal(said.join(''), 'Hello there, nice to meet you.');
  assert.equal(client.calls[0].messages[0].role, 'user');
  assert.match(JSON.stringify(client.calls[0].messages[0].content), /hello/);
  d.input.close();
});
