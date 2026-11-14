// What the Oct 4, 2026 session showed (14 minutes, 42 spoken turns), each with the fix it led to:
// - nine sentences got "[quiet]" back, two of them said with a key held down and one of them just
//   "Echo": a "[quiet]" to something certainly said to Echo is now a question, never silence;
// - "there you go" after "tell me when you've got it open" was treated as maybe-not-for-Echo;
// - "[model] Claude Haiku 4.5…" (one of Echo's own notes) was shown in the chat;
// - a faint "Yes" let a worker delete files: a soft yes to something risky is asked about once;
// - "Can you show me where?" in a lesson made Echo click the button ("show me"): it points now;
// - events that only confirmed what was just said got a second and third reply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, until } from './helpers.js';

const dirs = sandbox('oct4');
const { Dispatcher, NoteFilter, stripNotes, QUIET_FALLBACK, PROGRESS_PROMPT, NOTES_PROMPT, saysCant } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');
const { awaitsAnswer } = await import('../public/autolisten.js');
const { answerShaped, judgeAddressee } = await import('../lib/addressed.js');
const { softSpoken } = await import('../lib/voicelevel.js');
const { teachCommand } = await import('../lib/teach.js');
const { HelpLadder, RUNG } = await import('../lib/ladder.js');
const { computerPrompt } = await import('../lib/tools/computer.js');

const ev = (event: any) => ({ type: 'stream_event', parent_tool_use_id: null, event });
const start = (id: string) => ev({ type: 'message_start', message: { id, model: 'fake', usage: { input_tokens: 3 } } });
const textBlock = (...parts: string[]) => [ev({ type: 'content_block_start', content_block: { type: 'text' } }), ...parts.map((text) => ev({ type: 'content_block_delta', delta: { type: 'text_delta', text } })), ev({ type: 'content_block_stop' })];
const stop = ev({ type: 'message_stop' });
const whole = (id: string, text: string) => ({ type: 'assistant', parent_tool_use_id: null, message: { id, content: [{ type: 'text', text }] } });
const RESULT = { type: 'result', subtype: 'success', session_id: 's1', total_cost_usd: 0 };

/** A dispatcher whose model answers every message with `parts` (streamed in those pieces). */
function rig(...parts: string[]) {
  return rigEach([parts]);
}
/** The same, with a different answer for each message the session reads (the last one repeats). */
function rigEach(answers: string[][]) {
  let call = 0;
  for (const f of ['state.json', 'events.jsonl', 'dispatcher-timing.jsonl']) fs.rmSync(path.join(dirs.data, f), { force: true });
  const quick: any = { favorites: () => [], pendingList: () => [], osa: async () => '', mediaControl: async () => ({}) };
  const d: any = new Dispatcher(new TaskManager({ queryFn: async function* () {} } as any), null, quick);
  d.queryFn = ({ prompt }: { prompt: AsyncIterable<any> }) => {
    const q = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's1' };
      for await (const _ of prompt) {
        const parts = answers[Math.min(call++, answers.length - 1)] ?? [];
        yield start('m1');
        yield* textBlock(...parts);
        yield stop;
        yield whole('m1', parts.join(''));
        yield RESULT;
      }
    })();
    return Object.assign(q, { setModel: async () => {}, setMaxThinkingTokens: async () => {}, close() {}, interrupt: async () => {} });
  };
  const spoken: string[] = [];
  const shown: string[] = [];
  const dropped: any[] = [];
  d.on('speak', (text: string) => spoken.push(text));
  d.on('say_delta', (text: string) => shown.push(text));
  d.on('dropped', (x: any) => dropped.push(x));
  return { d, spoken, shown, dropped, calls: () => call };
}
const run = async (r: ReturnType<typeof rig>, send: (d: any) => void) => {
  r.d.start();
  await until(() => r.d.q, 1000, 'session');
  send(r.d);
  await until(() => r.d.busy, 2000, 'turn');
  await until(() => !r.d.busy, 3000, 'done');
  r.d.input.close();
};

test('a "[quiet]" to something certainly said to Echo becomes a question; one that may not be for Echo stays silent', async () => {
  // Asked once more first (the quick model called "Now, what next?" quiet three times): the
  // second answer is what the user hears, and nothing of the first is said or shown.
  const again = rigEach([['[qui', 'et]'], ['The sheet is open in Preview.']]);
  await run(again, (d) => d.send('now, what next?', { raw: 'x' }));
  assert.deepEqual(again.spoken, ['The sheet is open in Preview.']);
  assert.equal(again.shown.join(''), 'The sheet is open in Preview.');
  assert.equal(again.calls(), 2);
  assert.equal(again.dropped.length, 0, 'not a dropped sentence');

  // Quiet both times: Echo asks, it never goes silent.
  const sure = rig('[qui', 'et]');
  await run(sure, (d) => d.send('there you go', { raw: 'x' }));
  assert.deepEqual(sure.spoken, [QUIET_FALLBACK]);
  assert.equal(sure.shown.join(''), QUIET_FALLBACK);
  assert.equal(sure.calls(), 2, 'asked the model once more, not for ever');
  assert.equal(sure.dropped.length, 0, 'not a dropped sentence');

  const maybe = rig('[qui', 'et]');
  await run(maybe, (d) => d.send('and in other news tonight', { raw: 'x', mayNotBeForEcho: true }));
  assert.deepEqual(maybe.spoken, []);
  assert.equal(maybe.shown.join(''), '');
  assert.equal(maybe.dropped[0]?.reason, 'quiet');
});

test('an event that only confirms what was just said may get no reply at all', async () => {
  const r = rig('[quiet]');
  await run(r, (d) => d.notify('[task 4 stopped] stopped by the user'));
  assert.deepEqual(r.spoken, []);
  assert.equal(r.shown.join(''), '');
  assert.match(new Dispatcher(new TaskManager({ queryFn: async function* () {} } as any), null, { favorites: () => [], pendingList: () => [] } as any).systemPrompt(), /only confirms what you just told the user/);
});

test("Echo's own notes are never said or shown, however the reply is cut into pieces", async () => {
  const r = rig("The worker's on it.\n\n[mo", 'del] Claude Haiku 4.5 (claude-haiku-4-5), the quick ', 'model.');
  await run(r, (d) => d.send("that's perfect", { raw: 'x' }));
  assert.deepEqual(r.spoken, ["The worker's on it."]);
  assert.doesNotMatch(r.shown.join(''), /model|Haiku/);

  const f = new NoteFilter();
  assert.equal(f.push('(see the list) [one]') + f.flush(), '(see the list) [one]', 'ordinary brackets pass');
  assert.equal(stripNotes('Done.\n[task digest] 3 running\n(quick turn)\nNext.'), 'Done.\nNext.');
  assert.match(NOTES_PROMPT(), /never answer it with \[quiet\]/);
});

test('"[hand_off]" written as text is never shown: the main model answers the turn', async () => {
  const r = rigEach([['[hand', '_off]'], ['Looking at the Adobe Stock page now.']]);
  await run(r, (d) => d.send('can you upload it for me', { raw: 'x' }));
  assert.deepEqual(r.spoken, ['Looking at the Adobe Stock page now.']);
  assert.doesNotMatch(r.shown.join(''), /hand_off/);
  assert.equal(r.calls(), 2);
  const { friendlyError } = await import('../lib/text.js');
  assert.doesNotMatch(friendlyError('error_during_execution'), /error_/);
});

test('what was carried out survives a summary that left it out', async () => {
  const { writeSummary, doneLines, DONE_HEAD, MAX_EXCHANGES } = await import('../lib/rotation.js');
  const prev = `The user is selling trip photos.\n${DONE_HEAD}\n- 11:02 uploaded eleven photos to the stock site, waiting to be submitted`;
  const ex = [{ at: '2026-10-04T15:00:00.000Z', user: 'thanks', echo: 'Any time.', tools: [] }];
  const answer = (text: string) => async function* () { yield { type: 'result', subtype: 'success', result: text }; };
  const dropped = await writeSummary(prev, ex, { queryFn: answer('The user said thanks.') as any });
  assert.match(dropped.summary, /uploaded eleven photos/, 'the old list is kept when the model drops it');
  const kept = await writeSummary(prev, ex, { queryFn: answer(`Chatting.\n${DONE_HEAD}\n- uploaded eleven photos\n- texted a contact`) as any });
  assert.equal(doneLines(kept.summary).split('\n').length, 3);
  let seen = '';
  await writeSummary(prev, ex, { queryFn: (async function* ({ prompt }: any) { seen = prompt; yield { type: 'result', subtype: 'success', result: 'x' }; }) as any });
  assert.match(seen, /never drop one because it is finished/);
  assert.ok(MAX_EXCHANGES >= 60, 'a long session keeps its early exchanges until the summary is written');
});

test('"tell me when" waits for an answer, and "there you go" is one', () => {
  const asked = "Go ahead. Tell me when you've got it open and I'll take a look.";
  assert.equal(awaitsAnswer(asked), true);
  for (const said of ['Alright, there, you go', 'There, you go', 'Here you go', 'here it is', "it's open", 'done']) assert.equal(answerShaped(said, asked), true, said);
  assert.equal(answerShaped('there you go', 'What time is the meeting?'), false, 'only when Echo asked to be told');
  assert.equal(answerShaped('and in other news tonight', asked), false);
  const j = judgeAddressee({ text: 'Alright, there, you go', followUp: true, awaitingAnswer: true, question: asked });
  assert.equal(j.decision, 'accept');
});

test('a soft yes does not stand for something risky until it is asked about once', () => {
  const owner = -20;
  const level = (db: number) => 10 ** (db / 20);
  assert.equal(softSpoken({ level: level(-30), voicedMs: 480 }, owner, 'run'), true, '10 dB under the usual level');
  assert.equal(softSpoken({ level: level(-22), voicedMs: 480 }, owner, 'run'), false, 'a short yes at the usual level is a yes');
  assert.equal(softSpoken({ level: level(-30), voicedMs: 480 }, owner, 'push-to-talk'), false, 'a held key is their own say-so');
  assert.equal(softSpoken({ level: level(-30), voicedMs: 480 }, null, 'run'), false, 'nothing known about the owner yet');

  const d: any = rig('x').d;
  d.turn = { soft: true };
  assert.equal(d.clearYes('approval:7'), false, 'asked about first');
  assert.equal(d.clearYes('approval:7'), true, 'the answer to that question counts');
  d.turn = { soft: true };
  assert.equal(d.clearYes('approval:8'), false, 'another approval is its own question');
  d.turn = {};
  assert.equal(d.clearYes('approval:8'), true, 'a clear yes goes straight through');
  for (const f of ['lib/tools/core.js', 'lib/tools/quick.js', 'lib/tools/computer.js']) assert.match(fs.readFileSync(path.join(import.meta.dirname, '..', f), 'utf8'), /clearYes\(/, f);
});

test('"show me where" in a lesson points; only "show me" shows the step and only "do it" does it', () => {
  for (const said of ['Can you show me where?', 'show me where it is', 'where is it', 'show me which one', 'can you point']) assert.equal(teachCommand(said), 'where', said);
  assert.equal(teachCommand('show me'), 'show');
  assert.equal(teachCommand('just do it'), 'do');
  assert.equal(teachCommand('where?'), 'stuck');
  assert.equal(teachCommand('show me the rest'), 'show_all');

  const low = new HelpLadder();
  low.rung = RUNG.PROMPT;
  assert.equal(low.pointOut(0)?.to, RUNG.POINT);
  assert.equal(low.pointOut(0), null, 'already at the point: the light just goes again');
  const high = new HelpLadder();
  high.rung = RUNG.DO_PART;
  assert.equal(high.pointOut(0), null, 'never down, and never up to doing it');
  assert.match(computerPrompt({ pointer: true, computerUse: true }), /never click it for them/);
});

test('the rules: a word before the first tool, no flattery, one answer, no acting on a mishearing', () => {
  assert.match(PROGRESS_PROMPT(false), /BEFORE the first tool call/);
  assert.match(PROGRESS_PROMPT(false), /must never begin in silence/);
  const rules = (rig('x').d as any).systemPrompt();
  for (const want of [/never "Echo will/, /No flattery/, /Say a thing once/, /you misheard/, /too quiet to be sure/, /called sample every time/]) assert.match(rules, want);
});

test('a list of sources is shown and never read out', async () => {
  const reply = 'Go with 375 degrees for 12 to 15 minutes. Flip them halfway.\n\nSources:\n- [Air fryer timing](https://example.com/a)\n- [Another page](https://example.com/b)';
  const r = rig(reply.slice(0, 40), reply.slice(40, 90), reply.slice(90));
  await run(r, (d) => d.send('how long in the air fryer', { raw: 'x' }));
  const said = r.spoken.join(' ');
  assert.match(said, /375 degrees/);
  assert.match(said, /Flip them halfway/);
  assert.doesNotMatch(said, /Sources|Air fryer timing|Another page|example\.com/);
  assert.match(r.shown.join(''), /Sources:/, 'still shown');
  // The next reply speaks normally again.
  const next = rig('Sources matter, but here is the answer: yes.');
  await run(next, (d) => d.send('is that right', { raw: 'x' }));
  assert.match(next.spoken.join(' '), /here is the answer/);
});

test('after a quiet stretch the sound output is opened afresh before Echo speaks, and each line logs how it played', () => {
  const app = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /const QUIET_FRESH_MS = 90_000;/);
  assert.match(app, /await ctx\.suspend\(\);[\s\S]{0,80}await ctx\.resume\(\);/);
  assert.match(app, /voiceGain\.gain\.setValueAtTime\(1, ctx\.currentTime\)/, 'a volume left turned down is put back');
  assert.match(app, /if \(outputDue\(\)\) await freshOutput\(/);
  assert.match(app, /const outputDue = \(\) => !sources\.size && /, 'never in the middle of a reply');
  assert.match(app, /Promise\.race\(\[work, new Promise\(\(r\) => setTimeout\(r, FRESH_MAX_MS\)\)\]\)/, 'a line never waits long on the sound system');
  for (const ev of ["'devicechange', staleOutput", "'pageshow', staleOutput"]) assert.ok(app.includes(ev), ev);
  assert.match(app, /timeline\('play\.start', \{[^}]*ctx: ctx\.state, gain: /);
  assert.match(app, /timeline\('audio\.fresh', \{ why, before, after: ctx\.state, idleS \}\)/);
});

test('the quick model never gets to say "I can\'t": the main model takes the turn, with every tool', async () => {
  // Only an opening refusal to DO counts.
  for (const t of ["I can't do AirDrop remotely, only between devices that are near each other.", "Sorry, I cannot send files that way.", "Unfortunately I'm not able to control that app.", "I don't have a way to do that from here."]) assert.equal(saysCant(t), true, t);
  for (const t of ["I can't tell which one you mean. The first or the second?", "I can't find a folder called California on this Mac.", "I couldn't catch that. Say it again?", "Sure, sending it now.", "I can't be anyone's therapist, but I'm good to talk to.", "I won't do that one, even with your permission.", "Done. I can't see any errors."]) assert.equal(saysCant(t), false, t);

  const { saveSettings } = await import('../lib/settings.js');
  saveSettings({ fastModel: 'auto' });
  const r = rigEach([["I can't do AirDrop from here. ", 'You need to drag the file yourself.'], ['Opening AirDrop from the Share menu.']]);
  r.d.start();
  await until(() => r.d.q, 1000, 'session');
  // (Whether a turn goes to the quick model depends on how it is weighed: here it is made to.)
  r.d.onQuickModel = () => true;
  r.d.send('can you airdrop it to her', { raw: 'x' });
  await until(() => r.d.busy, 2000, 'turn');
  await until(() => !r.d.busy, 4000, 'done');
  assert.deepEqual(r.spoken, ['Opening AirDrop from the Share menu.']);
  assert.doesNotMatch(r.shown.join(''), /can't/);
  assert.equal(r.calls(), 2, 'asked once more, on the main model');
  r.d.input.close();
  // The main model's own "I can't" is its considered answer and is said.
  const main = rig("I can't reach that printer from here. It's switched off.");
  main.d.onQuickModel = () => false;
  await run(main, (d) => d.send('print it', { raw: 'x' }));
  assert.match(main.spoken.join(' '), /can't reach that printer/);
  assert.equal(main.calls(), 1);
  const rules = (rig('x').d as any).systemPrompt();
  assert.match(rules, /Never say you can't do something on this Mac before checking your tools/);
  assert.match(rules, /Never read steps out as a numbered list/);
  assert.match(NOTES_PROMPT(), /so hand_off instead/);
});

test('a reply the user stopped in the window is not an error', async () => {
  const r = rig('x');
  const errors: string[] = [];
  r.d.on('error', (e: Error) => errors.push(e.message));
  let interrupted = 0;
  r.d.q = { interrupt: async () => { interrupted++; } };
  r.d.busy = true;
  await r.d.stopByUser();
  assert.equal(interrupted, 1);
  assert.equal(r.d.hushed, true, 'the interrupted result that follows is expected');
  r.d.busy = false; r.d.hushed = false;
  await r.d.stopByUser();
  assert.equal(r.d.hushed, false, 'nothing under way: nothing to mark');
  const win = fs.readFileSync(path.join(import.meta.dirname, '..', 'lib', 'server', 'window.js'), 'utf8');
  assert.match(win, /case 'interrupt':[\s\S]{0,160}dispatcher\.stopByUser\(\);/);
});
