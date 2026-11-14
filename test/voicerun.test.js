// Talking to Echo while she drives the Mac (lib/computer.js, lib/dispatcher.js): "stop" ends the
// run like Escape; anything else is handed to the assistant on its next step (the step itself
// isn't done), a wait in progress ends early, and a word the assistant never got to becomes a new
// request. Steps are narrated. The user's voice never counts as taking back control with the
// mouse or keyboard. Plus the permission helpers and stable signing of the Mac app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { sandbox, fakeQuery, serverSource, pageSource } from './helpers.js';

const dirs = sandbox('voicerun');
const { ComputerUse, isStopCommand, routeSpeech, narration, computerPrompt } = await import('../lib/computer.js');
const { ScreenBridge } = await import('../lib/screen.js');
const { Dispatcher } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');
const { saveSettings, getSettings, setFixedForTest } = await import('../lib/settings.js');
const { privacyPaneUrl, PRIVACY_PANES, QuickActions } = await import('../lib/quick.js');
const { describeSigning, LOCAL_IDENTITY, BUNDLE_ID } = await import('../lib/appsign.js');

const logFile = path.join(dirs.data, 'computer-log.jsonl');
const root = path.join(import.meta.dirname, '..');

/** A fake Mac app that finds and does everything; waits never find anything unless told. */
function fakeApp({ waitFound = false } = {}) {
  const bridge = new ScreenBridge({ logFile: path.join(dirs.data, 'screen-log.jsonl'), timeoutMs: 2000, browserTimeoutMs: 500 });
  bridge.nativeClients = () => 1;
  const seen = [];
  bridge.on('request', (r) => {
    seen.push(r);
    const p = r.params;
    let out;
    if (r.kind === 'act' && p.step === 'resolve') out = { ok: true, found: true, token: 't', label: p.target || '', role: 'AXButton', app: 'Google Chrome', window: 'New Tab' };
    else if (r.kind === 'act' && p.step === 'do') out = { ok: true, via: 'accessibility', app: 'Google Chrome', window: 'New Tab' };
    else if (r.kind === 'wait') {
      // A slow page: the answer only comes after the chunk's time-out.
      setTimeout(() => bridge.deliver(r.id, { ok: true, found: waitFound }), Math.min(1500, p.timeoutMs));
      return;
    }
    if (out) setImmediate(() => bridge.deliver(r.id, out));
  });
  const does = () => seen.filter((r) => r.kind === 'act' && r.params.step === 'do');
  return { bridge, seen, does };
}

const on = () => (setFixedForTest({ screenAware: false }), saveSettings({ computerUse: true, pointer: true }));

test('"stop" is recognised on its own, not inside a new instruction', () => {
  for (const t of ['stop', 'Stop.', 'Stop!', 'stop it', 'Stop now', 'okay stop', 'Echo, stop!', 'hey echo stop', 'no stop', 'stop stop', 'Stop, stop!', 'wait, stop', "That's enough.", 'That’s enough', 'cancel', 'never mind', 'abort', 'stop driving', 'please stop'])
    assert.equal(isStopCommand(t), true, t);
  for (const t of ['', 'stop at the second result', 'no, search for otters instead', 'go back', 'open Claude now', "don't stop", 'stop the music and open Spotify', 'bus stop near me', 'cancel my 3pm meeting in the calendar'])
    assert.equal(isStopCommand(t), false, t);
});

test('routing: stop, a mid-run instruction, or an ordinary turn', () => {
  assert.equal(routeSpeech({ text: 'stop', driving: true, busy: true }), 'stop');
  assert.equal(routeSpeech({ text: 'stop', driving: true, busy: false }), 'stop', 'a stop counts even while she waits for a yes');
  assert.equal(routeSpeech({ text: 'no, search for otters instead', driving: true, busy: true }), 'instruct');
  assert.equal(routeSpeech({ text: 'yes, send it', driving: true, busy: false }), 'turn', 'her turn is over: an answer is a turn');
  assert.equal(routeSpeech({ text: 'stop', driving: false, busy: true }), 'turn', 'not driving: an ordinary turn');
  assert.equal(routeSpeech({ text: 'open Claude now', driving: false, busy: false }), 'turn');
});

test('a mid-run instruction replaces the next step, which is not done, and the run carries on', async () => {
  on();
  const { bridge, does } = fakeApp();
  const c = new ComputerUse({ bridge, logFile });
  assert.equal((await c.act('click', { target: 'New Tab' })).done, true);
  const runId = c.run?.id;
  c.instruct('no, search for otters instead');
  const r = await c.act('type_text', { text: 'cats', into: 'Search' });
  assert.equal(r.done, false);
  assert.deepEqual(r.userSaidMidRun, ['no, search for otters instead']);
  assert.match(r.note, /Nothing was done/);
  assert.equal(does().length, 1, 'the stale step never reached the app');
  // Not a take-back: the same run goes on, and the next step works.
  assert.equal(c.blocked, null);
  assert.equal(c.run?.id, runId);
  assert.equal((await c.act('type_text', { text: 'otters', into: 'Search' })).done, true);
  assert.equal(does().length, 2);
  // It's logged without the words.
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const inst = lines.find((l) => l.event === 'instruction');
  assert.ok(inst && inst.chars > 0 && !JSON.stringify(inst).includes('otters'));
});

test('a mid-run instruction ends a wait_for early', async () => {
  on();
  const { bridge } = fakeApp();
  const c = new ComputerUse({ bridge, logFile });
  const started = Date.now();
  const waiting = c.act('wait_for', { target: 'Results', timeout_seconds: 20 });
  setTimeout(() => c.instruct('go back'), 100);
  const r = await waiting;
  assert.ok(Date.now() - started < 1400, 'it did not sit out the wait');
  assert.deepEqual(r.userSaidMidRun, ['go back']);
});

test('saying stop ends the run like Escape; the voice itself never stops a run', async () => {
  on();
  const { bridge } = fakeApp();
  const tasks = new TaskManager({ queryFn: fakeQuery(() => []).queryFn });
  const c = new ComputerUse({ bridge, logFile });
  const d = new Dispatcher(tasks, null, undefined, bridge, c);
  const pushed = [];
  d.input = /** @type {any} */ ({ push: (m) => pushed.push(m), size: 0 });
  const hushes = [];
  const aborted = [];
  d.on('hush', () => hushes.push(1));
  c.on('aborted', (a) => aborted.push(a.reason));
  // Mid-run: the assistant's turn is going and Echo is driving.
  d.setBusy(true);
  await c.act('click', { target: 'New Tab' });
  assert.equal(c.driving, true);
  // "no, search for X instead" goes to the next step, not a new turn, and doesn't end the run.
  assert.equal(d.send('no, search for otters instead'), 'instruct');
  assert.equal(pushed.length, 0);
  assert.equal(c.driving, true);
  assert.equal(c.blocked, null, 'talking is not taking back control');
  // "stop" ends it at once.
  assert.equal(d.send('Stop!'), 'stop');
  assert.equal(c.driving, false);
  assert.deepEqual(aborted, ['said stop']);
  assert.equal(hushes.length, 1, 'Echo stops talking too');
  const r = await c.act('click', { target: 'New Tab' });
  assert.equal(r.error, 'stopped');
  assert.equal(c.takeInstructions().length, 0, 'what was waiting is dropped');
});

test('an instruction the assistant never got to becomes a new request when its turn ends', async () => {
  on();
  const { bridge } = fakeApp();
  const c = new ComputerUse({ bridge, logFile });
  const d = new Dispatcher(new TaskManager({ queryFn: fakeQuery(() => []).queryFn }), null, undefined, bridge, c);
  const pushed = [];
  d.input = /** @type {any} */ ({ push: (m) => pushed.push(m), size: 0 });
  d.setBusy(true);
  await c.act('click', { target: 'New Tab' });
  assert.equal(d.send('open Claude now'), 'instruct');
  d.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0, session_id: 's' });
  assert.equal(pushed.length, 1);
  assert.match(String(pushed[0]), /open Claude now/);
  assert.equal(d.busy, true, 'a new turn started');
});

test('a spoken yes mid-run counts as the user speaking after a confirmation card', async () => {
  on();
  const { bridge } = fakeApp();
  const c = new ComputerUse({ bridge, logFile });
  const card = await c.act('click', { target: 'Send' });
  assert.ok(card.waitingForConfirmation);
  assert.equal((await c.confirm(card.confirmId, true, 'voice')).error, 'not_yet');
  c.instruct('yes, send it');
  c.takeInstructions();
  const r = await c.confirm(card.confirmId, true, 'voice');
  assert.equal(r.done, true);
});

test('each step is narrated as it happens, briefly and without secrets', async () => {
  on();
  const { bridge } = fakeApp({ waitFound: true });
  const c = new ComputerUse({ bridge, logFile });
  const said = [];
  c.on('say', (t) => said.push(t));
  await c.act('click', { target: 'Chrome', say: 'Opening Chrome…' });
  await c.act('type_text', { text: 'otters', into: 'Search', say: 'Searching…' });
  await c.act('wait_for', { target: 'Results', say: 'Waiting for results…' });
  await c.act('press_keys', { keys: 'cmd+t' }); // no narration given: nothing said
  assert.deepEqual(said, ['Opening Chrome…', 'Searching…', 'Waiting for results…']);
  assert.equal(narration('   '), '');
  assert.ok(narration('x'.repeat(200)).length <= 60);
  const prompt = computerPrompt({ computerUse: true, pointer: true });
  assert.match(prompt, /Narrate as you go/);
  assert.match(prompt, /userSaidMidRun/);
  assert.match(prompt, /say in a sentence what you see/);
});

test('the page listens during a run without any key or mouse input', () => {
  const app = pageSource();
  assert.match(app, /syncRunListen\(Boolean\(msg\.driving\)\)/);
  assert.match(app, /case 'hush': hush\(\)/);
  // The run-listen capture is the mic only: nothing in it sends key or mouse events to the app.
  const block = app.slice(app.indexOf('function autoOpened'), app.indexOf('function syncRunListen'));
  assert.doesNotMatch(block, /toApp\(|computer_stop|dispatchEvent/);
  // The Mac app only stops a run on real input events (key presses, clicks, scrolls, mouse moves).
  const driver = fs.readFileSync(path.join(root, 'macos', 'Sources', 'Driver.swift'), 'utf8');
  assert.match(driver, /\.keyDown, \.leftMouseDown/);
  assert.doesNotMatch(driver, /microphone|AVAudio/i);
  assert.equal(getSettings().listenDuringRuns, true);
});

test('permission settings: the exact Privacy panes', async () => {
  assert.equal(privacyPaneUrl('screen'), 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  assert.equal(privacyPaneUrl('accessibility'), 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  assert.equal(privacyPaneUrl('input'), 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent');
  assert.equal(privacyPaneUrl('toString'), '', 'only known panes');
  assert.equal(privacyPaneUrl('nope'), '');
  assert.ok(PRIVACY_PANES.microphone);
  const opened = [];
  const q = new QuickActions({ exec: async (cmd, args) => { opened.push([cmd, ...args]); return ''; } });
  await q.openPrivacySettings('input');
  assert.deepEqual(opened, [['open', 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent']]);
  await assert.rejects(q.openPrivacySettings('constructor'));
  const server = serverSource();
  assert.match(server, /'GET \/api\/permissions\/app'/);
});

test('how the app is signed, in plain words', () => {
  const adhoc = describeSigning('Executable=/x\nIdentifier=local.echo.app\nFormat=app bundle\nSignature=adhoc\nTeamIdentifier=not set');
  assert.equal(adhoc.stable, false);
  assert.equal(adhoc.adhoc, true);
  assert.match(adhoc.message, /ad hoc/);
  const local = describeSigning(`Identifier=local.echo.app\nAuthority=${LOCAL_IDENTITY}\nTeamIdentifier=not set`);
  assert.equal(local.stable, true);
  assert.match(local.message, /keeps these permissions/);
  const dev = describeSigning('Identifier=local.echo.app\nAuthority=Apple Development: Someone (X)\nAuthority=Apple Root CA');
  assert.equal(dev.authority, 'Apple Development: Someone (X)');
  assert.equal(describeSigning('code object is not signed at all').signed, false);
  assert.equal(BUNDLE_ID, 'local.echo.app');
});

test('the build signs with a stable identity and keeps the bundle id', () => {
  const sh = fs.readFileSync(path.join(root, 'scripts', 'build-app.sh'), 'utf8');
  const plist = fs.readFileSync(path.join(root, 'macos', 'Info.plist'), 'utf8');
  assert.match(plist, /<string>local\.echo\.app<\/string>/);
  // Apple certificates first, then the local one, made once.
  const dev = sh.indexOf('"Developer ID Application"');
  const apple = sh.indexOf('"Apple Development"', dev);
  assert.ok(dev > 0 && apple > dev, 'Developer ID, then Apple Development');
  assert.match(sh, /LOCAL_IDENTITY="Echo Local Signing"/);
  assert.match(sh, /extendedKeyUsage = critical, codeSigning/);
  assert.match(sh, /security login-keychain/);
  assert.match(sh, /security" import|security import/);
  assert.match(sh, /codesign --force --sign "\$SIGN_ID"/);
  // Ad hoc only as the fallback (or for a shared --dist build).
  const adhocAt = sh.indexOf('--sign - --timestamp=none "$BUILD"');
  assert.ok(adhocAt > sh.indexOf('if [ "$signed" = 0 ]'), 'ad hoc is only the fallback');
  assert.equal(sh.match(/--sign -/g)?.length, 2, 'no other ad hoc signing');
  const docs = fs.readFileSync(path.join(root, 'docs', 'mac-permissions.md'), 'utf8');
  assert.match(docs, /Echo Local Signing/);
  assert.match(docs, /Privacy_ScreenCapture/);
  assert.match(docs, /Privacy_Microphone/);
  // ECHO_SIGN_IDENTITY=local always picks the self-signed identity, skipping any Apple certificate.
  assert.match(sh, /if \[ "\$want" != local \]; then\n    for prefix in "Developer ID Application"/);
  assert.match(docs, /ECHO_SIGN_IDENTITY=local/);
});

test('--identity says which identity a build would use, without making one', { skip: process.platform !== 'darwin' }, async () => {
  const { execFileSync } = await import('node:child_process');
  const sh = path.join(root, 'scripts', 'build-app.sh');
  const env = { ...process.env, ECHO_SIGN_KEYCHAIN: path.join(os.tmpdir(), 'no-such-echo-test.keychain-db') };
  assert.equal(execFileSync('bash', [sh, '--identity'], { env: { ...env, ECHO_SIGN_IDENTITY: '-' } }).toString().trim(), 'ad hoc (-)');
  // "local" with no local certificate yet: --identity never creates one, so it reports ad hoc.
  assert.equal(execFileSync('bash', [sh, '--identity'], { env: { ...env, ECHO_SIGN_IDENTITY: 'local' } }).toString().trim(), 'ad hoc (-)');
});
