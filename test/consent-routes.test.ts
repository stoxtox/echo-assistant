// Oct 4: three ways a risky step got past, or got asked about too often (data/computer-log.jsonl):
//  A. a cancelled "Submit" card was bypassed by a click on the text "Submit " and then by Return
//     on the focused Submit button;
//  B. a file went out by AirDrop with no card;
//  C. one intent took two yeses (the app's own "Try Again" / "Don't Save" asked a second time).
// A fake Mac app answers every request; nothing touches a real screen, mouse or keyboard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';

const dirs = sandbox('consent-routes');
const { ComputerUse, CARRY_MS } = await import('../lib/computer.js');
const { classifyByEffect, pressesButton } = await import('../lib/policy.ts');
const { ScreenBridge } = await import('../lib/screen.js');
const { saveSettings, setFixedForTest } = await import('../lib/settings.js');
(setFixedForTest({ screenAware: true }), saveSettings({ computerUse: true, pointer: true }));
process.env.ECHO_FLAG_POLICY = '1';

const logFile = path.join(dirs.data, 'computer-log.jsonl');
const events = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

type Screen = { label?: string; role?: string; app?: string; window?: string; container?: string };

/** A fake Mac app: `at.now` says what the step's target (or the keyboard focus) is right now. */
function rig(first: Screen = {}) {
  const at = { now: first, t: 1_000_000 };
  const bridge: any = new ScreenBridge({ logFile: path.join(dirs.data, 'screen-log.jsonl'), timeoutMs: 500, browserTimeoutMs: 500 });
  bridge.nativeClients = () => 1;
  const seen: any[] = [];
  bridge.on('request', (r: any) => {
    seen.push(r);
    const p = r.params;
    const s = { label: p.target || '', role: 'AXButton', app: 'Google Chrome', window: 'Survey', ...at.now };
    let out;
    if (r.kind === 'act' && p.step === 'resolve') out = { ok: true, found: true, token: `t${seen.length}`, ...s };
    else if (r.kind === 'act' && p.step === 'do') out = { ok: true, via: 'accessibility', app: s.app, window: s.window, verified: true, changes: ['window_title'] };
    if (out) setImmediate(() => bridge.deliver(r.id, out));
  });
  const c: any = new ComputerUse({ bridge, logFile, confirmSettleMs: 0, now: () => at.t });
  const cards: any[] = [];
  c.on('confirm_request', (x: any) => cards.push(x));
  const does = () => seen.filter((r) => r.kind === 'act' && r.params.step === 'do').length;
  /** The user says yes to the card that is up, by voice. */
  const yes = async () => {
    c.newTurn('yes');
    return c.confirm(cards.at(-1).id, true, 'voice');
  };
  return { c, cards, does, at, yes };
}

/* ---------- A: a no is not got round by another route ---------- */

test('Return, Enter or Space on a focused risky button is judged as a click on it', () => {
  const press = (keys: string, label: string, role = 'AXButton', app = 'Google Chrome') => classifyByEffect({ action: 'press_keys', keys, resolved: { label, role, app, window: 'Survey' } } as any);
  for (const keys of ['return', 'enter', 'space']) {
    assert.deepEqual([press(keys, 'Submit').level, press(keys, 'Submit').category], ['risky', 'submit'], keys);
    assert.equal(press(keys, 'Submit 11 items').category, 'submit');
  }
  assert.equal(press('return', 'Send').category, 'send');
  assert.equal(press('space', 'Delete').category, 'delete');
  assert.equal(press('return', 'Confirm purchase').level, 'risky');
  assert.equal(press('return', 'Pay now').level, 'refuse', 'moving money stays the user\'s, by a key too');
  assert.equal(press('space', 'Buy').category, 'money');
  // Not a button, or not a risky one, or not a key that presses it: as before.
  assert.equal(press('return', 'Search', 'AXTextField').level, 'ok');
  assert.equal(press('return', 'Next').level, 'ok');
  assert.equal(press('tab', 'Submit').level, 'ok');
  assert.equal(press('return', '', 'AXButton').level, 'ok', 'no name for what has the focus: nothing to go on');
  assert.equal(pressesButton({ action: 'press_keys', keys: 'return', resolved: { label: 'Submit', role: 'AXButton' } }), true);
  assert.equal(pressesButton({ action: 'press_keys', keys: 'cmd+return', resolved: { label: 'Submit', role: 'AXButton' } }), false);
});

test('A: after a cancelled Submit card, the text "Submit " and Return on the Submit button both ask', async () => {
  const { c, cards, does, at } = rig({ label: 'Submit 11 items', role: 'AXButton' });
  c.newTurn('fill in the form and hand it in');
  const r1 = await c.act('click', { target: 'Submit 11 items' });
  assert.equal(r1.waitingForConfirmation, true);
  assert.equal(cards[0].category, 'submit');
  // The user moves on without a yes: the card is cancelled.
  c.newTurn("you might need to scroll down, that's just a title, it's not the button");
  assert.equal(c.pending.size, 0);
  assert.ok(events().some((e) => e.event === 'confirm_cancelled' && e.id === cards[0].id));

  // Route 1: a click on plain text that says Submit.
  at.now = { label: 'Submit ', role: 'AXStaticText' };
  const r2 = await c.act('click', { target: 'Submit' });
  assert.equal(r2.waitingForConfirmation, true, 'the text asks, whatever it is made of');
  assert.equal(cards.length, 2);
  assert.equal(cards[1].category, 'submit');
  assert.equal(does(), 0);
  assert.equal(events().filter((e) => e.event === 'confirm_asked').at(-1).again, true);
  assert.equal((await c.confirm(cards[1].id, false, 'window')).cancelled, true);

  // Route 2: Return with the Submit button in focus.
  at.now = { label: 'Submit', role: 'AXButton' };
  const r3 = await c.act('press_keys', { keys: 'return' });
  assert.equal(r3.waitingForConfirmation, true, 'Return on the button asks');
  assert.equal(cards[2].category, 'submit');
  assert.match(cards[2].what, /press return on “Submit”/);
  assert.equal(does(), 0, 'the form was never sent');

  // A yes sends it, once.
  c.newTurn('yes');
  assert.equal((await c.confirm(cards[2].id, true, 'voice')).done, true);
  assert.equal(does(), 1);
});

test('A: with no card refused, a field or text with a risky word in its name still never asks', async () => {
  const { c, cards, does, at } = rig({ label: 'Submit ', role: 'AXStaticText' });
  c.newTurn('tidy the page');
  assert.equal((await c.act('click', { target: 'Submit' })).done, true);
  assert.equal(cards.length, 0);
  // A no in one app is not held against another.
  at.now = { label: 'Delete', role: 'AXButton', app: 'Notes', window: 'Notes' };
  const card = await c.act('click', { target: 'Delete', app: 'Notes' });
  assert.equal(card.waitingForConfirmation, true);
  await c.confirm(card.confirmId, false, 'window');
  at.now = { label: 'Remove Corner', role: 'AXTextField', app: 'Adobe XD', window: 'Landing page' };
  assert.equal((await c.act('click', { target: 'Remove Corner', app: 'Adobe XD' })).waitingForConfirmation, undefined);
  assert.equal(does(), 2, 'done, with no card');
  // In the same app it asks.
  at.now = { label: 'Remove Corner', role: 'AXTextField', app: 'Notes', window: 'Notes' };
  assert.equal((await c.act('click', { target: 'Remove Corner', app: 'Notes' })).waitingForConfirmation, true);
  assert.equal(does(), 2);
  assert.equal(cards.length, 2);
});

/* ---------- B: AirDrop asks like a message ---------- */

test('B: a click on a recipient in the AirDrop window asks, naming the file and who gets it', async () => {
  const { c, cards, does, at, yes } = rig();
  const finder = { app: 'Finder', window: 'Documents' };
  c.newTurn('share the report with the studio');
  at.now = { ...finder, label: 'report.pdf', role: 'AXImage' };
  await c.act('click', { target: 'report.pdf', button: 'right', app: 'Finder' });
  at.now = { ...finder, label: 'Share', role: 'AXMenuItem' };
  assert.equal((await c.act('click', { target: 'Share', app: 'Finder' })).done, true);
  at.now = { ...finder, label: 'AirDrop', role: 'AXMenuItem' };
  assert.equal((await c.act('click', { target: 'AirDrop', app: 'Finder' })).done, true);
  assert.equal(cards.length, 0, 'opening the menus sends nothing');

  at.now = { app: 'Finder', window: 'AirDrop', label: 'Studio iMac', role: 'AXButton' };
  const r = await c.act('click', { target: 'Studio iMac', app: 'Finder' });
  assert.equal(r.waitingForConfirmation, true, 'sending a file to someone asks');
  assert.equal(cards[0].category, 'send');
  assert.match(cards[0].why, /send “report\.pdf” to “Studio iMac” by AirDrop/);
  assert.equal(does(), 3, 'nothing was sent');
  assert.equal((await yes()).done, true);
  assert.equal(does(), 4, 'sent once, after the yes');
});

test('B: the click right after choosing AirDrop asks even when the window is not called AirDrop', async () => {
  const { c, cards, at } = rig();
  const finder = { app: 'Finder', window: 'Documents' };
  c.newTurn('airdrop this to the studio');
  at.now = { ...finder, label: 'AirDrop', role: 'AXMenuItem' };
  await c.act('click', { target: 'AirDrop', app: 'Finder' });
  at.now = { ...finder, label: 'Studio iMac', role: 'AXImage' };
  const r = await c.act('click', { target: 'Studio iMac', app: 'Finder' });
  assert.equal(r.waitingForConfirmation, true);
  assert.equal(cards[0].category, 'send');
  assert.match(cards[0].why, /send the file to “Studio iMac” by AirDrop/);
  // Pure: the window by its title, and the buttons that send nothing.
  const click = (label: string, window: string) => classifyByEffect({ action: 'click', target: label, resolved: { label, role: 'AXButton', app: 'Finder', window } } as any);
  assert.equal(click('Studio iMac', 'AirDrop').category, 'send');
  assert.equal(click('Cancel', 'AirDrop').level, 'ok');
  assert.equal(click('Done', 'AirDrop').level, 'ok');
  assert.equal(click('Studio iMac', 'Documents').level, 'ok');
});

/* ---------- C: one yes for one intent ---------- */

test('C: "Try Again" right after an allowed "Send failure" in Messages does not ask a second time', async () => {
  const { c, cards, does, at, yes } = rig({ app: 'Messages', window: 'Messages', label: 'Send failure', role: 'AXButton' });
  c.newTurn('try sending that message again');
  assert.equal((await c.act('click', { target: 'Send failure', app: 'Messages' })).waitingForConfirmation, true);
  assert.equal(cards[0].category, 'send');
  assert.equal((await yes()).done, true);

  at.now = { app: 'Messages', window: 'Messages', label: 'Try Again', role: 'AXButton' };
  at.t += 3000;
  const r = await c.act('click', { target: 'Try Again', app: 'Messages' });
  assert.equal(r.done, true, 'the app\'s own follow-up goes through on the same yes');
  assert.equal(cards.length, 1, 'one card for one intent');
  assert.equal(does(), 2);
  const carried = events().filter((e) => e.event === 'confirm_carried');
  assert.equal(carried.length, 1);
  assert.equal(carried[0].category, 'send');
  assert.equal(carried[0].id, cards[0].id, 'tied to the card that was allowed');
  assert.doesNotMatch(JSON.stringify(carried[0]), /Try Again|Messages/, 'the kind of action, never what it was');

  // Only once per yes: the same thing again is a new action.
  const again = await c.act('click', { target: 'Try Again', app: 'Messages' });
  assert.equal(again.waitingForConfirmation, true);
  assert.equal(does(), 2);
});

test('C: "Don\'t Save" right after an allowed close-without-saving does not ask again; a second ⌘W does', async () => {
  const { c, cards, does, at, yes } = rig({ app: 'Microsoft Excel', window: 'Budget.xlsx', label: 'Budget.xlsx', role: 'AXWindow' });
  c.newTurn('shut that workbook, never mind the changes');
  assert.equal((await c.act('press_keys', { keys: 'cmd+w', app: 'Microsoft Excel' })).waitingForConfirmation, true);
  assert.equal(cards[0].category, 'close');
  assert.equal((await yes()).done, true);
  at.now = { app: 'Microsoft Excel', window: 'Budget.xlsx', label: "Don't Save", role: 'AXButton', container: 'dialog' };
  assert.equal((await c.act('click', { target: "Don't Save", app: 'Microsoft Excel' })).done, true);
  assert.equal(cards.length, 1);
  assert.equal(events().filter((e) => e.event === 'confirm_carried').at(-1).category, 'close');

  // Another window closed straight after a yes is not the app's follow-up: it asks.
  const b = rig({ app: 'Microsoft Excel', window: 'Budget.xlsx', label: 'Budget.xlsx', role: 'AXWindow' });
  b.c.newTurn('shut that workbook, never mind the changes');
  await b.c.act('press_keys', { keys: 'cmd+w', app: 'Microsoft Excel' });
  await b.yes();
  b.at.now = { app: 'Microsoft Excel', window: 'Plan.xlsx', label: 'Plan.xlsx', role: 'AXWindow' };
  assert.equal((await b.c.act('press_keys', { keys: 'cmd+w', app: 'Microsoft Excel' })).waitingForConfirmation, true);
  assert.equal(b.does(), 1);
  assert.equal(does(), 2);
});

/** An allowed "Send failure" in Messages, then `between()`, then a click on `next`: was a card asked? */
async function afterYes(between: (r: ReturnType<typeof rig>) => unknown, next: Screen = {}) {
  const r = rig({ app: 'Messages', window: 'Messages', label: 'Send failure', role: 'AXButton' });
  r.c.newTurn('try sending that message again');
  await r.c.act('click', { target: 'Send failure', app: 'Messages' });
  assert.equal((await r.yes()).done, true);
  await between(r);
  r.at.now = { app: 'Messages', window: 'Messages', label: 'Try Again', role: 'AXButton', ...next };
  const out = await r.c.act('click', { target: r.at.now.label, app: r.at.now.app });
  return { asked: Boolean(out.waitingForConfirmation), does: r.does(), cards: r.cards };
}

test('the yes does NOT carry across a new request, another app, another kind, or the time limit', async () => {
  const before = events().filter((e) => e.event === 'confirm_carried').length;
  // The baseline, so each case below fails for its own reason.
  assert.equal((await afterYes(() => {})).asked, false);
  assert.equal(events().filter((e) => e.event === 'confirm_carried').length, before + 1);

  assert.equal((await afterYes((r) => r.c.newTurn('and tell the studio too'))).asked, true, 'a new request asks again');
  assert.equal((await afterYes((r) => r.c.instruct('and tell the studio too'))).asked, true, 'so do words said mid-run');
  assert.equal((await afterYes((r) => r.c.newTurn('', { pointed: true }))).asked, true, 'a drop of the light is no yes');
  assert.equal((await afterYes(() => {}, { app: 'Mail', window: 'New Message', label: 'Send' })).asked, true, 'another app asks');
  const other = await afterYes(() => {}, { label: 'Delete Conversation…' });
  assert.equal(other.asked, true, 'another kind of action asks');
  assert.equal(other.cards.at(-1).category, 'delete');
  assert.equal((await afterYes((r) => { r.at.t += CARRY_MS + 1000; })).asked, true, 'too late: it asks');
  assert.equal((await afterYes((r) => { r.at.t += CARRY_MS - 1000; })).asked, false, 'inside the limit it carries');
  // A step in between uses the yes up: only the very next step is covered.
  const stepped = await afterYes(async (r) => {
    r.at.now = { app: 'Messages', window: 'Messages', label: 'Details', role: 'AXButton' };
    await r.c.act('click', { target: 'Details', app: 'Messages' });
  });
  assert.equal(stepped.asked, true, 'not after another step');
  // Nothing was done in any case that asked.
  assert.equal(other.does, 1);
  assert.equal(events().filter((e) => e.event === 'confirm_carried').length, before + 2);
});

test('money never carries, and words said before a card cover one action only', async () => {
  // A yes to Buy does not answer the shop's "Confirm purchase".
  const shop = rig({ app: 'Google Chrome', window: 'Checkout', label: 'Buy', role: 'AXButton' });
  shop.c.newTurn('get the blue one');
  await shop.c.act('click', { target: 'Buy' });
  assert.equal((await shop.yes()).done, true);
  shop.at.now = { app: 'Google Chrome', window: 'Checkout', label: 'Confirm purchase', role: 'AXButton', container: 'dialog' };
  assert.equal((await shop.c.act('click', { target: 'Confirm purchase' })).waitingForConfirmation, true);

  // "Close it" approves ⌘W by the user's own words; losing what is unsaved is still asked about.
  const xd = rig({ app: 'Adobe XD', window: 'Landing page', label: 'Landing page', role: 'AXWindow' });
  xd.c.newTurn('close it');
  const closed = await xd.c.act('press_keys', { keys: 'cmd+w', app: 'Adobe XD' });
  assert.equal(closed.preapproved, true);
  xd.at.now = { app: 'Adobe XD', window: 'Landing page', label: "Don't Save", role: 'AXButton', container: 'dialog' };
  assert.equal((await xd.c.act('click', { target: "Don't Save", app: 'Adobe XD' })).waitingForConfirmation, true);
  assert.equal(xd.does(), 1);
});
