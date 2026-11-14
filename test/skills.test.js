// Per-app skills (lib/skills.js, the skills flag): a job checked done is kept as an episode; a job
// like it done twice becomes a skill (the shorter way), listed for sessions and in Settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, serverSource, pageSource } from './helpers.js';

const dirs = sandbox('skills');
const { recordEpisode, loadSkills, skillsText, findSkill, removeSkill, skillStep, PROMOTE_AFTER } = await import('../lib/skills.js');

test('a job that worked twice becomes a skill: the shorter way, versioned, nothing typed kept', () => {
  assert.equal(PROMOTE_AFTER, 2);
  assert.equal(skillStep('type “hello@example.com” into To in Mail'), 'type (the text) into To in Mail');
  const first = recordEpisode({ app: 'Adobe XD', goal: 'Centre the title on the artboard', steps: ['click “Title” in Adobe XD', 'click “Align Center” in Adobe XD', 'press cmd+s in Adobe XD'] });
  assert.equal(first.skill, null, 'once is not yet a skill');
  const second = recordEpisode({ app: 'Adobe XD', goal: 'Centre the title on the artboard', steps: ['click “Title” in Adobe XD', 'click “Align Center” in Adobe XD'] });
  assert.equal(second.skill?.version, 1);
  assert.deepEqual(second.skill?.steps, ['click “Title” in Adobe XD', 'click “Align Center” in Adobe XD'], 'the shorter way');
  const third = recordEpisode({ app: 'Adobe XD', goal: 'Centre the title on the artboard please', steps: ['click “Title” in Adobe XD'] });
  assert.equal(third.skill?.version, 2, 'a shorter way is a new version');
  assert.equal(loadSkills().length, 1);
  recordEpisode({ app: 'Mail', goal: 'Centre the title on the artboard', steps: ['click “x”', 'click “y”'] });
  assert.equal(loadSkills().length, 1, 'another app: its own episode, not this skill');
});

test('listed by app for a session; its steps found by id or by what the job is', () => {
  const t = skillsText();
  assert.match(t, /call skill_steps with its id/);
  assert.match(t, /In Adobe XD: Centre the title on the artboard please \([0-9a-f]+\)/);
  const s = findSkill('centre the title', 'Adobe XD');
  assert.ok(s);
  assert.equal(findSkill(String(s?.id))?.uses, 1, 'uses counted');
  assert.equal(findSkill('book a flight'), null);
  assert.equal(removeSkill(String(s?.id))?.app, 'Adobe XD');
  assert.equal(skillsText(), '');
});

test('the whole way: a job checked done becomes an episode, and the second time a skill', async () => {
  const { ComputerUse } = await import('../lib/computer.js');
  const { ScreenBridge } = await import('../lib/screen.js');
  const { saveSettings, setFixedForTest } = await import('../lib/settings.js');
  (setFixedForTest({ screenAware: true }), saveSettings({ computerUse: true, driveMode: 'do' }));
  const bridge = new ScreenBridge({ logFile: path.join(dirs.data, 'screen-log.jsonl'), timeoutMs: 500, browserTimeoutMs: 500 });
  bridge.nativeClients = () => 1;
  bridge.on('request', (r) => {
    const p = r.params;
    let out;
    if (r.kind === 'act' && p.step === 'resolve') out = { ok: true, found: true, token: 't', label: p.target || '', role: 'AXButton', app: 'Keynote', window: 'Deck' };
    else if (r.kind === 'act' && p.step === 'do') out = { ok: true, via: 'accessibility', verified: true, changes: ['content'], app: 'Keynote' };
    else if (r.kind === 'look') out = { ok: true, source: 'native', text: 'Slide', width: 10, height: 10, app: 'Keynote' };
    if (out) setImmediate(() => bridge.deliver(r.id, out));
  });
  process.env.ECHO_FLAG_SKILLS = '1';
  try {
    for (let round = 1; round <= 2; round++) {
      const c = new ComputerUse({ bridge, logFile: path.join(dirs.data, 'computer-log.jsonl') });
      c.setGoal('Add a title slide', ['A title slide is first']);
      await c.act('click', { target: 'Add Slide' });
      await c.act('click', { target: 'Title' });
      c.criticQueryFn = () => (async function* () { yield { type: 'result', subtype: 'success', result: '{"points":[{"point":"A title slide is first","met":true,"why":"Yes."}]}' }; })();
      const r = await c.checkDone();
      assert.equal(r.pass, true);
      if (round === 1) assert.equal(r.learned, undefined);
      else assert.equal(r.learned, 'Add a title slide (in Keynote)');
      c.end('done');
    }
  } finally {
    delete process.env.ECHO_FLAG_SKILLS;
  }
  assert.equal(fs.readFileSync(path.join(dirs.data, 'episodes.jsonl'), 'utf8').trim().split('\n').filter((l) => l.includes('Keynote')).length, 2);
  assert.match(serverSource(), /'POST \/api\/skills\/remove': async/);
  assert.match(pageSource(), /renderSkills\(Boolean\(settings\.flags\?\.skills\)\);/);
});
