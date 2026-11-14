// Feature flags (lib/flags.ts). This file is TypeScript on purpose: it proves the test runner and
// the type check both handle .ts (docs/adr/0001-stack.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.js';

sandbox('flags');
const { FLAGS, flagOn, flagState, allFlags, envName } = await import('../lib/flags.ts');
const { saveSettings, getSettings, cleanFlags } = await import('../lib/settings.js');

/** The one switch that starts off: it needs an API key and changes what the owner is billed for. */
const OFF_BY_DECISION = ['messages'];

test('every switch is on by default (they are how Echo works), except the one that changes billing; each says what it is for', () => {
  for (const [name, spec] of Object.entries(FLAGS)) {
    assert.equal(spec.default, !OFF_BY_DECISION.includes(name), `${name}: ${OFF_BY_DECISION.includes(name) ? 'off by decision' : 'should be on'}`);
    assert.ok(spec.about.length > 20, `${name} needs a description`);
    assert.doesNotMatch(spec.about, /Stage \d/, `${name}: a plain description, no plan jargon`);
  }
  assert.deepEqual(Object.keys(FLAGS).sort(), ['catchUp', 'critic', 'messages', 'milestones', 'policy', 'rules', 'skills', 'windowCrop']);
});

test('hints and verify are not switches any more: they are how Echo works, and their old paths are gone', async () => {
  assert.equal('hints' in FLAGS, false);
  assert.equal('verify' in FLAGS, false);
  const fs = await import('node:fs');
  const read = (f: string) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  for (const f of ['server.js', 'lib/server/speech.js', 'lib/computer.js', 'lib/correct.js']) assert.doesNotMatch(read(f), /flagOn\('(hints|verify)'\)/, f);
  // The old rewrite: learned replacements, then a correction model kept warm.
  assert.doesNotMatch(read('lib/correct.js'), /class Corrector|claude-agent-sdk|guardCorrection|needsSmartFix/);
  assert.doesNotMatch(read('lib/vocab.js'), /applyCorrections/);
  assert.doesNotMatch(read('server.js') + read('lib/server/speech.js'), /corrector|smartCorrection/);
  assert.doesNotMatch(read('lib/settings.js'), /smartCorrection/);
  // The Labs switches left Settings (the flags keep their defaults; ECHO_FLAG_<NAME> still sets one).
  assert.doesNotMatch(read('public/index.html'), /labsGroup|labsList/);
});

test('the environment beats settings, settings beat the default', () => {
  const env: NodeJS.ProcessEnv = {};
  assert.deepEqual(flagState('policy', { settings: {}, env }), { on: true, source: 'default' });
  assert.deepEqual(flagState('messages', { settings: {}, env }), { on: false, source: 'default' });
  assert.deepEqual(flagState('policy', { settings: { core: { policy: false } }, env }), { on: false, source: 'settings' }, 'switched off in Labs');
  env[envName('policy')] = '1';
  assert.deepEqual(flagState('policy', { settings: { core: { policy: false } }, env }), { on: true, source: 'env' });
  env[envName('policy')] = 'no';
  assert.equal(flagOn('policy', { settings: {}, env }), false);
  env[envName('policy')] = 'maybe';
  assert.equal(flagState('policy', { settings: {}, env }).source, 'default', 'an unreadable value is ignored');
  assert.equal(envName('policy'), 'ECHO_FLAG_POLICY');
});

test('a flag saved in settings sticks, merges with the others, and stays a plain boolean', () => {
  saveSettings({ core: { policy: false } });
  saveSettings({ core: { critic: false } });
  assert.deepEqual(getSettings().core, { policy: false, critic: false });
  assert.equal(flagOn('policy', { env: {} }), false);
  saveSettings({ core: { policy: true } });
  assert.equal(flagOn('policy', { env: {} }), true);
  saveSettings({ userName: 'Sam' });
  assert.deepEqual(getSettings().core, { policy: true, critic: false }, 'saving anything else keeps the flags');
  // A switch that no longer exists, left in settings from before, changes nothing.
  saveSettings({ core: { hints: false } });
  assert.equal(allFlags({ env: {} }).some((f) => String(f.name) === 'hints'), false);
  assert.deepEqual(cleanFlags({ ok: true, bad: 'yes', 'no spaces': true, Upper: true, n: 1 }), { ok: true });
  assert.deepEqual(cleanFlags(['x']), {});
  assert.deepEqual(cleanFlags(null), {});
});

test('the list for Settings shows every flag with its source', () => {
  const list = allFlags({ settings: { core: { policy: true } }, env: {} });
  assert.deepEqual(list.map((f) => f.name).sort(), Object.keys(FLAGS).sort());
  assert.deepEqual(list.find((f) => f.name === 'policy'), { name: 'policy', on: true, source: 'settings', label: FLAGS.policy.label, about: FLAGS.policy.about, envName: 'ECHO_FLAG_POLICY' });
});
