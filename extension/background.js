// Echo for Chrome: the extension side of Echo's browser adapter (lib/browser.js in Echo).
//
// It keeps one WebSocket to Echo on this Mac (ws://127.0.0.1:<port>/ws/browser?code=<pairing
// code>), and answers Echo's requests about the active tab: a snapshot of its interactive
// elements with refs, acting on a ref with real input (chrome.debugger: real mouse events and
// Input.insertText, DOM.setFileInputFiles for attachments; the page's own events if the debugger
// can't attach), and reading it back so Echo can check it worked. Nothing is sent anywhere else.
// It never reads or fills password fields.
//
// Staying connected (Manifest V3): Chrome stops an idle service worker after about 30 seconds,
// which silently drops the socket. So the worker sends a keep-alive ping every 20 seconds (a
// WebSocket message keeps it awake, Chrome 116+), and an alarm every 30 seconds wakes it and
// reconnects if it was stopped anyway. There's only ever one socket (a second one made Echo close
// the first, and each reconnect replaced the other in a loop).
//
// What it shows is what Echo said, not a guess: "connected" (the green dot) only after Echo's
// `welcome`, which it sends once it has accepted the socket. A socket that closes before that was
// refused (the pairing code is wrong) if Echo is running, or Echo isn't running.
//
// Reconnecting by itself (Oct 11): the pairing code and port live in chrome.storage.local, which
// survives Chrome restarts, extension reloads and Echo restarts (Echo keeps its code in its data
// folder). A lost connection is retried at once and then with a growing wait (1 s doubling, at
// most RETRY_MAX_MS, with a little jitter), and the alarm catches a worker Chrome stopped. A socket
// that stops answering (no pong for two keep-alives: the Mac slept, Echo was killed) is closed
// and replaced instead of looking open forever, and a try that hangs is given up after
// CONNECT_TIMEOUT_MS. With no code yet it still knocks (with an empty code), so Echo's window can
// show one clear "pair the extension" prompt instead of nothing happening.
import { snapshotPage, readBack, locate, actInPage, selectAllIn, focusInFrame, textInFrame } from './page.js';

const KEEPALIVE_MS = 20000;
const RETRY_MAX_MS = 10000;
const CONNECT_TIMEOUT_MS = 6000;
let ws = null; // the one socket: opening or open
let accepted = false; // Echo sent `welcome` on it
let backoff = 1000;
let retryTimer = null;
let keepalive = null;
let lastHeard = 0; // when Echo last said anything on this socket
/** @type {{ state: string, detail: string, at: number }} */
let status = { state: 'starting', detail: '', at: Date.now() };

async function settings() {
  const s = await chrome.storage.local.get({ port: 4777, code: '' });
  return { port: Number(s.port) || 4777, code: String(s.code || '').trim() };
}

/**
 * The state everyone sees: the toolbar badge and title, and the options page (which reads it
 * from session storage and hears it change).
 * @param {'connected' | 'connecting' | 'refused' | 'offline' | 'unpaired'} state @param {string} [detail]
 */
function setStatus(state, detail = '') {
  status = { state, detail, at: Date.now() };
  const on = state === 'connected';
  chrome.action.setBadgeText({ text: on ? '●' : state === 'refused' ? '!' : '' });
  chrome.action.setBadgeBackgroundColor({ color: on ? '#3ec27a' : state === 'refused' ? '#e0564f' : '#888' });
  chrome.action.setTitle({ title: on ? 'Echo is connected: it can read the front web tab' : detail || 'Echo is not connected (open the options to pair)' });
  chrome.storage.session.set({ echoStatus: status }).catch(() => {});
}

function stopKeepalive() {
  clearInterval(keepalive);
  keepalive = null;
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  clearTimeout(retryTimer);
  retryTimer = null;
  const { port, code } = await settings();
  // Another call may have opened one while settings were read.
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  if (!code) setStatus('unpaired', "Not paired yet: paste the code from Echo's Settings, under Screen.");
  else if (!accepted && status.state !== 'refused') setStatus('connecting', 'Connecting to Echo…');
  let sock;
  try {
    // Unpaired, it still knocks (an empty code is always refused) so Echo can ask for the pairing.
    sock = new WebSocket(`ws://127.0.0.1:${port}/ws/browser?code=${encodeURIComponent(code)}`);
  } catch {
    return retry();
  }
  ws = sock;
  accepted = false;
  // A try that neither opens nor fails (it happens after the Mac wakes): give it up and try again.
  const opening = setTimeout(() => {
    if (ws === sock && sock.readyState === WebSocket.CONNECTING) try { sock.close(); } catch {}
  }, CONNECT_TIMEOUT_MS);
  sock.onopen = () => {
    clearTimeout(opening);
    lastHeard = Date.now();
    sock.send(JSON.stringify({ type: 'hello', version: chrome.runtime.getManifest().version, browser: navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] || 'Chrome' }));
    stopKeepalive();
    keepalive = setInterval(() => {
      if (sock.readyState !== WebSocket.OPEN) return;
      // Echo hasn't answered two keep-alives: the socket is dead even if it still looks open.
      if (Date.now() - lastHeard > KEEPALIVE_MS * 2 + 5000) {
        try { sock.close(4000, 'no answer'); } catch {}
        return;
      }
      sock.send(JSON.stringify({ type: 'ping' }));
    }, KEEPALIVE_MS);
  };
  sock.onmessage = async (ev) => {
    lastHeard = Date.now();
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (m.type === 'welcome') {
      accepted = true;
      backoff = 1000;
      return setStatus('connected');
    }
    if (m.type === 'pong') return;
    if (!m.id) return;
    try {
      const result = await handle(m.cmd, m.args || {});
      sock.send(JSON.stringify({ id: m.id, ok: true, result }));
    } catch (e) {
      sock.send(JSON.stringify({ id: m.id, ok: false, error: String(e?.message || e), code: e?.code || 'failed' }));
    }
  };
  sock.onclose = async (ev) => {
    clearTimeout(opening);
    if (ws !== sock) return; // an old socket we already replaced
    ws = null;
    stopKeepalive();
    const was = accepted;
    accepted = false;
    if (ev.reason === 'replaced') {
      // Another copy of this extension (a second Chrome profile) took over: don't fight it.
      setStatus('offline', 'Another Chrome profile with Echo for Chrome is connected instead.');
      return retry(30000);
    }
    if (was) {
      // Echo restarted (or the socket died): straight back, then the usual growing wait.
      setStatus('connecting', 'Lost the connection to Echo; reconnecting…');
      backoff = 1000;
      return retry(500);
    }
    if (!code) setStatus('unpaired', "Not paired yet: paste the code from Echo's Settings, under Screen.");
    else if (await echoRunning(port)) setStatus('refused', "Echo refused the pairing code. Copy it again from Echo's Settings, under Screen, and click Connect.");
    else setStatus('offline', `Echo isn't running on port ${port}. It reconnects by itself when Echo starts.`);
    retry();
  };
  sock.onerror = () => {};
}

/** Is Echo answering on this port (so a refused socket means a wrong code)? */
async function echoRunning(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

function retry(ms = backoff) {
  clearTimeout(retryTimer);
  // A little jitter, so two Chrome profiles don't knock in lockstep.
  retryTimer = setTimeout(connect, Math.round(ms * (0.85 + Math.random() * 0.3)));
  backoff = Math.min(backoff * 2, RETRY_MAX_MS);
}

/** Start over now (new code or port, or the options page asked). */
function reconnect() {
  const old = ws;
  ws = null;
  accepted = false;
  stopKeepalive();
  backoff = 1000;
  try { old?.close(1000, 'reconnecting'); } catch {}
  connect();
}

async function activeTab() {
  // The front browser window's tab (not a popup or DevTools window).
  let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' });
  if (!tab) [tab] = (await chrome.tabs.query({ active: true, windowType: 'normal' })).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  if (!tab?.id || !/^https?:/.test(tab.url || '')) {
    const what = !tab ? 'no tab' : /^chrome-extension:/.test(tab.url || '') ? "the Echo extension's own page" : `${(tab.url || 'a browser page').split(/[?#]/)[0].slice(0, 60)}`;
    // Connected, but nothing to read: Echo reads web pages (http and https) only.
    throw Object.assign(new Error(`The extension is connected, but the front tab is ${what}, not a web page. Switch to the web page's tab.`), { code: 'no_page' });
  }
  return tab;
}

const run = async (tabId, func, args = []) => (await chrome.scripting.executeScript({ target: { tabId }, func, args }))[0]?.result;
/** The same function in every frame of the tab that can be reached (cross-origin iframes too). */
async function runAll(tabId, func, args = []) {
  try {
    return (await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func, args })).map((r) => r?.result).filter(Boolean);
  } catch {
    const one = await run(tabId, func, args).catch(() => null);
    return one ? [one] : [];
  }
}

/** Real input through the debugger (trusted events, like a person's). */
async function withDebugger(tabId, fn) {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch {
    return false;
  }
  try {
    await fn((method, params) => chrome.debugger.sendCommand(target, method, params));
    return true;
  } finally {
    chrome.debugger.detach(target).catch(() => {});
  }
}

async function act({ snapshot, ref, verb, text = '', commit = '', files = [] }) {
  const tab = await activeTab();
  const key = `${snapshot}:${ref}`;
  const before = await run(tab.id, readBack, [key]);
  if (!before?.exists) throw Object.assign(new Error(`${ref} is gone from the page (the snapshot is stale). Take a new snapshot.`), { code: 'stale' });
  const box = await run(tab.id, locate, [key]);
  if (box?.secret && ['fill', 'replace'].includes(verb)) throw Object.assign(new Error('That is a password field. Echo never types passwords.'), { code: 'secure' });
  let via = 'debugger';
  let filled = null;
  const ok = await withDebugger(tab.id, async (send) => {
    const mouse = (type, button = 'left') => send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button, clickCount: 1 });
    if (['click', 'focus', 'fill', 'replace'].includes(verb)) {
      await mouse('mouseMoved');
      await mouse('mousePressed');
      await mouse('mouseReleased');
    } else if (verb === 'right_click') {
      await mouse('mousePressed', 'right');
      await mouse('mouseReleased', 'right');
    } else if (verb === 'hover') await mouse('mouseMoved');
    if (verb === 'replace') await run(tab.id, selectAllIn, [key]);
    if ((verb === 'fill' || verb === 'replace') && text) await send('Input.insertText', { text });
    if (verb === 'upload') {
      const { root } = await send('DOM.getDocument', { depth: 0 });
      const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: `[data-echo-ref="${key}"]` });
      await send('DOM.setFileInputFiles', { nodeId, files });
      await run(tab.id, (k) => document.querySelector('[data-echo-ref="' + k + '"]')?.dispatchEvent(new Event('change', { bubbles: true })), [key]);
    }
    // What the field holds after typing, before a commit turns it into a chip (and empties it).
    if (commit && ['fill', 'replace'].includes(verb)) filled = await run(tab.id, readBack, [key]);
    const k = { enter: ['Enter', 13, '\r'], tab: ['Tab', 9, ''], comma: [',', 188, ','] }[commit];
    if (k) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k[0], windowsVirtualKeyCode: k[1], text: k[2] || undefined });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k[0], windowsVirtualKeyCode: k[1] });
    }
  });
  if (!ok) {
    if (verb === 'upload') throw Object.assign(new Error('Attaching a file needs the debugger, and Chrome refused it (is DevTools open?).'), { code: 'no_debugger' });
    via = 'page';
    await run(tab.id, actInPage, [key, verb, text, '']);
    if (commit && ['fill', 'replace'].includes(verb)) filled = await run(tab.id, readBack, [key]);
    if (commit) await run(tab.id, actInPage, [key, 'none', '', commit]);
  }
  await new Promise((r) => setTimeout(r, 250));
  const after = await run(tab.id, readBack, [key]).catch(() => ({ exists: false }));
  return { before, after, via, ...(filled ? { filled } : {}) };
}

async function handle(cmd, args) {
  switch (cmd) {
    case 'snapshot': {
      const tab = await activeTab();
      return { ...(await run(tab.id, snapshotPage)), tabId: tab.id };
    }
    case 'act':
      return act(args);
    case 'tabs':
      return (await chrome.tabs.query({})).filter((t) => /^https?:/.test(t.url || '')).map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active }));
    case 'activate_tab': {
      const t = await chrome.tabs.update(Number(args.tabId), { active: true });
      if (t?.windowId) await chrome.windows.update(t.windowId, { focused: true });
      return { activated: args.tabId };
    }
    case 'focus': {
      // Where the keyboard is in the front tab, through iframes (an editor's frame answers for
      // itself): is it something text goes into? Echo's focus guard asks this when the Mac's
      // Accessibility can't see into the page's editor.
      const tab = await activeTab();
      const found = (await runAll(tab.id, focusInFrame)).filter((f) => f.into !== 'frame');
      const best = found.find((f) => f.editable) || found[0] || null;
      return best ? { ...best, tabId: tab.id } : { editable: false, kind: 'none', tabId: tab.id };
    }
    case 'find_text': {
      // Did the text land in a field or editor anywhere in the front tab (frames too)? Yes or no.
      const tab = await activeTab();
      const found = (await runAll(tab.id, textInFrame, [String(args.text || '').slice(0, 200)])).find((f) => f.found);
      return found || { found: false };
    }
    case 'navigate': {
      if (!/^https?:\/\//.test(String(args.url))) throw new Error('Only web links.');
      const tab = await activeTab();
      await chrome.tabs.update(tab.id, { url: String(args.url) });
      return { navigated: args.url };
    }
    default:
      throw new Error(`Unknown request ${cmd}.`);
  }
}

// A new pairing code or port: start over at once (only those; the status lives in session storage).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ('code' in changes || 'port' in changes)) reconnect();
});
// The options page asks how it's going (and wakes the worker doing so).
chrome.runtime.onMessage.addListener((m, _sender, reply) => {
  if (m?.type === 'echo-status') {
    if (m.reconnect) reconnect();
    else connect();
    reply(status);
  }
});
// Wakes a stopped worker every 30 seconds; connect() does nothing if it's already connected.
chrome.alarms.create('echo-connect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'echo-connect') connect();
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
// A worker that just started has no socket yet: never show a connection left over from before.
setStatus('connecting', 'Connecting to Echo…');
connect();
