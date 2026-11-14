// What Echo says after a message is sent: only what it knows. osascript is faked: nothing here
// talks to Messages or Contacts, and nothing is sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';

const dirs = sandbox('delivered');
const { QuickActions, deliveryWords, describeDelivery, fileState, fileAttempts } = await import('../lib/quick.js');
const { Dispatcher } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');

const NUMBER = '+1 555 010 3141';
const home = path.join(dirs.root, 'home');
const photo = path.join(home, 'Pictures', 'beach.jpg');
fs.mkdirSync(path.dirname(photo), { recursive: true });
fs.writeFileSync(photo, 'jpeg');

/**
 * A fake Mac. `send`: what the words script answers (or an error to throw); `file`: what each
 * try at sending the file answers (or throws; the last repeats); `transfer`: what Messages says
 * about the file each time it is asked (the last answer repeats).
 * @param {{ send?: any, file?: any[], transfer?: string[] }} [o]
 */
function fakeMac({ send = 'sent', file = ['sent'], transfer = ['finished|iMessage'] } = {}) {
  const calls = [];
  let looks = 0;
  let tries = 0;
  const answer = (a) => {
    if (a instanceof Error) throw a;
    return a;
  };
  const exec = async (bin, args, input) => {
    calls.push({ file: bin, args, input });
    if (input.includes("Application('Contacts')")) return JSON.stringify([{ name: 'Sam', nickname: '', phones: [{ value: NUMBER, label: 'mobile' }], emails: [] }]);
    if (input.includes('file transfers')) return transfer[Math.min(looks++, transfer.length - 1)];
    if (input.includes('POSIX file')) return answer(file[Math.min(tries++, file.length - 1)]);
    if (input.includes('tell application "Messages"')) return answer(send);
    throw new Error('unexpected script');
  };
  /** The tries at sending the file, as [path, form]; and how many times the words were sent. */
  const fileTries = () => calls.filter((c) => c.input.includes('POSIX file')).map((c) => c.args.slice(-2));
  const textSends = () => calls.filter((c) => c.input.includes('send theText')).length;
  return { exec, calls, looks: () => looks, fileTries, textSends };
}
const refusal = () => Object.assign(new Error('x'), { stderr: 'Messages got an error: Can’t get file (-1728)' });
const STAGED = ['/tmp/in-messages/staged-beach.jpg', '/tmp/in-pictures/staged-beach.jpg'];

/** Echo with one favorite, "Sam". */
async function echo(mac) {
  fs.rmSync(path.join(dirs.data, 'quick-actions.log'), { force: true });
  const q = new QuickActions({ exec: mac.exec, deliveryWaitMs: 60 });
  q.stageAttachment = () => STAGED;
  // On this Mac the look at Messages' transfers has been seen to work (see the last test for a Mac where it hasn't).
  q.lookProven = true;
  const found = await q.findContact('Sam');
  q.setAlias('Sam', found.matches[0].handles[0].id);
  return q;
}
const log = () => fs.readFileSync(path.join(dirs.data, 'quick-actions.log'), 'utf8');
const sendPhoto = async (q, text = 'the beach') => {
  const card = await q.sendMessage({ to: 'Sam', text, attachment: photo }, { home });
  return q.resolvePending(card.pendingId, true, 'voice');
};

test('each state has its own words, and only "delivered" says it arrived', () => {
  assert.equal(deliveryWords('delivered'), 'delivered');
  assert.equal(deliveryWords('sent'), 'sent, not delivered yet');
  assert.equal(deliveryWords('sms'), 'went as a text message (SMS), not iMessage');
  assert.equal(deliveryWords('failed'), 'NOT delivered: Messages shows an error');
  assert.equal(deliveryWords('unknown'), "sent; delivery can't be checked from here");
  assert.equal(deliveryWords('something new'), deliveryWords('unknown'), 'a state we do not know is never a claim');
  for (const s of ['sent', 'sms', 'failed', 'unknown']) assert.doesNotMatch(deliveryWords(s), /^delivered|got it|went through/);
  // A failure or a fallback comes with one next step; an unknown with how to check; delivered with neither.
  assert.match(describeDelivery({ text: 'failed' }).next, /other number/);
  assert.match(describeDelivery({ text: 'sms' }).next, /Text Message Forwarding/);
  assert.match(describeDelivery({ text: 'unknown' }).check, /Delivered/);
  assert.deepEqual(describeDelivery({ text: 'delivered' }), { state: 'delivered', delivery: 'delivered' });
});

test('what Messages says about a file becomes a state', () => {
  assert.equal(fileState('failed|iMessage'), 'failed');
  assert.equal(fileState('finished|SMS'), 'sms', 'asked for iMessage, left as SMS');
  assert.equal(fileState('finished|iMessage'), 'unknown', 'it left this Mac; that is not delivered');
  assert.equal(fileState('transferring|iMessage'), 'sent');
  assert.equal(fileState('none'), 'not_attached', 'Messages has no transfer for it: it never attached');
  assert.equal(fileState(''), 'unknown');
});

test('a plain text send says sent, never delivered: Messages cannot be asked', async () => {
  const mac = fakeMac();
  const q = await echo(mac);
  const r = await q.sendMessage({ to: 'Sam', text: 'hi', direct: true });
  assert.equal(r.sent, true);
  assert.equal(r.state, 'unknown');
  assert.equal(r.delivery, "sent; delivery can't be checked from here");
  assert.match(r.check, /Delivered/);
  assert.equal(mac.looks(), 0, 'no waiting when there is nothing to watch');
  // Asked for as SMS: it is reported as a text message, not iMessage.
  const sms = await q.sendMessage({ to: 'Sam', text: 'hi', direct: true, sms: true });
  assert.equal(sms.delivery, 'went as a text message (SMS), not iMessage');
});

test('a photo that falls back to SMS is reported as SMS, with one next step', async () => {
  const mac = fakeMac({ transfer: ['transferring|iMessage', 'finished|SMS'] });
  const r = await sendPhoto(await echo(mac));
  assert.equal(r.state, 'sms');
  assert.equal(r.delivery, 'went as a text message (SMS), not iMessage');
  assert.match(r.next, /Text Message Forwarding/);
  assert.equal(mac.looks(), 2, 'it stops looking once Messages has an answer');
  assert.match(log(), /"state":"sms"/);
});

test('a failed photo says NOT delivered, apart from the words that went', async () => {
  const r = await sendPhoto(await echo(fakeMac({ transfer: ['failed|iMessage'] })));
  assert.equal(r.state, 'failed');
  assert.equal(r.attachmentState, 'failed');
  assert.equal(r.textState, 'unknown');
  assert.match(r.delivery, /the words: sent; delivery can't be checked from here\. The file beach\.jpg: NOT delivered/);
  assert.match(r.next, /Don't resend/);
  assert.equal(r.fileAttached, true, 'it attached, then failed');
  assert.equal(r.label, 'Text sent · file not delivered');
  // The reverse: the file went, the words did not.
  const reverse = await sendPhoto(await echo(fakeMac({ send: refusal() })));
  assert.match(reverse.delivery, /the words: NOT delivered.*The file beach\.jpg: sent; delivery can't be checked/);
  assert.equal(reverse.label, 'File sent · text not sent');
});

test('unknown never claims delivery, and the wait is short', async () => {
  // Messages answers nothing useful, or only that the file left this Mac: still "can't be checked", never "delivered".
  for (const transfer of [['garbage'], ['finished|iMessage']]) {
    const r = await sendPhoto(await echo(fakeMac({ transfer })));
    assert.equal(r.state, 'unknown');
    assert.doesNotMatch(JSON.stringify(r), /"delivered"|: delivered/);
    assert.equal(r.fileAttached, true);
    assert.equal(r.label, undefined, 'the card reads Sent as before');
  }
  // A file still on its way after the whole wait: "sent, not delivered yet", within the cap.
  const mac = fakeMac({ transfer: ['transferring|iMessage'] });
  const q = await echo(mac);
  const t = Date.now();
  const r = await sendPhoto(q);
  assert.ok(Date.now() - t < 1000, 'it never waits longer than the cap');
  assert.equal(r.attachmentState, 'sent');
  assert.ok(mac.looks() <= 4);
  // A status script that hangs is cut off at the cap too.
  const slow = fakeMac();
  const exec = slow.exec;
  const q2 = await echo(slow);
  q2.exec = (file, args, input) => (input.includes('file transfers') ? new Promise(() => {}) : exec(file, args, input));
  assert.equal((await sendPhoto(q2)).state, 'unknown');
  assert.equal(slow.fileTries().length, 1, 'Messages cannot be asked: no second try, which could send the file twice');
});

test('the words go first, then the file on its own; a transfer that appears is reported as before', async () => {
  const mac = fakeMac({ transfer: ['none', 'transferring|iMessage', 'finished|iMessage'] });
  const r = await sendPhoto(await echo(mac));
  const scripts = mac.calls.filter((c) => c.input.includes('tell application "Messages"') && !c.input.includes('file transfers'));
  assert.match(scripts[0].input, /send theText/);
  assert.deepEqual(scripts[0].args.slice(-2), ['the beach', 'iMessage']);
  assert.match(scripts[1].input, /POSIX file thePath as alias/);
  assert.deepEqual(mac.fileTries(), [[STAGED[0], 'alias']], 'the first form attached: no other is tried');
  assert.equal(r.sent, true);
  assert.equal(r.state, 'unknown');
  assert.equal(r.delivery, "sent; delivery can't be checked from here");
  assert.equal(r.fileAttached, true);
  assert.equal(r.label, undefined);
  // Nothing of the user's is spliced into a script: the number, words and path only ride on argv.
  for (const c of scripts) assert.ok(!/beach|555|staged/.test(c.input));
});

test('a file Messages never starts sending did NOT attach: every form is tried, then the plain truth', async () => {
  const mac = fakeMac({ transfer: ['none'] });
  const q = await echo(mac);
  const seen = [];
  q.on('confirm_resolved', (r) => seen.push(r));
  const r = await sendPhoto(q);
  assert.deepEqual(mac.fileTries(), [[STAGED[0], 'alias'], [STAGED[1], 'alias'], [STAGED[1], 'posix']], 'each copy as an alias, then the Pictures copy as a POSIX file');
  assert.equal(mac.textSends(), 1, 'the words are never sent twice');
  assert.equal(r.state, 'not_attached');
  assert.equal(r.attachmentState, 'not_attached');
  assert.equal(r.fileAttached, false);
  assert.equal(r.label, 'Text sent · file not attached');
  assert.equal(r.delivery, 'The words were sent, but the file did NOT attach: Messages never started sending it.');
  assert.match(r.next, /AirDrop if they are nearby, or email it/);
  assert.match(r.next, /Don't resend/);
  assert.equal(r.check, undefined);
  assert.doesNotMatch(r.delivery, /file[^.]*\bsent\b|delivered/i, 'no claim the file went');
  // The card in the window gets the same result.
  assert.equal(seen[0].fileAttached, false);
  assert.equal(seen[0].label, 'Text sent · file not attached');
  // The record says so too, and message_status repeats it later even when Messages has forgotten.
  const line = JSON.parse(log().trim().split('\n').at(-1));
  assert.equal(line.fileState, 'not_attached');
  assert.equal(line.state, 'not_attached');
  assert.equal(line.tries, 3);
  const s = await q.messageStatus({ to: 'Sam' });
  assert.equal(s.messages[0].state, 'not_attached');
  assert.match(s.messages[0].delivery, /did NOT attach/);
  assert.match(s.next, /AirDrop/);
});

test('a later form that works stops the tries', async () => {
  // The first form is refused outright, the second is taken but never attaches, the third attaches.
  const mac = fakeMac({ file: [refusal(), 'sent', 'sent'], transfer: ['none', 'none', 'none', 'transferring|iMessage', 'finished|iMessage'] });
  const r = await sendPhoto(await echo(mac));
  assert.deepEqual(mac.fileTries().map((t) => t[1]), ['alias', 'alias', 'posix']);
  assert.equal(r.fileAttached, true);
  assert.equal(r.state, 'unknown');
  // Only the first form was needed here: the second and third are never run.
  const first = fakeMac({ file: [refusal(), 'sent'], transfer: ['transferring|iMessage', 'finished|iMessage'] });
  await sendPhoto(await echo(first));
  assert.deepEqual(first.fileTries(), [[STAGED[0], 'alias'], [STAGED[1], 'alias']]);
});

test('Messages refusing the file outright: not attached with the words, a failed send without', async () => {
  const mac = fakeMac({ file: [refusal()] });
  const r = await sendPhoto(await echo(mac));
  assert.equal(r.attachmentState, 'not_attached');
  assert.equal(r.label, 'Text sent · file not attached');
  assert.equal(mac.looks(), 0, 'nothing to watch');
  // A file on its own that never attaches is nothing sent: an error, and the card says Not sent.
  for (const o of [{ file: [refusal()] }, { transfer: ['none'] }]) {
    const q = await echo(fakeMac(o));
    const seen = [];
    q.on('confirm_resolved', (x) => seen.push(x));
    await assert.rejects(sendPhoto(q, ''), /did NOT attach|Messages gave an error/);
    assert.equal(seen[0].sent, false);
    assert.match(log(), /"event":"message_failed"/);
    assert.doesNotMatch(log(), /"event":"message_sent"/);
  }
  // A file on its own that does attach still works.
  const alone = fakeMac();
  const ok = await sendPhoto(await echo(alone), '');
  assert.equal(alone.textSends(), 0);
  assert.equal(ok.sent, true);
  assert.equal(ok.delivery, "the file beach.jpg: sent; delivery can't be checked from here");
  assert.equal(ok.fileAttached, true);
});

test('the file is staged where Messages can read it, under one unique name', () => {
  const q = new QuickActions({ exec: async () => '' });
  const copies = q.stageAttachment(photo, { home });
  assert.equal(copies.length, 2);
  assert.ok(copies[0].startsWith(path.join(home, 'Library', 'Messages', 'Attachments', 'Echo') + path.sep));
  assert.ok(copies[1].startsWith(path.join(home, 'Pictures', 'Echo Attachments') + path.sep));
  assert.equal(path.basename(copies[0]), path.basename(copies[1]));
  assert.match(path.basename(copies[0]), /^[a-z0-9]+-beach\.jpg$/);
  for (const c of copies) assert.equal(fs.readFileSync(c, 'utf8'), 'jpeg');
  assert.deepEqual(fileAttempts(['/a/x', '/b/x']), [['/a/x', 'alias'], ['/b/x', 'alias'], ['/b/x', 'posix']]);
  assert.deepEqual(fileAttempts('/b/x'), [['/b/x', 'alias'], ['/b/x', 'posix']]);
});

test('a send Messages refuses is still an error, not a delivery report', async () => {
  const q = await echo(fakeMac({ send: Object.assign(new Error('x'), { stderr: 'Messages got an error: Can’t get account (-1728)' }) }));
  await assert.rejects(q.sendMessage({ to: 'Sam', text: 'hi', direct: true }), /Messages gave an error/);
  const s = await q.messageStatus({ to: 'Sam' });
  assert.equal(s.messages[0].state, 'failed');
  assert.match(s.messages[0].delivery, /NOT sent/);
});

test('message_status answers from the record: masked number, states, no message text', async () => {
  const mac = fakeMac({ transfer: ['finished|iMessage'] });
  const q = await echo(mac);
  assert.match((await q.messageStatus({ to: 'Sam' })).note, /has not sent this person anything/);
  await q.sendMessage({ to: 'Sam', text: 'the secret plan', direct: true });
  await q.sendMessage({ to: 'Sam', text: 'the second secret', direct: true, sms: true });
  await sendPhoto(q, 'a third secret');
  // Later the photo fails in Messages (the chat fell back): asking again sees it.
  const later = fakeMac({ transfer: ['failed|SMS'] });
  q.exec = later.exec;
  const before = log().length;
  const s = await q.messageStatus({ to: 'Sam', count: 2 });
  assert.equal(s.masked, '•••3141');
  assert.equal(s.messages.length, 2, 'the newest two');
  assert.equal(s.messages[0].state, 'failed');
  assert.equal(s.messages[0].attachment, 'beach.jpg');
  assert.equal(s.messages[1].delivery, 'went as a text message (SMS), not iMessage');
  assert.match(s.next, /other number/);
  assert.match(s.note, /only messages Echo sent/);
  const out = JSON.stringify(s);
  assert.ok(!/secret/.test(out), 'no message text comes back');
  assert.ok(!out.includes('555') && !out.includes('010'), 'no full number');
  // Its own log line: who (masked), how many, which states. No text, no number.
  const line = JSON.parse(log().slice(before).trim());
  assert.deepEqual(line.states, { failed: 1, sms: 1 });
  assert.deepEqual(Object.keys(line).sort(), ['at', 'count', 'event', 'masked', 'states', 'to']);
  assert.equal(line.masked, '•••3141');
  await assert.rejects(q.messageStatus({ to: 'Nobody' }), /find_contact/);
});

test('the tools and the prompt carry it to the assistant', async () => {
  const mac = fakeMac();
  const q = await echo(mac);
  const d = new Dispatcher(new TaskManager({ queryFn: async function* () {} }), null, q);
  const p = d.systemPrompt();
  assert.match(p, /Only "delivered" means they got it/);
  assert.match(p, /never "they just got it"/);
  assert.match(p, /offer one next step/);
  assert.match(p, /never resend on your own/);
  assert.match(p, /message_status, not by looking at the screen/);
  assert.match(p, /did NOT attach.*never say the file was sent/);
  const tools = /** @type {any[]} */ (d.quickTools());
  const sent = await tools.find((t) => t.name === 'send_imessage').handler({ to: 'Sam', text: 'hi', direct: true }, {});
  assert.match(sent.content[0].text, /"delivery":"sent; delivery can't be checked from here"/);
  const status = await tools.find((t) => t.name === 'message_status').handler({ to: 'Sam' }, {});
  assert.match(status.content[0].text, /"masked":"•••3141"/);
  assert.ok(!status.content[0].text.includes('"hi"'));
});

test('on a Mac where the look has never seen a transfer, "no transfer" is not believed: one try, and "can\'t tell"', async () => {
  fs.rmSync(path.join(dirs.data, 'messages-look.json'), { force: true });
  const mac = fakeMac({ transfer: ['none'] });
  const q = await echo(mac);
  q.lookProven = undefined; // as on a fresh install: read from the data folder, where nothing says it works
  const r = await sendPhoto(q);
  assert.equal(mac.fileTries().length, 1, 'never sent a second time on a guess');
  assert.notEqual(r.attachmentState, 'not_attached');
  assert.doesNotMatch(JSON.stringify(r), /did NOT attach/);
  assert.equal(fs.existsSync(path.join(dirs.data, 'messages-look.json')), false);
  // The first real transfer it sees proves the look, and it is remembered.
  const works = fakeMac({ transfer: ['finished|iMessage'] });
  const q2 = await echo(works);
  q2.lookProven = undefined;
  await sendPhoto(q2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dirs.data, 'messages-look.json'), 'utf8')).seen, true);
  const q3 = await echo(fakeMac({ transfer: ['none'] }));
  q3.lookProven = undefined;
  assert.equal((await sendPhoto(q3)).attachmentState, 'not_attached', 'now "no transfer" means what it says');
});
