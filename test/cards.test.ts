// Stage 2: confirmation cards that hold (policy flag): a card stops the plan, an approved step goes
// to what was approved or nowhere, only dictated details are read back, and moving on drops a card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { sandbox } from './helpers.js';

const dirs = sandbox('cards');
const { ComputerUse, sameTarget, dictated } = await import('../lib/computer.js');
const { ScreenBridge } = await import('../lib/screen.js');
const { saveSettings, setFixedForTest } = await import('../lib/settings.js');
(setFixedForTest({ screenAware: true }), saveSettings({ computerUse: true, pointer: true }));

/** A fake Mac app: `screen()` says what's at the target right now. */
function rig(screen: () => { label: string; role: string; app?: string; window?: string }) {
  const bridge: any = new ScreenBridge({ logFile: path.join(dirs.data, 'screen-log.jsonl'), timeoutMs: 500, browserTimeoutMs: 500 });
  bridge.nativeClients = () => 1;
  const seen: any[] = [];
  bridge.on('request', (r: any) => {
    seen.push(r);
    const p = r.params;
    let out;
    const s = screen();
    if (r.kind === 'act' && p.step === 'resolve') out = { ok: true, found: true, token: `t${seen.length}`, label: s.label, role: s.role, app: s.app || 'Mail', window: s.window || 'New Message' };
    else if (r.kind === 'act' && p.step === 'do') out = { ok: true, via: 'accessibility', app: s.app || 'Mail', window: s.window || 'New Message', verified: true, changes: ['window_title'] };
    if (out) setImmediate(() => bridge.deliver(r.id, out));
  });
  const c: any = new ComputerUse({ bridge, logFile: path.join(dirs.data, 'computer-log.jsonl'), confirmSettleMs: 0 });
  const cards: any[] = [];
  c.on('confirm_request', (x: any) => cards.push(x));
  return { c, cards, does: () => seen.filter((r) => r.kind === 'act' && r.params.step === 'do').length };
}

const withPolicy = async (fn: () => Promise<void>) => {
  process.env.ECHO_FLAG_POLICY = '1';
  try {
    await fn();
  } finally {
    delete process.env.ECHO_FLAG_POLICY;
  }
};

test('a waiting card stops the plan: nothing else happens on the Mac until it is answered', () =>
  withPolicy(async () => {
    const { c, cards, does } = rig(() => ({ label: 'Send', role: 'AXButton' }));
    c.newTurn('write to Sam that I am late');
    const r1 = await c.act('click', { target: 'Send', app: 'Mail' });
    assert.equal(r1.waitingForConfirmation, true);
    const r2 = await c.act('click', { target: 'Subject', app: 'Mail' });
    assert.equal(r2.error, 'waiting_for_confirmation');
    assert.equal(r2.confirmId, cards[0].id);
    assert.equal(does(), 0);
    const yes = await c.confirm(cards[0].id, true, 'window');
    assert.equal(yes.done, true, 'the yes goes through');
    assert.equal(does(), 1);
  }));

test('switched off in Labs, a card does not hold the plan (as before)', async (t) => {
  process.env.ECHO_FLAG_POLICY = '0';
  t.after(() => delete process.env.ECHO_FLAG_POLICY);
  const { c } = rig(() => ({ label: 'Send', role: 'AXButton' }));
  c.newTurn('write to Sam');
  await c.act('click', { target: 'Send', app: 'Mail' });
  const r2 = await c.act('click', { target: 'Subject', app: 'Mail' });
  assert.notEqual(r2.error, 'waiting_for_confirmation');
});

test('an approved step goes to what was approved, or nowhere (the screen changed)', () =>
  withPolicy(async () => {
    let now = { label: 'Send', role: 'AXButton' };
    const { c, cards, does } = rig(() => now);
    c.newTurn('send the draft');
    await c.act('click', { target: 'Send', app: 'Mail' });
    now = { label: 'Properties Inspector', role: 'AXScrollArea' };
    const r = await c.confirm(cards[0].id, true, 'window');
    assert.equal(r.error, 'target_changed');
    assert.equal(r.done, false);
    assert.equal(does(), 0, 'nothing was clicked');
  }));

test('the same target, judged by app, role and name', () => {
  const b = { label: 'Send', role: 'AXButton', app: 'Mail', window: 'New Message' };
  assert.equal(sameTarget(b, { label: 'send ', role: 'AXButton', app: 'Mail' }), true);
  assert.equal(sameTarget(b, { label: 'Send', role: 'AXMenuItem', app: 'Mail' }), false);
  assert.equal(sameTarget(b, { label: 'Send', role: 'AXButton', app: 'Messages' }), false);
  assert.equal(sameTarget(b, { label: 'Send Later', role: 'AXButton', app: 'Mail' }), false);
});

test('only what the user dictated is read back; a value Echo chose is not', () => {
  assert.equal(dictated('111827', 'make the headline darker'), false, 'a color Echo picked');
  assert.equal(dictated('5551234567', 'call 555 123 4567'), true);
  assert.equal(dictated('5551234567', 'call five five five one two three'), true, 'number words count');
  assert.equal(dictated('sam.lee@example.com', 'email sam lee at example dot com'), true);
  assert.equal(dictated('sam.lee@example.com', 'email Sam about lunch'), false, 'Echo looked the address up');
});

test('type_text: the hex color goes straight in; the dictated number still asks', () =>
  withPolicy(async () => {
    const { c } = rig(() => ({ label: 'Fill', role: 'AXTextField', app: 'Adobe XD', window: 'Landing page' }));
    c.newTurn('make the headline darker');
    const color = await c.act('type_text', { text: '111827', target: 'Fill', app: 'Adobe XD' });
    assert.equal(color.needsReadBack, undefined);
    c.newTurn('type my number 555 123 4567 in the phone field');
    const phone = await c.act('type_text', { text: '5551234567', target: 'Fill', app: 'Adobe XD' });
    assert.equal(phone.needsReadBack, true);
  }));

test('moving on drops a waiting card; a yes or a no answers it instead', () =>
  withPolicy(async () => {
    const { c, cards } = rig(() => ({ label: 'Send', role: 'AXButton' }));
    c.newTurn('send it');
    await c.act('click', { target: 'Send', app: 'Mail' });
    assert.equal(c.pending.size, 1);
    c.newTurn('yes');
    assert.equal(c.pending.size, 1, 'a yes is the answer, not moving on');
    c.newTurn('actually, make the title bigger');
    assert.equal(c.pending.size, 0, 'moved on: the card goes');
    assert.ok(cards.length >= 1);
  }));
