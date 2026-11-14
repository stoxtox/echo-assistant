// "Is this for me?" gate decisions, with the real phrases from Sept 28 2026.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sandbox } from './helpers.js';

sandbox('addressed');
const { midRunGate, addressedToEcho, looksLikeCommand, isImperative, heardClearly, inUserLanguage, continuesTopic } = await import('../lib/addressed.js');

// Background speech and TV fragments that cancelled clicks mid-run.
const NOISE = ['Memory', 'And then what is it?', 'Katoly, Sam', 'Kadi Pachi', 'Q. A. L. A.'];
// Real mid-run commands.
const COMMANDS = ['Open YouTube', 'scroll down', 'go back', 'Click the first video', 'search for lofi music', 'can you play the next one', 'okay now type hello'];

test('mid-run: background talk and TV fragments are ignored, not treated as commands', () => {
  for (const text of NOISE) assert.deepEqual(midRunGate({ text, clarity: 'ok' }), { accept: false, why: 'not_a_command' }, text);
});

test('mid-run: clear spoken commands get through', () => {
  for (const text of COMMANDS) assert.deepEqual(midRunGate({ text, clarity: 'ok' }), { accept: true, why: 'command' }, text);
  // No scores (live text) still counts; badly heard does not.
  assert.equal(midRunGate({ text: 'scroll down' }).accept, true);
  assert.equal(midRunGate({ text: 'scroll down', clarity: 'low' }).accept, false);
});

test('mid-run: "stop" always wins; "Echo…" and "wait…" are always for her', () => {
  for (const text of ['stop', 'Stop!', 'Echo, stop', 'okay stop', 'cancel']) assert.equal(midRunGate({ text, clarity: 'low' }).why, 'stop', text);
  assert.deepEqual(midRunGate({ text: 'Echo, what is on screen?', clarity: 'low' }), { accept: true, why: 'name' });
  assert.deepEqual(midRunGate({ text: 'wait, not that one' }), { accept: true, why: 'name' });
  assert.deepEqual(midRunGate({ text: 'hey Echo memory' }), { accept: true, why: 'name' });
});

test('mid-run: a pending question lets a plain answer through', () => {
  assert.deepEqual(midRunGate({ text: 'the second one', clarity: 'ok', pendingQuestion: true }), { accept: true, why: 'answer' });
  assert.deepEqual(midRunGate({ text: 'yes', pendingQuestion: true }), { accept: true, why: 'answer' });
  assert.equal(midRunGate({ text: 'the second one', clarity: 'ok' }).accept, false);
  assert.equal(midRunGate({ text: 'Kadi Pachi', clarity: 'low', pendingQuestion: true }).accept, false);
});

test('hands-free: the dropped Sept 28 command is flagged as a real command; noise is not', () => {
  assert.equal(looksLikeCommand('Open YouTube.', 'ok'), true);
  assert.equal(looksLikeCommand('Can you open YouTube for me?', 'unknown'), true);
  for (const text of NOISE) assert.equal(looksLikeCommand(text, 'ok'), false, text);
  assert.equal(looksLikeCommand('Open YouTube', 'low'), false);
});

test('hands-free: name, the follow-up window, and on-topic speech count as for Echo', () => {
  assert.deepEqual(addressedToEcho({ text: 'Echo, open YouTube' }), { ok: true, why: 'name' });
  assert.deepEqual(addressedToEcho({ text: 'open YouTube', followUp: true }), { ok: true, why: 'follow_up' });
  const context = ['User: find me some lofi playlists on YouTube', 'Assistant: I found three lofi playlists on YouTube. Want me to open one?'];
  assert.deepEqual(addressedToEcho({ text: 'open the second lofi playlist', sinceReplyMs: 60_000, context, clarity: 'ok' }), { ok: true, why: 'topic' });
  // Off-topic, too late, or TV talk: not for her.
  assert.equal(addressedToEcho({ text: 'open the second lofi playlist', sinceReplyMs: 10 * 60_000, context }).ok, false);
  assert.equal(addressedToEcho({ text: 'open YouTube', sinceReplyMs: 24_000, context: [] }).ok, false);
  for (const text of NOISE) assert.equal(addressedToEcho({ text, sinceReplyMs: 20_000, context, clarity: 'ok' }).ok, false, text);
  assert.equal(continuesTopic('Memory', ['Assistant: your memory settings are saved']), false);
});

test('helpers: imperative, clarity and language checks', () => {
  assert.equal(isImperative('Memory'), false);
  assert.equal(isImperative('and then open it'), true);
  assert.equal(heardClearly({ segments: [{ lp: -0.2 }, { lp: -0.4 }] }), 'ok');
  assert.equal(heardClearly({ segments: [{ lp: -0.9 }] }), 'low');
  assert.equal(heardClearly({ words: [{ p: 0.9 }] }), 'ok');
  assert.equal(heardClearly({ segments: [] }), 'unknown');
  assert.equal(inUserLanguage('Q. A. L. A.'), false);
  assert.equal(inUserLanguage('открой ютуб'), false);
  assert.equal(inUserLanguage('open YouTube'), true);
});

test('answer window: plain answers need no "Echo"; TV, other languages and long unrelated talk are left alone', async () => {
  const { answerGate, ANSWER_MAX_WORDS } = await import('../lib/addressed.js');
  const context = ['User: find somewhere for dinner', 'Assistant: I found two Italian places near you. Should I book the first one?'];
  for (const text of ['yes', 'Yeah.', 'no thanks', 'the second one', 'sure, go ahead', 'Book the other Italian place instead']) {
    assert.equal(answerGate({ text, clarity: 'ok', context }).accept, true, text);
  }
  // Faintly heard: a short answer still counts, anything else doesn't.
  assert.deepEqual(answerGate({ text: 'yes', clarity: 'low', context }), { accept: true, why: 'answer' });
  assert.equal(answerGate({ text: 'and then what is it', clarity: 'low', context }).accept, false);
  // "Stop" and her name always get through.
  assert.equal(answerGate({ text: 'stop', clarity: 'low' }).why, 'stop');
  assert.equal(answerGate({ text: 'Echo, never mind that', clarity: 'low' }).why, 'name');
  // Another language, spelled-out letters, a long stretch of unrelated talk.
  assert.equal(answerGate({ text: 'открой ютуб', clarity: 'ok' }).accept, false);
  assert.equal(answerGate({ text: 'Q. A. L. A.', clarity: 'ok' }).accept, false);
  const monologue = 'and the weather tonight is going to stay mild across most of the region with a chance of showers moving in from the west later tomorrow afternoon';
  assert.ok(monologue.split(' ').length > ANSWER_MAX_WORDS);
  assert.deepEqual(answerGate({ text: monologue, clarity: 'ok', context }), { accept: false, why: 'not_for_echo' });
  // A longer answer that stays on topic is fine.
  assert.equal(answerGate({ text: `${monologue} but actually book the first Italian place for dinner at eight`, clarity: 'ok', context }).accept, true);
});

test('answer window: the server gates it, and a drop is reported like hands-free', () => {
  // The gates live in lib/pipeline/utterance.ts (the server hands every sentence to it).
  const pipeline = fs.readFileSync(new URL('../lib/pipeline/utterance.ts', import.meta.url), 'utf8');
  assert.match(pipeline, /mode === 'answer' \|\| mode === 'run'\) \{\s*const judged = await judge\(/);
  assert.match(pipeline, /log: \{ event: 'not_for_echo', mode, window: 'closed'/);
});
