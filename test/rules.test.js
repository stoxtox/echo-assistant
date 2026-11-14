// Preferences as rules (lib/rules.js, the rules flag): kept in the user's words, the same or the
// opposite rule replaces the old one, followed every session, removable in Settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, serverSource, pageSource } from './helpers.js';

const dirs = sandbox('rules');
const { addRule, removeRule, loadRules, rulesText, sameThing, BUILT_IN_RULES } = await import('../lib/rules.js');

test('the rule from Oct 6 ("show it when you explain") ships with Echo: there from the first start, nothing written, and removable for good', () => {
  const store = path.join(dirs.data, 'rules.json');
  const [rule] = loadRules();
  assert.equal(loadRules().length, 1, 'an empty store still has it');
  assert.match(rule.text, /^When you explain something on my screen, show it: point at the part you mean and go one small piece at a time\.$/);
  assert.ok(rule.at.startsWith('2026-10-06'), 'from the user, on Oct 6');
  assert.ok(rule.said, 'with what they said');
  assert.match(rulesText(), /- When you explain something on my screen, show it/);
  assert.equal(fs.existsSync(store), false, 'reading it writes nothing to the data folder');
  // It stays when the user adds a rule of their own, and can be reworded like any other.
  addRule('Use metric units');
  assert.deepEqual(loadRules().map((r) => r.id), [BUILT_IN_RULES[0].id, loadRules()[1].id]);
  const again = addRule('When you explain something on my screen, show it: point at the part you mean and go slowly, one small piece at a time');
  assert.equal(again.rule.id, BUILT_IN_RULES[0].id, 'said again in other words: the same rule, reworded');
  assert.equal(loadRules().filter((r) => /explain something on my screen/.test(r.text)).length, 1);
  // Removed: it does not come back with the next rule, or the next start.
  assert.ok(removeRule(BUILT_IN_RULES[0].id));
  removeRule('use metric units');
  addRule('Use metric units');
  removeRule('use metric units');
  assert.deepEqual(loadRules(), []);
  assert.equal(rulesText(), '');
});

test('kept in their words, per app or everywhere; the same rule again, or its opposite, replaces it', () => {
  const a = addRule('Never save the file unless I ask', { said: 'never save unless I ask, okay?' });
  assert.equal(a.replaced, null);
  addRule('Keep the footer at the bottom', { app: 'Adobe XD' });
  const b = addRule('Always save the file when you finish', {});
  assert.equal(b.replaced?.text, 'Never save the file unless I ask', 'the opposite replaces it');
  assert.equal(loadRules().length, 2);
  const c = addRule('Keep the footer at the very bottom', { app: 'Adobe XD' });
  assert.ok(c.replaced, 'the same thing said again');
  assert.equal(loadRules().filter((r) => r.app === 'Adobe XD').length, 1);
  assert.ok(sameThing('stop opening new tabs', 'never open new tabs') >= 0.5);
});

test('in every session\'s instructions, general rules first, then each app\'s', () => {
  const t = rulesText();
  assert.match(t, /Follow them every time, in every session/);
  assert.match(t, /- Always save the file when you finish\nIn Adobe XD:\n- Keep the footer at the very bottom/);
});

test('removed by id or by its words', () => {
  const r = loadRules().find((x) => x.app === 'Adobe XD');
  assert.equal(removeRule(String(r?.id))?.text, 'Keep the footer at the very bottom');
  assert.equal(removeRule('always save when finished')?.text, 'Always save the file when you finish');
  assert.equal(removeRule('something never said'), null);
  assert.equal(rulesText(), '');
});

test('the tools, the instructions and Settings come with the switch (on unless turned off in Labs)', async () => {
  const { Dispatcher } = await import('../lib/dispatcher.js');
  const { TaskManager } = await import('../lib/tasks.js');
  const make = () => new Dispatcher(new TaskManager({ queryFn: async function* () {} }));
  assert.ok(make().toolList().some((t) => t.name === 'remember_rule'), 'on by default');
  process.env.ECHO_FLAG_RULES = '0';
  assert.ok(!make().toolList().some((t) => t.name === 'remember_rule'), 'switched off');
  process.env.ECHO_FLAG_RULES = '1';
  try {
    addRule('Never open new tabs', {});
    const d = make();
    assert.ok(d.toolList().some((t) => t.name === 'remember_rule') && d.toolList().some((t) => t.name === 'forget_rule'));
    const p = d.systemPrompt();
    assert.match(p, /call remember_rule right away/);
    assert.match(p, /- Never open new tabs/);
  } finally {
    delete process.env.ECHO_FLAG_RULES;
  }
  assert.match(serverSource(), /'POST \/api\/rules\/remove': async/);
  assert.match(pageSource(), /renderRules\(Boolean\(settings\.flags\?\.rules\)\);/);
});

test('two rules about different things stay two, however alike the sentence', () => {
  assert.ok(sameThing('Keep the footer at the bottom', 'Keep the header at the bottom') < 0.6, 'footer is not header');
  assert.ok(sameThing('send the report to Sam', 'send the report to Ria') < 0.6, 'a different person is a different job');
  assert.ok(sameThing('use tabs', 'never use spaces') < 0.4, 'one shared word is not much');
  assert.ok(sameThing('stop opening new tabs', 'never open new tabs') >= 0.9, 'the same words in other forms');
  addRule('Never save the file unless I ask', {});
  assert.equal(removeRule('never save')?.text, 'Never save the file unless I ask', 'a rule is still found by a few of its words');
});
