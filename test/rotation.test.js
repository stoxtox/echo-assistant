// Keeping the dispatcher's conversation small: session rotation with a seeded summary, carrying
// pending confirmations and driving sessions over, the slimmer task digest, and the timing log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, until } from './helpers.js';

const dirs = sandbox('rotation');
const { Dispatcher } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');
const { taskDigest } = await import('../lib/digest.js');
const rotation = await import('../lib/rotation.js');
const { addCost, costSummary } = await import('../lib/costs.js');
const { saveSettings } = await import('../lib/settings.js');

const LIMITS = { tokens: 20_000, hardTokens: 60_000, busyTokens: 60_000, turns: 1000, idleMs: 60 * 60_000, verbatim: 2 };

/**
 * A fake Agent SDK session: every user message is one turn with one model call. The context
 * grows like the real one: the system prompt, then every message and reply so far.
 */
function fakeSdk({ base = 12_000, perTurn = 2_500, reply = (n, _body) => `Reply ${n}.` } = {}) {
  const sessions = [];
  const queryFn = ({ prompt, options }) => {
    const s = { id: `s${sessions.length + 1}`, resume: options.resume, systemPrompt: options.systemPrompt, prompts: [], ctx: base };
    sessions.push(s);
    return (async function* () {
      let first = true;
      for await (const m of prompt) {
        const body = typeof m.message.content === 'string' ? m.message.content : m.message.content.at(-1).text;
        s.prompts.push(body);
        if (first) yield { type: 'system', subtype: 'init', session_id: s.id };
        first = false;
        s.ctx += Math.ceil(body.length / 4) + perTurn;
        const id = `msg_${s.id}_${s.prompts.length}`;
        yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id, model: 'fake', usage: { input_tokens: 10, cache_read_input_tokens: s.ctx - 10, cache_creation_input_tokens: 0 } } } };
        yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } };
        yield { type: 'assistant', parent_tool_use_id: null, message: { id, content: [{ type: 'text', text: reply(s.prompts.length, body) }] } };
        yield { type: 'result', subtype: 'success', session_id: s.id, total_cost_usd: 0 };
      }
    })();
  };
  return { sessions, queryFn };
}

const summaryFn = (text, calls = []) => ({ prompt }) => {
  calls.push(prompt);
  return (async function* () {
    yield { type: 'result', subtype: 'success', result: text, total_cost_usd: 0.001 };
  })();
};

const stubQuick = (pending = []) => /** @type {any} */ ({ favorites: () => [], pendingList: () => pending });

function rig({ pending = [], sdk = fakeSdk(), summary = 'SUMMARY: the user is planning dinner with Mira at 8.' } = {}) {
  fs.rmSync(path.join(dirs.data, 'state.json'), { force: true });
  const d = new Dispatcher(new TaskManager({ queryFn: async function* () {} }), null, stubQuick(pending));
  d.queryFn = /** @type {any} */ (sdk.queryFn);
  const summaryCalls = [];
  d.summaryQueryFn = summaryFn(summary, summaryCalls);
  d.limits = { ...LIMITS };
  d.on('error', () => {});
  return { d, sdk, summaryCalls };
}

const turn = async (d, textIn) => {
  d.send(textIn);
  await until(() => !d.busy, 3000, `turn "${textIn}"`);
};

test('rotationDue: tokens, turns, idle gap and a new day; a live driving session only at the hard cap', () => {
  const now = Date.parse('2026-09-28T22:00:00-04:00');
  const base = { sessionId: 's', ctxTokens: 1000, sessionTurns: 3, lastTurnAt: new Date(now - 60_000).toISOString(), sessionDay: rotation.localDay(now) };
  const limits = { ...LIMITS };
  assert.equal(rotation.rotationDue(base, { now, limits }), null);
  assert.equal(rotation.rotationDue({ ...base, sessionId: null, ctxTokens: 1e6 }, { now, limits }), null, 'nothing to rotate yet');
  assert.equal(rotation.rotationDue({ ...base, ctxTokens: 25_000 }, { now, limits }), 'tokens');
  assert.equal(rotation.rotationDue({ ...base, sessionTurns: 1000 }, { now, limits }), 'turns');
  assert.equal(rotation.rotationDue({ ...base, lastTurnAt: new Date(now - 2 * 3600_000).toISOString() }, { now, limits }), 'idle');
  assert.equal(rotation.rotationDue({ ...base, sessionDay: '2026-09-27' }, { now, limits }), 'new_day');
  assert.equal(rotation.rotationDue({ ...base, ctxTokens: 25_000 }, { now, limits, busyWithUser: true }), null, 'never mid-drive below the hard cap');
  assert.equal(rotation.rotationDue({ ...base, ctxTokens: 70_000 }, { now, limits, busyWithUser: true }), 'hard_tokens');
  const env = rotation.rotationLimits({ ECHO_ROTATE_TOKENS: '80000', ECHO_ROTATE_IDLE_MIN: '10' });
  assert.equal(env.tokens, 80_000);
  assert.equal(env.idleMs, 600_000);
  assert.equal(rotation.rotationLimits({}).tokens, 80_000, 'default about 80K: Echo\'s own instructions are about 45K of it, and past 70K the first word comes later');
});

test('past the token limit, a fresh session starts, seeded with the summary, the last turns and the rules', async () => {
  const { d, sdk, summaryCalls } = rig({ sdk: fakeSdk({ perTurn: 3000 }) });
  d.start();
  // 15K, 18K, then 21K tokens: past the 20K limit after the third turn.
  for (const said of ['plan dinner with Mira somewhere near Hoboken', 'book the Italian place', 'text her the time']) await turn(d, said);
  await until(() => sdk.sessions.length === 2, 3000, 'rotation');
  const [old, fresh] = sdk.sessions;
  assert.equal(fresh.resume, undefined, 'a new session, not a resume');
  assert.ok(summaryCalls.length === 1 && /plan dinner with Mira/.test(summaryCalls[0]), 'the small model summarized the exchanges');
  const state = d.readState();
  assert.equal(state.ctxTokens, 0);
  assert.equal(state.lastRotation.reason, 'tokens');
  assert.ok(state.lastRotation.fromCtx >= LIMITS.tokens);
  // The stable rules come first, then the cache boundary, then projects and memory.
  assert.equal(fresh.systemPrompt[1], '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__');
  assert.match(fresh.systemPrompt[0], /You are Echo/);
  assert.match(fresh.systemPrompt[2], /^Projects:/);
  assert.deepEqual(fresh.systemPrompt[0], old.systemPrompt[0], 'the cacheable prefix is identical across sessions');

  await turn(d, 'what time did we say?');
  const first = fresh.prompts[0];
  assert.match(first, /^\[conversation carried over\]/);
  assert.match(first, /SUMMARY: the user is planning dinner with Mira at 8\./);
  assert.match(first, /Last exchanges, word for word:[\s\S]*book the Italian place[\s\S]*text her the time/);
  assert.doesNotMatch(first.split('Last exchanges')[1], /somewhere near Hoboken/, 'only the last few verbatim');
  assert.equal(old.prompts.length, 3);
  assert.match(first, /\[end of carried-over context[\s\S]*what time did we say\?/);
  assert.match(first, /\[task digest\]|what time did we say\?$/);
  assert.ok(first.length < 4000, 'the seed stays small');
  // Only the first message carries it.
  await turn(d, 'thanks');
  assert.doesNotMatch(fresh.prompts[1], /carried over/);
  d.input.close();
});

test('pending message cards and computer confirmations carry over with their ids', async () => {
  const card = { id: 'ab12cd34', name: 'Mira', masked: '•••• 3141', text: 'Dinner at 8?', service: 'iMessage', expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const { d, sdk } = rig({ pending: [card] });
  d.computer.pending.set('cf99', /** @type {any} */ ({ id: 'cf99', what: 'click Send', reason: 'sends a message', category: 'send', app: 'Messages', expiresAt: Date.now() + 60_000, timer: null }));
  d.start();
  // A computer confirmation is live: no rotation below the hard cap.
  d.writeState({ sessionId: 's1', ctxTokens: LIMITS.tokens + 1, sessionDay: rotation.localDay(), lastTurnAt: new Date().toISOString() });
  assert.equal(await d.maybeRotate(), false);
  // Over the hard cap it rotates anyway, and says exactly what's still waiting.
  d.writeState({ ctxTokens: LIMITS.hardTokens + 1 });
  assert.equal(await d.maybeRotate(), true);
  await turn(d, 'yes send it');
  const first = sdk.sessions.at(-1).prompts[0];
  assert.match(first, /pending_id ab12cd34, to Mira \(•••• 3141\): "Dinner at 8\?"[\s\S]*confirm_message/);
  assert.match(first, /id cf99, click Send in Messages[\s\S]*confirm_action/);
  assert.match(first, /yes send it/);
  d.input.close();
});

test('a driving session is never rotated lightly, and is carried over when it has to be', async () => {
  const { d, sdk } = rig();
  d.start();
  d.computer.run = /** @type {any} */ ({ id: 'r1', startedAt: Date.now(), deadline: Date.now() + 60_000, steps: 0, app: 'Safari', requests: 3, lastActivity: Date.now() });
  try {
    d.writeState({ sessionId: 's1', ctxTokens: LIMITS.tokens * 2, sessionDay: rotation.localDay(), lastTurnAt: new Date().toISOString() });
    assert.equal(await d.maybeRotate(), false, 'mid-drive: the session keeps its step history');
    d.writeState({ ctxTokens: LIMITS.hardTokens });
    assert.equal(await d.maybeRotate(), true);
    await turn(d, 'now search for otters');
    assert.match(sdk.sessions.at(-1).prompts[0], /driving session in Safari \(request 4\)[\s\S]*stop_driving/);
  } finally {
    d.computer.run = null;
    d.input.close();
  }
});

test('a reply that asks something is not rotated away before the answer comes', async () => {
  // Past the token limit after the first turn, but that reply asked a question.
  const sdk = fakeSdk({ base: 19_000, perTurn: 3000, reply: (_n, body) => (/book/.test(body) ? 'Found two places. Should I book the Italian one?' : 'Done, it is booked.') });
  const { d } = rig({ sdk });
  d.start();
  const ends = [];
  d.on('reply_end', (e) => ends.push(e.awaitsReply));
  await turn(d, 'find somewhere to book for dinner');
  assert.deepEqual(ends, [true]);
  assert.ok(d.busyWithUser(), 'waiting on the answer counts as busy with the user');
  assert.equal(await d.maybeRotate(), false, 'no rotation while the answer window is open');
  assert.equal(sdk.sessions.length, 1);
  // The answer lands in the session that asked, then the rotation goes ahead.
  await turn(d, 'yes');
  assert.deepEqual(sdk.sessions[0].prompts.map((p) => /yes/.test(p)), [false, true]);
  assert.deepEqual(ends, [true, false]);
  assert.equal(d.busyWithUser(), false);
  await until(() => sdk.sessions.length === 2, 3000, 'rotation after the answer');
  d.input.close();
});

test('a turn that starts after a long idle gap rotates at once, without waiting for a model', async () => {
  const { d, sdk, summaryCalls } = rig();
  d.start();
  await turn(d, 'remind me what Mira said');
  const st = d.readState();
  d.writeState({ lastTurnAt: new Date(Date.now() - 2 * LIMITS.idleMs).toISOString(), summary: 'Earlier: Mira is free Friday.' });
  summaryCalls.length = 0;
  clearTimeout(d.rotateTimer);
  await turn(d, 'good morning');
  assert.equal(summaryCalls.length, 0, 'no model call on the way in');
  const first = sdk.sessions.at(-1).prompts[0];
  assert.notEqual(sdk.sessions.at(-1).id, st.sessionId);
  assert.match(first, /Mira is free Friday/);
  assert.match(first, /remind me what Mira said[\s\S]*good morning$|remind me what Mira said[\s\S]*good morning/);
  d.input.close();
});

test('the first start after the upgrade leaves the giant session, seeded from today\'s log', async () => {
  const { d, sdk } = rig();
  const day = rotation.localDay();
  fs.mkdirSync(path.join(dirs.data, 'conversations'), { recursive: true });
  fs.writeFileSync(path.join(dirs.data, 'conversations', `${day}.md`), `**[9:01:02 PM] User:** send it to Mira\n\n**[9:01:09 PM] Assistant:** It's on the card, waiting for you.\n\n**[9:05:00 PM] Event:** Task 7 finished\n\n`);
  fs.writeFileSync(path.join(dirs.data, 'state.json'), JSON.stringify({ sessionId: 'giant-800k' }));
  d.start();
  await turn(d, 'hi');
  assert.equal(sdk.sessions.length, 1);
  assert.equal(sdk.sessions[0].resume, undefined, 'the old session is not resumed');
  const first = sdk.sessions[0].prompts[0];
  assert.match(first, /\[21:01\] User: send it to Mira\n  Echo: It's on the card, waiting for you\./);
  assert.match(first, /\[event\] Task 7 finished/);
  d.input.close();
});

test('the summary comes from the small model, and falls back to a plain recap if it fails', async () => {
  const ex = [{ at: '2026-09-28T21:00:00Z', user: 'text Mira dinner at 8', echo: 'Card is up.', tools: ['send_imessage {"to":"Mira"}'] }];
  const ok = await rotation.writeSummary('Old facts.', ex, { queryFn: summaryFn('New summary.') });
  assert.deepEqual([ok.summary, ok.fallback], ['New summary.', false]);
  let cost = 0;
  await rotation.writeSummary('', ex, { queryFn: summaryFn('x'), onCost: (usd) => (cost += usd) });
  assert.ok(cost > 0, 'its cost is counted');
  const broken = () => (async function* () { throw new Error('offline'); })();
  const fb = await rotation.writeSummary('Old facts.', [...ex, ...ex, ...ex, ...ex, ...ex], { queryFn: broken });
  assert.equal(fb.fallback, true);
  assert.match(fb.summary, /^Old facts\.\nEarlier since then:\n- 21:00 user: text Mira dinner at 8/);
  const slow = () => (async function* () { await new Promise((r) => setTimeout(r, 500)); yield { type: 'result', subtype: 'success', result: 'late' }; })();
  assert.equal((await rotation.writeSummary('P', ex, { queryFn: slow, timeoutMs: 50 })).fallback, true, 'a slow model never holds things up');
  const list = Array.from({ length: rotation.MAX_EXCHANGES + 10 }, (_, i) => ({ at: 'x', user: `u${i}`, echo: 'e' })).reduce((l, e) => rotation.addExchange(l, e), []);
  assert.equal(list.length, rotation.MAX_EXCHANGES);
  assert.equal(list.at(-1).user, `u${rotation.MAX_EXCHANGES + 9}`);
});

test('the digest shows active, waiting and just-finished tasks in full, and only counts older ones', () => {
  const now = Date.parse('2026-09-28T22:00:00Z');
  const iso = (minAgo) => new Date(now - minAgo * 60000).toISOString();
  const done = (id, minAgo) => ({ id, kind: 'code', project: 'P', title: `Done job ${id}`, status: 'done', finishedAt: iso(minAgo), updatedAt: iso(minAgo), summary: `Summary ${id}`, log: [] });
  const list = [
    { id: 20, kind: 'code', project: 'P', title: 'Live one', status: 'running', updatedAt: iso(1), log: [] },
    { id: 19, kind: 'code', project: 'P', title: 'Waiting one', status: 'waiting_approval', updatedAt: iso(90), log: [], pendingApproval: { id: 'a', level: 'risky', reason: 'git push' } },
    { id: 18, kind: 'self', project: 'Echo', title: 'Self review', status: 'done', finishedAt: iso(120), updatedAt: iso(120), self: { state: 'review' }, log: [] },
    done(17, 5),
    done(16, 14),
    ...Array.from({ length: 12 }, (_, i) => done(15 - i, 20 + i * 30)),
    done(1, 60 * 30),
  ];
  const d = taskDigest({ list: () => list, isLive: (id) => id === 20, isApprovalPending: () => true }, { now });
  for (const s of ['#20 running', '#19 needs OK (risky)', '#18 ready for review', '#17 done 5 min ago', '#16 done 14 min ago']) assert.ok(d.includes(s), s);
  assert.doesNotMatch(d, /Done job 15|Done job 4\b/);
  const older = list.filter((t) => t.status === 'done' && t.id <= 15 && now - Date.parse(t.finishedAt) < 24 * 3600_000).length;
  assert.match(d, new RegExp(`\\+${older} older finished today \\(list_tasks or get_task has them\\)`));
  assert.ok(d.length < 700, `compact (${d.length} chars)`);
  // Nothing active, only old ones: still a single short line about them.
  const quiet = taskDigest({ list: () => [done(3, 120)], isLive: () => false }, { now });
  assert.match(quiet, /none active\n\+1 older finished today/);
});

test('every model call and turn is timed in the log, with its context size', async () => {
  const { d } = rig();
  const log = path.join(dirs.data, 'dispatcher-timing.jsonl');
  fs.rmSync(log, { force: true });
  d.start();
  await turn(d, 'hello');
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const req = lines.find((l) => l.type === 'request');
  const t = lines.find((l) => l.type === 'turn');
  assert.ok(req.ctx > 12_000 && req.ms >= 0 && req.firstMs >= 0 && req.cacheRead > 0, JSON.stringify(req));
  assert.ok(t.ms >= 0 && t.requests === 1 && t.ctx === req.ctx, JSON.stringify(t));
  d.input.close();
});

test('a synthetic long evening: rotation keeps context under the limit (before/after)', async () => {
  const turns = 120;
  const said = Array.from({ length: turns }, (_, i) => `request number ${i}: check the task and tell me how it's going`);
  const measure = async (limits) => {
    const { d, sdk } = rig();
    d.limits = limits;
    d.start();
    const ctx = [];
    for (const s of said) {
      await turn(d, s);
      ctx.push(d.readState().ctxTokens || d.ctxTokens);
      await new Promise((r) => setImmediate(r));
      await until(() => !d.rotating, 2000, 'rotation settled');
    }
    d.input.close();
    clearTimeout(d.rotateTimer);
    return { peak: Math.max(...ctx), total: ctx.reduce((a, b) => a + b, 0), sessions: sdk.sessions.length };
  };
  const before = await measure({ ...LIMITS, tokens: Infinity, hardTokens: Infinity });
  const after = await measure({ ...LIMITS, tokens: 60_000, hardTokens: 150_000 });
  assert.equal(before.sessions, 1);
  assert.ok(before.peak > 300_000, `one session keeps growing (${before.peak})`);
  assert.ok(after.peak < 60_000 + 5_000, `rotated sessions stay near the limit (${after.peak})`);
  assert.ok(after.sessions > 3);
  assert.ok(after.total < before.total / 4, `far fewer tokens re-read in total (${after.total} vs ${before.total})`);
});

test('dispatcher cost is tracked per day, and passes the Settings warning softly', () => {
  saveSettings({ dispatcherCostWarnUsd: 5 });
  addCost('dispatcher', 3);
  addCost('assistant', 1); // speech correction and titles: assistant, not the conversation
  let c = costSummary();
  assert.equal(c.today.dispatcher, 3);
  assert.equal(c.today.assistant, 4);
  assert.equal(c.overWarn, false);
  c = addCost('dispatcher', 2.5);
  assert.equal(c.overWarn, true);
  assert.equal(c.warnAt, 5);
  saveSettings({ dispatcherCostWarnUsd: 0 });
  assert.equal(costSummary().overWarn, false, '0 turns the warning off');
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="usageToday"/);
});

// Oct 11, 2026: twelve lively minutes went from 44K to 124K tokens with no fresh session. The
// summary was only kept when it finished in a silence, and a driving session only reset at the hard cap.
test('a summary written while the user kept talking is used at the next gap between turns', async () => {
  const { d, sdk } = rig({ sdk: fakeSdk({ base: 25_000 }) }); // every turn ends past the limit
  /** @type {(v?: any) => void} */
  let release = () => {};
  const calls = [];
  d.summaryQueryFn = ({ prompt }) => {
    calls.push(prompt);
    return (async function* () {
      await new Promise((r) => (release = r));
      yield { type: 'result', subtype: 'success', result: 'SUMMARY: playing a game with a guest.', total_cost_usd: 0 };
    })();
  };
  d.start();
  await turn(d, 'one');
  await until(() => calls.length === 1, 2000, 'the summary is being written');
  // The user is speaking when it comes back: no switch now, but the summary is kept.
  const idle = d.idle;
  d.idle = () => false;
  release();
  await until(() => !d.rotating, 2000, 'the summary came back');
  assert.equal(sdk.sessions.length, 1, 'no switch under a turn');
  assert.ok(d.readySummary, 'kept for the next gap');
  d.idle = idle;
  // The next gap between turns: the switch is immediate, and no second summary is written.
  assert.equal(await d.maybeRotate(), true);
  assert.equal(calls.length, 1);
  assert.equal(d.readySummary, null);
  await until(() => sdk.sessions.length === 2, 3000, 'the fresh session');
  await turn(d, 'three');
  const first = sdk.sessions.at(-1).prompts[0];
  assert.match(first, /SUMMARY: playing a game with a guest\./);
  assert.match(first, /one/, 'the last exchanges are carried over word for word');
  d.input.close();
  clearTimeout(d.rotateTimer);
});

test('a kept summary is dropped once the conversation has moved well past it', () => {
  const { d } = rig();
  const ex = (n) => ({ at: new Date(Date.UTC(2026, 9, 11, 12, 0, n)).toISOString(), user: `u${n}`, echo: `e${n}` });
  d.readySummary = { summary: 'S', ms: 5, at: Date.now(), session: 's1', lastAt: ex(1).at };
  assert.ok(d.readySummaryFor({ sessionId: 's1', exchanges: [ex(0), ex(1), ex(2), ex(3)] }), 'two newer exchanges: both go over word for word');
  assert.equal(d.readySummaryFor({ sessionId: 's1', exchanges: [ex(1), ex(2), ex(3), ex(4), ex(5)] }), null, 'more newer ones than are carried over');
  assert.equal(d.readySummaryFor({ sessionId: 's2', exchanges: [ex(1)] }), null, 'another session');
  d.readySummary.at = Date.now() - 11 * 60_000;
  assert.equal(d.readySummaryFor({ sessionId: 's1', exchanges: [ex(1)] }), null, 'too old');
});

test('a driving session with nothing waiting starts fresh at the busy cap; a question or a game still holds it', async () => {
  const now = Date.now();
  const base = { sessionId: 's', ctxTokens: 45_000, sessionTurns: 3, lastTurnAt: new Date(now).toISOString(), sessionDay: rotation.localDay(now) };
  const limits = { ...LIMITS, busyTokens: 40_000 };
  assert.equal(rotation.rotationDue(base, { now, limits, busyWithUser: true, onlyDriving: true }), 'busy_tokens');
  assert.equal(rotation.rotationDue(base, { now, limits, busyWithUser: true, onlyDriving: false }), null, 'a confirmation or a question is waiting');
  assert.equal(rotation.rotationDue({ ...base, ctxTokens: 30_000 }, { now, limits, busyWithUser: true, onlyDriving: true }), null);
  assert.equal(rotation.rotationLimits({}).busyTokens, 105_000);

  const { d, sdk } = rig();
  d.limits = limits;
  d.start();
  d.computer.run = /** @type {any} */ ({ id: 'r1', startedAt: now, deadline: now + 60_000, steps: 0, app: 'Chrome', requests: 5, lastActivity: now });
  try {
    d.writeState({ sessionId: 's1', ctxTokens: 45_000, sessionDay: rotation.localDay(), lastTurnAt: new Date().toISOString() });
    assert.ok(d.onlyDriving());
    d.computer.play = /** @type {any} */ ({ what: 'tic-tac-toe', timer: null });
    assert.equal(d.onlyDriving(), false, 'a game being played is not interrupted');
    assert.equal(await d.maybeRotate(), false);
    d.computer.play = null;
    assert.equal(await d.maybeRotate(), true);
    await turn(d, 'now the next one');
    assert.match(sdk.sessions.at(-1).prompts[0], /driving session in Chrome/);
  } finally {
    d.computer.run = null;
    d.computer.play = null;
    d.input.close();
    clearTimeout(d.rotateTimer);
  }
});
