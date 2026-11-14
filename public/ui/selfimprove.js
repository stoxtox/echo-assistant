// Self-improve mode (split out of public/app.js): the unlock prompt that needs a person at this
// screen, the review of a change, Merge & restart, and the PIN.
import { $, el, button, actionButton, segmentedInput, step, postJson } from './dom.js';
import { openModal, closeModal, onModalClosed, modalShowing } from './modal.js';
import { tasks, setReviewActions } from './tasks.js';

/** The request the unlock prompt on screen is for. */
let shownRequest = null;
/** The assistant's name, for the prompt (set by app.js from the settings). */
let assistantName = () => 'Echo';
/** @param {() => string} fn */
export const setAssistantName = (fn) => void (assistantName = fn);
const els = { selfBadge: $('selfBadge'), selfTimer: $('selfTimer'), restartOverlay: $('restartOverlay') };

export let selfStatus = { available: false, unlocked: false, hasPin: false };
let selfTimer = null;
export function setSelfStatus(st) {
  if (!st) return;
  selfStatus = st;
  els.selfBadge.hidden = !st.unlocked;
  clearInterval(selfTimer);
  if (st.unlocked) {
    const tick = () => {
      const s = Math.max(0, Math.round((Date.parse(st.expiresAt) - Date.now()) / 1000));
      els.selfTimer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    tick();
    selfTimer = setInterval(tick, 1000);
  }
  // Only the developer's copy of Echo can self-improve; elsewhere the PIN guards reset and rollback only.
  const dev = st.available !== false;
  if (dev && st.pendingRequest && (!modalShowing() || (modalShowing() === 'unlock' && shownRequest !== st.pendingRequest.id))) showUnlock(st.pendingRequest);
  else if (!st.pendingRequest && modalShowing() === 'unlock') closeModal(); // answered or expired elsewhere
}
els.selfBadge.onclick = () => postJson('/api/self/lock', {});

// Unlocking needs a human at this screen: type the code shown here (plus the PIN, if set).
// It can't be done by voice, so it can't be triggered by a mishearing or someone overhearing.
export function showUnlock(req) {
  if (selfStatus.available === false) return; // not the developer copy: no self-improve, no unlock box
  const len = req.code.length;
  const codeStatus = el('div', { className: 'step-status' }, `Type the ${len} characters shown above.`);
  const codeShow = el('div', { className: 'code-show' });
  codeShow.setAttribute('aria-label', `Code: ${req.code.split('').join(' ')}`);
  codeShow.append(...req.code.split('').map((ch) => el('span', {}, ch)));
  const segs = segmentedInput(len, (v) => {
    const done = v.length === len;
    const ok = done && v === req.code;
    step1.classList.toggle('done', ok);
    step1.classList.toggle('bad', done && !ok);
    codeStatus.textContent = ok ? 'Code matches.' : done ? "That doesn't match the code above. Check each character." : `Type the ${len} characters shown above.`;
    if (ok) (req.needsPin ? pinIn : confirm).focus();
  });
  const step1 = step(1, 'Type this code', [codeShow, el('label', {}, 'Your entry'), segs.el, codeStatus]);

  const pinIn = el('input', { type: 'password', inputMode: 'numeric', className: 'pin-in', placeholder: '••••', autocomplete: 'off', id: 'unlockPin' });
  const pinStatus = el('div', { className: 'step-status' }, 'Your Echo PIN.');
  pinIn.addEventListener('input', () => { pinIn.classList.remove('invalid'); step2.classList.remove('bad'); pinStatus.textContent = 'Your Echo PIN.'; });
  const step2 = step(2, 'Enter your PIN', [pinIn, pinStatus]);
  const err = el('div', { className: 'err', role: 'alert' });

  const body = [
    el('p', {}, `${assistantName()} wants to edit its own code:`),
    el('div', { className: 'instruction' }, req.instruction),
    el('p', { className: 'hint' }, `It works on a separate branch, and nothing changes until you review the diff and click Merge. The unlock lasts 30 minutes or one task, whichever comes first.${req.firstTime ? ' First time only: Echo will create a git repository with a baseline commit.' : ''}`),
    step1,
    ...(req.needsPin ? [step2] : []),
    err,
  ];
  const submit = async () => {
    err.textContent = '';
    const code = segs.value();
    if (code !== req.code) {
      step1.classList.add('bad');
      codeStatus.textContent = code.length < len ? `Type all ${len} characters of the code.` : "That doesn't match the code above. Check each character.";
      segs.focus();
      return;
    }
    if (req.needsPin && !pinIn.value.trim()) {
      step2.classList.add('bad');
      pinIn.classList.add('invalid');
      pinStatus.textContent = 'Enter your PIN to continue.';
      pinIn.focus();
      return;
    }
    try {
      await postJson('/api/self/confirm', { requestId: req.id, code, pin: pinIn.value });
      closeModal();
    } catch (e) {
      // The code was checked above, so a rejection here is the PIN (or an expired request).
      if (req.needsPin && /PIN/.test(e.message)) {
        step2.classList.add('bad');
        pinIn.classList.add('invalid');
        pinStatus.textContent = "That PIN isn't right. Too many wrong tries locks self-improve for 15 minutes.";
        pinIn.select();
      } else err.textContent = e.message;
    }
  };
  const confirm = actionButton('Unlock & start', 'ok', submit);
  const cancel = button('Cancel', 'ghost', async () => {
    await postJson('/api/self/cancel', {}).catch(() => {});
    closeModal();
  });
  openModal('Allow self-improvement?', body, [cancel, confirm], { narrow: true, onEnter: () => confirm.click(), locked: true, hint: 'Enter to confirm', kind: 'unlock' });
  shownRequest = req.id;
  segs.focus();
}

export async function showDiff(taskId) {
  const review = await fetch(`/api/self/diff?taskId=${taskId}`).then((r) => r.json());
  const pre = el('pre', { className: 'diff' });
  for (const line of (review.diff || '').split('\n')) {
    const cls = line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : '';
    pre.append(el('span', { className: cls }, line + '\n'));
  }
  const checks = Object.entries(review.checks || {}).map(([k, v]) => {
    const d = el('details');
    d.append(el('summary', {}, `${k}: ${v.ok ? 'passed' : 'FAILED'}`), el('pre', { className: 'diff' }, v.output));
    return d;
  });
  openModal(`Self-improvement #${taskId}: changes`, [el('pre', { className: 'review-stat' }, review.stat), ...checks, pre], [
    button('Close', 'ghost', closeModal),
    button('Merge & restart', 'ok', () => confirmMerge(taskId)),
  ]);
}

export function confirmMerge(taskId) {
  const t = tasks.get(taskId);
  const failed = Object.entries(t?.self?.review?.checks || {}).filter(([, v]) => !v.ok).map(([k]) => k);
  const pinIn = el('input', { type: 'password', inputMode: 'numeric', className: 'pin-in', placeholder: '••••', autocomplete: 'off', id: 'mergePin' });
  const err = el('div', { className: 'err', role: 'alert' });
  pinIn.addEventListener('input', () => { pinIn.classList.remove('invalid'); err.textContent = ''; });
  const body = [
    el('p', {}, 'This merges the change into the live Echo and restarts it. Running tasks are paused and resumed automatically. If the new version fails its health check, Echo rolls back on its own.'),
    ...(failed.length ? [el('p', { className: 'err' }, `Warning: ${failed.join(' and ')} failed for this change.`)] : []),
    ...(selfStatus.hasPin ? [el('label', { className: 'field', htmlFor: 'mergePin' }, 'Enter your PIN'), pinIn] : []),
    err,
  ];
  const merge = actionButton('Merge & restart', 'ok', async () => {
    if (selfStatus.hasPin && !pinIn.value.trim()) {
      pinIn.classList.add('invalid');
      err.textContent = 'Enter your PIN to merge.';
      pinIn.focus();
      return;
    }
    try {
      await postJson('/api/self/merge', { taskId, pin: pinIn.value });
      closeModal();
      els.restartOverlay.hidden = false;
    } catch (e) {
      if (/PIN/.test(e.message)) pinIn.classList.add('invalid');
      err.textContent = e.message;
    }
  });
  openModal('Merge and restart?', body, [button('Cancel', 'ghost', closeModal), merge], { narrow: true, onEnter: () => merge.click(), hint: 'Enter to merge' });
  (selfStatus.hasPin ? pinIn : merge).focus();
}

setReviewActions({ diff: showDiff, merge: confirmMerge });
// A self-improve confirmation that's still waiting comes back once another dialog closes.
onModalClosed((was) => {
  const req = selfStatus.pendingRequest;
  if (was !== 'unlock' && selfStatus.available !== false && req && Date.parse(req.expiresAt) > Date.now()) showUnlock(req);
});
