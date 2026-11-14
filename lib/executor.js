// The element-ref executor: one API over every way Echo can see and act (the plan's
// observe → act → verify).
//
//   observe()          → a compact, rotor-style list of what's on screen, each with a ref:
//                        [e7] combobox "To recipients", [e14] button "Send". From the Echo Chrome
//                        extension or Chrome's DevTools port for a web page (lib/browser.js), from
//                        the Mac app's Accessibility reading for everything else (n-refs).
//   act({ ref, verb }) → acts on exactly that element (no label guessing) and checks it worked:
//                        verbs click, double_click, right_click, hover, fill, replace, clear,
//                        upload (a file input, browser only), with commit enter/tab/comma.
//   batch(steps)       → 2–5 steps in a row, each checked; stops at the first that didn't work
//                        (or that needs the user's yes), so one model call does several steps.
//
// A ref is only good for the observation it came from: a stale ref is refused and the assistant
// observes again. Every act goes through ComputerUse's safety gate (refusals, the confirmation
// card) exactly like a label-based step, and is logged the same way.
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { rotor, judgeBrowserAct, findByLabel } from './browser.js';
import { classifyAction, narration, cleanPayload } from './computer.js';
import { redactText } from './screen.js';

export const VERBS = ['click', 'double_click', 'right_click', 'hover', 'fill', 'replace', 'clear', 'upload'];
const BROWSER_APPS = /^(google chrome|chrome|chromium|brave browser|microsoft edge|arc)$/i;

/** A page element's kind, as the safety gate's Accessibility roles. */
const AX_ROLE = { textbox: 'AXTextField', combobox: 'AXComboBox', searchbox: 'AXSearchField', button: 'AXButton', link: 'AXLink', checkbox: 'AXCheckBox', radio: 'AXRadioButton', tab: 'AXTab', menuitem: 'AXMenuItem' };

/** Which browser adapter to use: the extension when it's connected, else Chrome's DevTools port. */
export class BrowserHub {
  /** @param {{ extension?: import('./browser.js').ExtensionBrowser | null, cdp?: import('./browser.js').CdpBrowser | null }} o */
  constructor({ extension = null, cdp = null } = {}) {
    this.extension = extension;
    this.cdp = cdp;
  }

  /**
   * The extension, else Chrome's debugging port. A paired extension that is on its way back
   * (Echo just restarted, or it dropped a moment ago) is waited for a few seconds first.
   * @returns {Promise<any | null>}
   */
  async pick() {
    if (this.extension?.connected) return this.extension;
    if (this.extension?.expectedBack?.() && (await this.extension.waitForConnection())) return this.extension;
    if (this.cdp && (await this.cdp.available())) return this.cdp;
    return null;
  }

  /** Is the extension connected right now (no waiting)? */
  get connected() {
    return Boolean(this.extension?.connected);
  }

  async status() {
    return {
      extension: Boolean(this.extension?.connected),
      cdp: Boolean(this.cdp && (await this.cdp.available().catch(() => false))),
      ...(this.extension ? { extensionStatus: this.extension.status(), detail: this.extension.explain() } : {}),
    };
  }

  /** Why no browser is available, for the assistant: what the extension's socket last did. */
  explain() {
    const ext = this.extension ? this.extension.explain() : 'The Echo Chrome extension is not set up.';
    return `${ext} Chrome has no debugging port open either.`;
  }
}

export class Executor {
  /**
   * @param {{ computer: import('./computer.js').ComputerUse, browser?: BrowserHub | null }} o
   */
  constructor({ computer, browser = null }) {
    this.computer = computer;
    this.browser = browser;
    computer.refActor = (p) => this.confirmed(p);
    // Typing's paste fallback asks the page where the focus is and whether the text landed.
    computer.browser = browser;
    /** The last observation: where it came from, its id, its elements. @type {{ source: 'browser' | 'native', adapter?: any, snapshot: string, elements: any[], app: string, url?: string, title?: string } | null} */
    this.last = null;
  }

  /** Is the app the user is working in a browser (so the page is read through the browser)? */
  wantsBrowser(app) {
    const a = String(app || this.computer.run?.app || this.computer.appContext || '');
    return !a || BROWSER_APPS.test(a);
  }

  /**
   * What's on screen, with refs.
   * @param {{ app?: string, source?: 'auto' | 'browser' | 'native', scope?: string }} [o]
   */
  async observe({ app = '', source = 'auto', scope } = {}) {
    const no = this.computer.enabled ? null : this.computer.unavailable();
    if (no) return no;
    if (source !== 'native' && this.browser && (source === 'browser' || this.wantsBrowser(app))) {
      const adapter = await this.browser.pick();
      if (adapter) {
        try {
          const s = await adapter.snapshot();
          this.last = { source: 'browser', adapter, snapshot: s.snapshot, elements: s.elements || [], app: app || 'Google Chrome', url: s.url, title: s.title };
          this.computer.noteApp(this.last.app);
          return { source: 'browser', snapshot: s.snapshot, count: this.last.elements.length, page: rotor(s) };
        } catch (e) {
          // The extension answered but couldn't read a page (the front tab is chrome://, the
          // extension's own options, a new tab): it IS connected, and says so.
          if (source === 'browser') return { error: e.code || 'browser', message: e.message, connected: adapter === this.browser.extension };
        }
      } else if (source === 'browser') {
        return { error: 'no_browser', connected: false, message: `${this.browser.explain()} Tell the user they can pair the extension in Settings, under On your Mac; meanwhile use click and type_text by label.` };
      }
    }
    if (!this.computer.bridge?.native) return { error: 'no_app', message: 'Seeing an app\'s controls needs the Echo Mac app, and it is not open.' };
    const r = await this.computer.bridge.request('observe', { app: app || this.computer.run?.app || this.computer.appContext || undefined, scope });
    if (!r?.ok) return { error: r?.error || 'failed', message: r?.message || "Couldn't read the app's controls." };
    this.last = { source: 'native', snapshot: String(r.snapshot), elements: r.elements || [], app: String(r.app || app || ''), title: r.title };
    if (this.last.app) this.computer.noteApp(this.last.app);
    /** @type {any} */
    const seen = { source: 'native', snapshot: r.snapshot, count: this.last.elements.length, page: rotor({ snapshot: r.snapshot, url: '', title: `${r.app} · ${r.title || ''}`, elements: this.last.elements }) };
    // Chrome read through Accessibility (the page itself couldn't be read): say so plainly, so a
    // list of Chrome's own buttons isn't mistaken for the page.
    if (this.browser && source !== 'native' && BROWSER_APPS.test(this.last.app)) {
      seen.browser = { connected: this.browser.connected, ...(this.browser.extension ? { why: this.browser.extension.explain() } : {}) };
      seen.browserNote = "This is Chrome read through the Mac's Accessibility, not the page through the Echo extension, so the page's own fields may be missing. Tell the user in a few words if it matters (why is in browser.why); click and type_text by label or x/y still work.";
    }
    return seen;
  }

  /** The element behind a ref in the last observation, or why not. */
  element(ref, snapshot) {
    if (!this.last) return { error: 'no_observation', message: 'Observe first (observe_screen), then act on a ref from it.' };
    if (snapshot && snapshot !== this.last.snapshot) return { error: 'stale', message: `That ref is from an older observation (${snapshot}); the latest is ${this.last.snapshot}. Observe again.` };
    const el = this.last.elements.find((e) => e.ref === ref);
    if (!el) return { error: 'no_ref', message: `There's no ${ref} in the last observation.` };
    return { el };
  }

  /**
   * Act on a ref, checked. Browser refs go through the page; native refs through the Mac app.
   * @param {{ ref: string, verb: string, text?: string, commit?: 'enter' | 'tab' | 'comma', files?: string[], snapshot?: string, expect?: string, say?: string, payload?: any }} a
   * @param {{ confirmed?: string, fresh?: boolean }} [opts] fresh: after a page change, a new
   *   observation comes back with the result (off inside a batch, whose refs share one observation)
   */
  async act(a, { confirmed, fresh = true } = {}) {
    if (!VERBS.includes(a.verb)) return { error: 'bad_verb', message: `verb is one of ${VERBS.join(', ')}.` };
    const found = this.element(a.ref, a.snapshot);
    if (found.error) return found;
    const el = found.el;
    if (this.last?.source === 'native') return this.actNative(a, el, { confirmed });
    return this.actBrowser(a, el, { confirmed, fresh });
  }

  /** Native: the Mac app acts on the ref's element (resolve by ref, then the usual do + verify). */
  async actNative(a, el, { confirmed }) {
    const last = /** @type {NonNullable<Executor['last']>} */ (this.last);
    const base = { ref: a.ref, snapshot: last.snapshot, app: last.app, target: el.name || a.ref, say: a.say, expect: a.expect, payload: a.payload };
    const map = {
      click: ['click', {}], double_click: ['click', { clicks: 2 }], right_click: ['click', { button: 'right' }], hover: ['hover', {}],
      fill: ['type_text', { text: a.text, mode: 'append' }], replace: ['type_text', { text: a.text, mode: 'replace' }], clear: ['clear_field', {}],
    };
    if (a.verb === 'upload') return { error: 'unsupported', message: 'Attaching a file by ref works in the browser (the Echo extension). In other apps, drag the file or use the app\'s own attach button.' };
    const [action, extra] = map[a.verb];
    const r = await this.computer.act(action, { ...base, ...extra }, { confirmed });
    if (r?.done && a.commit) {
      const key = { enter: 'return', tab: 'tab', comma: ',' }[a.commit];
      const c = await this.computer.act('press_keys', { keys: key, app: last.app });
      return { ...r, commit: { done: c.done, ...(c.waitingForConfirmation ? c : {}) } };
    }
    return r;
  }

  /** Browser: the safety gate, then the page acts and reads itself back. */
  async actBrowser(a, el, { confirmed, fresh = true }) {
    const c = this.computer;
    const last = /** @type {NonNullable<Executor['last']>} */ (this.last);
    const no = c.unavailable();
    if (no) return no;
    const heard = !confirmed && c.heardMidRun();
    if (heard) return heard;
    if (['fill', 'replace'].includes(a.verb) && !String(a.text || '')) return { error: 'empty', message: 'Nothing to type.' };
    const action = { fill: 'type_text', replace: 'type_text', clear: 'clear_field', hover: 'hover' }[a.verb] || (a.verb === 'upload' ? 'click' : 'click');
    const resolved = { label: el.name, role: AX_ROLE[el.role] || 'AXGroup', app: last.app, window: `${last.title || ''} ${last.url || ''}`, field: el.name, secure: Boolean(el.secret) };
    const verdict = classifyAction({ action, target: el.name, text: a.text, keys: a.commit === 'enter' ? 'return' : undefined, resolved });
    // Return on a field (commit enter) is judged like pressing Return there.
    const commitVerdict = a.commit === 'enter' ? classifyAction({ action: 'press_keys', keys: 'return', resolved }) : { level: 'ok' };
    const worst = verdict.level === 'refuse' ? verdict : commitVerdict.level === 'risky' && verdict.level !== 'risky' ? commitVerdict : verdict;
    if (worst.level === 'refuse') return c.refuse(action, { ...a, target: el.name }, worst, resolved);
    const rb = ['fill', 'replace'].includes(a.verb) ? c.readBack([String(a.text)]) : null;
    if (rb) return rb;
    if (worst.level === 'risky' && confirmed !== worst.category) {
      return c.askFirst(`ref:${a.verb}`, { ...a, target: el.name, payload: a.payload }, worst, resolved);
    }
    const run = c.ensureRun();
    if (run.steps >= c.maxSteps) {
      c.end('step_cap');
      return { error: 'step_cap', message: `That's ${c.maxSteps} steps, the most in one go, so Echo stopped. Tell the user where things are and ask before carrying on.` };
    }
    run.steps++;
    c.emitState();
    c.touch();
    const say = narration(a.say);
    if (say) c.emit('say', say);
    c.inFlight++;
    let r;
    const t0 = Date.now();
    try {
      r = await last.adapter.act({ snapshot: last.snapshot, ref: a.ref, verb: a.verb === 'clear' ? 'replace' : a.verb, text: a.verb === 'clear' ? '' : a.text || '', commit: a.commit || '', files: a.files || [] });
    } catch (e) {
      c.record({ event: 'action', run: run.id, step: run.steps, action: `ref:${a.verb}`, ref: a.ref, target: redactText(el.name || '').text.slice(0, 80), via: 'browser', ok: false, error: e.code || 'failed' });
      return { error: e.code || 'failed', done: false, message: e.message };
    } finally {
      c.inFlight = Math.max(0, c.inFlight - 1);
    }
    const judged = judgeBrowserAct(a.verb === 'clear' ? 'replace' : a.verb, r, { text: a.verb === 'clear' ? '' : a.text || '' });
    c.record({ event: 'action', run: run.id, step: run.steps, action: `ref:${a.verb}`, ref: a.ref, target: redactText(el.name || '').text.slice(0, 80), role: el.role, via: `browser/${r.via || 'cdp'}`, ok: true, verified: judged.verified, ms: Date.now() - t0 });
    /** @type {any} */
    const out = { done: judged.verified, verified: judged.verified, step: run.steps, did: `${a.verb.replace('_', ' ')} ${a.ref} “${redactText(el.name || '').text.slice(0, 60)}”`, observed: { value: redactText(String(r.after?.value || '')).text.slice(0, 160), url: String(r.after?.url || '').slice(0, 200) } };
    if (judged.verified && a.expect) {
      const s = await last.adapter.snapshot().catch(() => null);
      const seen = Boolean(s && (findByLabel(s.elements || [], a.expect) || String(s.title || '').toLowerCase().includes(String(a.expect).toLowerCase())));
      out.expected = { appears: a.expect, found: seen };
      if (!seen) out.done = out.verified = false;
      if (s) this.last = { ...last, snapshot: s.snapshot, elements: s.elements || [], url: s.url, title: s.title };
    }
    // The page changed (a dialog opened, a new page): the new observation comes with the result,
    // so the next step needs no separate observe_screen (chrome-devtools-mcp's includeSnapshot).
    const changed = r.after?.url !== r.before?.url || r.after?.nodes !== r.before?.nodes || !r.after?.exists;
    if (fresh && out.done && changed && !out.expected) {
      const s = await last.adapter.snapshot().catch(() => null);
      if (s) {
        this.last = { ...last, snapshot: s.snapshot, elements: s.elements || [], url: s.url, title: s.title };
        out.page = rotor(s);
      }
    }
    out.note = out.done
      ? out.page ? 'Confirmed on the page. It changed; the new observation is above (use its refs).' : 'Confirmed on the page.'
      : `NOT confirmed: ${judged.why || `"${a.expect}" didn't show up`}. Don't tell the user it worked. Observe again and try another way.`;
    return out;
  }

  /**
   * Several steps, each checked, stopping at the first that didn't work or needs a yes.
   * A step is { ref, verb, text?, commit?, expect? } (by ref) or { action, ...args } (by label).
   * @param {any[]} steps
   */
  async batch(steps) {
    // Every detail the batch would type, read back in one question before any of it is typed.
    const rb = this.computer.readBack(steps.filter((st) => ['fill', 'replace', 'type_text'].includes(st.verb || st.action)).map((st) => String(st.text || '')));
    if (rb) return { ...rb, completed: 0, of: steps.length };
    const results = [];
    for (const [i, st] of steps.entries()) {
      const r = st.ref ? await this.act(st, { fresh: false }) : await this.computer.act(st.action, { ...st, action: undefined, target: st.target ?? st.into });
      const ok = Boolean(r?.done);
      results.push({ step: i + 1, ok, ...(r?.waitingForConfirmation ? { waitingForConfirmation: true, confirmId: r.confirmId, what: r.what } : {}), ...(ok ? {} : { why: r?.note || r?.message || r?.error }) });
      if (!ok) {
        if (r?.waitingForConfirmation) {
          return { done: false, completed: i, of: steps.length, results, waitingForConfirmation: true, confirmId: r.confirmId, what: r.what, remaining: steps.slice(i + 1),
            note: "Stopped at a step that needs the user's yes (a card is up). Ask; after a clear yes, confirm_action with this confirmId does that step, then batch_actions the remaining steps." };
        }
        return { done: false, completed: i, of: steps.length, results, note: 'Stopped at the first step that did not work; the ones after it were not done. Look (observe_screen) and decide.' };
      }
    }
    // One new observation at the end, if the batch was on a page.
    const out = { done: true, completed: steps.length, of: steps.length, results };
    if (this.last?.source === 'browser' && steps.some((st) => st.ref)) {
      const s = await this.last.adapter.snapshot().catch(() => null);
      if (s) {
        this.last = { ...this.last, snapshot: s.snapshot, elements: s.elements || [], url: s.url, title: s.title };
        out.page = rotor(s);
      }
    }
    return out;
  }

  /** A confirmed ref step (the card was allowed): run it again with the category confirmed. */
  async confirmed(p) {
    return this.act({ ...p.args, verb: String(p.action).replace(/^ref:/, '') }, { confirmed: p.category });
  }
}

const out = (value) => ({ content: [{ type: /** @type {const} */ ('text'), text: typeof value?.page === 'string' ? `${value.page}\n\n${JSON.stringify({ ...value, page: undefined })}` : JSON.stringify(value) }], ...(value && (value.error || value.refused) ? { isError: true } : {}) });

export const EXECUTOR_TOOL_NAMES = ['observe_screen', 'act', 'batch_actions'];

const stepSchema = z.object({
  ref: z.string().optional().describe('A ref from the last observe_screen, e.g. "e7" or "n12"'),
  verb: z.enum(/** @type {[string, ...string[]]} */ (VERBS)).optional(),
  text: z.string().optional(),
  commit: z.enum(['enter', 'tab', 'comma']).optional(),
  expect: z.string().optional(),
  action: z.enum(['click', 'type_text', 'press_keys', 'scroll', 'hover', 'clear_field']).optional().describe('For a step by label instead of ref'),
  target: z.string().optional(),
  into: z.string().optional(),
  keys: z.string().optional(),
  mode: z.enum(['append', 'replace']).optional(),
  direction: z.enum(['up', 'down', 'left', 'right']).optional(),
  app: z.string().optional(),
});

/** @param {Executor} ex */
export function executorTools(ex) {
  return [
    tool(
      'observe_screen',
      'See the front app\'s controls as a list with refs, grouped by kind: [e7] combobox "To recipients", [e14] button "Send". In Chrome it reads the page itself (the Echo extension or Chrome\'s debugging port); elsewhere the Mac\'s Accessibility. Then act on a ref: exact, no label guessing. Refs expire when the page changes: observe again.',
      { app: z.string().optional(), source: z.enum(['auto', 'browser', 'native']).optional(), scope: z.enum(['page', 'app', 'browser']).optional() },
      async (a) => out(await ex.observe(a))
    ),
    tool(
      'act',
      'Act on a ref from the last observe_screen, checked afterwards: click, double_click, right_click, hover, fill (type, adding), replace (empty it, then type), clear, upload (attach files to a file input, browser only). commit presses enter, tab or comma after typing (tab or comma turns an email address into a chip). Risky steps wait for the user\'s yes like any click.',
      {
        ref: z.string(),
        verb: z.enum(/** @type {[string, ...string[]]} */ (VERBS)),
        text: z.string().optional(),
        commit: z.enum(['enter', 'tab', 'comma']).optional(),
        files: z.array(z.string()).optional().describe('upload: full paths from find_file'),
        expect: z.string().optional().describe('Something that should appear afterwards'),
        say: z.string().optional(),
      },
      async (a) => out(await ex.act(a))
    ),
    tool(
      'batch_actions',
      'Do 2 to 5 steps in one go, each checked, stopping at the first that did not work or needs a yes (e.g. fill To, commit, fill Subject, fill the body). Steps are by ref ({ ref, verb, text, commit }) or by label ({ action, target/into, text, keys }).',
      { steps: z.array(stepSchema).min(1).max(5) },
      async ({ steps }) => out(await ex.batch(steps))
    ),
  ];
}

export { cleanPayload };
