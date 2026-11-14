// The eval harness: a fixed 30-task Mac suite (Gmail ×6, Chrome/YouTube ×6, Finder ×6,
// Messages/FaceTime ×4, Settings ×4, misc ×4) run on the simulated Mac (lib/evalsim.js) through
// the real ComputerUse executor and recipes. It measures, per driver:
//   - task success: the world ended the way the user wanted AND the run said it was done
//   - false success: the run said done, but the world isn't right (the audit's worst failure)
//   - honest failure: the run said it couldn't
//   - steps (tool calls) and time (model round trips + the executor's own time)
// The 'legacy' agent plays each task the way the model did on Sept 28–29 with the tools it had
// then; the 'v0' agent uses today's tools and prompt guidance (recipes, into names, replace mode,
// right-click, hover, drag, Spotlight). The agent reacts to a step that didn't work only by its
// scripted alternative (like a model retrying once), then gives up honestly.
//
// Run: npm run eval (scripts/eval.js). The test (test/eval.test.js) holds the Phase targets.
import { World, SimBridge, SimBrowser, simGround, COST, gmailScene, openCompose, chromeScene, menuExtras, finderScene, facetimeScene, settingsScene, notesScene, messagesScene, excelScene, simSheets } from './evalsim.js';
import { Sheets } from './sheets.js';
import { Executor, BrowserHub } from './executor.js';
import { findByLabel } from './browser.js';
import { localIntent, runLocalIntent } from './intent.js';
export { COST };
import { ComputerUse } from './computer.js';
import { Recipes } from './recipes.js';
import { midRunGate, addressedToEcho, answerGate, judgeAddressee } from './addressed.js';

/** A fake of lib/quick.js on the simulated Mac. */
class SimQuick {
  /** @param {World} w */
  constructor(w) {
    this.w = w;
  }

  async osa(script) {
    const w = this.w;
    const vol = script.match(/set volume output volume (\d+)/);
    if (vol) w.set('volume', Number(vol[1]));
    else if (/output volume of \(get volume settings\)\) \+/.test(script)) w.set('volume', (w.get('volume') ?? 50) + 12);
    else if (/output volume of \(get volume settings\)\) -/.test(script)) w.set('volume', (w.get('volume') ?? 50) - 12);
    else if (/output muted true/.test(script)) w.set('muted', true);
    else if (/output muted false/.test(script)) w.set('muted', false);
    if (/URL of active tab/.test(script)) return w.front === 'Google Chrome' ? w.apps.get('Google Chrome')?.url || '' : '';
    if (/every process whose name is in/.test(script)) return w.get('spotify') ? 'Spotify' : '';
    return '';
  }

  async mediaControl({ app, action }) {
    this.w.set('media', `${app}:${action}`);
    return { app, did: action };
  }

  async sendMessage({ to, text, attachment = '' }) {
    this.w.set('messageSent', text);
    if (attachment) this.w.set('attachmentSent', attachment);
    return { waitingForConfirmation: false, sent: true, to };
  }

  async findFiles(name, { scope = 'home', kind = '' } = {}) {
    const files = (this.w.get('files') || []).filter((f) => (!name || f.name.toLowerCase().includes(String(name).toLowerCase())) && (scope === 'everywhere' || f.scope === scope) && (!kind || f.kind === kind));
    this.w.set('found', files.map((f) => f.path));
    return { files };
  }

  async revealFile(p) {
    this.w.set('revealed', p);
    return { revealed: p };
  }

  async openLink(url) {
    const w = this.w;
    if (url.startsWith('https://mail.google.com/mail/?')) {
      if (w.get('signedOut')) return { opened: url };
      const q = new URL(url).searchParams;
      openCompose(w);
      const to = w.els.get('to');
      if (to && q.get('to')) to.chips = [q.get('to') || ''];
      const sub = w.els.get('subject');
      if (sub) sub.value = q.get('su') || '';
      const body = w.els.get('body');
      if (body) body.value = q.get('body') || '';
      if (sub?.value) w.add({ app: 'Google Chrome', role: 'AXStaticText', value: sub.value, web: true });
      return { opened: url };
    }
    if (url.startsWith('x-apple.systempreferences:')) {
      w.app('System Settings');
      w.front = 'System Settings';
      w.apps.get('System Settings').window = /wifi/i.test(url) ? 'Wi‑Fi' : /Displays/.test(url) ? 'Displays' : /Sound/.test(url) ? 'Sound' : 'Settings';
      w.touch('System Settings');
      return { opened: 'settings' };
    }
    if (url.startsWith('facetime')) {
      w.set('facetimeCall', url);
      return { opened: 'facetime' };
    }
    return { opened: url };
  }
}

/**
 * @typedef {{ tool: string, args?: any, alt?: Step[] }} Step
 * @typedef {{ id: string, group: string, ask: string, setup: (w: World) => void,
 *   legacy: Step[], v0: Step[], v1?: Step[], v2?: Step[], check: (w: World) => boolean }} Task
 */

const chip = (w, addr) => (w.els.get('to')?.chips || []).some((c) => c.includes(addr));
const val = (w, id) => w.els.get(id)?.value || '';
const EMAIL = 'sam@example.com';
const openDraft = (w, { subject = '', body = '', focus = 'body' } = {}) => {
  gmailScene(w);
  openCompose(w);
  const s = w.els.get('subject'), b = w.els.get('body');
  if (s) s.value = subject;
  if (b) b.value = body;
  const f = w.els.get(focus);
  if (f) w.focus(f);
};

/** @type {Task[]} */
export const TASKS = [
  // ---------- Gmail ×6 ----------
  {
    id: 'gmail-compose', group: 'gmail', ask: 'Email sam@example.com: subject Lunch, "See you at noon"',
    setup: (w) => gmailScene(w),
    legacy: [
      { tool: 'click', args: { target: 'Compose' } },
      { tool: 'type_text', args: { text: EMAIL, into: 'To' } },
      { tool: 'type_text', args: { text: 'Lunch', into: 'Subject' } },
      { tool: 'type_text', args: { text: 'See you at noon', into: 'Message Body' } },
    ],
    v0: [{ tool: 'compose_email', args: { to: EMAIL, subject: 'Lunch', body: 'See you at noon' } }],
    check: (w) => chip(w, EMAIL) && val(w, 'subject') === 'Lunch' && val(w, 'body') === 'See you at noon',
  },
  {
    id: 'gmail-compose-watch', group: 'gmail', ask: 'Show me writing an email to Sam about the demo',
    setup: (w) => gmailScene(w),
    legacy: [
      { tool: 'click', args: { target: 'Compose' } },
      { tool: 'type_text', args: { text: EMAIL, into: 'To' } },
      { tool: 'click', args: { target: 'Subject' } },
      { tool: 'press_keys', args: { keys: 'cmd+a' } },
      { tool: 'type_text', args: { text: 'Meet Echo, the Mac assistant', into: 'Subject' } },
      { tool: 'type_text', args: { text: 'Here is the demo.', into: 'Message Body' } },
    ],
    v0: [{ tool: 'compose_email', args: { to: EMAIL, subject: 'Meet Echo, the Mac assistant', body: 'Here is the demo.', watch: true } }],
    check: (w) => chip(w, EMAIL) && val(w, 'subject') === 'Meet Echo, the Mac assistant' && val(w, 'body') === 'Here is the demo.',
  },
  {
    id: 'gmail-send', group: 'gmail', ask: 'Email Sam "Running late" and send it',
    setup: (w) => gmailScene(w),
    legacy: [
      { tool: 'click', args: { target: 'Compose' }, alt: [{ tool: 'press_keys', args: { keys: 'c' } }] },
      { tool: 'type_text', args: { text: EMAIL, into: 'To' } },
      { tool: 'type_text', args: { text: 'Running late', into: 'Message Body' } },
      { tool: 'click', args: { target: 'Send' } },
    ],
    v0: [{ tool: 'compose_email', args: { to: EMAIL, body: 'Running late', send: true, watch: true } }],
    check: (w) => Boolean(w.get('sent')) && chip(w, EMAIL) && val(w, 'body') === 'Running late',
  },
  {
    id: 'gmail-add-recipient', group: 'gmail', ask: 'Add Sam to the draft that is open',
    setup: (w) => openDraft(w, { subject: 'Notes', body: 'Hi', focus: 'body' }),
    legacy: [{ tool: 'type_text', args: { text: EMAIL, into: 'To' } }],
    v0: [{ tool: 'type_text', args: { text: EMAIL, into: 'To recipients' } }, { tool: 'press_keys', args: { keys: 'tab', expect: 'sam' } }],
    check: (w) => chip(w, EMAIL) && val(w, 'body') === 'Hi',
  },
  {
    id: 'gmail-change-subject', group: 'gmail', ask: 'Change the subject to "Monday plan"',
    setup: (w) => openDraft(w, { subject: 'Old subject', body: 'Hi', focus: 'body' }),
    legacy: [
      { tool: 'click', args: { target: 'Subject' } },
      { tool: 'press_keys', args: { keys: 'cmd+a' } },
      { tool: 'type_text', args: { text: 'Monday plan' } },
    ],
    v0: [{ tool: 'type_text', args: { text: 'Monday plan', into: 'Subject', mode: 'replace' } }],
    check: (w) => val(w, 'subject') === 'Monday plan',
  },
  {
    id: 'gmail-search', group: 'gmail', ask: 'Search my mail for invoices',
    setup: (w) => gmailScene(w),
    legacy: [{ tool: 'type_text', args: { text: 'invoices', into: 'Search' } }, { tool: 'press_keys', args: { keys: 'return' } }],
    v0: [{ tool: 'type_text', args: { text: 'invoices', into: 'Search mail', mode: 'replace' } }, { tool: 'press_keys', args: { keys: 'return' } }],
    check: (w) => w.get('mailSearch') === 'invoices',
  },
  // ---------- Chrome / YouTube ×6 ----------
  {
    id: 'chrome-click-result', group: 'chrome', ask: 'Open the Wikipedia result',
    setup: (w) => chromeScene(w),
    legacy: [{ tool: 'click', args: { target: 'Sea otter - Wikipedia' } }],
    v0: [{ tool: 'click', args: { target: 'Sea otter - Wikipedia' } }],
    check: (w) => /wikipedia/.test(w.apps.get('Google Chrome')?.url || ''),
  },
  {
    id: 'chrome-new-search', group: 'chrome', ask: 'Search for sea lions instead',
    setup: (w) => chromeScene(w),
    legacy: [{ tool: 'type_text', args: { text: 'sea lions', into: 'Search' } }, { tool: 'press_keys', args: { keys: 'return' } }],
    v0: [{ tool: 'type_text', args: { text: 'sea lions', into: 'Search', mode: 'replace' } }, { tool: 'press_keys', args: { keys: 'return' } }],
    check: (w) => w.get('searched') === 'sea lions',
  },
  {
    id: 'chrome-save-image', group: 'chrome', ask: 'Save this otter photo',
    setup: (w) => chromeScene(w),
    legacy: [],
    v0: [{ tool: 'click', args: { target: 'Otter photo', button: 'right' } }, { tool: 'click', args: { target: 'Save Image As', scope: 'app' } }],
    check: (w) => Boolean(w.get('savedImage')),
  },
  {
    id: 'youtube-pause', group: 'chrome', ask: 'Pause the video',
    setup: (w) => { chromeScene(w, { youtube: true }); w.set('playing', true); },
    legacy: [{ tool: 'press_keys', args: { keys: 'k' } }],
    v0: [{ tool: 'youtube_control', args: { control: 'pause' } }],
    v1: [{ tool: 'local', args: { text: 'pause' } }],
    check: (w) => w.get('playing') === false,
  },
  {
    id: 'youtube-fullscreen', group: 'chrome', ask: 'Put this video on full screen',
    setup: (w) => chromeScene(w, { youtube: true }),
    legacy: [{ tool: 'press_keys', args: { keys: 'f' } }],
    v0: [{ tool: 'youtube_control', args: { control: 'fullscreen' } }],
    check: (w) => Boolean(w.get('fullscreen')),
  },
  {
    id: 'chrome-sort-date', group: 'chrome', ask: 'Click Date to sort by date',
    setup: (w) => { chromeScene(w); menuExtras(w); w.front = 'Google Chrome'; },
    legacy: [{ tool: 'click', args: { target: 'Date' } }],
    v0: [{ tool: 'click', args: { target: 'Date' } }],
    check: (w) => Boolean(w.get('sortedByDate')) && !w.get('clockMenu'),
  },
  // ---------- Finder ×6 ----------
  {
    id: 'finder-find', group: 'finder', ask: 'Find my budget spreadsheet',
    setup: (w) => { finderScene(w); w.set('files', [{ name: 'Budget 2026.xlsx', path: '/Users/me/Documents/Budget 2026.xlsx', scope: 'home', kind: 'spreadsheet' }]); },
    legacy: [{ tool: 'type_text', args: { text: 'budget', into: 'Search' } }, { tool: 'press_keys', args: { keys: 'return' } }],
    v0: [{ tool: 'find_file', args: { name: 'budget' } }],
    check: (w) => w.get('finderSearch') === 'budget' || (w.get('found') || []).length > 0,
  },
  {
    id: 'finder-card-photos', group: 'finder', ask: 'Find the LA photos from the memory card',
    setup: (w) => { finderScene(w); w.set('files', [{ name: 'LA-001.jpg', path: '/Volumes/CARD/DCIM/LA-001.jpg', scope: 'volumes', kind: 'image' }]); },
    legacy: [{ tool: 'click', args: { target: 'CARD' } }],
    v0: [{ tool: 'find_file', args: { name: 'LA', scope: 'volumes', kind: 'image' } }],
    check: (w) => (w.get('found') || []).some((p) => p.includes('/Volumes/CARD')),
  },
  {
    id: 'finder-share', group: 'finder', ask: 'Share the budget file',
    setup: (w) => finderScene(w),
    legacy: [{ tool: 'click', args: { target: 'Share' } }],
    v0: [{ tool: 'click', args: { target: 'Budget 2026.xlsx', button: 'right' } }, { tool: 'click', args: { target: 'Share' } }],
    check: (w) => Boolean(w.get('shareOpen')),
  },
  {
    id: 'finder-move', group: 'finder', ask: 'Move the budget file into Projects',
    setup: (w) => finderScene(w),
    legacy: [],
    v0: [{ tool: 'drag', args: { target: 'Budget 2026.xlsx', to: 'Projects' } }],
    check: (w) => w.get('moved') === 'Budget 2026.xlsx',
  },
  {
    id: 'finder-delete', group: 'finder', ask: 'Delete the budget file',
    setup: (w) => finderScene(w),
    legacy: [{ tool: 'click', args: { target: 'Budget 2026.xlsx' } }, { tool: 'press_keys', args: { keys: 'cmd+delete' } }],
    v0: [{ tool: 'click', args: { target: 'Budget 2026.xlsx' } }, { tool: 'press_keys', args: { keys: 'cmd+delete' } }],
    check: (w) => w.get('trashed') === 'Budget 2026.xlsx',
  },
  {
    id: 'finder-reveal', group: 'finder', ask: 'Show me where the budget file is',
    setup: (w) => { finderScene(w); w.set('files', [{ name: 'Budget 2026.xlsx', path: '/Users/me/Documents/Budget 2026.xlsx', scope: 'home', kind: 'spreadsheet' }]); },
    legacy: [{ tool: 'type_text', args: { text: 'budget', into: 'Search' } }, { tool: 'press_keys', args: { keys: 'return' } }],
    v0: [{ tool: 'find_file', args: { name: 'budget' } }, { tool: 'reveal_file', args: { path: '/Users/me/Documents/Budget 2026.xlsx' } }],
    check: (w) => Boolean(w.get('revealed')) || w.get('finderSearch') === 'budget',
  },
  // ---------- Messages / FaceTime ×4 ----------
  {
    id: 'imessage-text', group: 'messages', ask: 'Text Sam "on my way"',
    setup: (w) => messagesScene(w),
    legacy: [{ tool: 'send_imessage', args: { to: 'Sam', text: 'on my way' } }],
    v0: [{ tool: 'send_imessage', args: { to: 'Sam', text: 'on my way' } }],
    check: (w) => w.get('messageSent') === 'on my way',
  },
  {
    id: 'imessage-photo', group: 'messages', ask: 'Send Sam the beach photo',
    setup: (w) => { messagesScene(w); w.set('files', [{ name: 'beach.jpg', path: '/Users/me/Pictures/beach.jpg', scope: 'home', kind: 'image' }]); },
    legacy: [{ tool: 'send_imessage', args: { to: 'Sam', text: "Here's the beach photo" } }],
    v0: [{ tool: 'find_file', args: { name: 'beach', kind: 'image' } }, { tool: 'send_imessage', args: { to: 'Sam', text: "Here's the beach photo", attachment: '/Users/me/Pictures/beach.jpg' } }],
    check: (w) => w.get('attachmentSent') === '/Users/me/Pictures/beach.jpg',
  },
  {
    id: 'facetime-share', group: 'messages', ask: 'Share my screen in this FaceTime call',
    setup: (w) => facetimeScene(w),
    legacy: [{ tool: 'click', args: { target: 'Share Screen' } }],
    v0: [{ tool: 'hover', args: { target: 'Call window', expect: 'Share Screen' } }, { tool: 'click', args: { target: 'Share Screen' } }],
    check: (w) => Boolean(w.get('sharing')),
  },
  {
    id: 'facetime-call', group: 'messages', ask: 'FaceTime Sam',
    setup: (w) => facetimeScene(w),
    legacy: [{ tool: 'open_url', args: { url: 'facetime://+15550100000' } }],
    v0: [{ tool: 'facetime_call', args: { handle: '+1 555 010 0000' } }],
    check: (w) => Boolean(w.get('facetimeCall')),
  },
  // ---------- Settings ×4 ----------
  {
    id: 'settings-displays', group: 'settings', ask: 'Open display settings',
    setup: (w) => settingsScene(w),
    legacy: [{ tool: 'click', args: { target: 'Displays', app: 'System Settings' } }],
    v0: [{ tool: 'open_settings_pane', args: { pane: 'displays' } }],
    check: (w) => w.apps.get('System Settings')?.window === 'Displays',
  },
  {
    id: 'settings-dark', group: 'settings', ask: 'Turn on dark mode',
    setup: (w) => settingsScene(w),
    legacy: [{ tool: 'click', args: { target: 'Appearance', app: 'System Settings' } }, { tool: 'click', args: { target: 'Dark', app: 'System Settings' } }],
    v0: [{ tool: 'click', args: { target: 'Appearance', app: 'System Settings' } }, { tool: 'click', args: { target: 'Dark', app: 'System Settings' } }],
    check: (w) => Boolean(w.get('dark')),
  },
  {
    id: 'settings-wifi', group: 'settings', ask: 'Open Wi-Fi settings',
    setup: (w) => { settingsScene(w); menuExtras(w); w.front = 'System Settings'; },
    legacy: [{ tool: 'click', args: { target: 'Wi-Fi', app: 'System Settings' } }],
    v0: [{ tool: 'open_settings_pane', args: { pane: 'wifi' } }],
    check: (w) => /Wi.?Fi/.test(w.apps.get('System Settings')?.window || ''),
  },
  {
    id: 'settings-sound', group: 'settings', ask: 'Open sound settings',
    setup: (w) => { settingsScene(w); menuExtras(w); w.front = 'System Settings'; },
    legacy: [{ tool: 'click', args: { target: 'Sound', app: 'System Settings' } }],
    v0: [{ tool: 'open_settings_pane', args: { pane: 'sound' } }],
    check: (w) => w.apps.get('System Settings')?.window === 'Sound',
  },
  // ---------- misc ×4 ----------
  {
    id: 'notes-new', group: 'misc', ask: 'Open Notes and write "hello from Echo"',
    setup: (w) => notesScene(w),
    legacy: [{ tool: 'press_keys', args: { keys: 'cmd+n', app: 'Notes' } }, { tool: 'type_text', args: { text: 'hello from Echo', app: 'Notes' } }],
    v0: [{ tool: 'press_keys', args: { keys: 'cmd+n', app: 'Notes' } }, { tool: 'type_text', args: { text: 'hello from Echo', app: 'Notes' } }],
    check: (w) => w.get('newNote') && [...w.els.values()].some((e) => e.app === 'Notes' && e.value === 'hello from Echo'),
  },
  {
    id: 'notes-type-unfocused', group: 'misc', ask: 'Write "groceries" in a note',
    setup: (w) => notesScene(w),
    legacy: [{ tool: 'type_text', args: { text: 'groceries', app: 'Notes' } }],
    v0: [{ tool: 'type_text', args: { text: 'groceries', app: 'Notes' }, alt: [{ tool: 'press_keys', args: { keys: 'cmd+n', app: 'Notes' } }, { tool: 'type_text', args: { text: 'groceries', app: 'Notes' } }] }],
    v1: [{ tool: 'press_keys', args: { keys: 'cmd+n', app: 'Notes' } }, { tool: 'type_text', args: { text: 'groceries', app: 'Notes' } }],
    check: (w) => [...w.els.values()].some((e) => e.app === 'Notes' && e.value === 'groceries'),
  },
  {
    id: 'chrome-new-tab', group: 'misc', ask: 'Open a new tab',
    setup: (w) => chromeScene(w),
    legacy: [{ tool: 'click', args: { target: 'New Tab' } }],
    v0: [{ tool: 'click', args: { target: 'New Tab' }, alt: [{ tool: 'click', args: { target: 'New Tab', scope: 'browser' } }] }],
    check: (w) => (w.apps.get('Google Chrome')?.windows || 0) > 1,
  },
  {
    id: 'chrome-clear-search', group: 'misc', ask: 'Clear the search box',
    setup: (w) => chromeScene(w),
    legacy: [{ tool: 'click', args: { target: 'Search' } }, { tool: 'press_keys', args: { keys: 'cmd+a' } }, { tool: 'press_keys', args: { keys: 'delete' } }],
    v0: [{ tool: 'clear_field', args: { into: 'Search' } }],
    check: (w) => [...w.els.values()].some((e) => e.title === 'Search' && e.value === ''),
  },
];

/**
 * Plays one task with one driver. Never throws: a crash counts as an honest failure.
 * @param {Task} task @param {'legacy' | 'v0' | 'v1' | 'v2'} driver @param {{ logFile: string }} o
 */
export async function runTask(task, driver, { logFile }) {
  const w = new World();
  task.setup(w);
  const bridge = new SimBridge(w, driver);
  // Excel and Numbers answer scripts on the simulated Mac too (lib/sheets.js over simSheets).
  const sheets = new Sheets({ run: simSheets(w).run });
  const computer = new ComputerUse({ bridge: /** @type {any} */ (bridge), sheets, logFile, focusRetryMs: 0, confirmSettleMs: 0, expectMs: 300, settleMs: 0 });
  const quick = new SimQuick(w);
  const recipes = new Recipes({ computer, quick, open: (url) => quick.openLink(url) });
  // v1: the executor over the Echo extension (Chrome pages) and the Mac app's observe.
  const executor = new Executor({ computer, browser: new BrowserHub({ extension: /** @type {any} */ (new SimBrowser(w, bridge)) }) });
  const byName = (a) => {
    if (!a.name) return a;
    const el = findByLabel(executor.last?.elements || [], a.name, { wantsField: ['fill', 'replace', 'clear'].includes(a.verb) });
    return { ...a, name: undefined, ref: el?.ref || 'none' };
  };
  let steps = 0;
  let decisions = 0;
  const call = async (st) => {
    steps++;
    const a = st.args || {};
    switch (st.tool) {
      case 'local': {
        // An instant command: no model call at all.
        const intent = localIntent(a.text, { driving: computer.driving || Boolean(a.driving) });
        if (!intent) return { error: 'not_local' };
        if (a.driving) computer.ensureRun();
        bridge.clock += 180; // an osascript or one key press
        const r = await runLocalIntent(intent, { quick, computer, recipes, now: () => 'Tuesday, September 29, 2026 at 2:05 PM EDT' });
        return r.ok ? { ok: true } : { ok: false, error: 'failed' };
      }
      case 'observe_screen': return executor.observe(a);
      case 'click_visual': return computer.clickVisual(a, { groundImpl: simGround(w) });
      // The model reads the observation and picks the ref by what it's called.
      case 'act': return executor.act(byName(a));
      case 'batch_actions': return executor.batch(a.steps.map(byName));
      case 'media_control': return quick.mediaControl(a);
      case 'compose_email': return recipes.gmailCompose(a);
      case 'facetime_call': return recipes.facetime(a);
      case 'open_settings_pane': return recipes.settingsPane(a);
      case 'youtube_control': return recipes.youtube(a);
      case 'send_imessage': return quick.sendMessage(a);
      case 'find_file': {
        const r = await quick.findFiles(a.name, a);
        return { ok: r.files.length > 0 };
      }
      case 'reveal_file': return { ok: true, ...(await quick.revealFile(a.path)) };
      case 'open_url': {
        // The tool then: web and mail links only.
        if (!/^(https?|mailto):/.test(a.url)) return { error: 'bad_link' };
        return quick.openLink(a.url);
      }
      case 'sheet_read': case 'sheet_write': case 'sheet_select': case 'sheet_format': case 'sheet_find': case 'sheet_undo':
        bridge.clock += 400; // one script call, as measured against Excel
        return computer.sheet(/** @type {any} */ (st.tool.slice(6)), a);
      case 'type_text': return computer.act('type_text', { ...a, target: a.into });
      case 'clear_field': return computer.act('clear_field', { ...a, target: a.into });
      default: return computer.act(st.tool, a);
    }
  };
  const worked = (r) => Boolean(r) && !r.error && !r.refused && r.found !== false && r.done !== false && r.ok !== false;
  /** @returns {Promise<boolean>} */
  const play = async (plan) => {
    for (const st of plan) {
      if (st.tool !== 'local') decisions += 1;
      let r = await call(st);
      // Echo reads the email address or number back, the user says yes, and the step goes again.
      if (r?.needsReadBack) {
        decisions += 1;
        computer.noteSaid(`That's ${r.readBack.join(', ')}, right?`);
        computer.newTurn('yes');
        r = await call(st);
      }
      // The user says yes to a card (they asked for it).
      // The user says yes to each card; a batch stopped at a card goes on with the rest after it.
      for (let guard = 0; r?.waitingForConfirmation && r.confirmId && guard < 6; guard++) {
        const rest = r.remaining;
        r = await computer.confirm(r.confirmId, true, 'window');
        if (r?.done && rest?.length) r = await executor.batch(rest);
      }
      if (!worked(r)) {
        if (st.alt) {
          if (!(await play(st.alt))) return false;
          continue;
        }
        return false;
      }
    }
    return true;
  };
  const plan = driver === 'v2' ? task.v2 || task.v1 || task.v0 : driver === 'v1' ? task.v1 || task.v0 : task[driver];
  // The final answer is a model call too, unless everything was done locally.
  if (plan.some((st) => st.tool !== 'local')) decisions += 1;
  let claimed = false;
  try {
    // No way to do it with the tools of the day: the assistant says so.
    claimed = plan.length ? await play(plan) : false;
  } catch {
    claimed = false;
  }
  computer.end('done');
  const right = Boolean(task.check(w));
  const ms = decisions * COST.model + bridge.clock;
  return { id: task.id, group: task.group, driver, claimed, right, success: claimed && right, falseSuccess: claimed && !right, steps, ms };
}

/**
 * The whole suite with one driver: per-task results and the metrics.
 * @param {'legacy' | 'v0' | 'v1' | 'v2'} driver @param {{ logFile: string, tasks?: Task[] }} o
 */
export async function runSuite(driver, { logFile, tasks = TASKS }) {
  const results = [];
  for (const t of tasks) results.push(await runTask(t, driver, { logFile }));
  const n = results.length;
  const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
  };
  const claimed = results.filter((r) => r.claimed).length;
  const metrics = {
    driver,
    tasks: n,
    success: results.filter((r) => r.success).length,
    successRate: results.filter((r) => r.success).length / n,
    falseSuccess: results.filter((r) => r.falseSuccess).length,
    // Of the runs that said "done", how many weren't (the report's false-success rate).
    falseSuccessRate: claimed ? results.filter((r) => r.falseSuccess).length / claimed : 0,
    honestFailure: results.filter((r) => !r.claimed).length,
    medianSteps: median(results.map((r) => r.steps)),
    medianSeconds: Math.round(median(results.map((r) => r.ms)) / 100) / 10,
    commandSeconds: (() => {
      const c = results.filter((r) => r.group === 'command');
      return c.length ? Math.round(median(c.map((r) => r.ms)) / 100) / 10 : null;
    })(),
    byGroup: Object.fromEntries([...new Set(results.map((r) => r.group))].map((g) => {
      const rs = results.filter((r) => r.group === g);
      return [g, `${rs.filter((r) => r.success).length}/${rs.length}`];
    })),
  };
  return { metrics, results };
}

/**
 * The stress set: things today's driver can't do yet (a canvas with no labels, a site that's
 * broken, Gmail signed out). What matters here is that it says so instead of claiming success.
 * @type {Task[]}
 */
export const STRESS_TASKS = [
  {
    id: 'canvas-no-labels', group: 'stress', ask: 'Pick the rectangle tool in the drawing app',
    setup: (w) => { w.app('Sketchpad', { window: 'Untitled' }); w.front = 'Sketchpad'; w.add({ app: 'Sketchpad', role: 'AXGroup', title: '', looks: 'rectangle tool square outline left toolbar', at: { x: 40, y: 220 }, onPress: (ww) => ww.set('rectangle', true) }); },
    legacy: [{ tool: 'click', args: { target: 'Rectangle' } }],
    v0: [{ tool: 'click', args: { target: 'Rectangle' } }],
    v2: [{ tool: 'click', args: { target: 'Rectangle' }, alt: [{ tool: 'click_visual', args: { description: 'the rectangle tool in the left toolbar' } }] }],
    check: (w) => Boolean(w.get('rectangle')),
  },
  {
    id: 'dead-button', group: 'stress', ask: 'Click Download on this page',
    setup: (w) => { chromeScene(w); w.add({ app: 'Google Chrome', role: 'AXButton', title: 'Download', web: true, pressAX: true, inert: true, onPress: () => {} }); },
    legacy: [{ tool: 'click', args: { target: 'Download' } }],
    v0: [{ tool: 'click', args: { target: 'Download' } }],
    check: (w) => Boolean(w.get('downloaded')),
  },
  {
    id: 'gmail-signed-out', group: 'stress', ask: 'Email Sam "hi"',
    setup: (w) => { chromeScene(w); w.set('signedOut', true); },
    legacy: [{ tool: 'click', args: { target: 'Compose' } }],
    v0: [{ tool: 'compose_email', args: { to: EMAIL, body: 'hi' } }],
    check: (w) => Boolean(w.get('sent')),
  },
  {
    id: 'type-into-label', group: 'stress', ask: 'Type the code into Verification code',
    setup: (w) => { chromeScene(w); w.add({ app: 'Google Chrome', role: 'AXTextField', desc: 'Verification code', web: true }); },
    legacy: [{ tool: 'type_text', args: { text: '4417 2210', into: 'Verification code' } }],
    v0: [{ tool: 'type_text', args: { text: '4417 2210', into: 'Verification code' } }],
    // Never typed: a code is the user's to type (refused, and said so).
    check: () => false,
  },
];

/* ---------- addressee: "is this for me?" on a labelled replay ---------- */

/**
 * Utterances like the Sept 28–29 ones (names changed), labelled: was it for Echo? The setting is
 * where it was heard: a driving run, the auto-listen window after her question, or hands-free.
 * @type {Array<{ text: string, forEcho: boolean, mode: 'run' | 'answer' | 'hands-free', pendingQuestion?: boolean, quiet?: boolean }>}
 */
export const ADDRESSEE_SET = [
  // Real commands and replies that were dropped (run_ignored / not_for_echo).
  { text: 'Hey can you put this video on full screen', forEcho: true, mode: 'run' },
  { text: 'You can send it', forEcho: true, mode: 'run', pendingQuestion: true },
  { text: 'I think that\'s perfect', forEcho: true, mode: 'run', pendingQuestion: true },
  { text: 'No, seems like you are clicking on the wrong buttons', forEcho: true, mode: 'run' },
  { text: 'I just said something to you. Can you copy that thing?', forEcho: true, mode: 'run' },
  { text: 'I wanna write the email to Sam', forEcho: true, mode: 'hands-free', quiet: true },
  { text: 'I think he is on my contact list', forEcho: true, mode: 'answer', pendingQuestion: true },
  { text: 'Tell me what you can able to do', forEcho: true, mode: 'hands-free', quiet: true },
  { text: 'Yeah', forEcho: true, mode: 'answer', pendingQuestion: true },
  { text: 'Yes send it', forEcho: true, mode: 'run', pendingQuestion: true },
  { text: 'The other one', forEcho: true, mode: 'run', pendingQuestion: true },
  { text: 'Scroll down a bit', forEcho: true, mode: 'run' },
  { text: 'Go back', forEcho: true, mode: 'run' },
  { text: 'Sam, Echo, open my calendar', forEcho: true, mode: 'hands-free' },
  { text: 'What can you do for me', forEcho: true, mode: 'hands-free', quiet: true },
  { text: 'Can you open YouTube', forEcho: true, mode: 'hands-free', quiet: true },
  { text: 'Open Spotify, Echo', forEcho: true, mode: 'hands-free' },
  { text: 'That looks good', forEcho: true, mode: 'run', pendingQuestion: true },
  { text: 'Stop', forEcho: true, mode: 'run' },
  { text: 'Echo what is on my calendar today', forEcho: true, mode: 'hands-free' },
  // Talk that wasn't for Echo: a side chat, the TV, fragments.
  { text: 'That\'s a cool feature', forEcho: false, mode: 'run' },
  { text: 'The way for and this is the one only', forEcho: false, mode: 'run' },
  { text: 'And then what is it?', forEcho: false, mode: 'run' },
  { text: 'Memory', forEcho: false, mode: 'run' },
  { text: 'Madagascar, Cure, Diario, Nape', forEcho: false, mode: 'hands-free' },
  { text: 'They have these glasses that record everything you see', forEcho: false, mode: 'hands-free' },
  { text: 'turn on the Echo Dot in the kitchen', forEcho: false, mode: 'hands-free' },
  { text: 'There is an echo in this room', forEcho: false, mode: 'hands-free' },
  { text: 'Enric, Black, Colonna, Capra', forEcho: false, mode: 'run' },
  { text: 'kill Edgers', forEcho: false, mode: 'run' },
  { text: 'Did you watch the game last night', forEcho: false, mode: 'hands-free', quiet: false },
  { text: 'Coming up next, the weather with Janet', forEcho: false, mode: 'answer', pendingQuestion: true },
  { text: 'We should get dinner after this, maybe that Thai place on Main Street near the station', forEcho: false, mode: 'answer', pendingQuestion: true },
  { text: 'Check this out, subscribe and hit the bell for more videos like this one', forEcho: false, mode: 'run' },
  { text: 'Oh my god look at that', forEcho: false, mode: 'run' },
  { text: 'My mom called earlier about the weekend', forEcho: false, mode: 'hands-free', quiet: true },
];

/**
 * The addressee replay: the gates as they were (drop what the strict gate drops) and addressee
 * v1 (judgeAddressee decides; "ask" counts as not dropped silently: it shows a chip).
 */
export function runAddressee(set = ADDRESSEE_SET) {
  const old = (u) => {
    if (u.mode === 'run') return midRunGate({ text: u.text, clarity: 'ok', pendingQuestion: Boolean(u.pendingQuestion) }).accept;
    if (u.mode === 'answer') return answerGate({ text: u.text, clarity: 'ok' }).accept;
    return addressedToEcho({ text: u.text, clarity: 'ok' }).ok;
  };
  const now = (u) => {
    return judgeAddressee({ text: u.text, clarity: 'ok', driving: u.mode === 'run', pendingQuestion: Boolean(u.pendingQuestion) || u.mode === 'answer', quiet: u.quiet }).decision;
  };
  const score = (decide) => {
    const d = set.map((u) => ({ u, got: decide(u) }));
    const mine = d.filter((x) => x.u.forEcho), theirs = d.filter((x) => !x.u.forEcho);
    const accepted = (g) => g === true || g === 'accept';
    return {
      // Real ones dropped silently (neither accepted nor asked about).
      falseReject: mine.filter((x) => !accepted(x.got) && x.got !== 'ask').length / mine.length,
      // Real ones that needed a tap on "Was that for me?".
      asked: mine.filter((x) => x.got === 'ask').length,
      // Room talk that went through as a command.
      falseAccept: theirs.filter((x) => accepted(x.got)).length / theirs.length,
      askedNoise: theirs.filter((x) => x.got === 'ask').length,
      n: set.length,
    };
  };
  return { legacy: score(old), v0: score(now) };
}

/* ---------- the Phase 1 half: 30 more tasks (60 in all) ---------- */

/** A web form in Chrome: labelled fields, a checkbox, a file input, Submit. */
function formScene(w) {
  const app = 'Google Chrome';
  w.app(app, { window: 'Sign up for the newsletter', url: 'https://example.com/signup' });
  w.front = app;
  w.add({ app, role: 'AXTab', title: 'Sign up for the newsletter', chrome: true });
  w.add({ app, role: 'AXStaticText', value: 'Name', web: true });
  w.add({ id: 'name', app, role: 'AXTextField', desc: 'Name', web: true, value: '' });
  w.add({ app, role: 'AXStaticText', value: 'Email', web: true });
  w.add({ id: 'email', app, role: 'AXTextField', desc: 'Email', web: true, value: 'sma@example.com' });
  w.add({ id: 'phone', app, role: 'AXTextField', desc: 'Phone', web: true, value: '' });
  w.add({ id: 'news', app, role: 'AXCheckBox', title: 'Send me the weekly newsletter', web: true, onPress: (ww) => ww.set('newsletter', !ww.get('newsletter')) });
  w.add({ id: 'cv', app, role: 'AXButton', title: 'Choose file', desc: 'Upload your CV', web: true, fileInput: true, onPress: (ww) => ww.set('fileDialog', true), onUpload: (ww, files) => ww.set('uploaded', files[0]) });
  w.add({ app, role: 'AXButton', title: 'Submit', web: true, onPress: (ww) => { ww.set('submitted', { name: ww.els.get('name')?.value, email: ww.els.get('email')?.value, phone: ww.els.get('phone')?.value }); ww.apps.get(app).url = 'https://example.com/thanks'; } });
  const search = w.add({ app, role: 'AXSearchField', desc: 'Search this site', web: true, value: '', onReturn: (ww) => { ww.set('siteSearch', search.value); ww.apps.get(app).url = `https://example.com/search?q=${search.value}`; ww.touch(app); } });
}

/** Gmail with a thread open: Reply, Archive, a draft to discard. */
function threadScene(w) {
  gmailScene(w);
  const app = 'Google Chrome';
  w.apps.get(app).window = 'Lunch on Friday? - sam@example.com - Gmail';
  const row = w.add({ app, role: 'AXRow', title: 'Sam, Lunch on Friday?, 11:02 AM', web: true, onPress: (ww) => { ww.apps.get(app).url = 'https://mail.google.com/mail/u/0/#inbox/thread1'; ww.set('threadOpen', true); } });
  void row;
  w.add({ app, role: 'AXButton', title: 'Reply', web: true, onPress: (ww) => { const body = ww.add({ id: 'reply', app, role: 'AXTextArea', desc: 'Message Body', web: true, value: '' }); ww.focus(body); ww.add({ app, role: 'AXButton', title: 'Send ‪(⌘Enter)‬', desc: 'Send', web: true, onPress: (w2) => w2.set('replied', ww.els.get('reply')?.value) }); } });
  w.add({ app, role: 'AXButton', title: 'Archive', web: true, onPress: (ww) => ww.set('archived', true) });
  w.add({ app, role: 'AXButton', title: 'Discard draft', web: true, onPress: (ww) => ww.set('discarded', true) });
}

/** Slack in a Chrome tab. */
function slackScene(w) {
  const app = 'Google Chrome';
  w.app(app, { window: 'general - Acme - Slack', url: 'https://app.slack.com/client/T1/C1' });
  w.front = app;
  const box = w.add({ id: 'slackbox', app, role: 'AXTextArea', desc: 'Message #general', web: true, value: '', onReturn: (ww) => { ww.set('slackSent', box.value); box.value = ''; ww.touch(app); } });
  w.focus(box);
}

const spotify = (w) => { chromeScene(w); w.set('spotify', true); w.front = 'Finder'; w.app('Finder'); };
const drivingChrome = (w) => { chromeScene(w); w.apps.get('Google Chrome').keys = { ...(w.apps.get('Google Chrome').keys || {}), 'cmd+[': (ww) => { ww.apps.get('Google Chrome').url = 'https://www.google.com/previous'; ww.touch('Google Chrome'); } }; };

/** @type {Task[]} */
export const PHASE1_TASKS = [
  // ---------- instant commands ×6 ----------
  { id: 'cmd-pause-music', group: 'command', ask: 'Pause', setup: spotify,
    legacy: [{ tool: 'media_control', args: { app: 'Spotify', action: 'pause' } }], v0: [{ tool: 'media_control', args: { app: 'Spotify', action: 'pause' } }],
    v1: [{ tool: 'local', args: { text: 'pause' } }], check: (w) => w.get('media') === 'Spotify:pause' },
  { id: 'cmd-next-song', group: 'command', ask: 'Next song', setup: spotify,
    legacy: [{ tool: 'media_control', args: { app: 'Spotify', action: 'next' } }], v0: [{ tool: 'media_control', args: { app: 'Spotify', action: 'next' } }],
    v1: [{ tool: 'local', args: { text: 'next song' } }], check: (w) => w.get('media') === 'Spotify:next' },
  { id: 'cmd-volume-up', group: 'command', ask: 'Turn it up', setup: (w) => { spotify(w); w.set('volume', 40); },
    legacy: [], v0: [], v1: [{ tool: 'local', args: { text: 'turn it up' } }], check: (w) => w.get('volume') === 52 },
  { id: 'cmd-mute', group: 'command', ask: 'Mute', setup: spotify,
    legacy: [], v0: [], v1: [{ tool: 'local', args: { text: 'mute' } }], check: (w) => w.get('muted') === true },
  { id: 'cmd-scroll', group: 'command', ask: 'Scroll down (while driving)', setup: drivingChrome,
    legacy: [{ tool: 'scroll', args: { direction: 'down', app: 'Google Chrome' } }], v0: [{ tool: 'scroll', args: { direction: 'down', app: 'Google Chrome' } }],
    v1: [{ tool: 'local', args: { text: 'scroll down', driving: true } }], check: (w) => (w.apps.get('Google Chrome')?.version || 0) > 0 },
  { id: 'cmd-go-back', group: 'command', ask: 'Go back (while driving)', setup: drivingChrome,
    legacy: [{ tool: 'press_keys', args: { keys: 'cmd+[', app: 'Google Chrome' } }], v0: [{ tool: 'press_keys', args: { keys: 'cmd+[', app: 'Google Chrome' } }],
    v1: [{ tool: 'local', args: { text: 'go back', driving: true } }], check: (w) => /previous/.test(w.apps.get('Google Chrome')?.url || '') },
  // ---------- web forms ×6 ----------
  { id: 'form-name', group: 'forms', ask: 'Put Sam Lee as the name', setup: formScene,
    legacy: [{ tool: 'type_text', args: { text: 'Sam Lee', into: 'Name' } }], v0: [{ tool: 'type_text', args: { text: 'Sam Lee', into: 'Name' } }],
    check: (w) => val(w, 'name') === 'Sam Lee' },
  { id: 'form-all', group: 'forms', ask: 'Fill in my name, fix the email, add my phone', setup: formScene,
    legacy: [{ tool: 'type_text', args: { text: 'Sam Lee', into: 'Name' } }, { tool: 'type_text', args: { text: 'sam@example.com', into: 'Email' } }, { tool: 'type_text', args: { text: '555 010 3141', into: 'Phone' } }],
    v0: [{ tool: 'type_text', args: { text: 'Sam Lee', into: 'Name' } }, { tool: 'type_text', args: { text: 'sam@example.com', into: 'Email', mode: 'replace' } }, { tool: 'type_text', args: { text: '555 010 3141', into: 'Phone' } }],
    v1: [{ tool: 'observe_screen', args: { app: 'Google Chrome' } }, { tool: 'batch_actions', args: { steps: [{ name: 'Name', verb: 'fill', text: 'Sam Lee' }, { name: 'Email', verb: 'replace', text: 'sam@example.com' }, { name: 'Phone', verb: 'fill', text: '555 010 3141' }] } }],
    check: (w) => val(w, 'name') === 'Sam Lee' && val(w, 'email') === 'sam@example.com' && val(w, 'phone') === '555 010 3141' },
  { id: 'form-checkbox', group: 'forms', ask: 'Tick the newsletter box', setup: formScene,
    legacy: [{ tool: 'click', args: { target: 'newsletter' } }], v0: [{ tool: 'click', args: { target: 'Send me the weekly newsletter' } }],
    check: (w) => w.get('newsletter') === true },
  { id: 'form-fix-email', group: 'forms', ask: 'The email has a typo: make it sam@example.com', setup: formScene,
    legacy: [{ tool: 'type_text', args: { text: 'sam@example.com', into: 'Email' } }], v0: [{ tool: 'type_text', args: { text: 'sam@example.com', into: 'Email', mode: 'replace' } }],
    check: (w) => val(w, 'email') === 'sam@example.com' },
  { id: 'form-upload', group: 'forms', ask: 'Attach my CV', setup: (w) => { formScene(w); w.set('files', [{ name: 'CV.pdf', path: '/Users/me/Documents/CV.pdf', scope: 'home', kind: 'pdf' }]); },
    legacy: [{ tool: 'click', args: { target: 'Choose file' } }, { tool: 'type_text', args: { text: '/Users/me/Documents/CV.pdf' } }],
    v0: [{ tool: 'click', args: { target: 'Upload your CV' } }, { tool: 'type_text', args: { text: '/Users/me/Documents/CV.pdf' } }],
    v1: [{ tool: 'find_file', args: { name: 'CV', kind: 'pdf' } }, { tool: 'observe_screen', args: { app: 'Google Chrome' } }, { tool: 'act', args: { name: 'Choose file', verb: 'upload', files: ['/Users/me/Documents/CV.pdf'] } }],
    check: (w) => w.get('uploaded') === '/Users/me/Documents/CV.pdf' },
  { id: 'form-site-search', group: 'forms', ask: 'Search this site for pricing', setup: formScene,
    legacy: [{ tool: 'type_text', args: { text: 'pricing', into: 'Search' } }, { tool: 'press_keys', args: { keys: 'return' } }],
    v0: [{ tool: 'type_text', args: { text: 'pricing', into: 'Search this site' } }, { tool: 'press_keys', args: { keys: 'return' } }],
    check: (w) => w.get('siteSearch') === 'pricing' },
  // ---------- Gmail ×6 ----------
  { id: 'gmail-open-thread', group: 'gmail2', ask: 'Open the lunch email from Sam', setup: threadScene,
    legacy: [{ tool: 'click', args: { target: 'Lunch on Friday?' } }], v0: [{ tool: 'click', args: { target: 'Sam, Lunch on Friday?, 11:02 AM' } }],
    check: (w) => Boolean(w.get('threadOpen')) },
  { id: 'gmail-reply', group: 'gmail2', ask: 'Reply "Friday works" and send', setup: threadScene,
    legacy: [{ tool: 'click', args: { target: 'Reply' } }, { tool: 'type_text', args: { text: 'Friday works' } }, { tool: 'click', args: { target: 'Send' } }],
    v0: [{ tool: 'click', args: { target: 'Reply', expect: 'Message Body' } }, { tool: 'type_text', args: { text: 'Friday works', into: 'Message Body' } }, { tool: 'click', args: { target: 'Send' } }],
    v1: [{ tool: 'observe_screen', args: { app: 'Google Chrome' } }, { tool: 'act', args: { name: 'Reply', verb: 'click' } }, { tool: 'batch_actions', args: { steps: [{ name: 'Message Body', verb: 'fill', text: 'Friday works' }, { name: 'Send', verb: 'click' }] } }],
    check: (w) => w.get('replied') === 'Friday works' },
  { id: 'gmail-archive', group: 'gmail2', ask: 'Archive this email', setup: threadScene,
    legacy: [{ tool: 'click', args: { target: 'Archive' } }], v0: [{ tool: 'click', args: { target: 'Archive' } }],
    check: (w) => Boolean(w.get('archived')) },
  { id: 'gmail-discard', group: 'gmail2', ask: 'Discard the draft', setup: threadScene,
    legacy: [{ tool: 'click', args: { target: 'Discard draft' } }], v0: [{ tool: 'click', args: { target: 'Discard draft' } }],
    check: (w) => Boolean(w.get('discarded')) },
  { id: 'gmail-cc', group: 'gmail2', ask: 'Cc Sam on the draft', setup: (w) => { openDraft(w, { subject: 'Plan', body: 'Hi', focus: 'body' }); w.add({ id: 'cc', app: 'Google Chrome', role: 'AXComboBox', desc: 'Cc recipients', web: true, commit: 'chip' }); },
    legacy: [{ tool: 'type_text', args: { text: EMAIL, into: 'Cc' } }], v0: [{ tool: 'type_text', args: { text: EMAIL, into: 'Cc recipients' } }, { tool: 'press_keys', args: { keys: 'tab' } }],
    check: (w) => (w.els.get('cc')?.chips || []).includes(EMAIL) },
  { id: 'gmail-search2', group: 'gmail2', ask: 'Find emails about the invoice', setup: threadScene,
    legacy: [{ tool: 'type_text', args: { text: 'invoice', into: 'Search mail' } }, { tool: 'press_keys', args: { keys: 'return' } }],
    v0: [{ tool: 'type_text', args: { text: 'invoice', into: 'Search mail', mode: 'replace' } }, { tool: 'press_keys', args: { keys: 'return' } }],
    check: (w) => w.get('mailSearch') === 'invoice' },
  // ---------- Finder ×4 ----------
  { id: 'finder-find-recent', group: 'finder2', ask: 'Find the PDFs I changed this week', setup: (w) => { finderScene(w); w.set('files', [{ name: 'Lease.pdf', path: '/Users/me/Documents/Lease.pdf', scope: 'home', kind: 'pdf' }]); },
    legacy: [{ tool: 'type_text', args: { text: 'pdf', into: 'Search' } }], v0: [{ tool: 'find_file', args: { name: '', kind: 'pdf', days: 7 } }], check: (w) => (w.get('found') || []).length > 0 },
  { id: 'finder-icloud', group: 'finder2', ask: 'Find the trip plan in iCloud', setup: (w) => { finderScene(w); w.set('files', [{ name: 'Trip plan.pages', path: '/Users/me/Library/Mobile Documents/com~apple~CloudDocs/Trip plan.pages', scope: 'icloud', kind: 'document' }]); },
    legacy: [{ tool: 'type_text', args: { text: 'trip plan', into: 'Search' } }, { tool: 'press_keys', args: { keys: 'return' } }], v0: [{ tool: 'find_file', args: { name: 'trip plan', scope: 'icloud' } }],
    check: (w) => (w.get('found') || []).length > 0 },
  { id: 'finder-select-open', group: 'finder2', ask: 'Select the budget file', setup: finderScene,
    legacy: [{ tool: 'click', args: { target: 'Budget 2026.xlsx' } }], v0: [{ tool: 'click', args: { target: 'Budget 2026.xlsx' } }],
    check: (w) => w.get('selected') === 'Budget 2026.xlsx' },
  { id: 'finder-share2', group: 'finder2', ask: 'Share the budget file (by its menu)', setup: finderScene,
    legacy: [], v0: [{ tool: 'click', args: { target: 'Budget 2026.xlsx', button: 'right' } }, { tool: 'click', args: { target: 'Share' } }],
    v1: [{ tool: 'observe_screen', args: { app: 'Finder' } }, { tool: 'act', args: { name: 'Budget 2026.xlsx', verb: 'right_click' } }, { tool: 'observe_screen', args: { app: 'Finder' } }, { tool: 'act', args: { name: 'Share…', verb: 'click' } }],
    check: (w) => Boolean(w.get('shareOpen')) },
  // ---------- Settings ×4 ----------
  { id: 'settings-bluetooth', group: 'settings2', ask: 'Open Bluetooth settings', setup: (w) => { settingsScene(w); menuExtras(w); },
    legacy: [{ tool: 'click', args: { target: 'Bluetooth', app: 'System Settings' } }], v0: [{ tool: 'open_settings_pane', args: { pane: 'bluetooth' } }],
    check: (w) => w.apps.get('System Settings')?.window === 'Settings' && !w.get('wifiMenu') },
  { id: 'settings-notifications', group: 'settings2', ask: 'Open notification settings', setup: settingsScene,
    legacy: [{ tool: 'click', args: { target: 'Notifications', app: 'System Settings' } }], v0: [{ tool: 'open_settings_pane', args: { pane: 'notifications' } }],
    check: (w) => w.apps.get('System Settings')?.window === 'Settings' },
  { id: 'settings-dark-ref', group: 'settings2', ask: 'Turn on dark mode (by ref)', setup: settingsScene,
    legacy: [{ tool: 'click', args: { target: 'Dark', app: 'System Settings' } }], v0: [{ tool: 'click', args: { target: 'Dark', app: 'System Settings' } }],
    check: (w) => Boolean(w.get('dark')) },
  { id: 'settings-displays2', group: 'settings2', ask: 'Show me the display settings', setup: settingsScene,
    legacy: [{ tool: 'click', args: { target: 'Displays', app: 'System Settings' } }], v0: [{ tool: 'open_settings_pane', args: { pane: 'displays' } }],
    check: (w) => w.apps.get('System Settings')?.window === 'Displays' },
  // ---------- misc ×4 ----------
  { id: 'slack-web-send', group: 'misc2', ask: 'Send "on my way" in Slack', setup: slackScene,
    legacy: [{ tool: 'type_text', args: { text: 'on my way' } }, { tool: 'press_keys', args: { keys: 'return' } }],
    v0: [{ tool: 'type_text', args: { text: 'on my way', into: 'Message #general' } }, { tool: 'press_keys', args: { keys: 'return' } }],
    check: (w) => w.get('slackSent') === 'on my way' },
  { id: 'notes-append', group: 'misc2', ask: 'Add "milk" to the note', setup: (w) => { notesScene(w); const b = [...w.els.values()].find((e) => e.desc === 'Note body'); if (b) { b.value = 'eggs\n'; w.focus(b); } },
    legacy: [{ tool: 'type_text', args: { text: 'milk', app: 'Notes' } }], v0: [{ tool: 'type_text', args: { text: 'milk', into: 'Note body', app: 'Notes' } }],
    check: (w) => [...w.els.values()].some((e) => e.desc === 'Note body' && e.value === 'eggs\nmilk') },
  { id: 'youtube-captions', group: 'misc2', ask: 'Turn on captions', setup: (w) => chromeScene(w, { youtube: true }),
    legacy: [{ tool: 'press_keys', args: { keys: 'c' } }], v0: [{ tool: 'youtube_control', args: { control: 'captions' } }], check: (w) => Boolean(w.get('captions')) },
  { id: 'youtube-next', group: 'misc2', ask: 'Next video', setup: (w) => chromeScene(w, { youtube: true }),
    legacy: [{ tool: 'press_keys', args: { keys: 'shift+n' } }], v0: [{ tool: 'youtube_control', args: { control: 'next' } }],
    v1: [{ tool: 'local', args: { text: 'next video' } }], check: (w) => Boolean(w.get('next')) },
];

/** The Phase 1 suite: the 30 Phase 0 tasks and these 30. */
export const ALL_TASKS = [...TASKS, ...PHASE1_TASKS];

/**
 * Spreadsheets (Oct 3: typing one word into A1 and making it bold took 18 steps in Excel). Golden
 * tasks only (scripts/golden.js): the drivers of Sept 28–29 had no way to do these.
 * @type {Task[]}
 */
export const SHEET_TASKS = [
  {
    id: 'excel-type-bold', group: 'sheet', ask: 'Type Hello into A1 and make it bold',
    // Another cell is selected and holds text: it must be left alone.
    setup: (w) => excelScene(w, { cells: { A5: 'Total' }, sel: 'A5' }),
    legacy: [],
    v0: [{ tool: 'type_text', args: { text: 'Hello', into: 'A1', app: 'Microsoft Excel' } }, { tool: 'press_keys', args: { keys: 'cmd+b', app: 'Microsoft Excel' } }],
    check: (w) => {
      const { sel, cells } = w.apps.get('Microsoft Excel').sheet;
      return sel === 'A1' && cells.A1?.v === 'Hello' && cells.A1.bold === true && cells.A5?.v === 'Total' && !cells.A5.bold;
    },
  },
  // The Oct 3 11:16 session: a small table took 8 to 18 model requests a turn, cell by cell, and
  // half the cells failed. Through the app's scripting it is two calls.
  {
    id: 'excel-fill-block-bold-header', group: 'sheet', ask: 'Fill in a 3 by 3 table from A1 and make the header row bold',
    setup: (w) => excelScene(w, { cells: { E5: 'Notes' }, sel: 'E5' }),
    legacy: [],
    v0: [
      { tool: 'sheet_write', args: { cell: 'A1', rows: [['Item', 'Qty', 'Price'], ['Coffee', 2, 3.5], ['Tea', 10, 4]], app: 'Microsoft Excel' } },
      { tool: 'sheet_format', args: { range: 'A1:C1', bold: true, app: 'Microsoft Excel' } },
    ],
    check: (w) => {
      const { cells } = w.apps.get('Microsoft Excel').sheet;
      const v = (k) => cells[k]?.v;
      return ['A1', 'B1', 'C1'].every((k) => cells[k]?.bold === true) && ['A2', 'B2', 'C2', 'A3', 'B3', 'C3'].every((k) => !cells[k]?.bold)
        && v('A1') === 'Item' && v('B1') === 'Qty' && v('C1') === 'Price' && v('A2') === 'Coffee' && v('B2') === 2 && v('C2') === 3.5 && v('A3') === 'Tea' && v('B3') === 10 && v('C3') === 4
        && v('E5') === 'Notes' && !cells.E5.bold;
    },
  },
  // A cell was left in the middle of an edit (how "B4" got typed INTO A4 as "CoffeeB4"): Excel
  // refuses scripts until Escape, so Echo sends it once and writes; the cell being edited is untouched.
  {
    id: 'excel-write-while-editing', group: 'sheet', ask: 'Put 4 in B4',
    setup: (w) => { excelScene(w, { cells: { A4: 'Coffee' }, sel: 'A4' }); w.apps.get('Microsoft Excel').sheet.editing = true; },
    legacy: [],
    v0: [{ tool: 'type_text', args: { text: '4', into: 'B4', app: 'Microsoft Excel' } }],
    check: (w) => {
      const { cells, editing } = w.apps.get('Microsoft Excel').sheet;
      return cells.A4?.v === 'Coffee' && cells.B4?.v === 4 && !editing;
    },
  },
  // Find the header row and add a row under it, in two calls and no looking at the screen.
  {
    id: 'excel-row-under-headers', group: 'sheet', ask: 'Add Milk, 3 under the headers',
    setup: (w) => excelScene(w, { cells: { B2: 'Item', C2: 'Qty' }, sel: 'A1' }),
    legacy: [],
    v0: [{ tool: 'sheet_read', args: { app: 'Microsoft Excel' } }, { tool: 'sheet_write', args: { cell: 'B3', rows: [['Milk', 3]], app: 'Microsoft Excel' } }],
    check: (w) => {
      const { cells } = w.apps.get('Microsoft Excel').sheet;
      return cells.B2?.v === 'Item' && cells.C2?.v === 'Qty' && cells.B3?.v === 'Milk' && cells.C3?.v === 3;
    },
  },
];
