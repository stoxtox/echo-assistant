// Milestones instead of the step cap (lib/agent/budget.js, the milestones flag): no stop at 25 steps
// while it's getting somewhere, a progress line every 20, and a stop when it's stuck.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { sandbox } from './helpers.js';

const dirs = sandbox('budget');
const { remember, stuck, milestone, MILESTONE_STEPS, HARD_STEPS, STUCK_WINDOW } = await import('../lib/agent/budget.js');
const { ComputerUse } = await import('../lib/computer.js');
const { ScreenBridge } = await import('../lib/screen.js');
const { saveSettings } = await import('../lib/settings.js');

test('stuck: most recent steps did nothing, or the same thing keeps failing', () => {
  let h = [];
  for (let i = 0; i < 10; i++) h = remember(h, { action: 'click', target: `Item ${i}`, done: true });
  assert.equal(stuck(h).stuck, false);
  for (let i = 0; i < 4; i++) h = remember(h, { action: 'click', target: `Other ${i}`, done: false });
  assert.equal(stuck(h).stuck, false, '4 of 8 is not yet stuck');
  h = remember(h, { action: 'click', target: 'Other 9', done: false });
  assert.match(String(stuck(h).why), /5 of the last 8 steps didn't do anything/);
  let r = [];
  r = remember(r, { action: 'click', target: 'Done', done: true });
  for (let i = 0; i < 3; i++) r = remember(r, { action: 'click', target: 'Align Left', done: false });
  assert.match(String(stuck(r).why), /the same click on "align left" didn't work 3 times in a row/);
  assert.equal(remember(new Array(40).fill({ action: 'x', target: '', done: true }), { action: 'y', target: '', done: true }).length, 24, 'only the most recent few are kept');
  assert.ok(STUCK_WINDOW >= 6);
  assert.equal(milestone(MILESTONE_STEPS), true);
  assert.equal(milestone(MILESTONE_STEPS + 1), false);
  assert.equal(milestone(0), false);
  assert.ok(HARD_STEPS >= 100);
});

/**
 * A Mac app stand-in: every step done (or not, from `done`).
 * @param {(p: any) => boolean} [done]
 */
function fakeApp(done = (_p) => true) {
  const bridge = new ScreenBridge({ logFile: path.join(dirs.data, 'screen-log.jsonl'), timeoutMs: 500, browserTimeoutMs: 500 });
  bridge.nativeClients = () => 1;
  bridge.on('request', (r) => {
    const p = r.params;
    let out;
    if (r.kind === 'act' && p.step === 'resolve') out = { ok: true, found: true, token: 't', label: p.target || '', role: 'AXButton', app: 'Adobe XD', window: 'Untitled' };
    else if (r.kind === 'act' && p.step === 'do') out = done(p) ? { ok: true, via: 'accessibility', verified: true, changes: ['content'] } : { ok: true, via: 'accessibility', verified: false, changes: [] };
    else if (r.kind === 'wait') out = { ok: true, found: true };
    if (out) setImmediate(() => bridge.deliver(r.id, out));
  });
  return bridge;
}

const withMilestones = async (fn) => {
  process.env.ECHO_FLAG_MILESTONES = '1';
  try {
    await fn();
  } finally {
    delete process.env.ECHO_FLAG_MILESTONES;
  }
};

test('with milestones: past the old cap while it gets somewhere, a progress line at 20', () =>
  withMilestones(async () => {
    saveSettings({ computerUse: true, driveMode: 'do' });
    const c = new ComputerUse({ bridge: fakeApp(), logFile: path.join(dirs.data, 'computer-log.jsonl'), maxSteps: 5 });
    const out = [];
    for (let i = 1; i <= 22; i++) out.push(await c.act('click', { target: `Layer ${i}` }));
    assert.ok(out.every((r) => r.done), 'no stop at the old cap of 5');
    assert.equal(out[19].milestone, 20);
    assert.match(out[19].milestoneNote, /ONE short line of progress[\s\S]*don't ask whether to keep going/);
    assert.equal(out[20].milestone, undefined);
    c.end('done');
  }));

test('with milestones: stopped when stuck, with what is in the way', () =>
  withMilestones(async () => {
    saveSettings({ computerUse: true, driveMode: 'do' });
    const c = new ComputerUse({ bridge: fakeApp((p) => p.target !== 'Align Left'), logFile: path.join(dirs.data, 'computer-log.jsonl') });
    await c.act('click', { target: 'Rectangle' });
    for (let i = 0; i < 3; i++) assert.equal((await c.act('click', { target: 'Align Left' })).done, false);
    const r = await c.act('click', { target: 'Align Left' });
    assert.equal(r.error, 'stuck');
    assert.match(r.message, /same click on "align left" didn't work 3 times[\s\S]*Don't just try again/);
    assert.equal(c.driving, false, 'the run ended');
  }));

test('switched off in Labs: the step cap, as before', async (t) => {
  process.env.ECHO_FLAG_MILESTONES = '0';
  t.after(() => delete process.env.ECHO_FLAG_MILESTONES);
  saveSettings({ computerUse: true, driveMode: 'do' });
  const c = new ComputerUse({ bridge: fakeApp(), logFile: path.join(dirs.data, 'computer-log.jsonl'), maxSteps: 3 });
  for (let i = 0; i < 3; i++) assert.equal((await c.act('click', { target: `B${i}` })).done, true);
  assert.equal((await c.act('click', { target: 'B4' })).error, 'step_cap');
});
