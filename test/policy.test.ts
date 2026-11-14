// Stage 2: Echo asks by what an action does (lib/policy.ts, the policy flag), in four tiers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { sandbox } from './helpers.js';

const dirs = sandbox('policy');
const { classifyByEffect, SAY_SO_CATEGORIES } = await import('../lib/policy.ts');
const { classifyAction, ComputerUse } = await import('../lib/computer.js');
const { commandIntent, intentMatches } = await import('../lib/spokenintent.js');
const { ScreenBridge } = await import('../lib/screen.js');
const { saveSettings, setFixedForTest } = await import('../lib/settings.js');

const click = (label: string, role: string, app: string, window = '') => ({ action: 'click', target: label, resolved: { label, role, app, window } });
const tier = (req: any) => classifyByEffect(req).tier;

test('tier 1: undoable edits never ask, whatever their label says (the Oct 1 XD cards)', () => {
  for (const [label, role] of [['Apply Corner Radius All', 'AXTextField'], ['Apply Stroke', 'AXCheckBox'], ['Apply Drop Shadow', 'AXCheckBox'], ['Join thousands of people who plan smarter and finish faster.', 'AXStaticText'], ['Delete after sending', 'AXCheckBox']] as const) {
    assert.equal(classifyAction(click(label, role, 'Adobe XD')).level, 'risky', `before: ${label} asked`);
    assert.deepEqual(classifyByEffect(click(label, role, 'Adobe XD')), { level: 'ok', tier: 1 }, label);
  }
  assert.equal(tier({ action: 'scroll', direction: 'down' }), 1);
  assert.equal(tier({ action: 'type_text', text: 'Get started', resolved: { role: 'AXTextField', app: 'Adobe XD' } }), 1);
  assert.equal(tier(click('Rectangle', 'AXButton', 'Adobe XD')), 1);
});

test('tier 2: saving, closing, quitting and deleting ask unless the user said exactly that', () => {
  for (const keys of ['cmd+s', 'shift+cmd+s', 'Command+S']) assert.deepEqual([tier({ action: 'press_keys', keys, app: 'Adobe XD' }), classifyByEffect({ action: 'press_keys', keys, app: 'Adobe XD' }).category], [2, 'save'], keys);
  assert.equal(classifyAction({ action: 'press_keys', keys: 'cmd+s', app: 'Adobe XD' }).level, 'ok', 'before: ⌘S went through without asking');
  for (const keys of ['cmd+w', 'cmd+q']) assert.equal(classifyByEffect({ action: 'press_keys', keys, app: 'TextEdit' }).category, 'close', keys);
  assert.equal(classifyByEffect(click('Save', 'AXMenuItem', 'TextEdit')).category, 'save');
  assert.equal(classifyByEffect(click('Save As…', 'AXMenuItem', 'TextEdit')).category, 'save');
  assert.equal(classifyByEffect(click('Quit TextEdit', 'AXMenuItem', 'TextEdit')).category, 'close');
  assert.equal(classifyByEffect(click("Don't Save", 'AXButton', 'TextEdit')).category, 'close');
  assert.deepEqual([tier(click('Move to Trash', 'AXMenuItem', 'Finder')), classifyByEffect(click('Move to Trash', 'AXMenuItem', 'Finder')).category], [2, 'delete']);
  assert.deepEqual(SAY_SO_CATEGORIES, ['delete', 'save', 'close'], 'sending is never one of them');
});

test('tier 3: sending, buying, submitting, accounts, settings, the Terminal always ask', () => {
  assert.equal(tier(click('Send', 'AXButton', 'Mail')), 3);
  assert.equal(tier(click('Place your order', 'AXButton', 'Google Chrome', 'Checkout')), 3);
  assert.equal(tier(click('Submit', 'AXButton', 'Google Chrome')), 3);
  assert.equal(tier(click('Sign in', 'AXButton', 'Safari')), 3);
  assert.equal(tier(click('Wi-Fi', 'AXCheckBox', 'System Settings')), 3, 'a switch in System Settings changes the Mac');
  assert.equal(tier({ action: 'type_text', text: 'git push origin main', app: 'Terminal', resolved: { app: 'Terminal' } }), 3);
  assert.equal(tier({ action: 'press_keys', keys: 'return', app: 'Messages', resolved: { app: 'Messages', window: 'Sam' } }), 3, 'Return in a chat sends');
});

test('tier 4: never (passwords, the privacy settings, moving money), handed to the user', () => {
  assert.deepEqual([classifyByEffect({ action: 'type_text', text: 'hunter2', resolved: { role: 'AXSecureTextField', app: 'Safari' } }).level, tier({ action: 'type_text', text: 'hunter2', resolved: { role: 'AXSecureTextField', app: 'Safari' } })], ['refuse', 4]);
  assert.equal(tier(click('Send money', 'AXButton', 'Google Chrome')), 4);
  assert.equal(tier(click('Transfer funds', 'AXButton', 'Safari')), 4);
});

test('"save it", "close the window", "quit XD" approve that one tier-2 action; "send it" never does', () => {
  const save = commandIntent('save it');
  assert.equal(save?.category, 'save');
  assert.equal(commandIntent('save')?.category, 'save', 'one open document: plain "save" is clear');
  assert.equal(commandIntent('quit XD')?.category, 'close');
  assert.equal(commandIntent("don't save it"), null);
  const at = { turn: 3, now: 1000, app: 'Adobe XD', window: 'Landing page', label: '' };
  const intent = (text: string) => ({ ...(commandIntent(text) as any), turn: 3, at: 900 });
  const opts = { preapprovable: SAY_SO_CATEGORIES };
  assert.deepEqual(intentMatches(intent('save it'), { ...at, category: 'save' }, opts), { ok: true, why: 'it' });
  assert.deepEqual(intentMatches(intent('quit XD'), { ...at, category: 'close' }, opts), { ok: true, why: 'named' });
  assert.equal(intentMatches(intent('quit Safari'), { ...at, category: 'close' }, opts).ok, false, 'a different app');
  assert.equal(intentMatches(intent('save it'), { ...at, category: 'close' }, opts).ok, false, 'save never approves a close');
  assert.equal(intentMatches(intent('save it'), { ...at, turn: 4, category: 'save' }, opts).ok, false, 'this turn only');
  assert.equal(intentMatches(intent('send it to Sam'), { ...at, category: 'send', to: 'Sam' }, opts).ok, false, 'sending always asks now');
  assert.equal(intentMatches(intent('save it'), { ...at, category: 'save' }).ok, false, 'without the policy flag, saving was never pre-approved');
});

test('end to end with the flag on: XD fields act at once, ⌘S asks, "save it" saves', async () => {
  (setFixedForTest({ screenAware: true }), saveSettings({ computerUse: true, pointer: true }));
  process.env.ECHO_FLAG_POLICY = '1';
  try {
    const bridge: any = new ScreenBridge({ logFile: path.join(dirs.data, 'screen-log.jsonl'), timeoutMs: 500, browserTimeoutMs: 500 });
    bridge.nativeClients = () => 1;
    const seen: any[] = [];
    let role = 'AXTextField';
    bridge.on('request', (r: any) => {
      seen.push(r);
      const p = r.params;
      let out;
      if (r.kind === 'act' && p.step === 'resolve') out = { ok: true, found: true, token: `t${seen.length}`, label: p.target || '', role, app: 'Adobe XD', window: 'Landing page' };
      else if (r.kind === 'act' && p.step === 'do') out = { ok: true, via: 'accessibility', app: 'Adobe XD', window: 'Landing page', verified: true, changes: ['value'] };
      if (out) setImmediate(() => bridge.deliver(r.id, out));
    });
    const c: any = new ComputerUse({ bridge, logFile: path.join(dirs.data, 'computer-log.jsonl') });
    const cards: any[] = [];
    c.on('confirm_request', (x: any) => cards.push(x));
    const does = () => seen.filter((r) => r.kind === 'act' && r.params.step === 'do').length;
    c.newTurn('make the corners rounder');
    const r1 = await c.act('click', { target: 'Apply Corner Radius All', app: 'Adobe XD' });
    assert.equal(cards.length, 0, 'no card for an edit field');
    assert.equal(r1.waitingForConfirmation, undefined);
    assert.equal(does(), 1);
    role = 'AXWindow';
    const r2 = await c.act('press_keys', { keys: 'cmd+s', app: 'Adobe XD' });
    assert.equal(r2.waitingForConfirmation, true, 'saving asks when nobody said to');
    assert.equal(cards.at(-1)?.category, 'save');
    c.newTurn('save it');
    const r3 = await c.act('press_keys', { keys: 'cmd+s', app: 'Adobe XD' });
    assert.equal(r3.preapproved, true, 'the user said "save it"');
  } finally {
    delete process.env.ECHO_FLAG_POLICY;
  }
});
