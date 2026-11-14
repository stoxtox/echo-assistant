import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.js';

sandbox('dispatcher');
const { Dispatcher, PROGRESS_PROMPT } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');

test('the system prompt is conversational and keeps every rule', () => {
  const p = new Dispatcher(new TaskManager({ queryFn: async function* () {} })).systemPrompt();
  for (const phrase of ['Great question', 'Certainly!', "I'd be happy to", 'Let me know if', 'Is there anything else', 'Just a heads up']) assert.ok(p.includes(phrase), `bans ${phrase}`);
  assert.match(p, /Never open two replies in a row the same way/);
  // No stock acknowledgements: the first spoken words carry content, and progress is the model's own.
  assert.doesNotMatch(p, /already says a quick acknowledgement/);
  assert.match(p, /first spoken words must already carry content/);
  assert.match(p, /Never open with a stock acknowledgement/);
  assert.ok(p.includes(PROGRESS_PROMPT(false)), 'off by default: a progress line only for slow work');
  assert.match(PROGRESS_PROMPT(false), /BEFORE the first tool call/);
  assert.match(PROGRESS_PROMPT(true), /before you use any tool/);
  for (const pp of [PROGRESS_PROMPT(false), PROGRESS_PROMPT(true)]) assert.match(pp, /ONE short sentence[\s\S]*Never generic[\s\S]*once per turn/);
  assert.match(p, /usually one or two sentences/);
  assert.match(p, /answered in the window are handled\. Never mention them/);
  assert.match(p, /never grouped and never auto-approved/);
  // Existing capabilities stay.
  for (const rule of ['start_task', 'start_research', 'get_task', 'follow_up', 'learn_correction', 'add_vocabulary', 'set_project_alias', 'set_project_description', 'hide_project', 'remember', 'recall', 'open_terminal', 'WebSearch', 'current local date and time', '[event]', 'call those tools together in one reply']) {
    assert.ok(p.includes(rule), rule);
  }
  // Self-improve is only described to a copy that can change itself.
  assert.doesNotMatch(p, /start_self_improvement/);
  const withSelf = new Dispatcher(new TaskManager({ queryFn: async function* () {} }), /** @type {any} */ ({ available: true })).systemPrompt();
  assert.match(withSelf, /call start_self_improvement/);
  // An installed or shipped copy is told plainly that self-improve isn't there.
  const notDev = new Dispatcher(new TaskManager({ queryFn: async function* () {} }), /** @type {any} */ ({ available: false })).systemPrompt();
  assert.doesNotMatch(notDev, /call start_self_improvement/);
  assert.match(notDev, /only available in the developer copy of Echo/);
});

test('the persona is part of the prompt, and the Personality setting switches it', async () => {
  const { saveSettings, getSettings } = await import('../lib/settings.js');
  const prompt = () => new Dispatcher(new TaskManager({ queryFn: async function* () {} })).systemPrompt();
  try {
    saveSettings({ personality: 'friendly' });
    const friendly = prompt();
    for (const part of ['a friend first, not an assistant', 'Emotional awareness', 'Narrating the screen', 'Creativity', 'Respect privacy', 'Match the user', 'Rose sent. Pretty sure that just made her evening.', 'Level: Friendly']) {
      assert.ok(friendly.includes(part), part);
    }
    assert.ok((friendly.match(/\n- .+ Plain: /g) || []).length >= 6, 'has before/after examples');
    saveSettings({ personality: 'balanced' });
    assert.match(prompt(), /Level: Balanced/);
    saveSettings({ personality: 'professional' });
    const pro = prompt();
    assert.match(pro, /Level: Professional/);
    assert.doesNotMatch(pro, /Level: Friendly/);
    assert.ok(pro.includes('Respect privacy'), 'guardrails apply at every level');
    // Old personalities carry over; unknown ones fall back to Friendly.
    saveSettings({ personality: 'pro' });
    assert.equal(getSettings().personality, 'professional');
    saveSettings({ personality: 'nonsense' });
    assert.equal(getSettings().personality, 'friendly');
  } finally {
    saveSettings({ personality: 'friendly' });
  }
});

test('the accent line follows the setting: Indian English says so, others assume nothing', async () => {
  const { saveSettings } = await import('../lib/settings.js');
  const prompt = () => new Dispatcher(new TaskManager({ queryFn: async function* () {} })).systemPrompt();
  saveSettings({ sttLanguage: 'en-IN' });
  assert.match(prompt(), /speaks English with an Indian accent/);
  saveSettings({ sttLanguage: 'en-US' });
  assert.doesNotMatch(prompt(), /Indian/);
});
