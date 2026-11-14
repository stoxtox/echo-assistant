// Recipes: the flows people ask for most, done the reliable way with checks built in, so the
// assistant picks a recipe and its details in one call instead of steering click by click.
//
// Every recipe follows the implementation ladder (a direct way first, the screen last) and the
// observe → act → verify rule: each on-screen step goes through ComputerUse.act, which only says
// "done" when the Mac app saw the change, and a recipe stops at the first step that didn't work,
// saying which and why. Anything that sends goes behind a confirmation card that shows what will
// actually be sent (the payload), never straight out.
//
// - compose_email (Gmail): "just do it" opens Gmail's compose page already filled in (a link, no
//   hunting for Compose); "let me watch" clicks Compose on screen, types the recipient and commits
//   it as a chip (checked), then the subject and body into their own fields by name (never
//   whatever has the focus). Send is a click on Send, which waits for your yes on a card.
// - facetime: a call by link. settings_pane: a System Settings pane by link. youtube: the player's
//   own keys, with the page checked to be YouTube first.
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';

/** Gmail's compose page, filled in. */
export function gmailComposeUrl({ to = '', subject = '', body = '' } = {}) {
  const q = new URLSearchParams({ view: 'cm', fs: '1' });
  if (to) q.set('to', to);
  if (subject) q.set('su', subject);
  if (body) q.set('body', body);
  return `https://mail.google.com/mail/?${q.toString()}`;
}

/** System Settings panes people ask for, by their link. */
export const SETTINGS_PANES = {
  wifi: 'com.apple.wifi-settings-extension',
  bluetooth: 'com.apple.BluetoothSettings',
  displays: 'com.apple.Displays-Settings.extension',
  sound: 'com.apple.Sound-Settings.extension',
  battery: 'com.apple.Battery-Settings.extension',
  notifications: 'com.apple.Notifications-Settings.extension',
  focus: 'com.apple.Focus-Settings.extension',
  general: 'com.apple.systempreferences.GeneralSettings',
  appearance: 'com.apple.Appearance-Settings.extension',
  desktop: 'com.apple.Desktop-Settings.extension',
  wallpaper: 'com.apple.Wallpaper-Settings.extension',
  keyboard: 'com.apple.Keyboard-Settings.extension',
  trackpad: 'com.apple.Trackpad-Settings.extension',
  network: 'com.apple.Network-Settings.extension',
  storage: 'com.apple.settings.Storage',
  'software update': 'com.apple.Software-Update-Settings.extension',
};

/** YouTube's own keys for what people say. */
export const YOUTUBE_KEYS = {
  play: 'k', pause: 'k', toggle: 'k', forward: 'l', back: 'j', fullscreen: 'f', exit_fullscreen: 'escape',
  captions: 'c', mute: 'm', next: 'shift+n', previous: 'shift+p', faster: 'shift+.', slower: 'shift+,',
};

const CHROME = 'Google Chrome';

export class Recipes {
  /**
   * @param {{ computer: import('./computer.js').ComputerUse, quick?: any, open?: (url: string) => Promise<any>, now?: () => number }} o
   *   open: opens a link (default: quick.openUrl, or `open` for app links)
   */
  constructor({ computer, quick = null, open, now = Date.now }) {
    this.computer = computer;
    this.quick = quick;
    this.open = open || (async (url) => (quick ? quick.openUrl(url) : { opened: url }));
    this.now = now;
  }

  /** One on-screen step; the recipe stops at the first that didn't work. */
  async step(log, label, action, args, opts) {
    const t0 = this.now();
    const r = await this.computer.act(action, { app: CHROME, ...args, ...(args.into ? { target: args.into } : {}) }, opts);
    const ok = Boolean(r?.done) || Boolean(r?.waitingForConfirmation);
    log.push({ step: label, ok, ms: this.now() - t0, ...(r?.verified !== undefined ? { verified: r.verified } : {}), ...(ok ? {} : { why: r?.note || r?.message || r?.error || 'failed' }) });
    return { ok, r };
  }

  /**
   * Gmail compose. watch=false: the filled-in compose page by link (fast). watch=true: on screen,
   * every field checked. send=true: then Send, behind the payload card.
   * @param {{ to: string, subject?: string, body?: string, watch?: boolean, send?: boolean }} o
   */
  async gmailCompose({ to, subject = '', body = '', watch = false, send = false }) {
    const t0 = this.now();
    /** @type {any[]} */
    const log = [];
    const payload = { kind: 'email', to, subject, body };
    const recipient = String(to || '').trim();
    if (!recipient) return { ok: false, error: 'no_recipient', message: 'Who is the email to? An email address works best.' };
    // A dictated address is read back (spelled out) and confirmed before it goes into the To field.
    const rb = this.computer.readBack?.([recipient]);
    if (rb) return { ok: false, ...rb };
    const finish = (extra) => ({ ms: this.now() - t0, steps: log, ...extra });
    const sendStep = async () => {
      if (!send) return finish({ ok: true, drafted: true, note: 'The draft is filled in and waiting. Ask whether to send it; sending shows a card with what will go out.' });
      const s = await this.step(log, 'send', 'click', { target: 'Send', scope: 'page', payload });
      if (s.r?.waitingForConfirmation) return finish({ ok: true, drafted: true, waitingForConfirmation: true, confirmId: s.r.confirmId, what: s.r.what, note: 'The Send card is up with the recipient, subject and first line. Ask the user; call confirm_action after a clear yes or no.' });
      return finish({ ok: s.ok, drafted: true, sent: s.ok, ...(s.ok ? {} : { failedAt: 'send', why: s.r?.note || s.r?.message }) });
    };

    // Fast: Gmail's compose page, filled in. No hunting for Compose, no typing into the wrong field.
    const byLink = async (why) => {
      await this.open(gmailComposeUrl({ to: recipient, subject, body }));
      log.push({ step: 'open compose link', ok: true, ...(why ? { why } : {}) });
      this.computer.noteApp(CHROME);
      // Checked when Echo can look: the draft window is there.
      if (this.computer.enabled && this.computer.bridge?.native) {
        const w = await this.computer.act('wait_for', { target: subject ? subject.slice(0, 60) : 'Send', timeout_seconds: 12, app: CHROME });
        log.push({ step: 'draft open', ok: Boolean(w?.found), verified: Boolean(w?.found) });
        if (!w?.found) return finish({ ok: false, failedAt: 'draft open', why: 'The compose page did not show up. Look at the screen: Gmail may need signing in.' });
        return sendStep();
      }
      return finish({ ok: true, drafted: true, verified: 'unchecked', note: 'Opened the filled-in compose page. Echo could not check the screen (computer use or the Mac app is off).' });
    };
    if (!watch) return byLink('');

    // On screen, so the user can watch. Compose: the button on the page (never Chrome's own).
    const compose = await this.step(log, 'compose', 'click', { target: 'Compose', scope: 'page', expect: 'Recipients', say: 'Opening a new email…', steps_total: send ? 6 : 5 });
    if (!compose.ok) return byLink('Compose did not open on screen, so the filled-in compose page was opened instead');
    // The recipient: typed into the To box, committed as a chip with Tab, and the chip checked.
    const typedTo = await this.step(log, 'to', 'type_text', { text: recipient, into: 'To recipients', scope: 'page', say: 'Adding the recipient…' });
    if (!typedTo.ok) return finish({ ok: false, failedAt: 'to', why: typedTo.r?.note || typedTo.r?.message });
    const chip = await this.step(log, 'to chip', 'press_keys', { keys: 'tab', expect: recipient.includes('@') ? recipient.split('@')[0] : recipient });
    if (!chip.ok) return finish({ ok: false, failedAt: 'to chip', why: 'The recipient did not turn into a chip.' });
    if (subject) {
      const sub = await this.step(log, 'subject', 'type_text', { text: subject, into: 'Subject', mode: 'replace', scope: 'page', say: 'Adding the subject…' });
      if (!sub.ok) return finish({ ok: false, failedAt: 'subject', why: sub.r?.note || sub.r?.message });
    }
    if (body) {
      const b = await this.step(log, 'body', 'type_text', { text: body, into: 'Message Body', scope: 'page', say: 'Writing it…' });
      if (!b.ok) return finish({ ok: false, failedAt: 'body', why: b.r?.note || b.r?.message });
    }
    return sendStep();
  }

  /** A FaceTime call by link (video or audio), after the user said who. */
  async facetime({ handle, audio = false }) {
    const h = String(handle || '').trim();
    if (!/^[+\d][\d\s().-]{6,}$|^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(h)) return { ok: false, error: 'bad_handle', message: 'FaceTime needs a phone number or an email address.' };
    const url = `${audio ? 'facetime-audio' : 'facetime'}://${encodeURIComponent(h.replace(/[\s().-]/g, ''))}`;
    await this.open(url);
    return { ok: true, opened: audio ? 'FaceTime audio' : 'FaceTime', note: 'FaceTime asks to confirm the call on screen; the user presses Call.' };
  }

  /** A System Settings pane, straight there. */
  async settingsPane({ pane }) {
    const key = String(pane || '').toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
    const id = SETTINGS_PANES[key] || SETTINGS_PANES[key.replace(/ /g, '')];
    if (!id) return { ok: false, error: 'unknown_pane', message: `I know these panes: ${Object.keys(SETTINGS_PANES).join(', ')}.` };
    await this.open(`x-apple.systempreferences:${id}`);
    this.computer.noteApp('System Settings');
    return { ok: true, opened: key };
  }

  /** YouTube player controls: its own keys, only once the front tab is YouTube. */
  async youtube({ control }) {
    const keys = YOUTUBE_KEYS[String(control || '')];
    if (!keys) return { ok: false, error: 'unknown_control', message: `Controls: ${Object.keys(YOUTUBE_KEYS).join(', ')}.` };
    const r = await this.computer.act('press_keys', { keys, app: CHROME });
    if (r?.error || r?.refused) return { ok: false, ...r };
    if (!/youtube/i.test(`${r?.window || ''} ${r?.observed?.url || ''}`)) return { ok: false, error: 'not_youtube', message: 'The front Chrome tab is not YouTube, so Echo only pressed the key once. Open the video first.' };
    return { ok: Boolean(r?.done), control, verified: r?.verified };
  }
}

const out = (value) => ({ content: [{ type: /** @type {const} */ ('text'), text: JSON.stringify(value) }], ...(value && (value.error || value.ok === false) ? { isError: true } : {}) });

export const RECIPE_TOOL_NAMES = ['compose_email', 'facetime_call', 'open_settings_pane', 'youtube_control'];

/**
 * The recipe tools for the assistant.
 * @param {Recipes} recipes
 */
export function recipeTools(recipes) {
  const run = async (fn) => {
    try {
      return out(await fn());
    } catch (e) {
      return out({ ok: false, error: 'failed', message: String(e?.message || e) });
    }
  };
  return [
    tool(
      'compose_email',
      'Write an email in Gmail (Chrome) in one call, checked at every step. watch=false (default) opens the compose page already filled in; watch=true does it on screen so the user sees it (Compose, To as a chip, Subject, body). send=true then clicks Send, which waits for the user\'s yes on a card showing the recipient, subject and first line.',
      {
        to: z.string().describe('The email address (best), or a name as Gmail knows it'),
        subject: z.string().optional(),
        body: z.string().optional(),
        watch: z.boolean().optional().describe('True when the user wants to see it done on screen ("show me", "do it on the screen")'),
        send: z.boolean().optional().describe('True only when the user asked to send it'),
      },
      (a) => run(() => recipes.gmailCompose(a))
    ),
    tool(
      'facetime_call',
      'Start a FaceTime call (video, or audio) to a phone number or email (from find_contact the user confirmed). FaceTime asks to confirm on screen.',
      { handle: z.string(), audio: z.boolean().optional() },
      (a) => run(() => recipes.facetime(a))
    ),
    tool(
      'open_settings_pane',
      `Open a System Settings pane directly: ${Object.keys(SETTINGS_PANES).join(', ')}.`,
      { pane: z.string() },
      (a) => run(() => recipes.settingsPane(a))
    ),
    tool(
      'youtube_control',
      'Control the YouTube video in the front Chrome tab with its own keys: play/pause, forward/back 10 s, fullscreen, captions, mute, next, faster/slower.',
      { control: z.enum(/** @type {[string, ...string[]]} */ (Object.keys(YOUTUBE_KEYS))) },
      (a) => run(() => recipes.youtube(a))
    ),
  ];
}
