// Oct 8, 2026, evening: Echo answered about twenty sentences of a talk in another language beside
// the Mac (each "I didn't catch that" reopened the window), ignored "the Echo app" three times,
// sent an instruction to another assistant unread, gave a Friday reset as "tonight", lost its
// place among three chats, and could not copy the conversation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sandbox } from './helpers.js';

const dirs = sandbox('oct8evening');
const { judgeAddressee, soundsForeign } = await import('../lib/addressed.js');
const { spokenMode, notToEcho, onlyDidntCatch, modeLine, UNCLEAR_RESTS_AFTER } = await import('../lib/listenmode.js');
const { decideUtterance } = await import('../lib/pipeline/utterance.ts');
const { classifyAction } = await import('../lib/agent/risk.js');
const { Dispatcher, resetWhen } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');
const { computerPrompt } = await import('../lib/computer.js');
const { getSettings } = await import('../lib/settings.js');
const { said } = await import('../lib/transcript.ts');
const { sessionLines, asText, copyConversation } = await import('../lib/copytalk.js');

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const OWNER = { clip: { level: 0.05, voicedMs: 900 }, ownerDb: -26 };

test('sounds written down as words are another language, and are left alone; names the user uses are not', () => {
  const context = ['User: check the Stoxtox chat', 'Assistant: The Fortuna dashboard is done'];
  for (const t of ['Kabadi Paji Amar Kaam karo zaroori Ne', 'Barabar', 'Saru Chalo', 'Subolah.', 'Rajaji', 'Patana thodi']) assert.equal(soundsForeign(t, context), true, t);
  for (const t of ['open my calendar', 'Stoxtox daily errors', 'Fortuna dashboard', 'Bless you', 'What do you suggest?', 'Yes', '99']) assert.equal(soundsForeign(t, context), false, t);
  const live = { clarity: /** @type {const} */ ('ok'), followUp: true, sinceReplyMs: 5000, ...OWNER };
  assert.deepEqual(judgeAddressee({ ...live, text: 'Saru Chalo' }), { confidence: 0.05, decision: 'ignore', why: 'not_english' }, 'even in a live conversation');
  // Echo asked for a name: one odd word is an answer.
  assert.equal(judgeAddressee({ ...live, text: 'Rajaji', awaitingAnswer: true, question: 'Who should I send it to?' }).decision, 'accept');
});

test('a reply that only says "I didn\'t catch that" opens no window, and two in a row rest Echo', async () => {
  for (const r of ['I didn\'t quite catch that. Something about "hyper tough"? Could you say it again?', 'I caught "koi number", but not the rest. Can you say it again, maybe in English?', "Sorry, I'm not getting what you're saying clearly. Could you try once more?", 'I heard "bahar", outside. Are you heading out?']) assert.equal(onlyDidntCatch(r), true, r);
  for (const r of ["Yes, I'm here and listening.", 'Prepare what? Tell me what you want me to get ready.', 'The dashboard chat finished its work and is waiting for you to say merge.', '']) assert.equal(onlyDidntCatch(r), false, r);
  const judge = async (o) => judgeAddressee(o);
  const u = (text) => ({ text, page: { mode: 'hands-free', sinceReplyMs: 4000 }, clarity: /** @type {const} */ ('ok'), loud: null, quiet: false, mediaPlaying: false, clip: { ms: 1500, level: 0.05, voicedMs: 900 }, ownerDb: -26 });
  const base = { driving: false, busy: false, pendingCards: 0, pendingMessages: 0, lessonActive: false, wakeWord: true, sinceReplyMs: 4000, now: Date.now() };
  const after = (reply) => ({ ...base, recent: ['User: something', `Assistant: ${reply}`] });
  // After a real answer, the next clear sentence is part of the conversation.
  assert.equal((await decideUtterance(u('and what about the other one'), after('The first file is saved on the Desktop.'), { judge })).kind, 'deliver');
  // After "I didn't catch that", the same sentence is not: the window is closed, and its name is needed.
  const unclear = after("I didn't catch that. Could you say it again?");
  assert.equal((await decideUtterance(u('and what about the other one'), unclear, { judge })).kind, 'drop');
  assert.equal((await decideUtterance(u('Echo, what about the other one'), unclear, { judge })).kind, 'deliver');
  const server = read('server.js');
  assert.match(server, /unclearRun = onlyDidntCatch\(dispatcher\.lastReply\) \? unclearRun \+ 1 : 0;/);
  assert.match(server, /if \(unclearRun >= UNCLEAR_RESTS_AFTER && getSettings\(\)\.listenMode === 'listening'\) \{/);
  assert.equal(UNCLEAR_RESTS_AFTER, 2);
  assert.match(modeLine('resting', 'unclear'), /^Resting: I couldn't follow/);
});

test('"shhh" and "I wasn\'t talking to you" rest Echo, and what it overheard is forgotten', () => {
  for (const t of ['Shhh.', 'shush', 'Hush now', "I wasn't talking to you. I was talking to my wife echo.", 'I was speaking with my wife. She just called me back.', 'not you', "that wasn't for you"]) assert.equal(spokenMode(t), 'resting', t);
  for (const t of ['tell me what you were talking about', 'she said it was not for you to decide which of the many options we looked at last week would be the right one for us', 'show me the shh command']) assert.equal(spokenMode(t), null, t);
  assert.equal(notToEcho("I wasn't talking to you"), true);
  assert.equal(notToEcho('Shhh'), false, 'a shush rests it, but nothing was said about what came before');
  assert.match(read('lib/server/speech.js'), /if \(notToEcho\(verdict\.said\)\) dispatcher\.noteForNext\('\(The user says the last things you heard were not said to you/);
});

test('"the Echo app" is Echo itself, not a device', () => {
  const run = { clarity: /** @type {const} */ ('ok'), driving: true, followUp: true };
  for (const t of ['Alright now, can you go back to the echo app and copy all the', 'I want you to go to the echo application and copy the whole session', 'copy the echo session we just had', 'open the echo window']) assert.equal(judgeAddressee({ ...run, text: t }).decision, 'accept', t);
  assert.equal(judgeAddressee({ ...run, text: 'turn on the echo dot' }).why, 'device');
  assert.equal(judgeAddressee({ ...run, text: "there's an echo in this room" }).why, 'device');
});

test('what Echo writes for the user goes past them first: a standing instruction, and Return in an assistant\'s chat asks', () => {
  const d = new Dispatcher(new TaskManager({ queryFn: async function* () {} }));
  const prompt = d.systemPrompt();
  assert.match(prompt, /read out exactly what you are about to send and wait for their yes, every time, unless they dictated the exact words/);
  assert.match(prompt, /don't ask for the same yes again in words/);
  assert.match(prompt, /Keep the thread\./);
  for (const app of ['Claude', 'ChatGPT']) {
    assert.deepEqual(classifyAction({ action: 'press_keys', keys: 'return', resolved: { app, field: 'Prompt' } }).category, 'send', app);
    assert.equal(classifyAction({ action: 'type_text', text: 'Free up space in Supabase', resolved: { app, field: 'Prompt' } }).level, 'ok', 'typing it is not sending it');
  }
  const recipes = computerPrompt({ ...getSettings(), computerUse: true, pointer: true });
  assert.match(recipes, /type_text the question into "Prompt" \(the message box; an older Claude calls it "Write your prompt to Claude"/);
  assert.match(recipes, /read the user exactly what you typed; then press return, which sends it, so it waits for the user's yes/);
  // One command, one yes: the yes to typing it in Terminal covers the Return that runs it.
  assert.match(read('lib/computer.js'), /const CARRIES = new Set\(\['send', 'submit', 'delete', 'close', 'save', 'share_screen', 'terminal'\]\);/);
});

test('a reset time is said with its day', () => {
  const now = new Date(2026, 9, 8, 20, 0).getTime();
  assert.equal(resetWhen(new Date(2026, 9, 8, 21, 50).getTime(), now), 'today at 9:50 PM');
  assert.equal(resetWhen(new Date(2026, 9, 9, 23, 0).getTime(), now), 'tomorrow at 11:00 PM');
  assert.equal(resetWhen(new Date(2026, 9, 11, 23, 0).getTime(), now), 'on Sunday at 11:00 PM');
  assert.match(resetWhen(new Date(2026, 9, 20, 9, 0).getTime(), now), /^on Tuesday, October 20 at 9:00 AM$/);
  assert.match(read('lib/dispatcher.js'), /Don't bring this up by yourself in the middle of something else/);
});

test('"copy this conversation" puts the session so far on the clipboard, as plain text', async () => {
  const now = Date.now();
  said('you', 'said', 'an old question from this morning', {}, { now: now - 5 * 3_600_000 });
  said('echo', 'spoke', 'An old answer.', {}, { now: now - 5 * 3_600_000 + 2000 });
  said('you', 'said', 'what is going on in the Claude app', {}, { now: now - 120_000 });
  said('echo', 'step', 'Checking the Claude app.', {}, { now: now - 118_000 });
  said('echo', 'spoke', 'Claude finished the daily check.', {}, { now: now - 110_000 });
  said('echo', 'spoke', 'It found one problem.', {}, { now: now - 108_000 });
  said('echo', 'shown', 'Claude finished the daily check. It found one problem.', {}, { now: now - 107_000 });
  said('you', 'typed', 'ok', {}, { now: now - 60_000 });
  let copied = '';
  const r = await copyConversation({ now, copy: async (t) => ((copied = t), true) });
  assert.deepEqual([r.ok, r.lines], [true, 3]);
  assert.equal(copied, 'You: what is going on in the Claude app\nEcho: Checking the Claude app. Claude finished the daily check. It found one problem.\nYou: ok');
  assert.equal((await copyConversation({ now, minutes: 1.5, copy: async () => true })).lines, 1, 'or only the last few minutes');
  assert.equal(asText(sessionLines([], { now })), '');
  const d = new Dispatcher(new TaskManager({ queryFn: async function* () {} }));
  assert.ok(d.allTools().find((t) => t.name === 'copy_conversation'));
  void dirs;
});
