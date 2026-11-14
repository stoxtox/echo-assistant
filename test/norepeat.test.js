// Echo does not say its last answer again when what it hears next is unclear (lib/norepeat.js).
// Oct 11, 2026: Gujarati heard as English nonsense, a laugh and half-sentences each got the last
// answer said again ("Kem cho! Majama…" twice, "I've made my move" three times).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.js';

sandbox('norepeat');
const { unclearAfterAnswer, askedAgain, noRepeatNote, mayStayQuiet, REPEAT_WINDOW_MS, UNCLEAR_NOTE } = await import('../lib/norepeat.js');
const { Dispatcher } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');

const said = 'Kem cho! Majama? That means: hi, all good.';

test('words that make no sense, a written sound or a filler right after an answer are unclear', () => {
  const o = { lastReply: said, sinceMs: 4000 };
  assert.equal(unclearAfterAnswer('Somewhere bowl, Akbar', o), 'odd', 'a short line with a word nothing explains');
  assert.equal(unclearAfterAnswer('Biju Kaho Ke', o), 'foreign');
  assert.equal(unclearAfterAnswer('Enna Munna', o), 'foreign');
  assert.equal(unclearAfterAnswer('*laughter*', o), 'noise');
  assert.equal(unclearAfterAnswer('Oh, okay.', o), 'noise');
  assert.equal(unclearAfterAnswer('Hmm', o), 'noise');
});

test('a real request, an ask to hear it again, an answer to a question, or a late message are not', () => {
  const o = { lastReply: said, sinceMs: 4000 };
  assert.equal(unclearAfterAnswer('Put on the Dog Man movie', o), '');
  assert.equal(unclearAfterAnswer('Which movie is this?', o), '');
  assert.equal(unclearAfterAnswer('Say that again', o), '', 'then saying it again is the answer');
  assert.equal(unclearAfterAnswer('Sorry, I did not catch that', o), '');
  assert.equal(unclearAfterAnswer('Okay', { lastReply: 'Should I play the trailer?', sinceMs: 4000 }), '', 'after a question, okay is an answer');
  assert.equal(unclearAfterAnswer('Right. Right.', { lastReply: 'Should I start the trial, or play the free trailer?', sinceMs: 2000 }), '');
  assert.equal(unclearAfterAnswer('Enna Munna', { lastReply: said, sinceMs: REPEAT_WINDOW_MS + 1 }), '', 'not right after the answer');
  assert.equal(unclearAfterAnswer('Enna Munna', { lastReply: '', sinceMs: 1000 }), '', 'nothing was answered yet');
  assert.equal(unclearAfterAnswer('Kem cho', { lastReply: said, sinceMs: 3000 }), '', 'words Echo itself just used are not odd');
});

test('the note: the answer stands; ask once, then stay quiet', () => {
  assert.equal(askedAgain("I only caught part of that. Could you say it again, a little slower?"), true);
  assert.equal(askedAgain('Storks is playing now.'), false);
  const first = noRepeatNote('foreign', false);
  assert.ok(first.startsWith(UNCLEAR_NOTE));
  assert.match(first, /do NOT say it again, in the same or other words/);
  assert.match(first, /ask once, in five words or fewer/);
  assert.match(noRepeatNote('noise', true), /You already asked them to say it again, so reply with exactly \[quiet\]/);
  // A line that may be a real request with a name in it is never offered silence.
  assert.doesNotMatch(noRepeatNote('odd', true), /\[quiet\]/);
  assert.deepEqual(['foreign', 'noise', 'odd', ''].map(mayStayQuiet), [true, true, false, false]);
  assert.equal(unclearAfterAnswer('Eco meet my nephew, his name is Ryan', { lastReply: said, sinceMs: 3000 }), '', 'a misheard "Echo" is not an odd word');
});

test('a spoken unclear message right after an answer carries the note and may be left unanswered; a typed one does not', () => {
  const d = new Dispatcher(new TaskManager({ queryFn: async function* () {} }));
  const pushed = [];
  d.input = /** @type {any} */ ({ push: (body) => pushed.push(typeof body === 'string' ? body : body.at(-1).text), size: 0, close() {} });
  d.lastReply = said;
  d.lastSpeechEnd = Date.now() - 3000;
  d.send('Biju Kaho Ke', { raw: 'Biju Kaho Ke' });
  assert.match(pushed.at(-1), /\(unclear after your answer\): these words may be a mishearing/);
  assert.equal(d.turn?.mayQuiet, true, 'a "[quiet]" to it is taken as silence, not asked again');
  d.setBusy(false);
  d.turn = null;
  d.lastReply = said;
  d.lastSpeechEnd = Date.now() - 3000;
  d.send('Somewhere bowl, Akbar');
  assert.doesNotMatch(pushed.at(-1), /unclear after your answer/, 'typed words are what they are');
  d.setBusy(false);
  d.turn = null;
  d.lastReply = said;
  d.lastSpeechEnd = Date.now() - 3000;
  d.send('Play the free trailer', { raw: 'Play the free trailer' });
  assert.doesNotMatch(pushed.at(-1), /unclear after your answer/);
  assert.match(d.systemPrompt(), /your answer stands, so ask what they said in a few words, once/);
  clearTimeout(d.heldTimer);
  clearTimeout(d.rotateTimer);
});
