import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.js';

sandbox('dispatcher');
const { Dispatcher, FILLERS, fillerFor } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');

test('fillers are varied and never the same twice in a row', () => {
  for (const pool of Object.values(FILLERS)) assert.ok(pool.length >= 4 && new Set(pool).size === pool.length);
  for (const tool of ['mcp__ops__start_task', 'mcp__ops__get_task', 'mcp__ops__stop_task', 'WebSearch']) {
    let last = '';
    for (let i = 0; i < 50; i++) {
      const f = fillerFor(tool);
      assert.notEqual(f, last);
      last = f;
    }
  }
  assert.ok(!Object.values(FILLERS).flat().includes('Sure thing.'));
});

test('the system prompt is conversational and keeps every rule', () => {
  const p = new Dispatcher(new TaskManager({ queryFn: async function* () {} })).systemPrompt();
  for (const phrase of ['Great question', 'Certainly!', "I'd be happy to", 'Let me know if', 'Is there anything else', 'Just a heads up']) assert.ok(p.includes(phrase), `bans ${phrase}`);
  assert.match(p, /Never open two replies in a row the same way/);
  assert.match(p, /usually one or two sentences/);
  assert.match(p, /answered in the window are handled\. Never mention them/);
  assert.match(p, /never grouped and never auto-approved/);
  // Existing capabilities stay.
  for (const rule of ['start_task', 'start_research', 'get_task', 'follow_up', 'learn_correction', 'add_vocabulary', 'set_project_alias', 'set_project_description', 'hide_project', 'start_self_improvement', 'remember', 'open_terminal', 'WebSearch', 'Indian accent', 'current local date and time', '[event]']) {
    assert.ok(p.includes(rule), rule);
  }
});
