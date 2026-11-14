// The job journal (lib/agent/journal.js): a job with a goal is written down as it goes, carried to
// a fresh session, reloaded after a restart, and cleared when it's checked done.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';

const dirs = sandbox('journal');
const { loadJob, saveJob, stepDone, jobLine, JOB_MAX_AGE_MS } = await import('../lib/agent/journal.js');
const { pendingLines } = await import('../lib/rotation.js');
const { ComputerUse } = await import('../lib/computer.js');
const { ScreenBridge } = await import('../lib/screen.js');
const { saveSettings, setFixedForTest } = await import('../lib/settings.js');
const logFile = path.join(dirs.data, 'computer-log.jsonl');
const jobFile = path.join(dirs.data, 'job.json');

test('a job on file: recent ones load, old ones are history; the line a fresh session gets', () => {
  const now = Date.now();
  saveJob(jobFile, { goal: 'Landing hero', points: ['Title centred'], app: 'Adobe XD', steps: 0, last: [], at: now, updatedAt: now });
  let j = loadJob(jobFile, now);
  assert.equal(j?.goal, 'Landing hero');
  for (let i = 1; i <= 7; i++) j = stepDone(/** @type {any} */ (j), `click "Layer ${i}"`, { now });
  assert.equal(j?.steps, 7);
  assert.deepEqual(j?.last, ['click "Layer 3"', 'click "Layer 4"', 'click "Layer 5"', 'click "Layer 6"', 'click "Layer 7"']);
  assert.equal(loadJob(jobFile, now + JOB_MAX_AGE_MS + 1000), null);
  const line = jobLine(/** @type {any} */ (j));
  assert.match(line, /Unfinished job on the Mac in Adobe XD: Landing hero\. Done when: Title centred\. 7 steps so far\. Last done: [^.]*Layer 7"\. If the user carries on with it, look at the screen first/);
  assert.equal(pendingLines({ job: j })[0], line);
  assert.deepEqual(pendingLines({}), []);
});

function fakeApp() {
  const bridge = new ScreenBridge({ logFile: path.join(dirs.data, 'screen-log.jsonl'), timeoutMs: 500, browserTimeoutMs: 500 });
  bridge.nativeClients = () => 1;
  bridge.on('request', (r) => {
    const p = r.params;
    let out;
    if (r.kind === 'act' && p.step === 'resolve') out = { ok: true, found: true, token: 't', label: p.target || '', role: 'AXButton', app: 'Adobe XD', window: 'Landing' };
    else if (r.kind === 'act' && p.step === 'do') out = { ok: true, via: 'accessibility', verified: true, changes: ['content'] };
    else if (r.kind === 'look') out = { ok: true, source: 'native', text: 'Hero', width: 10, height: 10, app: 'Adobe XD' };
    if (out) setImmediate(() => bridge.deliver(r.id, out));
  });
  return bridge;
}

test('the journal follows the job: goal, steps done, kept through a restart, cleared when checked done', async () => {
  fs.rmSync(jobFile, { force: true });
  (setFixedForTest({ screenAware: true }), saveSettings({ computerUse: true, driveMode: 'do' }));
  const c = new ComputerUse({ bridge: fakeApp(), logFile });
  c.setGoal('Landing hero', ['Title centred']);
  await c.act('click', { target: 'Align Center' });
  await c.act('click', { target: 'Bold' });
  c.end('done');
  // Echo restarts: the job, and what done means, are still there.
  const again = new ComputerUse({ bridge: fakeApp(), logFile });
  assert.equal(again.job?.steps, 2);
  assert.match(String(again.job?.last.join(' ')), /Align Center[\s\S]*Bold/);
  assert.deepEqual(again.goal?.points, ['Title centred']);
  again.criticQueryFn = () => (async function* () { yield { type: 'result', subtype: 'success', result: '{"points":[{"point":"Title centred","met":true,"why":"It is."}]}' }; })();
  assert.equal((await again.checkDone()).pass, true);
  assert.equal(again.job, null);
  assert.equal(fs.existsSync(jobFile), false, 'done: off the journal');
});
