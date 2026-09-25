import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, fakeQuery, result } from './helpers.js';

const dirs = sandbox('speech');
for (const name of ['Foodbowl', 'Budget2', 'FitTrack', 'Cardz']) fs.mkdirSync(path.join(dirs.projects, name), { recursive: true });
// A fresh install has no personal vocabulary, so seed one like a user would build up.
fs.writeFileSync(path.join(dirs.data, 'vocabulary.json'), JSON.stringify({
  words: ['Echo', 'Claude', 'Sam', 'Maya', 'Hoboken', 'Riverside', 'AMC', 'pho', 'bibimbap'],
  corrections: {
    football: 'Foodbowl',
    gadget: 'Budget2',
    'white soaps': 'VoiceOps',
    emc: 'AMC',
    'hoe broken': 'Hoboken',
    'residential evil': 'Resident Evil',
    cards: 'Cardz',
    'they eat 31': '8:30',
  },
}));
const V = await import('../lib/vocab.js');
const { mergeTokens, uncertainWords, resolveEngine, sttLanguageFor, whisperForm, whisperArgs, deepgramParams } = await import('../lib/stt.js');
const { getSettings, saveSettings } = await import('../lib/settings.js');
const { Corrector, diffWords, isGuess } = await import('../lib/correct.js');

test('vocabulary includes project names, your words, and learned fixes', () => {
  const terms = V.vocabularyTerms();
  for (const t of ['Foodbowl', 'Budget2', 'Sam', 'Hoboken', 'pho', 'bibimbap', 'Resident Evil']) assert.ok(terms.includes(t), t);
  assert.ok(terms.indexOf('Foodbowl') < terms.indexOf('Sam'), 'projects first');
  assert.match(V.whisperPrompt(), /^Glossary: .*Foodbowl/);
  assert.ok(V.whisperPrompt().length <= 700);
});

test('instant fixes only touch safe phrases; everyday words wait for context', () => {
  const r = V.applyCorrections('We live in hoe broken. Book Residential Evil at EMC, they eat 31. Where is the gadget? Open white soaps.');
  assert.equal(r.text, 'We live in Hoboken. Book Resident Evil at AMC, 8:30. Where is the gadget? Open VoiceOps.');
  const { hints } = V.correctionSets();
  assert.equal(hints.gadget, 'Budget2');
  assert.equal(hints.football, 'Foodbowl');
  assert.equal(hints.cards, 'Cardz', 'plurals of real words are real words');
});

test('learning a correction saves it and adds the word to the vocabulary', () => {
  V.learnCorrection('foe', 'pho');
  V.learnCorrection('bee bim bop', 'bibimbap');
  V.learnCorrection('ramon', 'ramen');
  assert.equal(V.loadVocab().corrections.foe, 'pho');
  assert.ok(V.loadVocab().words.includes('ramen'), 'new word joins the vocabulary');
  assert.equal(V.applyCorrections('two bee bim bop please').text, 'two bibimbap please');
  assert.equal(V.applyCorrections('my old foe is here').text, 'my old foe is here', '"foe" is a real word: context only');
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

test('diff finds what the corrector changed, and loose guesses are flagged', () => {
  const d = diffWords('Where can we get foe and water bottle near Riverside?', 'Where can we get pho and bibimbap near Riverside?');
  assert.deepEqual(d, [{ heard: 'foe', meant: 'pho' }, { heard: 'water bottle', meant: 'bibimbap' }]);
  assert.equal(isGuess({ heard: 'water bottle', meant: 'bibimbap' }), true);
  assert.equal(isGuess({ heard: 'Maia', meant: 'Maya' }), false);
  assert.equal(isGuess({ heard: 'football', meant: 'Foodbowl' }), false);
  assert.equal(isGuess({ heard: '8.30', meant: '8:30' }), false);
});

test('the corrector applies instant fixes, then the model, and reports guesses as unsure', async () => {
  const fq = fakeQuery(async (turn, text) => {
    assert.match(text, /Transcript to fix: Find Resident Evil at AMC and some belly and water bottle/);
    return [result(JSON.stringify({ text: 'Find Resident Evil at AMC and some pho and bibimbap', unsure: [] }))];
  });
  const c = new Corrector({ queryFn: fq.queryFn });
  const out = await c.correct('Find residential evil at EMC and some belly and water bottle');
  assert.equal(out.text, 'Find Resident Evil at AMC and some pho and bibimbap');
  assert.deepEqual(out.unsure, ['pho', 'bibimbap'], 'loose sound matches get confirmed');
  assert.ok(out.changes.some((ch) => ch.heard === 'residential evil'));
  assert.ok(fq.calls[0].options.systemPrompt.includes('Indian accent'));
  assert.equal(fq.calls[0].options.thinking.type, 'disabled', 'no thinking: keeps it ~1s');
  c.stop();
});

test('the corrector never lets the model answer instead of correcting, and falls back on timeout', async () => {
  const chatty = fakeQuery(() => [result(JSON.stringify({ text: 'Sure! Here are ten great restaurants in Riverside that serve amazing street food, starting with...' }))]);
  const c = new Corrector({ queryFn: chatty.queryFn });
  const out = await c.correct('find food in Riverside');
  assert.equal(out.text, 'find food in Riverside');
  c.stop();

  const slow = fakeQuery(() => new Promise(() => {}));
  const c2 = new Corrector({ queryFn: slow.queryFn });
  c2.timeoutMs = 50;
  const out2 = await c2.correct('we live in hoe broken');
  assert.equal(out2.text, 'we live in Hoboken', 'instant fixes still apply');
  assert.equal(out2.timedOut, true);
  c2.stop();
});

test('speech recognition is locked to English for every engine', () => {
  assert.equal(getSettings().sttLanguage, 'en-IN', 'Indian English by default');
  for (const setting of ['en-IN', 'en-US', 'en', 'es', undefined]) {
    assert.equal(sttLanguageFor('whisper', setting), 'en');
    assert.match(sttLanguageFor('deepgram', setting), /^en(-IN|-US)?$/);
    assert.match(sttLanguageFor('browser', setting), /^en-(IN|US)$/);
  }
  assert.equal(sttLanguageFor('deepgram', 'en-US'), 'en-US');
  assert.equal(sttLanguageFor('deepgram', 'es'), 'en-IN');
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
  assert.equal(deepgramParams(undefined).get('language'), 'en-IN', 'never undefined');
  assert.ok(!deepgramParams('en-US').has('detect_language'));
});

test('the language setting only accepts English accents', () => {
  assert.equal(saveSettings({ sttLanguage: 'es' }).sttLanguage, 'en-IN');
  assert.equal(saveSettings({ sttLanguage: 'en-US' }).sttLanguage, 'en-US');
  assert.equal(saveSettings({ sttLanguage: 'en' }).sttLanguage, 'en', 'older saved setting still works');
  fs.writeFileSync(path.join(dirs.data, 'settings.json'), JSON.stringify({ sttLanguage: 'multi' }));
  assert.equal(getSettings().sttLanguage, 'en-IN', 'a hand-edited file cannot switch languages');
});

test('spelled-out names always win, and the corrector never swaps in the user\'s own name or over a contact', async () => {
  const { guardCorrection, spelledWords, applySpelling } = await import('../lib/correct.js');
  saveSettings({ userName: 'Sam Lee' });
  fs.writeFileSync(path.join(dirs.data, 'contact-aliases.json'), JSON.stringify({ 'priya aunty': { alias: 'Priya Aunty', name: 'Priya Shah', id: 'c1', handle: '+15555550100', label: 'mobile' } }));

  assert.deepEqual(spelledWords("It's T-A-V-I-S-H.").map((s) => s.word), ['Tavish']);
  assert.deepEqual(spelledWords('I think a cat is here').map((s) => s.word), [], 'ordinary words are not spelling');
  assert.equal(applySpelling('Its Tavis, T-A-V-I-S-H.').text, 'Its Tavish, T-A-V-I-S-H.', 'the spelling fixes the spoken word');

  // What really happened: the model turned a spoken and spelled name into the user's name.
  const fq = fakeQuery((turn, text) => {
    if (/Tavish Uncle/.test(text)) return [result(JSON.stringify({ text: "Yeah, it's Sam Uncle.", unsure: ['Sam'] }))];
    if (/T-A-V-I-S-H/.test(text)) return [result(JSON.stringify({ text: "It's a Sam, you heard that right. It's S-A-M.", unsure: [] }))];
    if (/Priya/.test(text)) return [result(JSON.stringify({ text: 'Text Maya that I am late', unsure: [] }))];
    return [result(JSON.stringify({ text: 'we live in Hoboken', unsure: [] }))];
  });
  const c = new Corrector({ queryFn: fq.queryFn });
  const a = await c.correct("Yeah, it's Tavish Uncle.");
  assert.equal(a.text, "Yeah, it's Tavish Uncle.");
  assert.ok(!a.unsure.includes('Sam'));
  const b = await c.correct("It's a Tavish, you heard that right. It's a T-A-V-I-S-H.");
  assert.equal(b.text, "It's a Tavish, you heard that right. It's a T-A-V-I-S-H.");
  assert.ok(b.rejected?.length);
  const d = await c.correct('Text Priya that I am late');
  assert.equal(d.text, 'Text Priya that I am late', 'a contact name is never replaced');
  const prompt = fq.calls[0].options.systemPrompt;
  assert.match(prompt, /spelled out/);
  assert.match(prompt, /Priya Shah/);
  assert.doesNotMatch(prompt.match(/Vocabulary[^\n]*/)[0], /\bSam\b/, "the user's own name isn't offered as vocabulary");
  c.stop();

  // Vocabulary words stay, real fixes still go through, and the user's name is fine when it sounds right.
  assert.equal(guardCorrection('call Maya about the gadget', 'call Mia about the Budget2', { terms: ['Maya'], own: [] }).text, 'call Maya about the Budget2');
  assert.equal(guardCorrection('this is Sem speaking', 'this is Sam speaking', { terms: [], own: ['Sam'] }).text, 'this is Sam speaking');
  assert.equal(guardCorrection('ask Tavish', 'ask Sam', { terms: [], own: ['Sam'] }).text, 'ask Tavish');
});
