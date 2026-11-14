import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';

const dirs = sandbox('speech');
for (const name of ['Foodbowl', 'Budget2', 'FitTrack', 'Cardz']) fs.mkdirSync(path.join(dirs.projects, name), { recursive: true });
// A fresh install has no personal vocabulary, so seed one like a user would build up.
fs.writeFileSync(path.join(dirs.data, 'vocabulary.json'), JSON.stringify({
  words: ['Echo', 'Claude', 'Sam', 'Maya', 'Hoboken', 'Riverside', 'AMC', 'pho', 'bibimbap'],
  corrections: {
    football: 'Foodbowl',
    gadget: 'Budget2',
    'white soaps': 'FitTrack',
    emc: 'AMC',
    'hoe broken': 'Hoboken',
    'residential evil': 'Resident Evil',
    cards: 'Cardz',
    'they eat 31': '8:30',
  },
}));
const V = await import('../lib/vocab.js');
const { mergeTokens, uncertainWords, resolveEngine, sttLanguageFor, whisperForm, whisperArgs, deepgramParams } = await import('../lib/stt.js');
const { getSettings, saveSettings, defaultAccent } = await import('../lib/settings.js');

test('vocabulary includes project names, your words, and learned fixes', () => {
  const terms = V.vocabularyTerms();
  for (const t of ['Foodbowl', 'Budget2', 'Sam', 'Hoboken', 'pho', 'bibimbap', 'Resident Evil']) assert.ok(terms.includes(t), t);
  assert.ok(terms.indexOf('Foodbowl') < terms.indexOf('Sam'), 'projects first');
  assert.match(V.whisperPrompt(), /^Glossary: .*Foodbowl/);
  assert.ok(V.whisperPrompt().length <= 700);
});

test('learning a correction saves it and adds the word to the vocabulary', () => {
  V.learnCorrection('foe', 'pho');
  V.learnCorrection('bee bim bop', 'bibimbap');
  V.learnCorrection('ramon', 'ramen');
  assert.equal(V.loadVocab().corrections.foe, 'pho');
  assert.ok(V.loadVocab().words.includes('ramen'), 'new word joins the vocabulary');
  assert.throws(() => V.learnCorrection('', 'x'));
});

test('whisper tokens merge into words and low-confidence key words are flagged', () => {
  const words = mergeTokens([
    { word: ' Open', probability: 0.84 }, { word: ' my', probability: 0.95 }, { word: ' Fit', probability: 0.46 },
    { word: 'Tr', probability: 0.6 }, { word: 'ack', probability: 1 }, { word: ' at', probability: 0.3 },
    { word: ' 8', probability: 0.5 }, { word: '.30', probability: 0.9 }, { word: ' the', probability: 0.2 },
  ]);
  assert.deepEqual(words.map((w) => w.word), ['Open', 'my', 'FitTrack', 'at', '8.30', 'the']);
  assert.deepEqual(uncertainWords(words).map((u) => u.word), ['FitTrack', '8.30']);
});

test('auto picks local Whisper when installed, else the browser', () => {
  assert.ok(['whisper', 'browser'].includes(resolveEngine('auto')));
  assert.equal(resolveEngine('deepgram') === 'deepgram', Boolean(process.env.DEEPGRAM_API_KEY));
});

test('speech recognition is locked to English for every engine', () => {
  assert.equal(getSettings().sttLanguage, defaultAccent(), "a fresh install's accent comes from the Mac's region");
  assert.equal(defaultAccent({ mac: '', locale: 'en-IN', lang: '' }), 'en-IN');
  assert.equal(defaultAccent({ mac: '', locale: 'en-US', lang: '' }), 'en-US');
  assert.equal(defaultAccent({ mac: '', locale: 'en-GB', lang: '' }), 'en');
  assert.equal(defaultAccent({ mac: '', locale: 'en', lang: 'en_IN.UTF-8' }), 'en-IN', 'or the shell language');
  assert.equal(defaultAccent({ mac: 'en_IN', locale: 'en-US', lang: '' }), 'en-IN', "the Mac's region first: started by the app, Node's locale is en-US anywhere");
  for (const setting of ['en-IN', 'en-US', 'en', 'es', undefined]) {
    assert.equal(sttLanguageFor('whisper', setting), 'en');
    assert.match(sttLanguageFor('deepgram', setting), /^en(-IN|-US)?$/);
    assert.match(sttLanguageFor('browser', setting), /^en-(IN|US)$/);
  }
  assert.equal(sttLanguageFor('deepgram', 'en-US'), 'en-US');
  assert.equal(sttLanguageFor('deepgram', 'es'), 'en', 'never another language, and no accent assumed');
  assert.equal(sttLanguageFor('browser', 'en'), 'en-US');
  assert.equal(sttLanguageFor('browser', 'en-IN'), 'en-IN');

  const form = whisperForm(Buffer.from('RIFF'), 'Glossary: Foodbowl');
  assert.equal(form.get('language'), 'en', 'every request forces English');
  assert.equal(form.get('translate'), 'false');
  assert.equal(form.get('detect_language'), 'false');
  const args = whisperArgs();
  assert.equal(args[args.indexOf('-l') + 1], 'en');
  assert.ok(!args.some((a) => /detect|auto|translate|^-tr$|^-dl$/.test(a)));

  assert.equal(deepgramParams('en-IN').get('language'), 'en-IN');
  assert.equal(deepgramParams(undefined).get('language'), 'en', 'never undefined');
  assert.ok(!deepgramParams('en-US').has('detect_language'));
});

test('the language setting only accepts English accents', () => {
  assert.equal(saveSettings({ sttLanguage: 'es' }).sttLanguage, defaultAccent());
  assert.equal(saveSettings({ sttLanguage: 'en-US' }).sttLanguage, 'en-US');
  assert.equal(saveSettings({ sttLanguage: 'en' }).sttLanguage, 'en', 'older saved setting still works');
  fs.writeFileSync(path.join(dirs.data, 'settings.json'), JSON.stringify({ sttLanguage: 'multi' }));
  assert.equal(getSettings().sttLanguage, defaultAccent(), 'a hand-edited file cannot switch languages');
});

test('spelled-out names always win, and nothing swaps in the user\'s own name or changes a contact', async () => {
  const { hearAsSaid, spelledWords, applySpelling } = await import('../lib/correct.js');
  saveSettings({ userName: 'Sam Lee' });
  fs.writeFileSync(path.join(dirs.data, 'contact-aliases.json'), JSON.stringify({ 'priya aunty': { alias: 'Priya Aunty', name: 'Priya Shah', id: 'c1', handle: '+15555550100', label: 'mobile' } }));

  assert.deepEqual(spelledWords("It's T-A-V-I-S-H.").map((s) => s.word), ['Tavish']);
  assert.deepEqual(spelledWords('I think a cat is here').map((s) => s.word), [], 'ordinary words are not spelling');
  assert.equal(applySpelling('Its Tavis, T-A-V-I-S-H.').text, 'Its Tavish, T-A-V-I-S-H.', 'the spelling fixes the spoken word');

  // What really happened once: a spoken and spelled name was turned into the user's own name.
  // Now every sentence reaches Echo as heard.
  for (const said of ["Yeah, it's Tavish Uncle.", "It's a Tavish, you heard that right. It's a T-A-V-I-S-H.", 'Text Priya that I am late']) {
    assert.equal(hearAsSaid(said).text, said, said);
  }
});

test('the Whisper prompt is short, names last, spoken the way you say them, and never has aliases', () => {
  fs.writeFileSync(path.join(dirs.data, 'projects.json'), JSON.stringify({ aliases: { okayshow: 'FitTrack' }, hidden: [], descriptions: {} }));
  const p = V.whisperPrompt();
  assert.ok(p.startsWith(`${V.WHISPER_PROMPT_PREFIX} `));
  assert.ok(p.length <= 320, 'long lists bias Whisper far less (measured)');
  assert.match(p, /\bFitTrack\.$/, 'the most important name (a project you have a nickname for) goes last, nearest the audio');
  assert.doesNotMatch(p, /Budget/, 'folder digits are not spoken, and "Budget" is an ordinary word');
  assert.doesNotMatch(p, /okayshow/i, 'aliases are mishearings, never prompt words');
  assert.doesNotMatch(p, /\bClaude\b|\bEcho\b/, 'ordinary words need no prompt');
  assert.ok(p.indexOf('Foodbowl') > p.indexOf('Hoboken'), 'projects after everyday vocabulary');
  assert.equal(V.spokenName('Notes2.0'), 'Notes');
  assert.equal(V.spokenName('Fit Track3'), 'Fit Track');
  assert.equal(V.spokenName('host-redesign'), 'host-redesign');
  assert.equal(whisperForm(Buffer.from('RIFF'), '').has('prompt'), false, 'no empty prompt');
});

test('turbo is the Whisper model used; large-v3 only when it is all there is or chosen', async () => {
  const { whisperModel, WHISPER_MODELS } = await import('../lib/stt.js');
  const dir = fs.mkdtempSync(path.join(dirs.data, 'models-'));
  const saved = process.env.ECHO_WHISPER_MODEL;
  delete process.env.ECHO_WHISPER_MODEL;
  try {
    assert.equal(path.basename(whisperModel(dir)), WHISPER_MODELS.at(-1), 'nothing downloaded: the last path (setup says what to run)');
    fs.writeFileSync(path.join(dir, 'ggml-large-v3-q5_0.bin'), '');
    assert.equal(path.basename(whisperModel(dir)), 'ggml-large-v3-q5_0.bin', 'only large-v3 there');
    fs.writeFileSync(path.join(dir, 'ggml-large-v3-turbo-q5_0.bin'), '');
    assert.equal(path.basename(whisperModel(dir)), 'ggml-large-v3-turbo-q5_0.bin', 'turbo wins: better on real speech, and faster');
    process.env.ECHO_WHISPER_MODEL = path.join(dir, 'ggml-large-v3-q5_0.bin');
    assert.equal(path.basename(whisperModel(dir)), 'ggml-large-v3-q5_0.bin', 'chosen explicitly');
    delete process.env.ECHO_WHISPER_MODEL;
  } finally {
    if (saved !== undefined) process.env.ECHO_WHISPER_MODEL = saved;
  }
});

test('spelled-out letters a letter or two off still find the project or contact', async () => {
  const { matchSpelled, applySpelling, spelledWords, editDistance } = await import('../lib/correct.js');
  assert.equal(editDistance('marold', 'marigold'), 2);
  assert.equal(matchSpelled('FDBOWL', ['Foodbowl', 'FitTrack']), 'Foodbowl', 'two letters dropped');
  assert.equal(matchSpelled('CRDZ', ['Cardz']), 'Cardz', 'one letter off a short name');
  assert.equal(matchSpelled('SSICIO', ['Foodbowl', 'Cardz']), null, 'too far from anything: stays as spelled');
  assert.equal(matchSpelled('CARDS', ['Cardz', 'Carda']), null, 'two equally close names: no guess');
  assert.deepEqual(spelledWords('It is F-O-D-B-O-W-L.', ['Foodbowl']).map((s) => s.word), ['Foodbowl']);
  // What happened: a project name spelled out letter by letter was misheard. Now the letters find the project.
  assert.equal(applySpelling('I mean Fudbowel project. F-O-D-B-O-W-L.', ['Foodbowl']).text, 'I mean Foodbowl project. F-O-D-B-O-W-L.');
  assert.equal(applySpelling('Its Tavis, T-A-V-I-S-H.', ['Foodbowl']).text, 'Its Tavish, T-A-V-I-S-H.', 'unknown names keep the spelling');
});

test('a project the user did not say is never swapped in: the words stay, and what they may be is a hint', async () => {
  const { hearAsSaid } = await import('../lib/correct.js');
  fs.writeFileSync(path.join(dirs.data, 'projects.json'), JSON.stringify({ aliases: { 'food bowl': 'Foodbowl' }, hidden: [], descriptions: {} }));
  // What happened once: "Okeshoe Project" was turned into another project that sounds nothing like it.
  const a = hearAsSaid("Check what's going on on Okayshow Project.");
  assert.equal(a.text, "Check what's going on on Okayshow Project.", 'the raw words stay');
  assert.equal(a.hints.some((h) => h.maybe === 'FitTrack'), false, 'and nothing that sounds unlike it is suggested');
  const b = hearAsSaid('Open the gadget folder');
  assert.equal(b.text, 'Open the gadget folder', 'a learned mishearing is not replaced any more');
  assert.deepEqual(b.hints, [{ heard: 'gadget', maybe: 'Budget2', why: 'learned' }], 'it is a hint for the assistant');
  const c = hearAsSaid('We live in hoe broken');
  assert.equal(c.text, 'We live in hoe broken', 'nor is one that is not an everyday word');
  assert.deepEqual(c.hints.map((h) => h.maybe), ['Hoboken']);
});
