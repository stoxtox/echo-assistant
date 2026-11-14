// Settings → You & privacy → Skills Echo has learned (lib/skills.js, the skills flag): each way that
// worked in an app, with its steps, version and how often it's been used, and a Remove button.
import { $, el, button, postJson, toast } from './dom.js';

/**
 * Show the skills (fetched fresh). The group is hidden when the flag is off, or there are none.
 * @param {boolean} on
 */
export async function renderSkills(on) {
  const group = $('skillsGroup');
  if (!group) return;
  if (!on) return void (group.hidden = true);
  let skills = [];
  try {
    skills = (await (await fetch('/api/skills')).json()).skills || [];
  } catch {}
  show(skills);
}

/** @param {Array<{ id: string, app: string, title: string, steps: string[], version: number, uses: number }>} skills */
function show(skills) {
  $('skillsGroup').hidden = skills.length === 0;
  $('skillsList').replaceChildren(
    ...skills.map((s) => {
      const row = el('div', { className: 'set-row' });
      const text = el('span', { className: 'set-text' });
      const desc = `In ${s.app} · ${s.steps.length} steps · version ${s.version}${s.uses ? ` · used ${s.uses}×` : ''}`;
      text.append(el('span', { className: 'set-label' }, s.title), el('span', { className: 'set-desc' }, desc));
      text.title = s.steps.join('\n');
      const remove = button('Remove', 'ghost small', async () => {
        try {
          show((await postJson('/api/skills/remove', { id: s.id })).skills || []);
        } catch (e) {
          toast(/** @type {Error} */ (e).message);
        }
      });
      remove.setAttribute('aria-label', `Remove the skill: ${s.title}`);
      row.append(text, remove);
      return row;
    }),
  );
}
