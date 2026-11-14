// Is audio playing on the Mac (a video, music, a podcast)? While it is, the bar for "that was for
// me" goes up (lib/addressed.js judgeAddressee, lib/listening.js interruptGate): the TV's "stop"
// or "go back" must not cancel what Echo is doing.
//
// macOS keeps a power assertion for every app that has sound going to an output device
// (`pmset -g assertions`: coreaudiod, "Created for PID", "Resources: audio-out"). Echo's own
// window (the Mac app's WebKit view) is left out, since her voice and the ambient piano play
// there. One check at most every few seconds; anything that fails reads as "not playing".
import { execFile } from 'node:child_process';

/** A check is reused for this long. */
export const MEDIA_CACHE_MS = 4000;

/**
 * The apps with sound going to an output device, from `pmset -g assertions`.
 * @param {string} text
 * @returns {Array<{ pid: number, resources: string }>}
 */
export function parseAudioAssertions(text) {
  const out = [];
  /** @type {{ pid: number, resources: string } | null} */
  let cur = null;
  for (const line of String(text || '').split('\n')) {
    if (/^\s*pid \d+\(/.test(line)) {
      cur = null;
      if (/\(coreaudiod\)/.test(line) && /named: "com\.apple\.audio\./.test(line)) {
        cur = { pid: 0, resources: '' };
        out.push(cur);
      }
      continue;
    }
    if (!cur) continue;
    const pid = line.match(/Created for PID: (\d+)/);
    if (pid) cur.pid = Number(pid[1]);
    const res = line.match(/Resources: (.*)$/);
    if (res) cur.resources = res[1].trim();
  }
  return out.filter((a) => a.pid > 0 && /audio-out/.test(a.resources));
}

/**
 * Echo's own sound: the Mac app and its web view (where her voice plays), and Echo's server.
 * Safari's tabs share the same WebKit helper, so a video in Safari isn't seen here.
 * @param {string} command the process's path
 */
export function isEchoOwnAudio(command) {
  const c = String(command || '');
  return /\/Echo\.app\//.test(c) || /com\.apple\.WebKit\.(GPU|WebContent)/.test(c) || /\/(node|coreaudiod)$/.test(c);
}

/** @param {string} file @param {string[]} args */
function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 1500, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

/**
 * A cached "is something else playing sound on this Mac?".
 * @param {{ platform?: string, now?: () => number, exec?: (file: string, args: string[]) => Promise<string> }} [o]
 */
export function mediaWatcher(o = {}) {
  const platform = o.platform ?? process.platform;
  const now = o.now || Date.now;
  const exec = o.exec || run;
  let last = { at: -Infinity, playing: false };
  /** @type {Promise<boolean> | null} */
  let inFlight = null;
  async function check() {
    const found = parseAudioAssertions(await exec('/usr/bin/pmset', ['-g', 'assertions']));
    if (!found.length) return false;
    const ps = await exec('/bin/ps', ['-o', 'pid=,comm=', '-p', found.map((a) => a.pid).join(',')]);
    return ps.split('\n').map((l) => l.trim().match(/^(\d+)\s+(.+)$/)).some((m) => m && !isEchoOwnAudio(m[2]));
  }
  return {
    /** @returns {Promise<boolean>} */
    async playing() {
      if (platform !== 'darwin') return false;
      if (now() - last.at < MEDIA_CACHE_MS) return last.playing;
      if (!inFlight) {
        inFlight = check().catch(() => false).then((p) => {
          last = { at: now(), playing: p };
          inFlight = null;
          return p;
        });
      }
      return inFlight;
    },
  };
}
