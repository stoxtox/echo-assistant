import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  STEPS, EXAMPLES, DEFAULT_SUGGESTIONS, tourExamples, suggestionsFor, friendlyPath, folderName, pinProblem, splitVoiceName, ACCENTS,
} from '../public/onboarding.js';

test('the wizard has the nine steps, in order', () => {
  assert.deepEqual([...STEPS], ['welcome', 'name', 'help', 'files', 'voice', 'talking', 'pin', 'permissions', 'tour']);
});

test('tour examples come from the chosen interests, topped up to at least four', () => {
  const one = tourExamples(['documents']);
  assert.equal(one.length, 4);
  assert.deepEqual(one.slice(0, 2).map((e) => e.text), EXAMPLES.documents);
  assert.ok(one.slice(2).every((e) => e.interest !== 'documents'));

  const two = tourExamples(['errands', 'apps']);
  assert.deepEqual(two.map((e) => e.interest), ['errands', 'apps', 'errands', 'apps']);

  const all = tourExamples(['errands', 'research', 'documents', 'apps']);
  assert.equal(all.length, 6);
  assert.deepEqual(all.slice(0, 4).map((e) => e.interest), ['errands', 'research', 'documents', 'apps']);

  const none = tourExamples([]);
  assert.equal(none.length, 6);
  assert.equal(new Set(none.map((e) => e.interest)).size, 4);
  assert.deepEqual(tourExamples(['bogus']).length, 6);
});

test('chat suggestions are tailored only when there is something to tailor to', () => {
  assert.deepEqual(suggestionsFor({}), DEFAULT_SUGGESTIONS);
  assert.deepEqual(suggestionsFor({ interests: ['apps'] }).slice(0, 2), EXAMPLES.apps);
  assert.equal(suggestionsFor({ interests: ['apps'] }).length, 3);
  assert.equal(suggestionsFor({ beginnerMode: true }).length, 3);
});

test('paths are shown the friendly way', () => {
  assert.equal(friendlyPath('/Users/sam/Echo Projects', '/Users/sam'), '~/Echo Projects');
  assert.equal(friendlyPath('/Users/sam', '/Users/sam/'), '~');
  assert.equal(friendlyPath('/Volumes/Work/Echo', '/Users/sam'), '/Volumes/Work/Echo');
  assert.equal(friendlyPath('/Users/alex/x', '/Users/sam'), '/Users/alex/x');
  assert.equal(folderName('~/Documents/My Stuff/'), 'My Stuff');
  assert.equal(folderName(''), 'Echo Projects');
});

test('PIN checks explain what is wrong in plain words', () => {
  assert.match(pinProblem('', ''), /Skip for now/);
  assert.match(pinProblem('12a4', '12a4'), /numbers only/);
  assert.match(pinProblem('123', '123'), /4 to 10/);
  assert.match(pinProblem('12345678901', '12345678901'), /4 to 10/);
  assert.match(pinProblem('1234', '1243'), /don't match/);
  assert.equal(pinProblem('2580', '2580'), null);
});

test('voice labels split into a name and a note', () => {
  assert.deepEqual(splitVoiceName('Heart (US, warm)'), { name: 'Heart', note: 'US, warm' });
  assert.deepEqual(splitVoiceName('Nova'), { name: 'Nova', note: '' });
  assert.deepEqual(ACCENTS.map(([v]) => v), ['en-IN', 'en-US', 'en']);
});

test('the page has no secrets, home paths, phone numbers or emails in it', async () => {
  // Personal words are checked at package time against this install's own data (npm run package).
  const { scanFolder } = await import('../lib/privacy.js');
  assert.deepEqual(scanFolder(fileURLToPath(new URL('../public/', import.meta.url))), []);
});

test('index.html has the settings controls and the suggestions box app.js expects', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const id of ['suggestions', 'setBeginner', 'setSafe', 'projectsDirShow', 'changeFolder', 'runSetup', 'resetEcho', 'restartText', 'restartSub', 'helpSafety']) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
  }
});
