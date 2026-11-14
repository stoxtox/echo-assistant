// Phase 0 of the computer-use plan: observe → act → verify ("done" only when Echo saw it work),
// the focus guard and replace mode, page-scoped targeting, the Gmail recipe with its payload card,
// right-click / hover / drag / clear-field, mid-run speech that queues instead of cutting in,
// addressee v1 ("Was that for me?"), iMessage attachments, saving from a link, the clipboard, and
// Spotlight with scopes. A fake Mac app (or the simulated one, lib/evalsim.js) answers; nothing
// touches a real screen, sends anything or creates anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';

const dirs = sandbox('phase0');
const { ComputerUse, judgeStep, cleanAnswer, cleanPayload, classifyAction, isPauseCommand, midRunKind, routeSpeech, isStopCommand } = await import('../lib/computer.js');
const { ScreenBridge } = await import('../lib/screen.js');
const { saveSettings, setFixedForTest } = await import('../lib/settings.js');
const { judgeAddressee, nameAnywhere } = await import('../lib/addressed.js');
const { QuickActions } = await import('../lib/quick.js');
const { Recipes, gmailComposeUrl } = await import('../lib/recipes.js');
const { runSuite, runAddressee, STRESS_TASKS, TASKS } = await import('../lib/evalsuite.js');

const logFile = path.join(dirs.data, 'computer-log.jsonl');
const on = () => (setFixedForTest({ screenAware: false }), saveSettings({ computerUse: true, pointer: true }));

/**
 * A fake Mac app: resolves every target, and answers "do" with `did(params)`.
 * @param {{ did?: (p: any) => object, wait?: (p: any) => object, resolved?: (p: any) => object }} [o]
 */
function fakeApp({ did = () => ({}), wait = () => ({ ok: true, found: true }), resolved = () => ({}) } = {}) {
  const bridge = new ScreenBridge({ logFile: path.join(dirs.data, 'screen-log.jsonl'), timeoutMs: 500, browserTimeoutMs: 500 });
  bridge.nativeClients = () => 1;
  const seen = [];
  bridge.on('request', (r) => {
    seen.push(r);
    const p = r.params;
    let out;
    if (r.kind === 'act' && p.step === 'resolve') out = { ok: true, found: true, token: `t${seen.length}`, label: p.target || '', role: 'AXButton', app: 'Google Chrome', window: 'Inbox - Gmail', ...resolved(p) };
    else if (r.kind === 'act' && p.step === 'do') out = { ok: true, via: 'accessibility', app: 'Google Chrome', window: 'Inbox - Gmail', ...did(p) };
    else if (r.kind === 'wait') out = wait(p);
    if (out) setImmediate(() => bridge.deliver(r.id, out));
  });
  return { bridge, seen };
}

test('judgeStep: done only when the change was seen; an older app is "unchecked", never "confirmed"', () => {
  // The stricter checks are how Echo works (no switch).
  assert.deepEqual(judgeStep('click', cleanAnswer({ ok: true, verified: true, changes: ['content'] })), { done: true, verified: true });
  // The focus moving onto a button isn't the button doing anything; onto a field, it is the point.
  const focusOnly = judgeStep('click', cleanAnswer({ ok: true, verified: true, changes: ['focus'] }), { role: 'AXButton' });
  assert.equal(focusOnly.done, false);
  assert.equal(focusOnly.weak, true, 'it may have worked out of sight, so it is not to be clicked again blindly');
  assert.deepEqual(judgeStep('click', cleanAnswer({ ok: true, verified: true, changes: ['focus'] }), { role: 'AXTextField' }), { done: true, verified: true });
  // A checkbox must change its own state.
  assert.equal(judgeStep('click', cleanAnswer({ ok: true, verified: true, changes: ['focus', 'content'] }), { role: 'AXCheckBox' }).done, true);
  assert.equal(judgeStep('click', cleanAnswer({ ok: true, verified: true, changes: ['focus'] }), { role: 'AXCheckBox' }).done, false);
  assert.equal(judgeStep('press_keys', cleanAnswer({ ok: true, verified: true, changes: ['focus'] })).done, true, 'keys: any change still counts');
  // There is no looser way left: the old switch does nothing.
  process.env.ECHO_FLAG_VERIFY = '0';
  assert.equal(judgeStep('click', cleanAnswer({ ok: true, verified: true, changes: ['focus'] }), { role: 'AXButton' }).done, false);
  delete process.env.ECHO_FLAG_VERIFY;
  assert.deepEqual(judgeStep('click', cleanAnswer({ ok: true })), { done: true, verified: 'unchecked' });
  const no = judgeStep('click', cleanAnswer({ ok: true, verified: false }));
  assert.equal(no.done, false);
  assert.match(no.why, /nothing on screen changed/);
  const empty = judgeStep('type_text', cleanAnswer({ ok: true, verified: false, observed: { value: '' } }));
  assert.match(empty.why, /still empty/, 'the Sept 29 empty To field is reported as such');
  const wrong = judgeStep('type_text', cleanAnswer({ ok: true, verified: false, observed: { value: 'TomasaTomasa' } }));
  assert.match(wrong.why, /TomasaTomasa/);
});

test('an unverified step is not done, says so, and is logged as unverified', async () => {
  on();
  fs.rmSync(logFile, { force: true });
  const { bridge } = fakeApp({ did: () => ({ verified: false, changes: [], observed: { focus: 'AXGroup Message list', value: '', window: 'Inbox - Gmail' } }) });
  const c = new ComputerUse({ bridge, logFile });
  const r = await c.act('click', { target: 'Compose' });
  assert.equal(r.done, false);
  assert.equal(r.verified, false);
  assert.match(r.note, /NOT confirmed/);
  assert.match(r.note, /Don't tell the user it worked/);
  const log = fs.readFileSync(logFile, 'utf8');
  assert.match(log, /"verified":false/);
  assert.match(log, /"event":"unverified"/);
  // Verified: done, and the note says Echo saw it.
  const { bridge: b2 } = fakeApp({ did: () => ({ verified: true, changes: ['content'] }) });
  const c2 = new ComputerUse({ bridge: b2, logFile });
  const ok = await c2.act('click', { target: 'Compose' });
  assert.equal(ok.done, true);
  assert.equal(ok.verified, true);
  assert.match(ok.note, /Confirmed/);
  c.end('done');
  c2.end('done');
});

test('expect: a step whose expected text never shows up is not done', async () => {
  on();
  const { bridge, seen } = fakeApp({ did: () => ({ verified: true, changes: ['windows'] }), wait: () => ({ ok: true, found: false }) });
  const c = new ComputerUse({ bridge, logFile, expectMs: 50 });
  const r = await c.act('click', { target: 'Compose', expect: 'New Message' });
  assert.equal(r.done, false);
  assert.deepEqual(r.expected, { appears: 'New Message', found: false });
  assert.equal(seen.find((x) => x.kind === 'wait')?.params.target, 'New Message');
  c.end('done');
});

test('the focus guard: nothing typed into the wrong field, and the assistant is told how to fix it', async () => {
  on();
  const { bridge, seen } = fakeApp({ did: () => ({ ok: false, error: 'focus_guard', focused: 'AXComboBox To recipients', message: "The cursor isn't in that field." }) });
  const c = new ComputerUse({ bridge, logFile });
  const r = await c.act('type_text', { text: 'Hi Sam!', into: 'Subject', mode: 'replace' });
  assert.equal(r.error, 'focus_guard');
  assert.equal(r.done, false);
  assert.match(r.message, /Nothing was typed/);
  assert.match(r.message, /To recipients/);
  const resolve = seen.find((x) => x.params.step === 'resolve');
  assert.equal(resolve.params.target, 'Subject', 'into is the target');
  assert.equal(resolve.params.mode, 'replace');
  c.end('done');
});

test('new actions reach the app with their options: right-click, triple-click, hover, drag, clear field, scope', async () => {
  on();
  const { bridge, seen } = fakeApp({ did: () => ({ verified: true, changes: ['menu_opened'] }) });
  const c = new ComputerUse({ bridge, logFile });
  assert.equal((await c.act('click', { target: 'Budget.xlsx', button: 'right' })).done, true);
  assert.equal((await c.act('click', { target: 'Paragraph', clicks: 3 })).done, true);
  assert.equal((await c.act('hover', { target: 'Call window' })).done, true);
  assert.equal((await c.act('drag', { target: 'Budget.xlsx', to: 'Projects' })).done, true);
  assert.equal((await c.act('clear_field', { target: 'Search' })).done, true);
  assert.equal((await c.act('click', { target: 'New Tab', scope: 'browser' })).done, true);
  const does = seen.filter((x) => x.params.step === 'do').map((x) => x.params);
  assert.equal(does[0].button, 'right');
  assert.equal(does[1].clicks, 3);
  assert.equal(does[2].action, 'hover');
  assert.equal(does[3].to, 'Projects');
  assert.equal(does[4].action, 'clear_field');
  assert.equal(does[5].scope, 'browser');
  assert.equal((await c.act('drag', { target: 'x' })).error, 'no_target', 'a drag needs where to');
  assert.equal((await c.act('click', { target: 'x', button: 'middle' })).error, 'bad_button');
  c.end('done');
});

test('safety stays at least as strict: drag to the Trash asks, Return in web chat asks, clearing a password field is refused', () => {
  assert.equal(classifyAction({ action: 'drag', target: 'Budget.xlsx', to: 'Trash' }).level, 'risky');
  assert.equal(classifyAction({ action: 'drag', target: 'Budget.xlsx', to: 'Projects' }).level, 'ok');
  assert.equal(classifyAction({ action: 'hover', target: 'Call window' }).level, 'ok');
  // Enter in Slack or WhatsApp running in Chrome sends (the audit's gap).
  assert.equal(classifyAction({ action: 'press_keys', keys: 'return', resolved: { app: 'Google Chrome', window: 'general - Acme - Slack' } }).category, 'send');
  assert.equal(classifyAction({ action: 'press_keys', keys: 'return', resolved: { app: 'Google Chrome', window: 'WhatsApp' } }).category, 'send');
  assert.equal(classifyAction({ action: 'press_keys', keys: 'return', resolved: { app: 'Google Chrome', window: 'Google' } }).level, 'ok');
  assert.equal(classifyAction({ action: 'clear_field', resolved: { role: 'AXSecureTextField' } }).level, 'refuse');
  assert.equal(classifyAction({ action: 'type_text', text: 'hunter2', resolved: { subrole: 'AXSecureTextField' } }).level, 'refuse');
  assert.equal(classifyAction({ action: 'click', target: 'Send' }).category, 'send');
});

test('the payload card: what a send would send, bounded and redacted, set by recipes only', async () => {
  on();
  assert.equal(cleanPayload(null), null);
  const secret = ['sk-', 'ant-', 'api03-', 'A'.repeat(40)].join('');
  const p = cleanPayload({ kind: 'email', to: 'sam@example.com', subject: 'Hi', body: `key ${secret}`, junk: 1 });
  assert.deepEqual(Object.keys(p || {}).sort(), ['body', 'kind', 'subject', 'to']);
  assert.ok(!String(p?.body).includes(secret), 'a secret in the body never reaches the card');
  const { bridge } = fakeApp({ resolved: () => ({ label: 'Send', role: 'AXButton' }) });
  const c = new ComputerUse({ bridge, logFile });
  const cards = [];
  c.on('confirm_request', (x) => cards.push(x));
  const r = await c.act('click', { target: 'Send', payload: { kind: 'email', to: 'sam@example.com', subject: 'Lunch', body: 'See you at noon' } });
  assert.equal(r.waitingForConfirmation, true);
  assert.deepEqual(cards[0].payload, { kind: 'email', to: 'sam@example.com', subject: 'Lunch', body: 'See you at noon' });
  c.abort('test over');
});

test('"wait" pauses the request, not the session; mid-run requests queue, corrections cut in', async () => {
  for (const t of ['wait', 'Wait!', 'hold on', 'hang on a second', 'one sec', 'pause', 'just a moment']) assert.equal(isPauseCommand(t), true, t);
  for (const t of ['wait for the page', 'pause the video and open Spotify', 'stop']) assert.equal(isPauseCommand(t), false, t);
  assert.equal(isStopCommand('hold on'), false, 'a TV saying "hold on" no longer ends the session');
  assert.equal(routeSpeech({ text: 'wait', driving: true, busy: true }), 'pause');
  assert.equal(routeSpeech({ text: 'wait', driving: true, busy: false }), 'turn');
  assert.equal(midRunKind('no, the other one'), 'now');
  assert.equal(midRunKind('search for otters instead'), 'now');
  assert.equal(midRunKind('yes send it'), 'now');
  assert.equal(midRunKind('then open Spotify'), 'queue');
  assert.equal(midRunKind('then open Spotify', { answering: true }), 'now');

  on();
  const { bridge, seen } = fakeApp({ did: () => ({ verified: true, changes: ['content'] }) });
  const c = new ComputerUse({ bridge, logFile });
  c.isBusy = () => true;
  await c.act('click', { target: 'Compose' });
  c.instruct('then open Spotify');
  const r = await c.act('click', { target: 'Search results' });
  assert.equal(r.done, true, 'a queued request does not throw away the step under way: ' + JSON.stringify(r));
  assert.deepEqual(r.userSaidNext, ['then open Spotify']);
  c.instruct('no, the other one');
  const r2 = await c.act('click', { target: 'Next' });
  assert.deepEqual(r2.userSaidMidRun, ['no, the other one'], 'a correction replaces the step');
  assert.equal(seen.filter((x) => x.params.step === 'do').length, 2);
  c.end('done');
});

test('addressee v1: replies and direct questions get through, devices and TV lines do not, unsure ones ask', () => {
  const j = (text, o = {}) => judgeAddressee({ text, clarity: 'ok', ...o });
  assert.equal(j('You can send it', { driving: true, pendingQuestion: true }).decision, 'accept');
  assert.equal(j("I think that's perfect", { driving: true }).decision, 'accept');
  assert.equal(j('Tell me what you can able to do', { quiet: true }).decision, 'accept', 'a clear direct question in a quiet room');
  assert.equal(j('Tell me what you can able to do', { quiet: false }).decision, 'ask', 'with noise around: ask, never drop silently');
  assert.equal(j('Sam, Echo, open my calendar').why, 'name', 'her name anywhere');
  assert.equal(nameAnywhere('open it for me, Echo'), true);
  assert.equal(nameAnywhere('turn on the Echo Dot'), false);
  assert.notEqual(j('turn on the Echo Dot in the kitchen').decision, 'accept');
  assert.equal(j('Check this out, subscribe and hit the bell', { driving: true }).decision, 'ignore', "a video's lines");
  assert.equal(j('Madagascar, Cure, Diario, Nape').decision, 'ignore');
  assert.equal(j('wait', { driving: true }).why, 'pause');
  assert.equal(j('Can you open YouTube', { clarity: 'low', quiet: true }).decision, 'ask', 'faint: ask');
  const r = runAddressee();
  assert.ok(r.v0.falseReject < 0.05, `real replies dropped: ${r.v0.falseReject}`);
  assert.ok(r.v0.falseAccept < r.legacy.falseAccept || r.v0.falseAccept === 0, 'less room talk accepted than before');
  assert.ok(r.legacy.falseReject > 0.2, 'the old gates dropped real replies (the audit)');
});

test('iMessage with a picture: always a card, sent as a file, only the user\'s own files', async () => {
  const home = path.join(dirs.root, 'home');
  fs.mkdirSync(path.join(home, 'Pictures'), { recursive: true });
  const photo = path.join(home, 'Pictures', 'beach.jpg');
  fs.writeFileSync(photo, 'jpeg');
  const calls = [];
  const exec = async (file, args, input) => {
    calls.push({ file, args, input });
    if (input?.includes("Application('Contacts')")) return JSON.stringify([{ name: 'Sam', nickname: '', phones: [{ value: '+1 555 010 3141', label: 'mobile' }], emails: [] }]);
    return input?.includes('file transfers') ? 'finished|iMessage' : 'sent';
  };
  const q = new QuickActions({ exec, deliveryWaitMs: 60 });
  const found = await q.findContact('Sam');
  const id = found.matches[0].handles[0].id;
  q.setAlias('Sam', id);
  const r = await q.sendMessage({ to: 'Sam', text: 'the beach', direct: true, attachment: photo }, { home });
  assert.equal(r.waitingForConfirmation, true, 'a picture never goes straight out');
  assert.equal(r.attachment, 'beach.jpg');
  assert.equal(q.pendingList()[0].attachment, 'beach.jpg', 'the card shows it');
  await assert.rejects(q.sendMessage({ to: 'Sam', text: 'x', attachment: '/etc/hosts' }, { home }), /own files/);
  await assert.rejects(q.sendMessage({ to: 'Sam', text: 'x', attachment: path.join(home, '.ssh', 'id.jpg') }, { home }), /own files/);
  q.stageAttachment = () => ['/tmp/staged-beach.jpg'];
  await q.resolvePending(r.pendingId, true, 'window');
  const send = calls.find((c) => c.input?.includes('POSIX file'));
  assert.ok(send, 'sent as a file');
  assert.deepEqual(send.args.slice(-3), ['iMessage', '/tmp/staged-beach.jpg', 'alias']);
});

test('save from a link: into Downloads, never over a file, checked after; the clipboard is redacted', async () => {
  const home = path.join(dirs.root, 'home2');
  const q = new QuickActions({ exec: async (file) => (file === 'pbpaste' ? `copied ${['sk-', 'ant-', 'api03-', 'B'.repeat(40)].join('')}` : '') });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const fetchImpl = /** @type {any} */ (async () => ({ ok: true, status: 200, headers: new Map([['content-type', 'image/png'], ['content-length', String(png.length)]]), arrayBuffer: async () => png }));
  const a = await q.saveFromUrl({ url: 'https://example.com/pics/otter.png' }, { home, fetchImpl });
  assert.equal(a.saved, true);
  assert.equal(a.name, 'otter.png');
  assert.deepEqual(fs.readFileSync(path.join(home, 'Downloads', 'otter.png')), png);
  const b = await q.saveFromUrl({ url: 'https://example.com/pics/otter.png' }, { home, fetchImpl });
  assert.equal(b.name, 'otter 2.png', 'never over an existing file');
  await assert.rejects(q.saveFromUrl({ url: 'file:///etc/passwd' }, { home, fetchImpl }), /web links/);
  await assert.rejects(q.saveFromUrl({ url: 'http://localhost:4777/api/health' }, { home, fetchImpl }), /own servers/);
  const exe = /** @type {any} */ (async () => ({ ok: true, status: 200, headers: new Map([['content-type', 'application/octet-stream']]), arrayBuffer: async () => Buffer.from('MZ') }));
  await assert.rejects(q.saveFromUrl({ url: 'https://example.com/setup.exe' }, { home, fetchImpl: exe }), /not a picture/);
  const clip = await q.readClipboard();
  assert.ok(!clip.text.includes('B'.repeat(40)));
  assert.equal(clip.redacted, 1);
});

test('Spotlight with scopes: memory cards, iCloud Drive, the Finder folder; revealing in Finder', async () => {
  const home = path.join(dirs.root, 'home3');
  const vols = path.join(dirs.root, 'Volumes');
  const card = path.join(vols, 'CARD', 'DCIM');
  fs.mkdirSync(card, { recursive: true });
  fs.writeFileSync(path.join(card, 'LA-001.jpg'), 'x');
  const cloud = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
  fs.mkdirSync(cloud, { recursive: true });
  fs.writeFileSync(path.join(cloud, 'plan.pdf'), 'x');
  fs.mkdirSync(path.join(home, 'Library', 'Caches'), { recursive: true });
  fs.writeFileSync(path.join(home, 'Library', 'Caches', 'plan.pdf'), 'x');
  const calls = [];
  const exec = async (file, args, input) => {
    calls.push({ file, args, input });
    if (file === 'mdfind') {
      const root = args[1];
      return [path.join(card, 'LA-001.jpg'), path.join(cloud, 'plan.pdf'), path.join(home, 'Library', 'Caches', 'plan.pdf')].filter((p) => p.startsWith(root)).join('\n');
    }
    if (input?.includes('Finder')) return `${card}/\n`;
    return '';
  };
  const q = new QuickActions({ exec });
  const photos = await q.findFiles('LA', { home, scope: 'volumes', kind: 'image', volumesDir: vols });
  assert.deepEqual(photos.files.map((f) => f.name), ['LA-001.jpg']);
  assert.match(calls.at(-1).args[2], /kMDItemContentTypeTree == "public\.image"/, 'kind goes into the Spotlight query');
  const cloudy = await q.findFiles('plan', { home, scope: 'icloud' });
  assert.deepEqual(cloudy.files.map((f) => f.path), [path.join(cloud, 'plan.pdf')], 'iCloud Drive, but never Library caches');
  const here = await q.findFiles('LA', { home, scope: 'finder' });
  assert.equal(here.files.length, 1);
  await assert.rejects(q.findFiles('LA', { home, scope: 'volumes', volumesDir: path.join(dirs.root, 'none') }), /No drive/);
  const recent = await q.findFiles('', { home, kind: 'pdf', days: 7 });
  assert.match(calls.at(-1).args[2], /\$time\.today\(-7\)/);
  void recent;
  fs.mkdirSync(path.join(home, 'Documents'), { recursive: true });
  fs.writeFileSync(path.join(home, 'Documents', 'budget.xlsx'), 'x');
  const shown = await q.revealFile(path.join(home, 'Documents', 'budget.xlsx'), { home });
  assert.equal(shown.revealed, 'budget.xlsx');
  assert.deepEqual(calls.at(-1).args, ['-R', path.join(home, 'Documents', 'budget.xlsx')]);
  await assert.rejects(q.revealFile(path.join(home, 'Library', 'Caches', 'plan.pdf'), { home }), /own files/);
  await assert.rejects(q.openLink('javascript:alert(1)'), /only open/);
  await assert.rejects(q.openLink('facetime://x; rm -rf /'), /only open/);
  assert.deepEqual(await q.openLink('x-apple.systempreferences:com.apple.Displays-Settings.extension'), { opened: 'x-apple.systempreferences' });
});

test('the Gmail recipe: a filled-in compose link when not watching; on screen with every field checked', async (t) => {
  assert.equal(gmailComposeUrl({ to: 'sam@example.com', subject: 'Hi there', body: 'a&b' }), 'https://mail.google.com/mail/?view=cm&fs=1&to=sam%40example.com&su=Hi+there&body=a%26b');
  on();
  // The rule from before "ask by what an action does": every address is read back, dictated or
  // not (with it on, only what the user dictated is: test/policy.test.ts).
  process.env.ECHO_FLAG_POLICY = '0';
  t.after(() => delete process.env.ECHO_FLAG_POLICY);
  const opened = [];
  const { bridge, seen } = fakeApp({ did: () => ({ verified: true, changes: ['content'] }), wait: () => ({ ok: true, found: true }) });
  const c = new ComputerUse({ bridge, logFile, expectMs: 50 });
  const recipes = new Recipes({ computer: c, open: async (u) => opened.push(u) });
  // A dictated address is read back first (lib/readback.js); the user says yes.
  assert.equal((await recipes.gmailCompose({ to: 'sam@example.com', subject: 'Lunch', body: 'See you' })).needsReadBack, true);
  assert.equal(opened.length, 0);
  const readBack = (cu) => {
    cu.noteSaid("To s-a-m at example dot com, right?");
    cu.newTurn('yes');
  };
  readBack(c);
  const fast = await recipes.gmailCompose({ to: 'sam@example.com', subject: 'Lunch', body: 'See you' });
  assert.equal(fast.ok, true);
  assert.match(opened[0], /view=cm/);
  assert.ok(seen.some((x) => x.kind === 'wait'), 'checked that the draft opened');
  seen.length = 0;
  const watched = await recipes.gmailCompose({ to: 'sam@example.com', subject: 'Lunch', body: 'See you', watch: true, send: true });
  assert.equal(watched.waitingForConfirmation, true, 'Send waits for a yes');
  const targets = seen.filter((x) => x.params.step === 'resolve').map((x) => `${x.params.action}:${x.params.target || x.params.keys}`);
  assert.deepEqual(targets, ['click:Compose', 'type_text:To recipients', 'press_keys:tab', 'type_text:Subject', 'type_text:Message Body', 'click:Send']);
  assert.ok(seen.filter((x) => x.params.step === 'resolve').every((x) => x.params.action === 'press_keys' || x.params.scope === 'page'), 'in the page, never Chrome\'s own controls');
  c.abort('test over');
  // A step that didn't work stops the recipe, and it says which.
  const { bridge: b2 } = fakeApp({ did: (p) => (p.action === 'type_text' ? { verified: false, observed: { value: '' } } : { verified: true, changes: ['content'] }) });
  const c2 = new ComputerUse({ bridge: b2, logFile, expectMs: 50 });
  readBack(c2);
  const failed = await new Recipes({ computer: c2, open: async () => {} }).gmailCompose({ to: 'sam@example.com', subject: 'x', watch: true });
  assert.equal(failed.ok, false);
  assert.equal(failed.failedAt, 'to');
  c2.end('done');
});

test('eval harness: Phase 0 targets on the 30-task suite, and the stress set never lies', async () => {
  on();
  assert.equal(TASKS.length, 30);
  const now = await runSuite('v0', { logFile });
  const legacy = await runSuite('legacy', { logFile });
  assert.ok(now.metrics.successRate >= 0.7, `success ${now.metrics.successRate}`);
  assert.ok(now.metrics.falseSuccessRate < 0.03, `false success ${now.metrics.falseSuccessRate}`);
  assert.ok(now.metrics.medianSteps <= 6);
  assert.ok(now.metrics.medianSeconds <= 40);
  assert.ok(legacy.metrics.falseSuccess > 0, 'the old driver claimed success it did not have (the audit)');
  const stress = await runSuite('v0', { logFile, tasks: STRESS_TASKS });
  assert.equal(stress.metrics.falseSuccess, 0, 'what it cannot do yet, it says');
});

test('the Mac app: clean keys, the matched element (not a centre hit-test), page scope, verify after acting', () => {
  const src = (f) => fs.readFileSync(path.join(import.meta.dirname, '..', 'macos', 'Sources', f), 'utf8');
  const driver = src('Driver.swift');
  const postText = driver.slice(driver.indexOf('private func postText'), driver.indexOf('/// Typing key by key didn'));
  assert.match(postText, /e\.flags = \[\]/, 'typed text never carries a modifier');
  assert.match(postText, /KeyMath\.code\(for: run\)/, 'on the real key');
  assert.match(postText, /case \.key\(let code\):\s*postKey\(CGKeyCode\(code\), flags: \[\]\)/, 'tabs (and Return in a terminal) as real keys');
  assert.match(postText, /case \.softBreak:\s*postKey\(36, flags: \.maskShift\)/, 'a line break is Shift+Return: it never sends a chat message');
  assert.match(driver, /returnBreaks = NSRunningApplication\(processIdentifier: r\.pid\)\.map \{ KeyMath\.returnApps\.contains/, 'Return only in a terminal');
  assert.match(driver, /if !flags\.isEmpty \{ clearModifiers\(\) \}/, 'a shortcut releases its modifiers');
  assert.match(driver, /finish\(hit\.element \?\? self\.elementAt\(hit\.frame\)/, 'acts on what matched');
  assert.match(driver, /let before = snapshot\(r\.pid, target: r\.element\)/, 'observes before acting');
  assert.match(driver, /out\["verified"\] = !changes\.isEmpty/, 'and verifies after');
  assert.match(driver, /self\.postClick\(at: f, count: count, button: "left", flags: mods\)\s*verified\("accessibility\+events"/, 'a press that changed nothing is retried as a real click');
  assert.match(driver, /private func focusField\(/, 'the focus guard');
  assert.match(driver, /"AXShowMenu"/, 'right-click uses the context-menu action first');
  const pointer = src('Pointer.swift');
  assert.match(pointer, /if scope == "page", let w = focusedWindow \{/, 'a browser: its page only');
  assert.match(pointer, /for i in 2\.\.\.\(role == "AXStaticText" \? 6 : 5\)/, 'field values are not labels');
  const menubar = src('MenuBar.swift');
  assert.match(menubar, /return !menuBar && isExtraName\(target\) && !wantsField \? find\(target, seconds: 0\.6\) : nil/, "a miss never goes to other apps' status icons");
});

test('a click that only moved the focus is not done, and the assistant is told to look, not to click again', async () => {
  on();
  const { bridge, seen } = fakeApp({ did: () => ({ verified: true, changes: ['focus'] }) });
  const c = new ComputerUse({ bridge, logFile });
  const r = await c.act('click', { target: 'Align Left' });
  assert.equal(r.done, false);
  assert.match(r.note, /do NOT just click it again/);
  assert.equal(seen.filter((x) => x.kind === 'act' && x.params.step === 'do').length, 1, 'clicked once');
  const log = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(log.some((e) => e.event === 'unverified' && e.weak === true));
  c.end('done');
});

test('expect: something already on screen before the action proves nothing, and says so', async () => {
  on();
  const { bridge, seen } = fakeApp({ did: () => ({ verified: true, changes: ['content'] }), wait: () => ({ ok: true, found: true }) });
  const c = new ComputerUse({ bridge, logFile, expectMs: 50 });
  const r = await c.act('click', { target: 'Bold', expect: 'Formatting' });
  assert.equal(r.done, true);
  assert.equal(r.expected.alreadyThere, true);
  assert.match(r.expected.note, /on screen before the action too/);
  const waits = seen.filter((x) => x.kind === 'wait');
  assert.equal(waits.length, 2, 'looked once before and once after');
  assert.ok(waits[0].params.timeoutMs <= 300, 'the look before is quick');
  assert.ok(seen.indexOf(waits[0]) < seen.findIndex((x) => x.kind === 'act' && x.params.step === 'do'), 'before the action');
  c.end('done');
});

test('what each click should change (lib/agent/verify.js)', async () => {
  const { expectedChange, postcondition } = await import('../lib/agent/verify.js');
  assert.equal(expectedChange('type_text', 'AXTextField'), null, 'typing is checked by reading the field back');
  assert.equal(expectedChange('press_keys', undefined), null);
  assert.deepEqual(postcondition('click', 'AXSwitch', ['target_state']), { ok: true });
  assert.equal(postcondition('click', 'AXSwitch', ['focus']).ok, false);
  assert.equal(postcondition('click', 'AXPopUpButton', ['menu_opened']).ok, true);
  assert.equal(postcondition('click', 'AXButton', ['menu_closed']).ok, true, 'a menu item or a button that closed a menu did something');
  assert.equal(postcondition('click', 'AXButton', []).ok, false);
  assert.match(String(postcondition('click', 'AXButton', ['focus']).why), /only focus changed/);
  assert.deepEqual(postcondition('click', 'AXButton', undefined), { ok: true }, 'an app that reports no changes list is judged as before');
});

test('typing is always read back exactly, and a switch is never clicked a second time (there is no switch for it)', async () => {
  const { FLAGS } = await import('../lib/flags.ts');
  assert.equal('verify' in FLAGS, false, 'the stricter checks are not a switch any more');
  on();
  const { bridge, seen } = fakeApp({ did: () => ({ verified: true, changes: ['value'] }) });
  const c = new ComputerUse({ bridge, logFile });
  await c.act('type_text', { target: 'Subject', text: 'Hello' });
  const strict = seen.filter((x) => x.kind === 'act' && x.params.step === 'do').at(-1);
  assert.equal(strict?.params.strict, true, 'a Mac app from before Oct 3 is still asked for the exact check');
  c.end('done');
  const src = (f) => fs.readFileSync(path.join(import.meta.dirname, '..', 'macos/Sources', f), 'utf8');
  const swift = src('Driver.swift');
  // The Mac app no longer has a looser path to fall back to.
  assert.doesNotMatch(swift, /strictChecks/);
  assert.match(swift, /if toggle \{\n\s+return verify\(r, before: before, started: started, seconds: 1\.2\)/);
  assert.match(swift, /VerifyMath\.typed\(text, into: value, replaced: replaced, before: fieldBefore, suggested: suggested\)/);
  const typed = src('PointMath.swift').split('static func typed(')[1].split('\n  }')[0];
  assert.doesNotMatch(typed, /strict/, 'one way to check typed text: exactly');
  assert.match(typed, /if replaced \{ return have == want/);
});

test('a shortcut that changed nothing: no menu lists it, or it is a menu item to check (never pressed twice)', async () => {
  const none = judgeStep('press_keys', cleanAnswer({ ok: true, verified: false, changes: [], shortcutListed: false, menuShortcuts: ['File > New Chat (cmd+n)', 'File > New Window (shift+cmd+n)'] }), { keys: 'cmd+t' });
  assert.equal(none.done, false);
  assert.match(String(none.why), /no menu in this app lists cmd\+t[\s\S]*File > New Chat \(cmd\+n\)[\s\S]*click the menu item by name/);
  const listed = judgeStep('press_keys', cleanAnswer({ ok: true, verified: false, changes: [], menuItem: 'File > New Chat' }), { keys: 'cmd+n' });
  assert.match(String(listed.why), /which is the menu item "File > New Chat"\. Look at the screen first/);
  assert.match(judgeStep('press_keys', cleanAnswer({ ok: true, verified: false })).why, /nothing visible changed after the keys/);
  const swift = fs.readFileSync(path.join(import.meta.dirname, '..', 'macos/Sources/Driver.swift'), 'utf8');
  assert.match(swift, /if changes\.isEmpty, flags\.contains\(\.maskCommand\) \{\n\s+let items = self\.menuShortcuts\(r\.pid\)/);
  assert.doesNotMatch(swift.slice(swift.indexOf('private func menuShortcuts')), /AXUIElementPerformAction\(item/, 'the menu item is never pressed for a shortcut');
});
