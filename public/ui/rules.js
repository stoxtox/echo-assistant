// Settings → You & privacy → Rules Echo follows (lib/rules.js, the rules flag): each rule the user gave,
// where it applies and when it was set, with a Remove button.
import { $, el, button, postJson, toast } from './dom.js';

/**
 * Show the rules (fetched fresh). The group is hidden when the flag is off, or there are none.
 * @param {boolean} on
 */
export async function renderRules(on) {
  const group = $('rulesGroup');
  if (!group) return;
  if (!on) return void (group.hidden = true);
  let rules = [];
  try {
    rules = (await (await fetch('/api/rules')).json()).rules || [];
  } catch {}
  show(rules);
}

/** @param {Array<{ id: string, text: string, app?: string, at: string }>} rules */
function show(rules) {
  $('rulesGroup').hidden = rules.length === 0;
  $('rulesList').replaceChildren(
    ...rules.map((r) => {
      const row = el('div', { className: 'set-row' });
      const when = new Date(r.at).toLocaleDateString([], { month: 'short', day: 'numeric' });
      const text = el('span', { className: 'set-text' });
      text.append(el('span', { className: 'set-label' }, r.text), el('span', { className: 'set-desc' }, `${r.app ? `In ${r.app} · ` : 'Everywhere · '}since ${when}`));
      const remove = button('Remove', 'ghost small', async () => {
        try {
          show((await postJson('/api/rules/remove', { id: r.id })).rules || []);
        } catch (e) {
          toast(/** @type {Error} */ (e).message);
        }
      });
      remove.setAttribute('aria-label', `Remove the rule: ${r.text}`);
      row.append(text, remove);
      return row;
    }),
  );
}
