// The extension's options: the pairing code from Echo's Settings and Echo's port, and whether
// Echo actually accepted the connection (background.js keeps that in session storage; "connected"
// only after Echo's welcome).
const $ = (id) => document.getElementById(id);
chrome.storage.local.get({ port: 4777, code: '' }).then((s) => {
  $('port').value = s.port;
  $('code').value = s.code;
});
const LABELS = {
  connected: 'Connected: Echo can read the front web tab.',
  connecting: 'Connecting to Echo…',
  refused: 'Echo refused the pairing code.',
  offline: "Echo isn't reachable.",
  unpaired: 'Not paired yet.',
  starting: 'Starting…',
};
function show(st) {
  if (!st) return;
  const on = st.state === 'connected';
  $('state').textContent = on ? LABELS.connected : st.detail || LABELS[st.state] || '';
  $('state').className = on ? 'on' : st.state === 'refused' ? 'bad' : '';
  // This page is the extension's own, not a web page: Echo reads the web tab you switch to.
  $('note').hidden = !on;
}
chrome.storage.session.get('echoStatus').then((s) => show(s.echoStatus)).catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.echoStatus) show(changes.echoStatus.newValue);
});
// Wakes the worker (it connects if it isn't) and gets its latest state.
chrome.runtime.sendMessage({ type: 'echo-status' }).then(show).catch(() => {});
$('save').onclick = async () => {
  const code = $('code').value.trim();
  const port = Number($('port').value) || 4777;
  const before = await chrome.storage.local.get({ port: 4777, code: '' });
  show({ state: 'connecting' });
  await chrome.storage.local.set({ code, port });
  // Same code and port: storage doesn't change, so ask for a fresh try directly.
  if (before.code === code && Number(before.port) === port) chrome.runtime.sendMessage({ type: 'echo-status', reconnect: true }).then(show).catch(() => {});
};
