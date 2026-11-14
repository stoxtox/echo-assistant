// Oct 7, 2026: a night of tic-tac-toe where the user typed "g" after every move, their clicks
// kept stopping Echo, Echo spoke aloud after "I don't want to speak", and promised to build a
// feature "tomorrow". Play-along (the user's click is their move), quiet mode, and the rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, until, wait } from './helpers.js';

const dirs = sandbox('play');
const { ScreenBridge } = await import('../lib/screen.js');
const { ComputerUse, computerPrompt, PLAY_SETTLE_MS } = await import('../lib/computer.js');
const { Dispatcher, asksQuiet, asksVoice, QUIET_MODE_NOTE } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');
const { VoiceState } = await import('../lib/voicestate.js');
const { saveSettings, setFixedForTest, getSettings } = await import('../lib/settings.js');

function setup() {
  setFixedForTest({ screenAware: true });
  saveSettings({ computerUse: true, pointer: true, driveMode: 'do' });
  const bridge = new ScreenBridge({ logFile: path.join(dirs.data, 'screen-log.jsonl'), timeoutMs: 500, browserTimeoutMs: 200 });
  bridge.nativeClients = () => 1;
  const c = new ComputerUse({ bridge, logFile: path.join(dirs.data, 'computer-log.jsonl') });
  const moves = [], paused = [];
  c.on('play_move', (m) => moves.push(m));
  c.on('paused', (p) => paused.push(p));
  return { c, moves, paused };
}

test('playing along, the user\'s click in the game calls Echo to take its turn; a click elsewhere does not', async () => {
  const { c, moves, paused } = setup();
  const r = c.playAlong({ on: true, what: 'tic-tac-toe' });
  assert.equal(r.playing, true);
  assert.match(r.note, /Never ask them to say or type anything/);
  assert.equal(c.driving, true, 'the session is open so the app reports clicks');
  c.run.app = 'Google Chrome';
  // Two clicks in a burst are one move.
  assert.equal(c.pause('clicked', { app: 'Google Chrome' }), false, 'not a take-over');
  c.pause('clicked', { app: 'Chrome' });
  assert.equal(moves.length, 0, 'the board gets a moment to settle');
  await until(() => moves.length === 1, PLAY_SETTLE_MS + 1500);
  assert.deepEqual(moves[0], { what: 'tic-tac-toe', retry: false });
  assert.equal(paused.length, 0);
  // A click in another app, a click on Echo's own window, and typing are not moves.
  c.pause('clicked', { app: 'Finder' });
  c.pause('clicked', { app: 'Google Chrome', inEcho: true });
  c.pause('typed on the keyboard', { app: 'Google Chrome' });
  await wait(PLAY_SETTLE_MS + 200);
  assert.equal(moves.length, 1);
  c.abort('test over');
});

test('a click that cuts Echo\'s own move short is tried again by itself, with nothing said', async () => {
  const { c, moves, paused } = setup();
  c.playAlong({ on: true, what: 'tic-tac-toe' });
  c.run.app = 'Google Chrome';
  c.isBusy = () => true; // Echo is in the middle of its turn
  assert.equal(c.pause('clicked', { app: 'Google Chrome' }), true, 'the step under way does stop');
  assert.deepEqual(paused, [{ reason: 'clicked', play: true }]);
  assert.match(c.unavailable().message, /play-along.*End your turn now and say nothing/s);
  await until(() => moves.length === 1, PLAY_SETTLE_MS + 1500);
  assert.equal(moves[0].retry, true);
  // The turn Echo is called for starts clean: the pause is gone, and nobody said yes to anything.
  const request = c.run.requests;
  assert.equal(c.playTurn(), true);
  assert.equal(c.paused, null);
  assert.equal(c.run.requests, request + 1);
  c.abort('test over');
});

test('play-along keeps the session open between moves and ends with Stop, the tool, or the session', () => {
  const { c } = setup();
  c.playAlong({ on: true });
  c.idleCheck();
  assert.equal(c.driving, true, 'a quiet minute while they think does not end the game');
  c.play.lastAt = c.now() - 6 * 60 * 1000;
  c.idleCheck();
  assert.equal(c.driving, false, 'five minutes with no move does');
  assert.equal(c.play, null);
  c.playAlong({ on: true });
  assert.deepEqual(c.playAlong({ on: false }), { playing: false, was: true });
  c.playAlong({ on: true });
  c.abort('pressed Escape');
  assert.equal(c.play, null);
  // Without play-along a click between requests is still nothing, and one mid-step still stops it aloud.
  c.blocked = null;
  c.ensureRun();
  const said = [];
  c.on('paused', (p) => said.push(p));
  c.isBusy = () => true;
  c.pause('clicked', { app: 'Google Chrome' });
  assert.deepEqual(said, [{ reason: 'clicked', play: false }]);
  c.abort('test over');
});

test('quiet mode: "I don\'t want to speak" turns the voice off until they speak or ask for it', () => {
  for (const t of ["its night time and I dont wanna speack, you can just do things.", "I cant speack right now… but its your tern now", "I can't talk right now", "quiet mode", "text only please", "don't say it out loud"]) assert.equal(asksQuiet(t), true, t);
  for (const t of ["I can't talk about that with him", "I don't want to talk to her", 'play something quiet', 'can you speak Spanish?', 'go']) assert.equal(asksQuiet(t), false, t);
  assert.equal(asksVoice('voice on'), true);
  assert.equal(asksVoice('ok you can talk again'), true);
  assert.equal(asksVoice('g'), false);

  const d = new Dispatcher(new TaskManager({ queryFn: async function* () {} }));
  const sent = [], modes = [];
  d.input = /** @type {any} */ ({ push: (body) => sent.push(typeof body === 'string' ? body : body.at(-1).text), size: 0, close() {} });
  d.on('quiet_mode', (on) => modes.push(on));
  d.send("I can't speak right now, just do things");
  assert.deepEqual(modes, [true]);
  assert.ok(sent.at(-1).includes(QUIET_MODE_NOTE), 'the assistant is told with the message');
  d.busy = false;
  d.send('g');
  assert.deepEqual(modes, [true], 'typing keeps it on');
  assert.ok(sent.at(-1).includes(QUIET_MODE_NOTE));
  d.busy = false;
  d.send('okay I am back', { raw: 'okay I am back' });
  assert.deepEqual(modes, [true, false], 'their voice brings Echo\'s back');
  assert.equal(d.textOnly, false);
  assert.ok(!sent.filter((b) => b.includes('okay I am back')).some((b) => b.includes(QUIET_MODE_NOTE)), 'and the note is gone');

  // The voice tracker: in quiet mode a line is over the moment it is asked for, so no step waits on it.
  const v = new VoiceState();
  v.silent = true;
  const id = v.line('Centre.');
  return v.whenDone(id).then((r) => assert.equal(r.heard, false));
});

test('an event with a key replaces the one still waiting, and says when it goes in', () => {
  const d = new Dispatcher(new TaskManager({ queryFn: async function* () {} }));
  const sent = [];
  d.input = /** @type {any} */ ({ push: (body) => sent.push(typeof body === 'string' ? body : body.at(-1).text), size: 0, close() {} });
  d.busy = true;
  let started = 0;
  d.notify('[play-along] first click', { key: 'play', onStart: () => started++ });
  d.notify('[play-along] second click', { key: 'play', onStart: () => started++ });
  assert.equal(d.held.length, 1);
  d.busy = false;
  d.flushEvents();
  assert.equal(started, 1);
  assert.match(sent.at(-1), /second click/);
  assert.ok(!/first click/.test(sent.at(-1)));
  clearTimeout(d.heldTimer);
});

test('the instructions: set up and play yourself, no hints, try another way, and promise only what is done', () => {
  const p = computerPrompt({ ...getSettings(), computerUse: true, pointer: true });
  assert.match(p, /call play_along, and take your own turns/);
  assert.match(p, /never tell them what you are about to do, what they should watch/);
  assert.match(p, /a thing that would not scroll may drag/);
  assert.match(p, /Do your own setup\./);
  const d = new Dispatcher(new TaskManager({ queryFn: async function* () {} }));
  const prompt = d.systemPrompt();
  assert.match(prompt, /Never say you will build, add or learn a new ability "tomorrow" or "later"/);
  assert.match(prompt, /call save_idea/);
  assert.match(prompt, /One mention that it's late/);
});

test('save_idea notes the wish on this Mac and promises nothing', async () => {
  const d = new Dispatcher(new TaskManager({ queryFn: async function* () {} }));
  const tool = d.allTools().find((t) => t.name === 'save_idea');
  assert.ok(tool, 'the tool exists');
  const r = await tool.handler({ idea: 'A play-along mode where Echo moves as soon as I have moved', said: 'why do I need to keep typing g?' }, {});
  assert.match(r.content[0].text, /Nothing was built/);
  const rows = fs.readFileSync(path.join(dirs.data, 'ideas.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.match(rows[0].idea, /play-along mode/);
});

// Oct 11, 2026: "You are very slow". A tic-tac-toe move took 6.5 to 8.4 s, three model calls each
// (look, click, speak). Now the board is looked at once by Echo itself and sent with the call.
test('Echo\'s turn comes with the board: its text and its picture, taken without a model call', async () => {
  const { c } = setup();
  assert.equal(await c.playSnapshot(), null, 'no game: nothing is looked at');
  c.playAlong({ on: true, what: 'tic-tac-toe' });
  const asked = [];
  c.bridge.on('request', (r) => {
    asked.push(r.kind);
    setImmediate(() => c.bridge.deliver(r.id, { ok: true, source: 'native', text: 'Tic-tac-toe\nX turn', image: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]).toString('base64'), mime: 'image/jpeg', width: 800, height: 600, app: 'Google Chrome', window: 'tic tac toe' }));
  });
  const blocks = await c.playSnapshot();
  assert.deepEqual(asked, ['look']);
  assert.equal(blocks?.[0].type, 'text');
  assert.match(/** @type {any} */ (blocks?.[0]).text, /X turn/);
  const pic = /** @type {any} */ (blocks?.find((b) => b.type === 'image'));
  assert.equal(pic.source.type, 'base64');
  assert.equal(pic.source.media_type, 'image/jpeg');
  assert.ok(pic.source.data.length > 0);
  c.playAlong({ on: false });
  assert.ok(PLAY_SETTLE_MS <= 500, 'the board settles in under half a second');
});

test('an event can carry what it shows, and it goes to the assistant in the same message', () => {
  const d = new Dispatcher(new TaskManager({ queryFn: async function* () {} }));
  const pushed = [];
  d.input = /** @type {any} */ ({ push: (body) => pushed.push(body), size: 0, close() {} });
  const board = [{ type: 'text', text: 'the board' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }];
  d.notify('[play-along] The user just clicked in tic-tac-toe.', { key: 'play', blocks: board });
  assert.equal(pushed.length, 1);
  assert.ok(Array.isArray(pushed[0]), 'blocks, not a bare string');
  assert.deepEqual(pushed[0].slice(0, 2), board);
  assert.match(pushed[0].at(-1).text, /\[event\] \[play-along\] The user just clicked/);
  clearTimeout(d.heldTimer);
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(src, /const board = await computer\.playSnapshot\(\);/);
  assert.match(src, /so do NOT look again: act from it/);
});
