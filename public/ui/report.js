// The "more" menu → Save a report (lib/diagnostics.js): the whole report
// shown first, then saved to Downloads (and shown in Finder). Nothing is sent anywhere.
import { $, el, button, actionButton, postJson, toast } from './dom.js';
import { openModal, closeModal } from './modal.js';

$('reportBtn')?.addEventListener('click', async () => {
  let report;
  try {
    report = await (await fetch('/api/diagnostics')).json();
  } catch {
    return toast("Couldn't make the report.");
  }
  const pre = el('pre', { className: 'diff' }, JSON.stringify(report, null, 2));
  const save = actionButton('Save to Downloads', 'ok', async () => {
    try {
      const r = await postJson('/api/diagnostics/save', { made: report.made });
      closeModal();
      toast(`Saved: ${r.file}`);
    } catch (e) {
      toast(/** @type {Error} */ (e).message);
    }
  });
  openModal('A report for whoever helps you', [el('p', {}, 'This is everything in it. Nothing is sent anywhere: you choose who gets the file.'), pre], [button('Cancel', 'ghost', closeModal), save]);
});
