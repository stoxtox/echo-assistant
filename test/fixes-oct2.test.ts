// Fixes from the Oct 2 test: a guessed speech correction (and then its opposite) made two names
// flip back and forth; "Chrome" didn't open Google Chrome; Brief voice spoke whole replies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';

const dirs = sandbox('fixes-oct2');
const apps = path.join(dirs.root, 'Applications');
for (const a of ['Google Chrome', 'Google Chrome Canary', 'Safari', 'Microsoft Word', 'Adobe XD', 'Adobe Photoshop 2026']) fs.mkdirSync(path.join(apps, `${a}.app`), { recursive: true });
process.env.ECHO_APP_DIRS = apps;

const { isExplicitCorrection } = await import('../lib/corrections.ts');
const { closestApp } = await import('../lib/apps.ts');
const { learnCorrection, loadVocab } = await import('../lib/vocab.js');
const { QuickActions } = await import('../lib/quick.js');
const { Dispatcher } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');

test('a correction is only learned from the user saying Echo misheard', () => {
  for (const s of [
    'I actually said Silver Lake, not Silver Leaf.',
    "It's an album called Silver Lake.",
    "No, it's Riverside, not Riversaid.",
    'You misheard me, I said Foodbowl.',
    "That's not what I said.",
    'It is spelled C-A-R-D-Z.',
  ]) assert.equal(isExplicitCorrection(s), true, s);
  for (const s of [
    'Some kind of music. I think I would say Silver Lake music about Marigold.',
    'Hi, how are you?',
    'Open Spotify and Chrome.',
    'Play the Silver Lake album.',
    'Search for something not too loud.',
  ]) assert.equal(isExplicitCorrection(s), false, s);
});

test('the newest correction wins, so two names can never flip back and forth', () => {
  learnCorrection('Silver Lake', 'Silver Leaf');
  learnCorrection('Silver Leaf', 'Silver Lake');
  const c = loadVocab().corrections;
  assert.equal(c['silver lake'], undefined, 'the opposite rule is gone');
  assert.equal(c['silver leaf'], 'Silver Lake');
});

test('learn_correction refuses a guess and accepts the user correcting Echo', async () => {
  const d: any = new Dispatcher(new TaskManager({ queryFn: async function* () {} }));
  const tool = d.toolList().find((t: any) => t.name === 'learn_correction');
  d.beginTurn('Some kind of music, Silver Lake music about Marigold');
  const guess = await tool.handler({ heard: 'Silver Lake', meant: 'Something Else' }, {});
  assert.match(guess.content[0].text, /Not learned/);
  assert.equal(loadVocab().corrections['silver lake'], undefined);
  d.beginTurn('No, I said Marigold, not Marygold');
  const ok = await tool.handler({ heard: 'Marygold', meant: 'Marigold' }, {});
  assert.match(ok.content[0].text, /Learned/);
  assert.equal(loadVocab().corrections.marygold, 'Marigold');
});

test('a short app name opens the one installed app it clearly means', () => {
  const names = ['Google Chrome', 'Google Chrome Canary', 'Safari', 'Microsoft Word', 'Adobe XD', 'Adobe Photoshop 2026', 'Adobe Photoshop'];
  assert.equal(closestApp('Chrome', names), 'Google Chrome', 'fewest extra words wins over Canary');
  assert.equal(closestApp('chrome.app', names), 'Google Chrome');
  assert.equal(closestApp('Word', names), 'Microsoft Word');
  assert.equal(closestApp('XD', names), 'Adobe XD');
  assert.equal(closestApp('Safari', names), 'Safari');
  assert.equal(closestApp('Adobe', names), null, 'two Adobe apps: ask instead of guessing');
  assert.equal(closestApp('Spotify', names), null);
  assert.equal(closestApp('', names), null);
});

test('open_app: "Chrome" opens Google Chrome when there is no app called just Chrome', async () => {
  const calls: string[][] = [];
  const exec = async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    if (args[1] === 'Chrome' || args[1] === 'Spotify') {
      const e: any = new Error('failed');
      e.stderr = `Unable to find application named '${args[1]}'`;
      throw e;
    }
    return '';
  };
  const q: any = new QuickActions({ exec: exec as any });
  assert.deepEqual(await q.openApp('Chrome'), { opened: 'Google Chrome', asked: 'Chrome' });
  assert.deepEqual(calls.at(-1), ['open', '-a', 'Google Chrome']);
  await assert.rejects(q.openApp('Spotify'), /no app called Spotify/);
});
