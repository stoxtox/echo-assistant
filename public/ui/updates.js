// Updates (lib/updater.js), split out of public/app.js: the version line in Settings, the
// "Update available" card, checking, installing and going back to the previous version.
import { $, el, button, actionButton, toast, postJson } from './dom.js';
import { openModal, closeModal } from './modal.js';
import { pref } from './prefs.js';
import { selfStatus } from './selfimprove.js';

/** The restart screen (app.js), shown while Echo installs or goes back. */
let showRestarting = (_text, _sub) => {};
/** @param {(text: string, sub?: string) => void} fn */
export const setRestartScreen = (fn) => void (showRestarting = fn);

let updateStatus = null;
let pageVersion = null; // the version this page was loaded from; a newer server means reload
const PHASES = { checking: 'Checking…', downloading: 'Downloading…', verifying: 'Checking the download…', installing: 'Installing…', restarting: 'Restarting…' };
export function setUpdateStatus(st, notice) {
  if (!st) return;
  if (pageVersion && st.current !== pageVersion) { location.reload(); return; }
  pageVersion ||= st.current;
  updateStatus = st;
  $('updVersion').textContent = `Updates · Echo ${st.current}`;
  $('settingsVersion').textContent = `Echo ${st.current}${st.developer ? ' · developer copy' : ''}`;
  const hint = $('updHint');
  const state = $('updState');
  $('updCheck').hidden = st.developer || !st.configured;
  const back = $('updRollback');
  back.hidden = st.developer || !st.previous;
  back.textContent = st.previous ? `Go back to ${st.previous}` : 'Go back';
  if (st.developer) {
    state.textContent = '· Developer copy';
    hint.textContent = `This copy is a git checkout, so it updates through git${selfStatus.available ? ' and self-improve' : ''}, not from releases.`;
  } else if (!st.configured) {
    state.textContent = '';
    hint.textContent = "Updates aren't set up for this copy.";
  } else {
    const pct = st.phase === 'downloading' && typeof st.progress === 'number' ? ` ${Math.round(st.progress * 100)}%` : '';
    state.textContent = PHASES[st.phase] ? `· ${PHASES[st.phase]}${pct}` : st.available ? `· ${st.latest.version} is available` : st.checkedAt ? '· Up to date' : '';
    hint.textContent = st.error || (st.checkedAt ? `Last checked ${new Date(st.checkedAt).toLocaleString()}.` : 'Echo checks for updates once a day.');
  }
  const card = $('updateCard');
  const dismissed = pref.get('updateLater', '') === st.latest?.version;
  card.hidden = !(st.available && (!dismissed || PHASES[st.phase] || st.phase === 'error'));
  card.classList.toggle('is-working', Boolean(PHASES[st.phase]));
  if (st.available) {
    $('updateTitle').textContent = `Update available: v${st.latest.version}`;
    $('updateSub').textContent = PHASES[st.phase] ? `${PHASES[st.phase]}${st.phase === 'downloading' && typeof st.progress === 'number' ? ` ${Math.round(st.progress * 100)}%` : ''}` : st.phase === 'error' ? st.error : `You have ${st.current}.`;
    $('updateNotes').textContent = st.latest.notes || 'No notes for this release.';
    $('updateNotesWrap').hidden = !st.latest.notes;
  }
  if (notice?.kind === 'updated') toast(`Echo was updated to ${notice.to}.`);
  if (notice?.kind === 'rolled_back') toast(`The update to ${notice.from} didn't start properly, so Echo went back to ${notice.to}.`);
}
export async function checkForUpdates() {
  try {
    const res = await fetch('/api/update/check', { method: 'POST' });
    const st = await res.json();
    if (!res.ok) throw new Error(st.error || 'Check failed');
    pref.set('updateLater', '');
    setUpdateStatus(st);
    if (!st.developer && !st.available) toast(`Echo ${st.current} is up to date.`);
  } catch (e) {
    toast(e.message);
  }
}
async function installUpdate() {
  try {
    const res = await fetch('/api/update/apply', { method: 'POST' });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || 'Update failed');
    if (out.updated) showRestarting(`Installing Echo ${out.to}…`, 'Running tasks pause and pick up where they left off.');
    else toast('Echo is already up to date.');
  } catch (e) {
    toast(e.message);
  }
}
async function rollbackUpdate() {
  const st = updateStatus;
  if (!st?.previous) return;
  const pinIn = el('input', { type: 'password', inputMode: 'numeric', className: 'pin-in', placeholder: '••••', autocomplete: 'off' });
  const err = el('div', { className: 'err', role: 'alert' });
  const go = actionButton(`Go back to ${st.previous}`, 'danger', async () => {
    try {
      await postJson('/api/update/rollback', { pin: pinIn.value });
      closeModal();
      showRestarting(`Going back to Echo ${st.previous}…`);
    } catch (e) {
      err.textContent = e.message;
    }
  });
  const body = [el('p', {}, `Echo ${st.current} is replaced by the version you had before (${st.previous}). Your data and settings stay as they are.`)];
  if (selfStatus.hasPin) body.push(el('label', { className: 'field' }, 'Your PIN'), pinIn);
  body.push(err);
  openModal('Go back to the previous version?', body, [button('Cancel', 'ghost', closeModal), go], { narrow: true, onEnter: () => go.click() });
}
$('updCheck').onclick = checkForUpdates;
$('updRollback').onclick = rollbackUpdate;
$('updateNow').onclick = installUpdate;
$('updateLater').onclick = () => { pref.set('updateLater', updateStatus?.latest?.version || ''); $('updateCard').hidden = true; };
