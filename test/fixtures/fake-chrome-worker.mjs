// The real Echo for Chrome service worker (extension/background.js), run in a worker thread with
// a stand-in for Chrome's extension APIs, so a test can watch it connect to a real Echo server,
// lose it when Echo restarts and come back by itself with the same pairing code.
//
// workerData: { port, code }. Every status the extension shows is posted to the parent
// ({ status }); the parent can change the stored code ({ setCode }). The front tab is a page
// whose focus is in an iframe editor (what `focus` and `find_text` answer).
import { parentPort, workerData } from 'node:worker_threads';
import WS from 'ws';

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const local = { port: workerData.port, code: workerData.code };
const storageListeners = [];
const typed = [];

globalThis.WebSocket = class extends WS {
  constructor(url) {
    super(url, { origin: ORIGIN });
  }
};
if (!globalThis.navigator) globalThis.navigator = { userAgent: 'Chrome/140.0.0.0' };

const page = {
  focusInFrame: () => ({ editable: true, secret: false, kind: 'design_mode', name: '', inFrame: true }),
  textInFrame: ([text]) => ({ found: typed.some((t) => t.includes(String(text).toLowerCase())) }),
};

globalThis.chrome = {
  storage: {
    local: {
      get: async (defaults) => ({ ...defaults, ...local }),
      set: async (v) => {
        const changes = {};
        for (const [k, nv] of Object.entries(v)) changes[k] = { oldValue: local[k], newValue: nv };
        Object.assign(local, v);
        for (const f of storageListeners) f(changes, 'local');
      },
    },
    session: { set: async (v) => v.echoStatus && parentPort.postMessage({ status: v.echoStatus }), get: async () => ({}) },
    onChanged: { addListener: (f) => storageListeners.push(f) },
  },
  action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
  runtime: { getManifest: () => ({ version: '1.2.0' }), onMessage: { addListener() {} }, onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
  alarms: { create() {}, onAlarm: { addListener() {} } },
  tabs: { query: async () => [{ id: 7, url: 'http://127.0.0.1/listing', active: true, lastAccessed: 1 }] },
  scripting: {
    executeScript: async ({ target, func, args = [] }) => {
      const answer = page[func.name];
      if (!answer) throw new Error(`no page function ${func.name}`);
      // allFrames: the top page has no focus of its own; the editor's frame answers.
      return target.allFrames ? [{ frameId: 0, result: null }, { frameId: 3, result: answer(args) }] : [{ frameId: 0, result: answer(args) }];
    },
  },
  debugger: { attach: async () => { throw new Error('no debugger here'); } },
};

parentPort.on('message', (m) => {
  if (m.setCode !== undefined) chrome.storage.local.set({ code: m.setCode });
  if (m.typed) typed.push(String(m.typed).toLowerCase());
});

await import('../../extension/background.js');
