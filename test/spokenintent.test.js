// The safety-check fix: a plain "delete it" or "send it to Sam" is its own yes (one action, this
// turn only, same target), with an Undo chip instead of a second question. Payments, sign-ins,
// settings, Terminal and multi-item deletes still always ask. Also: a click on Echo's own window
// is never a take-over, a spoken yes to a waiting card gets past the addressee check, and the
// false flags from the action log are gone. A fake "Mac app" answers every request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, fakeQuery, serverSource } from './helpers.js';

const dirs = sandbox('spokenintent');
const { commandIntent, intentMatches, INTENT_TTL_MS } = await import('../lib/spokenintent.js');
const { ComputerUse, classifyAction, ECHO_INPUT_GRACE_MS } = await import('../lib/computer.js');
const { ScreenBridge } = await import('../lib/screen.js');
const { Dispatcher } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');
const { judgeAddressee } = await import('../lib/addressed.js');
const { saveSettings, setFixedForTest } = await import('../lib/settings.js');

const logFile = path.join(dirs.data, 'computer-log.jsonl');
const events = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const on = () => (setFixedForTest({ screenAware: true }), saveSettings({ computerUse: true, pointer: true }));

/** A Mac app where everything is in `app` (Finder by default) and every step works. */
function fakeApp({ app = 'Finder', window = 'Desktop', label = (p) => p.target || '' } = {}) {
  const bridge = new ScreenBridge({ logFile: path.join(dirs.data, 'screen-log.jsonl'), timeoutMs: 500, browserTimeoutMs: 500 });
  bridge.nativeClients = () => 1;
  const seen = [];
  bridge.on('request', (r) => {
    seen.push(r);
    const p = r.params;
    let out;
    if (r.kind === 'act' && p.step === 'resolve') out = { ok: true, found: true, token: `t${seen.length}`, label: label(p), role: 'AXButton', app, window };
    else if (r.kind === 'act' && p.step === 'do') out = { ok: true, via: 'accessibility', app, window, verified: true, changes: ['window_title'] };
    else if (r.kind === 'wait') out = { ok: true, found: true };
    if (out) setImmediate(() => bridge.deliver(r.id, out));
  });
  const does = () => seen.filter((r) => r.kind === 'act' && r.params.step === 'do');
  return { bridge, does };
}

/** A computer with its cards and Undo chips collected. */
function computer(o = {}, opts = {}) {
  const { bridge, does } = fakeApp(o);
  const c = new ComputerUse({ bridge, logFile, ...opts });
  const cards = [];
  const undos = [];
  c.on('confirm_request', (r) => cards.push(r));
  c.on('undo_offer', (u) => undos.push(u));
  return { c, does, cards, undos };
}

test('commandIntent: a plain delete or send of one thing, and nothing else', () => {
  /** @type {Array<[string, string, boolean]>} */
  const yes = [
    ['delete it', 'delete', true],
    ['Delete it.', 'delete', true],
    ['Okay, delete it please', 'delete', true],
    ['Echo, trash that', 'delete', true],
    ['yes delete this one', 'delete', true],
    ['move it to the trash', 'delete', true],
    ['get rid of it', 'delete', true],
    ['delete the screenshot', 'delete', true], // a kind of thing, not which one: needs a clear "it"
    ['delete invoice-march.pdf', 'delete', false],
    ['Can you delete it?', 'delete', true],
    ['send it', 'send', true],
    ['send it to Sam', 'send', true],
    ['You can delete it.', 'delete', true], // said on 29 Sept, and then asked again
    ['Echo, you can send it now.', 'send', true],
    ['send the email to Sam', 'send', true],
    ['reply to Sam', 'send', true],
  ];
  for (const [text, category, pronoun] of yes) {
    const c = commandIntent(text);
    assert.ok(c, text);
    assert.equal(c.category, category, text);
    assert.equal(c.pronoun, pronoun, text);
  }
  assert.deepEqual(commandIntent('send it to Sam')?.to, ['sam']);
  const no = [
    'buy it', 'pay for it', 'place the order', 'sign in', 'delete my account', 'delete them all', 'delete all the screenshots',
    'delete the folder', 'delete these files', 'delete both', 'delete 3 photos', 'empty the trash', "don't delete it", 'do not send it',
    'should I delete it', 'delete it?', 'how do I delete it', 'delete it and send it', 'delete it if it is old', 'delete', 'send',
    'send it to everyone', 'send it to Sam and Alex', 'push it', 'deploy it', 'change the settings', 'install it', 'wait, delete it',
    'the TV said something about how you should delete it before tomorrow', 'reset it', 'erase it', '', 'what is this',
  ];
  for (const text of no) assert.equal(commandIntent(text), null, text);
});

test('intentMatches: same verb and target only, this turn only, and "it" must be clear', () => {
  const now = 1_000_000;
  const prior = { label: 'Screenshot 2026-09-30 at 10.02.png', app: 'Finder', at: now - 5000, turn: 1 };
  const it = { ...(/** @type {any} */ (commandIntent('delete it'))), turn: 2, at: now - 1000 };
  const base = { category: 'delete', turn: 2, now, app: 'Finder', label: '', prior, referent: prior };
  assert.equal(intentMatches(it, base).ok, true, 'Echo pointed at one file, then "delete it"');
  assert.equal(intentMatches(it, { ...base, turn: 3 }).why, 'other_turn', 'a later turn');
  assert.equal(intentMatches(it, { ...base, now: now + INTENT_TTL_MS }).why, 'stale');
  assert.equal(intentMatches(it, { ...base, category: 'send' }).why, 'different_action');
  for (const category of ['money', 'account', 'system', 'terminal', 'submit']) assert.equal(intentMatches({ ...it, category }, { ...base, category }).why, 'always_asks', category);
  assert.equal(intentMatches(it, { ...base, prior: null }).why, 'unclear_it', 'no clear "it": Echo would be choosing');
  assert.equal(intentMatches(it, { ...base, app: 'Google Chrome' }).why, 'unclear_it', '"it" was in another app');
  assert.equal(intentMatches(it, { ...base, prior: { ...prior, at: now - 10 * 60_000 } }).why, 'unclear_it', 'too long ago');
  assert.equal(intentMatches(it, { ...base, prior: { ...prior, label: 'Projects' } }).why, 'maybe_folder', 'a Finder item with no extension may be a folder');
  assert.equal(intentMatches(it, { ...base, prior: { ...prior, label: '3 items selected' } }).why, 'unclear_it', 'several things');
  assert.equal(intentMatches(it, { ...base, label: 'Empty Trash' }).why, 'several');
  // Named: what Echo selected has to be what the user named.
  const named = { ...(/** @type {any} */ (commandIntent('delete invoice-march.pdf'))), turn: 2, at: now };
  const selected = { label: 'invoice-march.pdf', app: 'Finder', at: now, turn: 2 };
  assert.equal(intentMatches(named, { ...base, prior: null, referent: selected }).ok, true);
  assert.equal(intentMatches(named, { ...base, prior: null, referent: { ...selected, label: 'invoice-april.pdf' } }).why, 'different_target');
  // Send: the recipient has to be the one Echo found.
  const toSam = { ...(/** @type {any} */ (commandIntent('send it to Sam'))), turn: 2, at: now };
  const send = { category: 'send', turn: 2, now, app: 'Messages', label: '', window: 'Sam', prior: null, referent: null };
  assert.equal(intentMatches(toSam, send).ok, true);
  assert.equal(intentMatches(toSam, { ...send, window: 'Alex' }).why, 'different_recipient');
  assert.equal(intentMatches(toSam, { ...send, window: 'Samantha' }).why, 'different_recipient', 'whole words only');
  assert.equal(intentMatches(toSam, { ...send, window: '', to: 'Sam Lee' }).ok, true, 'a recipe payload names the recipient');
  assert.equal(intentMatches(null, base).why, 'no_intent');
});

test('"Delete it" right after Echo pointed at one file deletes it with no second question, and an Undo chip', async () => {
  on();
  fs.rmSync(logFile, { force: true });
  const { c, does, cards, undos } = computer();
  c.newTurn('show me my newest screenshot');
  c.noteReferent('Screenshot 2026-09-30 at 10.02.png', 'Finder'); // point_at found it
  c.newTurn('delete it');
  const r = await c.act('press_keys', { keys: 'cmd+delete', app: 'Finder' });
  assert.equal(r.done, true, JSON.stringify(r));
  assert.equal(r.preapproved, true);
  assert.match(r.preapprovedNote, /do not ask for a yes/);
  assert.equal(cards.length, 0, 'no card, no second question');
  assert.equal(does().length, 1, 'deleted once');
  assert.equal(does()[0].params.confirmed, true);
  assert.equal(undos.length, 1, 'an Undo chip');
  assert.equal(undos[0].label, 'Deleted');
  assert.match(undos[0].detail, /cmd\+delete/, 'the chip says what was done');
  const log = events();
  assert.ok(log.some((e) => e.event === 'confirm_preapproved' && e.category === 'delete' && e.why === 'it'));
  assert.ok(!log.some((e) => e.event === 'confirm_asked'), 'not counted as a risk prompt');
  // One action only: a second delete in the same turn asks.
  const again = await c.act('press_keys', { keys: 'cmd+delete', app: 'Finder' });
  assert.equal(again.waitingForConfirmation, true);
  assert.equal(does().length, 1);
});

test('still asks: "buy it", no clear "it", a later turn, another target, another action, a folder', async () => {
  on();
  const asks = async (setup, action, args, o) => {
    const { c, does, cards } = computer(o);
    setup(c);
    const r = await c.act(action, args);
    assert.equal(r.waitingForConfirmation, true, JSON.stringify(r));
    assert.equal(does().length, 0);
    assert.equal(cards.length, 1);
    return r;
  };
  const shop = { app: 'Safari', window: 'Otter plush – Checkout' };
  await asks((c) => { c.noteReferent('Otter plush', 'Safari'); c.newTurn('buy it'); }, 'click', { target: 'Buy now' }, shop);
  await asks((c) => c.newTurn('delete it'), 'press_keys', { keys: 'cmd+delete', app: 'Finder' });
  await asks((c) => { c.newTurn('delete it'); c.noteReferent('notes.txt', 'Finder'); }, 'press_keys', { keys: 'cmd+delete', app: 'Finder' }); // Echo picked it this turn
  await asks((c) => { c.noteReferent('a.png', 'Finder'); c.newTurn('delete it'); c.newTurn('hmm'); }, 'press_keys', { keys: 'cmd+delete', app: 'Finder' });
  await asks((c) => { c.noteReferent('a.png', 'Finder'); c.newTurn('delete it'); c.clearIntent(); }, 'press_keys', { keys: 'cmd+delete', app: 'Finder' }); // a task event's turn
  await asks((c) => { c.noteReferent('invoice-april.pdf', 'Finder'); c.newTurn('delete invoice-march.pdf'); }, 'press_keys', { keys: 'cmd+delete', app: 'Finder' });
  await asks((c) => { c.noteReferent('Projects', 'Finder'); c.newTurn('delete it'); }, 'press_keys', { keys: 'cmd+delete', app: 'Finder' });
  await asks((c) => { c.noteReferent('Draft to Sam', 'Messages'); c.newTurn('delete it'); }, 'press_keys', { keys: 'return', app: 'Messages' }, { app: 'Messages', window: 'Sam' });
  await asks((c) => { c.noteReferent('a.png', 'Finder'); c.newTurn('delete it'); }, 'click', { target: 'Empty Trash' });
  // Heard unclearly (the TV, across the room): not the user's clear words.
  await asks((c) => { c.noteReferent('a.png', 'Finder'); c.newTurn('delete it', { lowOverall: true }); }, 'press_keys', { keys: 'cmd+delete', app: 'Finder' });
  await asks((c) => { c.noteReferent('a.png', 'Finder'); c.newTurn('delete it', { unsure: ['delete'] }); }, 'press_keys', { keys: 'cmd+delete', app: 'Finder' });
  // Without the user's words at all (page text, Echo's own words never reach newTurn).
  await asks((c) => { c.noteReferent('a.png', 'Finder'); c.newTurn(); }, 'press_keys', { keys: 'cmd+delete', app: 'Finder' });
});

test('"send it to Sam" in Sam\'s conversation sends once, with Undo; to someone else it asks', async (t) => {
  on();
  // Sending on the user's say-so is the rule with "ask by what an action does" off; with it on,
  // a send always asks (test/policy.test.ts).
  process.env.ECHO_FLAG_POLICY = '0';
  t.after(() => delete process.env.ECHO_FLAG_POLICY);
  const sam = computer({ app: 'Messages', window: 'Sam' });
  sam.c.newTurn('send it to Sam');
  const r = await sam.c.act('press_keys', { keys: 'return', app: 'Messages' });
  assert.equal(r.done, true, JSON.stringify(r));
  assert.equal(sam.cards.length, 0);
  assert.equal(sam.undos[0]?.label, 'Sent');
  const alex = computer({ app: 'Messages', window: 'Alex' });
  alex.c.newTurn('send it to Sam');
  assert.equal((await alex.c.act('press_keys', { keys: 'return', app: 'Messages' })).waitingForConfirmation, true);
  // "Send it" after Echo wrote the message last turn: that's the "it".
  const draft = computer({ app: 'Mail', window: 'New Message' });
  draft.c.newTurn('write Sam a note saying hi');
  await draft.c.act('type_text', { text: 'Hi Sam', into: 'Message Body' });
  draft.c.newTurn('send it');
  assert.equal((await draft.c.act('click', { target: 'Send' })).done, true);
  assert.equal(draft.cards.length, 0);
});

test('mid-run words count as the user\'s own too ("delete it" said while Echo is still busy)', async () => {
  on();
  const { c, cards } = computer();
  c.noteReferent('old.png', 'Finder');
  c.instruct('delete it');
  c.takeInstructions();
  const r = await c.act('press_keys', { keys: 'cmd+delete', app: 'Finder' });
  assert.equal(r.done, true, JSON.stringify(r));
  assert.equal(cards.length, 0);
});

test('the dispatcher passes the user\'s words (and how clearly they were heard); a task event clears the intent', () => {
  on();
  const { bridge } = fakeApp();
  const c = new ComputerUse({ bridge, logFile });
  const d = new Dispatcher(new TaskManager({ queryFn: fakeQuery(() => []).queryFn }), null, undefined, bridge, c);
  d.input = /** @type {any} */ ({ push() {}, size: 0 });
  d.send('delete it');
  assert.equal(c.intent?.category, 'delete');
  d.setBusy(false);
  d.lastSpeechEnd = 0;
  d.notify('Task 3 finished.');
  assert.equal(c.intent, null, 'an event turn is not the user speaking');
  d.setBusy(false);
  d.send('delete it', { raw: 'delete it', lowOverall: true });
  assert.equal(c.intent, null, 'heard unclearly');
});

test('the TV saying "delete it" is not for Echo; a spoken yes to a waiting card is', () => {
  const tv = judgeAddressee({ text: 'delete it', mediaPlaying: true });
  assert.notEqual(tv.decision, 'accept');
  assert.notEqual(judgeAddressee({ text: 'delete it' }).decision, 'accept', 'no wake word, no follow-up: not accepted');
  assert.equal(judgeAddressee({ text: 'yes', pendingQuestion: true }).decision, 'accept');
  assert.equal(judgeAddressee({ text: 'yes, send it', pendingQuestion: true }).decision, 'accept');
  const server = serverSource();
  const pipeline = fs.readFileSync(path.join(import.meta.dirname, '..', 'lib', 'pipeline', 'utterance.ts'), 'utf8');
  assert.match(server, /pendingCards: dispatcher\.computer\.pending\.size,\n\s+pendingMessages: quick\.pendingList\(\)\.length,/);
  assert.match(pipeline, /pendingQuestion: c\.pendingCards > 0 \|\| c\.pendingMessages > 0, awaitingAnswer: asked/, 'hands-free: a waiting card counts as a question');
});

test('a click on Echo\'s own window (a card, Undo) is never a take-over', async () => {
  on();
  let t = 1_000_000;
  const { c } = computer({}, { now: () => t });
  c.isBusy = () => true;
  const run = c.ensureRun();
  assert.equal(c.pause('clicked', { runId: run.id, inEcho: true }), false, 'the Mac app says it was Echo\'s window');
  c.noteEchoInput();
  t += 200;
  assert.equal(c.pause('clicked', { runId: run.id }), false, 'just after a click on a card');
  assert.equal(c.paused, null);
  assert.ok(events().some((e) => e.event === 'take_over_ignored' && e.why === 'echo_window'));
  t += ECHO_INPUT_GRACE_MS + 10;
  assert.equal(c.pause('clicked', { runId: run.id }), true, 'a real click in another app still takes over');
  // Allow on a card counts as a click in Echo's window.
  const w = computer({ app: 'Google Chrome', window: 'Compose Mail' }, { now: () => t, confirmSettleMs: 0 });
  w.c.isBusy = () => true;
  const card = await w.c.act('click', { target: 'Send' });
  const done = w.c.confirm(card.confirmId, true, 'window');
  assert.equal(w.c.pause('clicked', { runId: w.c.run?.id }), false);
  assert.equal((await done).done, true);
  const server = serverSource();
  assert.match(server, /if \(ECHO_CLICKS\.has\(msg\.type\)\) computer\.noteEchoInput\(\);/);
  assert.match(server, /inEcho: body\.inEcho === true/);
});

test('false flags from the action log no longer ask; the real ones still do', () => {
  const fine = [
    // Return in Chrome's address bar with a Gmail tab open (asked, and allowed in 5 seconds).
    { action: 'press_keys', keys: 'return', resolved: { app: 'Google Chrome', field: 'Address and search bar', window: 'Inbox - Gmail' } },
    // Finder's Share button only opens the menu (asked twice, allowed both times).
    { action: 'click', target: 'Share', resolved: { app: 'Finder', label: 'Share', role: 'AXButton', window: 'For Alex' } },
    // Opening a pane from the Settings sidebar.
    { action: 'click', target: 'General', resolved: { app: 'System Settings', label: 'General', role: 'AXStaticText', window: 'Wallpaper' } },
    { action: 'click', target: 'Displays', resolved: { app: 'System Settings', label: 'Displays', role: 'AXRow' } },
    // A conversation in the Messages list whose status says "Send Failure" only opens it.
    { action: 'click', target: 'Alex, Muted, Message Send Failure, 8:52 PM', resolved: { app: 'Messages', label: 'Alex, Muted, Message Send Failure, 8:52 PM', role: 'AXButton' } },
  ];
  for (const req of fine) assert.equal(classifyAction(/** @type {any} */ (req)).level, 'ok', JSON.stringify(req));
  const still = [
    [{ action: 'press_keys', keys: 'return', resolved: { app: 'Google Chrome', field: 'Message Body', window: 'Compose - Gmail' } }, 'send'],
    [{ action: 'press_keys', keys: 'cmd+return', resolved: { app: 'Google Chrome', field: 'Address and search bar', window: 'Compose - Gmail' } }, 'send'],
    [{ action: 'press_keys', keys: 'return', resolved: { app: 'Messages', field: 'Address and search bar' } }, 'send'],
    [{ action: 'click', target: 'Share', resolved: { app: 'Google Chrome', label: 'Share', window: 'Doc' } }, 'send'],
    [{ action: 'click', target: 'Send', resolved: { app: 'Finder', label: 'Send', window: 'AirDrop' } }, 'send'],
    [{ action: 'click', target: 'Wi-Fi', resolved: { app: 'System Settings', label: 'Wi-Fi', role: 'AXCheckBox', window: 'Wi-Fi' } }, 'system'],
    [{ action: 'click', target: 'Software Update', resolved: { app: 'System Settings', label: 'Software Update', role: 'AXButton' } }, 'system'],
    [{ action: 'click', target: 'Update Now', resolved: { app: 'System Settings', label: 'Update Now', role: 'AXStaticText' } }, 'system'],
    [{ action: 'click', target: 'Sign Out', resolved: { app: 'System Settings', label: 'Sign Out', role: 'AXRow' } }, 'system'],
    [{ action: 'click', target: 'Send failure', resolved: { app: 'Messages', label: 'Send failure', role: 'AXButton' } }, 'send'],
    [{ action: 'click', target: 'Try Again', resolved: { app: 'Messages', label: 'Try Again' } }, 'send'],
    [{ action: 'click', target: 'Sam, Send $20 now, 9:01 PM', resolved: { app: 'Messages', label: 'Sam, Send $20 now, 9:01 PM' } }, 'send'],
  ];
  for (const [req, category] of still) {
    const v = classifyAction(/** @type {any} */ (req));
    assert.equal(v.level, 'risky', JSON.stringify(req));
    assert.equal(v.category, category, JSON.stringify(req));
  }
  // Privacy panes are still refused outright, sidebar or not.
  assert.equal(classifyAction({ action: 'click', target: 'Privacy & Security', resolved: { app: 'System Settings', label: 'Privacy & Security', role: 'AXStaticText' } }).level, 'refuse');
});
