// Whose voice is it (lib/voicelevel.js): the owner's usual level, learned from clips that were
// certainly theirs, and what a clip's sound says against it being them. The numbers are from the
// Oct 2 session where a phone in the room was taken as the user six times in seven minutes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';

const dirs = sandbox('voicelevel');
const { voiceLevels, ownerLevelDb, notTheOwner, atOwnerLevel, levelDb, OWNER_MARGIN_DB, OWNER_NEAR_DB, BRIEF_VOICED_MS, OWNER_MIN_CLIPS, OWNER_KEEP, LEARN_MIN_VOICED_MS } = await import('../lib/voicelevel.js');
const { judgeAddressee } = await import('../lib/addressed.js');

const OWNER = [0.047, 0.052, 0.061, 0.068, 0.076]; // loudness (rms) of the owner's sentences
const PHONE = [[0.005, 160], [0.006, 420], [0.007, 640], [0.008, 900], [0.009, 1140]]; // rms, voiced ms

test('the constants say what they are for', () => {
  assert.equal(OWNER_MARGIN_DB, 12);
  assert.equal(BRIEF_VOICED_MS, 600);
  assert.ok(OWNER_MIN_CLIPS >= 3 && OWNER_KEEP >= OWNER_MIN_CLIPS && LEARN_MIN_VOICED_MS > 0);
});

test('the owner\'s level is the middle of the certain clips, and unknown with too few', () => {
  assert.equal(ownerLevelDb([]), null);
  assert.equal(ownerLevelDb(OWNER.slice(0, OWNER_MIN_CLIPS - 1).map(levelDb)), null, 'two clips are not a habit');
  const db = ownerLevelDb(OWNER.map(levelDb));
  assert.equal(db, +levelDb(0.061).toFixed(1));
  // One shout or one whisper doesn't move it.
  assert.equal(ownerLevelDb([...OWNER, 0.6].map(levelDb)), +((levelDb(0.061) + levelDb(0.068)) / 2).toFixed(1));
});

test('the phone is far below the owner on every clip; the owner never is', () => {
  const ownerDb = ownerLevelDb(OWNER.map(levelDb));
  for (const [level, voicedMs] of PHONE) assert.equal(notTheOwner({ level, voicedMs }, ownerDb), 'faint', `phone at ${level}`);
  for (const level of OWNER) assert.equal(notTheOwner({ level, voicedMs: 1800 }, ownerDb), null, `owner at ${level}`);
  // The owner leaning back (half as loud, 6 dB) is still the owner.
  assert.equal(notTheOwner({ level: 0.03, voicedMs: 1800 }, ownerDb), null);
  // Loud enough, but under 600 ms of voiced sound: a blip.
  assert.equal(notTheOwner({ level: 0.05, voicedMs: 300 }, ownerDb), 'brief');
  assert.equal(notTheOwner({ level: 0.05, voicedMs: BRIEF_VOICED_MS }, ownerDb), null);
});

test('with no estimate yet, or nothing measured, nothing changes', () => {
  assert.equal(notTheOwner({ level: 0.005, voicedMs: 160 }, null), null);
  assert.equal(notTheOwner({ level: 0.005, voicedMs: 160 }, undefined), null);
  assert.equal(notTheOwner(null, -24), null);
  assert.equal(notTheOwner({}, -24), null);
});

test('the judge: inside the follow-up window a phone no longer scores 0.9 whatever the sound', () => {
  const ownerDb = ownerLevelDb(OWNER.map(levelDb));
  const said = { text: 'your order has shipped and will arrive on Thursday', clarity: /** @type {const} */ ('ok'), followUp: true, sinceReplyMs: 3000 };
  assert.deepEqual(judgeAddressee(said), { confidence: 0.9, decision: 'accept', why: 'follow_up' }, 'as before, with nothing known about the sound');
  assert.deepEqual(judgeAddressee({ ...said, clip: { level: 0.007, snrDb: 33, voicedMs: 640 }, ownerDb: null }).why, 'follow_up', 'and with no estimate yet');
  for (const [level, voicedMs] of PHONE) {
    const j = judgeAddressee({ ...said, clip: { level, snrDb: 33, voicedMs }, ownerDb });
    assert.deepEqual([j.decision, j.why], ['ignore', 'faint'], `phone at ${level}`);
  }
  for (const level of OWNER) assert.equal(judgeAddressee({ ...said, clip: { level, snrDb: 54, voicedMs: 2000 }, ownerDb }).decision, 'accept', `owner at ${level}`);
  // Under 600 ms voiced with no name in it, outside any conversation, is not for Echo…
  assert.equal(judgeAddressee({ text: 'Okay so.', clip: { level: 0.05, voicedMs: 300 }, ownerDb }).why, 'brief');
  // …but her name, "stop", an answer to her question and a clear command still count.
  assert.equal(judgeAddressee({ text: 'Echo, louder', followUp: true, clip: { level: 0.006, voicedMs: 300 }, ownerDb }).why, 'name');
  assert.equal(judgeAddressee({ text: 'stop', driving: true, clip: { level: 0.006, voicedMs: 200 }, ownerDb }).why, 'stop');
  assert.equal(judgeAddressee({ text: 'Yes.', followUp: true, pendingQuestion: true, clip: { level: 0.05, voicedMs: 300 }, ownerDb }).decision, 'accept');
  assert.equal(judgeAddressee({ text: 'the second one', followUp: true, awaitingAnswer: true, question: 'The first one or the second one?', clip: { level: 0.05, voicedMs: 500 }, ownerDb }).decision, 'accept');
  assert.equal(judgeAddressee({ text: 'go back', followUp: true, driving: true, clip: { level: 0.05, voicedMs: 450 }, ownerDb }).decision, 'accept');
  // A phone saying "yes" to her question is still a phone.
  assert.equal(judgeAddressee({ text: 'Yes.', followUp: true, pendingQuestion: true, clip: { level: 0.006, voicedMs: 300 }, ownerDb }).why, 'faint');
});

test('a short clip in an open conversation is never dropped without a sign', () => {
  const ownerDb = ownerLevelDb(OWNER.map(levelDb));
  assert.equal(OWNER_NEAR_DB, 6);
  assert.equal(atOwnerLevel({ level: 0.05 }, ownerDb), true);
  assert.equal(atOwnerLevel({ level: 0.02 }, ownerDb), false, 'not faint (9.7 dB down), but not clearly the owner either');
  assert.equal(atOwnerLevel({ level: 0.05 }, null), false, 'nothing known');
  const blip = { level: 0.02, voicedMs: 300 };
  assert.equal(notTheOwner(blip, ownerDb), 'brief');
  // The short questions of a conversation ("Why?" was ignored): for Echo, at any level that isn't a phone's.
  for (const text of ['Why?', 'Really?', 'Which one?', 'And then?', 'how come']) {
    const j = judgeAddressee({ text, followUp: true, sinceReplyMs: 2000, clip: blip, ownerDb });
    assert.deepEqual([j.decision, j.why], ['accept', 'follow_up'], text);
  }
  // Real words as loud as the owner usually is: a follow-up like any other.
  assert.deepEqual(judgeAddressee({ text: 'Okay so.', followUp: true, clip: { level: 0.05, voicedMs: 300 }, ownerDb }).why, 'follow_up');
  assert.equal(judgeAddressee({ text: 'Not that one.', awaitingAnswer: true, question: 'Shall I book it?', clip: { level: 0.05, voicedMs: 400 }, ownerDb }).decision, 'accept');
  // Real words Echo can't place by their sound: asked about, not dropped.
  const unsure = judgeAddressee({ text: 'Okay so.', followUp: true, clip: blip, ownerDb });
  assert.deepEqual([unsure.decision, unsure.why], ['ask', 'brief_unsure']);
  // A sound with no word in it is still a blip, and so is anything short outside a conversation.
  assert.deepEqual(judgeAddressee({ text: 'Hmm.', followUp: true, clip: { level: 0.05, voicedMs: 300 }, ownerDb }).why, 'brief');
  assert.deepEqual(judgeAddressee({ text: 'Why?', clip: blip, ownerDb }).why, 'brief');
  // And a phone asking "Why?" is still a phone.
  assert.deepEqual(judgeAddressee({ text: 'Why?', followUp: true, clip: { level: 0.006, voicedMs: 300 }, ownerDb }).why, 'faint');
});

test('learned only from real speech, kept small in the data folder, one estimate per mic', () => {
  const v = voiceLevels(dirs.data);
  assert.equal(v.ownerDb('page'), null);
  assert.equal(v.learn('page', { voicedRms: 0.004, voicedMs: 80 }), false, 'a tapped key teaches nothing');
  for (const voicedRms of OWNER.slice(0, 2)) assert.equal(v.learn('page', { voicedRms, voicedMs: 1500 }), true);
  assert.equal(v.ownerDb('page'), null, 'not yet');
  v.learn('page', { voicedRms: OWNER[2], voicedMs: 1500 });
  assert.equal(v.ownerDb('page'), +levelDb(0.052).toFixed(1));
  assert.equal(v.ownerDb('app'), null, "the Mac app's mic is a different microphone");
  // It survives a restart, and holds only numbers.
  const file = path.join(dirs.data, 'voice-level.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(saved), ['v', 'mics']);
  assert.ok(saved.mics.page.every((x) => typeof x === 'number'));
  assert.equal(voiceLevels(dirs.data).ownerDb('page'), v.ownerDb('page'));
  // Only the newest are kept, so it follows a moved mic.
  for (let i = 0; i < OWNER_KEEP + 5; i++) v.learn('page', { voicedRms: 0.2, voicedMs: 1500 });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).mics.page.length, OWNER_KEEP);
  assert.equal(v.ownerDb('page'), +levelDb(0.2).toFixed(1));
  // Levels saved before voiced-frame loudness (whole-clip numbers, several dB lower) are learned again.
  fs.writeFileSync(file, JSON.stringify({ mics: { page: [-30, -31, -29, -30] } }));
  assert.equal(voiceLevels(dirs.data).ownerDb('page'), null);
  // A broken file starts over instead of throwing.
  fs.writeFileSync(file, '{nope');
  assert.equal(voiceLevels(dirs.data).ownerDb('page'), null);
});
