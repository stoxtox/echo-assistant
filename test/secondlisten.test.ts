// A second listen (lib/secondlisten.js): Apple's words start the turn, local Whisper hears the
// same clip meanwhile, and when Whisper's version is clearly the better one the turn is done
// again with it. The pairs below are from the user's own clips of Oct 4, 2026 (125 clips: the two
// recognizers agreed on 71, and on about 20 Apple's version had lost the meaning).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, until, wait, serverSource } from './helpers.js';

const dirs = sandbox('secondlisten');
const { secondOpinion, plainWords, wordEdits } = await import('../lib/secondlisten.js');
const { Dispatcher } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');

const sure = (text: string, lp = -0.15) => ({ text, segments: [{ lp }] });

test("Whisper's version replaces Apple's when the meaning was lost", () => {
  const pairs: Array<[string, string]> = [
    ['Nava snacks', "Now what's next?"],
    ['Length, hey horizon', 'Hey, how are you doing?'],
    ['He still receive the images', "But he still didn't receive the images."],
    ['I want you to look into what I have, so I have a lemon X', 'I want you to look into what I have. So I have a Luminex'],
    ["Yeah, let's build an another P table or add more data. I would say.", "Yeah, let's build in another pivot table or add more data, I would say."],
    ['Yeah, sure, Sab Mere', 'Yeah, sure, submit it.'],
    ['Kanshi, able to pick the cat pictures at all', "Can't you able to pick the cat pictures at all?"],
    ['Turn', 'Done.'],
    ["But I don't say it on the screen", "But I don't see it on the screen."],
  ];
  for (const [apple, whisper] of pairs) {
    const o = secondOpinion(apple, sure(whisper));
    assert.equal(o.use, 'whisper', apple);
    assert.equal(o.text, whisper);
  }
});

test("Apple's version is kept when the two agree, or differ only in ways that don't matter", () => {
  const same: Array<[string, string, string]> = [
    ['Alright, thank you', 'All right. Thank you.', 'same'],
    ["Alright, watch my screen. I'm gonna show you.", "Alright, watch my screen. I'm going to show you.", 'same'],
    ['Can you zoom little bit there?', 'Can you zoom a little bit to there?', 'minor'],
    ['In the meantime, can you open that edited photos?', 'Alright, in the meantime, can you open that edited photos?', 'minor'],
    ['I am already sign in. Can you upload it for me?', "I'm already signed in. Can you upload it for me?", 'minor'],
    ['No, no', 'No.', 'minor'],
    ["It's done", "Hey Echo, it's done.", 'minor'],
  ];
  for (const [apple, whisper, why] of same) {
    const o = secondOpinion(apple, sure(whisper));
    assert.equal(o.use, 'apple', apple);
    assert.equal(o.why, why, apple);
  }
});

test('Whisper is not believed when it is guessing: low confidence, an invented tail, or English made up for another language', () => {
  assert.equal(secondOpinion('Yes', sure('Guess', -0.53)).why, 'unsure');
  assert.equal(secondOpinion('I guess, iMessage', sure('I guess I message God.', -0.73)).why, 'unsure');
  assert.equal(secondOpinion('What is it?', sure('What is it? A video game.')).why, 'tail');
  // Gujarati, written down by Apple as sounds: Whisper's fluent English was never said.
  assert.equal(secondOpinion('Kaaththa Ne Mogalu Jawad mein karne Kare to Ponky Jio', sure("I'm not going to do that. I'm going to do that.")).why, 'not_english');
  assert.equal(secondOpinion('Madhu ka Bhuli Jaye', sure("I'm not going to go to the bathroom.")).why, 'not_english');
  assert.equal(secondOpinion('Open the budget sheet', sure('Qaya Parker, AMKJ zorvat.')).why, 'unsure');
  assert.equal(secondOpinion('Open the budget sheet', null).use, 'apple');
  assert.equal(secondOpinion('Open the budget sheet', sure('')).why, 'blank');
  assert.equal(wordEdits(plainWords('we just build it'), plainWords('we just built it')), 0);
});

/* ---------- the turn is done again, or the assistant is told ---------- */
const ev = (event: any) => ({ type: 'stream_event', parent_tool_use_id: null, event });
const start = (id: string) => ev({ type: 'message_start', message: { id, model: 'fake', usage: { input_tokens: 3 } } });
const textBlock = (text: string) => [ev({ type: 'content_block_start', content_block: { type: 'text' } }), ev({ type: 'content_block_delta', delta: { type: 'text_delta', text } }), ev({ type: 'content_block_stop' })];
const stop = ev({ type: 'message_stop' });
const whole = (id: string, text: string) => ({ type: 'assistant', parent_tool_use_id: null, message: { id, content: [{ type: 'text', text }] } });
const RESULT = { type: 'result', subtype: 'success', session_id: 's1', total_cost_usd: 0 };

/** A model that takes `thinkMs` to answer each message with "You said: <the message's own words>", and can be interrupted. */
function rig(thinkMs: number) {
  for (const f of ['state.json', 'events.jsonl', 'dispatcher-timing.jsonl']) fs.rmSync(path.join(dirs.data, f), { force: true });
  const quick: any = { favorites: () => [], pendingList: () => [], osa: async () => '', mediaControl: async () => ({}) };
  const d: any = new Dispatcher(new TaskManager({ queryFn: async function* () {} } as any), null, quick);
  const read: string[] = [];
  let stopped = false;
  d.queryFn = ({ prompt }: { prompt: AsyncIterable<any> }) => {
    const q = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's1' };
      for await (const m of prompt) {
        const body = String(m?.message?.content?.[0]?.text ?? m?.message?.content ?? '');
        read.push(body);
        stopped = false;
        const until2 = Date.now() + thinkMs;
        while (Date.now() < until2 && !stopped) await wait(10);
        if (stopped) {
          yield { type: 'result', subtype: 'error_during_execution', session_id: 's1', total_cost_usd: 0 };
          continue;
        }
        const reply = /pivot/.test(body) ? 'A pivot table adds things up by group.' : 'Pie tables are not a thing I know.';
        yield start(`m${read.length}`);
        yield* textBlock(reply);
        yield stop;
        yield whole(`m${read.length}`, reply);
        yield RESULT;
      }
    })();
    return Object.assign(q, { setModel: async () => {}, setMaxThinkingTokens: async () => {}, close() {}, interrupt: async () => { stopped = true; } });
  };
  const spoken: string[] = [];
  const errors: string[] = [];
  d.on('speak', (text: string) => spoken.push(text));
  d.on('error', (e: Error) => errors.push(e.message));
  return { d, spoken, errors, read };
}

test('before the assistant has said anything, the turn is done again with the better words: one answer, no error', async () => {
  const r = rig(200);
  r.d.start();
  await until(() => r.d.q, 1000, 'session');
  r.d.send('how do I use pi tables', { raw: 'x', trace: 't-1' });
  await until(() => r.d.busy && r.d.turn?.trace === 't-1', 1000, 'turn');
  await wait(60);
  assert.equal(r.d.rehear('t-1', 'how do I use pivot tables'), 'restarted');
  assert.equal(r.d.rehear('t-1', 'how do I use pivot tables'), 'late', 'once per turn');
  await until(() => r.spoken.length > 0, 3000, 'the answer');
  await until(() => !r.d.busy, 3000, 'done');
  assert.deepEqual(r.spoken, ['A pivot table adds things up by group.']);
  assert.deepEqual(r.errors, [], 'the dropped reply is not an error');
  assert.match(r.read.at(-1) || '', /how do I use pivot tables/);
  assert.match(r.read.at(-1) || '', /heard again more carefully/);
  r.d.input.close();
});

test('once the assistant has spoken, nothing is undone: it is told with the next message', async () => {
  const r = rig(40);
  r.d.start();
  await until(() => r.d.q, 1000, 'session');
  r.d.send('how do I use pi tables', { raw: 'x', trace: 't-2' });
  await until(() => r.spoken.length > 0, 3000, 'spoke');
  const outcome = r.d.busy ? r.d.rehear('t-2', 'how do I use pivot tables') : 'late';
  assert.ok(outcome === 'noted' || outcome === 'late');
  await until(() => !r.d.busy, 3000, 'done');
  assert.equal(r.d.rehear('t-2', 'how do I use pivot tables'), 'late', 'a finished turn is left alone');
  assert.deepEqual(r.spoken, ['Pie tables are not a thing I know.']);
  if (outcome === 'noted') {
    r.d.send('thanks', { raw: 'x' });
    await until(() => r.read.length === 2, 3000, 'next message');
    assert.match(r.read[1] || '', /was really "how do I use pivot tables"/);
    await until(() => !r.d.busy, 3000, 'done');
  }
  r.d.input.close();
});

test('the server gives every Apple sentence a second listen, and logs what came of it', async () => {
  const src = serverSource();
  assert.match(src, /apple && secondListenOn\(s\) && engines\(\)\.whisper\.available \? transcribe\(wav, \{ engine: 'whisper' \}\)/);
  // Never inside the tests: a Mac with the Whisper model would transcribe every test sentence for real.
  const { secondListenOn } = await import('../lib/secondlisten.js');
  assert.equal(process.env.ECHO_SECOND_LISTEN, 'off');
  assert.equal(secondListenOn({ secondListen: true }), false);
  assert.match(src, /second\.then\(\(w\) => secondHeard\(/);
  assert.match(src, /dispatcher\.rehear\(trace, opinion\.text\)/);
  assert.match(src, /type: 'heard_fix'/);
  assert.match(src, /event: 'second_listen'/);
});
