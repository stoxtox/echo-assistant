// Stage 1 listening: the conversation window (lib/session.ts), one judge with the conversation in
// view (lib/pipeline/utterance.ts decideV2), nothing meant for Echo silently set aside, and the
// assistant's quiet reply when it wasn't meant for it (lib/dispatcher.js [quiet]).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, until, serverSource, pageSource } from './helpers.js';

const dirs = sandbox('session');
const S = await import('../lib/session.ts');
const { decideUtterance } = await import('../lib/pipeline/utterance.ts');
const { judgeAddressee } = await import('../lib/addressed.js');
const { FLAGS } = await import('../lib/flags.ts');
const { Dispatcher, QUIET_MARK } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');

const judge = async (o: any) => judgeAddressee(o);
type Conv = Parameters<typeof decideUtterance>[1];
const NOW = 1_000_000_000;
const conv = (over: Partial<Conv> = {}): Conv => ({ recent: [], driving: false, busy: false, pendingCards: 0, pendingMessages: 0, lessonActive: false, wakeWord: true, now: NOW, ...over });
const utt = (text: string, mode = 'hands-free', over: any = {}) => ({ text, page: { mode, ...(over.page || {}) }, clarity: 'ok' as const, loud: null, quiet: true, mediaPlaying: false, ...over, ...(over.page ? { page: { mode, ...over.page } } : {}) });

test('the window: open while Echo works, 8 s after it speaks (15 s after a question), in Talk mode; "thanks" closes it', () => {
  const base = { working: false, asked: false, talk: null, closed: false, now: NOW };
  assert.deepEqual(S.sessionWindow({ ...base, working: true }), { open: true, why: 'working' });
  assert.deepEqual(S.sessionWindow({ ...base, sinceReplyMs: 7_000 }), { open: true, why: 'follow' });
  assert.equal(S.sessionWindow({ ...base, sinceReplyMs: 9_000 }).open, false);
  assert.deepEqual(S.sessionWindow({ ...base, asked: true, sinceReplyMs: 14_000 }), { open: true, why: 'question' });
  assert.equal(S.sessionWindow({ ...base, asked: true, sinceReplyMs: 16_000 }).open, false);
  assert.deepEqual(S.sessionWindow({ ...base, talk: { since: NOW - 60_000, lastAt: NOW - 20_000 } }), { open: true, why: 'talk' });
  assert.equal(S.sessionWindow({ ...base, talk: { since: NOW - 60_000, lastAt: NOW - 31_000 } }).open, false, '30 s with nothing said');
  assert.equal(S.sessionWindow({ ...base, talk: { since: NOW - 31 * 60_000, lastAt: NOW - 1_000 } }).open, false, '30 minutes at most');
  assert.equal(S.sessionWindow({ ...base, closed: true, sinceReplyMs: 2_000 }).open, false, '"thanks" closed it');
  assert.equal(S.sessionWindow({ ...base, closed: true, working: true }).open, true, 'still open while Echo works');
});

test('closing, Talk mode, "that was for you", and noise', () => {
  for (const s of ['thanks', 'Thank you.', "that's all", 'okay, thanks echo', 'goodbye', 'go to sleep', 'never mind']) assert.ok(S.CLOSING.test(s), s);
  for (const s of ['thanks, now open Notes', 'that is all I need from the report', 'stop']) assert.ok(!S.CLOSING.test(s), s);
  for (const s of ["let's talk", 'Echo, talk mode', "let's chat for a bit"]) assert.ok(S.TALK_START.test(s), s);
  for (const s of ['that was for you', 'I was talking to you', 'it was meant for you']) assert.ok(S.RECALL.test(s), s);
  for (const s of ['*sad*', '[music]', 'Um.', 'Th.', '']) assert.ok(S.isNoise(s), JSON.stringify(s));
  for (const s of ['Yes.', 'stop', 'keep going', 'No']) assert.ok(!S.isNoise(s), s);
});

test('what the window remembers between sentences', () => {
  let st = S.freshListenState();
  st = S.afterSentence(st, { kind: 'drop', said: 'open the settings page' }, { now: NOW });
  assert.deepEqual(st.lastSetAside, { text: 'open the settings page', at: NOW });
  st = S.afterSentence(st, { kind: 'drop', said: '*sad*' }, { now: NOW + 1 });
  assert.equal(st.lastSetAside?.text, 'open the settings page', 'noise is not kept');
  st = S.afterSentence(st, { kind: 'deliver', said: 'open the settings page', recalled: true }, { now: NOW + 2 });
  assert.equal(st.lastSetAside, null, 'used up');
  st = S.afterSentence(st, { kind: 'deliver', said: "let's talk" }, { now: NOW + 3 });
  assert.deepEqual(st.talk, { since: NOW + 3, lastAt: NOW + 3 });
  st = S.afterSentence(st, { kind: 'deliver', said: 'tell me about Mars' }, { now: NOW + 9 });
  assert.equal(st.talk?.lastAt, NOW + 9);
  st = S.afterSentence(st, { kind: 'deliver', said: 'thanks' }, { now: NOW + 10 });
  assert.deepEqual([st.talk, st.closed], [null, true]);
  st = S.afterSentence(st, { kind: 'deliver', said: 'what time is it' }, { surely: true, now: NOW + 11 });
  assert.equal(st.closed, false, 'push-to-talk or "Hey Echo" opens it again');
});

test('Oct 1: every sentence said to Echo while it worked now reaches it', async () => {
  const c = conv({ driving: true, recent: ['User: make it look better', 'Assistant: I added a soft shadow to the cards. Want me to keep going?'] });
  for (const s of [
    'What is this blue line in the middle of the page?',
    'I said no need to trim the page border.',
    'Who told you to save it, cancel it and work on this, it is not looking good.',
    'I think the layout could be better.',
    'In the header why do we have this dot in the menu?',
    'Keep going.',
  ]) {
    const v = await decideUtterance(utt(s), c, { judge });
    assert.equal(v.kind, 'deliver', s);
  }
});

test('mid-step: a correction is delivered at the next step, never kept back', async () => {
  const v = await decideUtterance(utt('no, the other button'), conv({ driving: true, busy: true }), { judge });
  assert.ok(v.kind === 'deliver' || (v.kind === 'hold' && v.nextStep === true), JSON.stringify(v));
  if (v.kind === 'hold') assert.equal(v.reply.reason, 'next_step');
});

test('the TV in an open window is left alone, with a chip; an unsure sentence goes through with a note', async () => {
  const tv = await decideUtterance(utt('and in other news tonight the markets fell sharply after the report', 'hands-free', { mediaPlaying: true }), conv({ driving: true }), { judge });
  assert.equal(tv.kind, 'drop');
  if (tv.kind === 'drop') {
    assert.equal(tv.reply.askForMe, true, 'never silent: a "Was that for me?" chip');
    assert.equal(tv.log.window, 'working');
  }
  const unsure = await decideUtterance(utt('so I told him the whole long story about the trip we took last summer to the lake house with my cousins and the dog', 'hands-free', { page: { sinceReplyMs: 3_000 } }), conv({ recent: ['Assistant: Done.'] }), { judge });
  assert.equal(unsure.kind, 'deliver');
  assert.equal(unsure.kind === 'deliver' && unsure.mayNotBeForEcho, true, 'the assistant decides, and may stay quiet');
});

test('the follow-up window and its edges', async () => {
  const c = conv({ recent: ['User: weather?', 'Assistant: Sunny, 24 degrees.'] });
  assert.equal((await decideUtterance(utt('and tomorrow', 'hands-free', { page: { sinceReplyMs: 5_000 } }), c, { judge })).kind, 'deliver');
  const late = await decideUtterance(utt('and tomorrow', 'hands-free', { page: { sinceReplyMs: 20_000 } }), c, { judge });
  assert.equal(late.kind, 'drop', 'window closed: its name is needed again');
  const asked = conv({ recent: ['User: book it', 'Assistant: Which day works, Tuesday or Wednesday?'] });
  assert.equal((await decideUtterance(utt('Tuesday works', 'hands-free', { page: { sinceReplyMs: 12_000 } }), asked, { judge })).kind, 'deliver', '15 s after a question');
  assert.equal((await decideUtterance(utt('Echo, and tomorrow', 'hands-free', { page: { sinceReplyMs: 60_000 } }), c, { judge })).kind, 'deliver', 'its name always works');
  const closed = await decideUtterance(utt('and tomorrow', 'hands-free', { page: { sinceReplyMs: 2_000 } }), conv({ closed: true }), { judge });
  assert.equal(closed.kind, 'drop', 'after "thanks"');
  const talk = await decideUtterance(utt('tell me about the moon landing', 'hands-free', { page: { sinceReplyMs: 25_000 } }), conv({ talk: { since: NOW - 60_000, lastAt: NOW - 10_000 } }), { judge });
  assert.equal(talk.kind, 'deliver', 'Talk mode');
});

test('"that was for you", noise, and push-to-talk echoing Echo\'s question back', async () => {
  const back = await decideUtterance(utt('that was for you'), conv({ lastSetAside: { text: 'open the settings page', at: NOW - 30_000 } }), { judge });
  assert.deepEqual([back.kind, back.said, back.kind === 'deliver' && back.recalled], ['deliver', 'open the settings page', true]);
  const stale = await decideUtterance(utt('that was for you', 'hands-free', { page: { sinceReplyMs: 2_000 } }), conv({ lastSetAside: { text: 'open the settings page', at: NOW - 3 * 60_000 } }), { judge });
  assert.notEqual(stale.said, 'open the settings page', 'only within 2 minutes');
  const noise = await decideUtterance(utt('*sad*'), conv({ driving: true }), { judge });
  assert.deepEqual([noise.kind, noise.kind === 'drop' && noise.reply.reason], ['drop', 'noise']);
  const ptt = await decideUtterance(utt('You can delete it.', 'push-to-talk'), conv({ recent: ['Assistant: Found the old file. You can delete it, should I?'] }), { judge });
  assert.equal(ptt.kind, 'deliver', 'push-to-talk is never mistaken for Echo\'s own voice');
});

/** A dispatcher whose model streams `reply`. */
async function run(reply: string, speech: any) {
  fs.rmSync(path.join(dirs.data, 'state.json'), { force: true });
  const quick: any = { favorites: () => [], pendingList: () => [], osa: async () => '', mediaControl: async () => ({}) };
  const d: any = new Dispatcher(new TaskManager({ queryFn: async function* () {} }), null, quick);
  const sent: string[] = [];
  d.queryFn = ({ prompt }: { prompt: AsyncIterable<any> }) => {
    const q = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's1' };
      for await (const m of prompt) {
        sent.push(JSON.stringify(m));
        yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: `m${sent.length}`, model: 'x', usage: {} } } };
        yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', content_block: { type: 'text' } } };
        for (let i = 0; i < reply.length; i += 2) yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: reply.slice(i, i + 2) } } };
        yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_stop' } };
        yield { type: 'assistant', parent_tool_use_id: null, message: { id: `m${sent.length}`, content: [{ type: 'text', text: reply }] } };
        yield { type: 'result', subtype: 'success', session_id: 's1', total_cost_usd: 0 };
      }
    })();
    return Object.assign(q, { setModel: async () => {}, close() {} });
  };
  const events: string[] = [];
  const spoken: string[] = [];
  for (const e of ['say_start', 'say_delta', 'say_end', 'say']) d.on(e, () => events.push(e));
  d.on('speak', (t: string) => spoken.push(t));
  d.start();
  await until(() => d.q, 1000, 'session');
  d.send('so I told him about the trip', speech);
  await until(() => !d.busy && sent.length > 0, 2000, 'turn done');
  d.input.close();
  return { sent, events, spoken, d };
}

test('an unsure sentence: the assistant may answer [quiet], and then nothing is said or shown', async () => {
  const q = await run(QUIET_MARK, { raw: 'so I told him about the trip', mayNotBeForEcho: true });
  assert.match(q.sent[0] ?? '', /\(maybe not for you\)/, 'a short tag on the message');
  assert.match(q.d.systemPrompt(), /\(maybe not for you\): [\s\S]*reply with exactly \[quiet\]/, 'what it means is in the system prompt, once');
  assert.deepEqual(q.events, [], 'no bubble, no voice');
  assert.deepEqual(q.spoken, []);
  const ok = await run('[Note] Sounds like a great trip.', { raw: 'so I told him about the trip', mayNotBeForEcho: true });
  assert.ok(ok.events.includes('say_start') && ok.events.includes('say_end'), 'text that only starts like the marker is shown');
  assert.match(ok.spoken.join(' '), /great trip/);
  const plain = await run('Nice.', { raw: 'so I told him about the trip' });
  assert.doesNotMatch(plain.sent[0] ?? '', /maybe not for you/, 'the note only when the judge was unsure');
});

test('the server and the browser path both use the window, with no flag to turn it off', () => {
  const server = serverSource();
  assert.match(server, /let verdict = await decideUtterance\(\{ text: pick\.text, page, clarity, loud, quiet, mediaPlaying, live, keepText: Boolean\(rec\), clip, ownerDb: voice\.ownerDb\(mic\) \}, conversationNow\(s\), \{ judge: judgeHere \}\)/);
  assert.match(server, /let v = await decideUtterance\(/, 'words from the browser recognizer too');
  assert.doesNotMatch(server, /flagOn\('session'\)|listen2|held: true/, 'the older path and its flag are gone');
  assert.match(server, /dispatcher\.computer\.instruct\(said, \{\}\)/, 'mid-step: delivered at the next step');
  assert.equal(Object.hasOwn(FLAGS, 'session'), false);
  const app = pageSource();
  assert.match(app, /case 'set_aside': if \(msg\.heard\) wasThatForMe\(msg\.heard\); break;/);
  assert.match(app, /out\.reason === 'next_step'/);
});
