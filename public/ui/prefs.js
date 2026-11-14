// The page's own saved choices, in localStorage as echo.<name> (split out of public/app.js).

// Saved as echo.<name>. Before the rename they were voiceops.<name>: moved over once, on load.
try {
  for (const k of Object.keys(localStorage)) {
    if (!k.startsWith('voiceops.')) continue;
    const name = 'echo.' + k.slice('voiceops.'.length);
    if (localStorage.getItem(name) === null) localStorage.setItem(name, localStorage.getItem(k));
    localStorage.removeItem(k);
  }
} catch {}
export const pref = {
  get: (k, d) => { try { const v = localStorage.getItem('echo.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('echo.' + k, JSON.stringify(v)); } catch {} },
};
