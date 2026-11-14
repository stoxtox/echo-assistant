// How the Mac app is signed. macOS remembers Screen Recording, Accessibility and Input Monitoring
// per app *signature*: an ad-hoc signed app gets a new one on every build, so each rebuild or update
// loses them. scripts/build-app.sh signs with a stable identity instead (a Developer ID or Apple
// Development certificate if there is one, else a local "Echo Local Signing" certificate made once),
// and the Settings drawer shows which one this app has (GET /api/permissions/app).
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';

/** The name of the local code-signing certificate scripts/build-app.sh makes when there's no Apple one. */
export const LOCAL_IDENTITY = 'Echo Local Signing';
/** The app's bundle id; it never changes, so macOS knows every build is the same app. */
export const BUNDLE_ID = 'local.echo.app';

/**
 * What `codesign -dv --verbose=2` said about an app, in plain terms.
 * @param {string} out codesign's output (it writes to stderr)
 */
export function describeSigning(out) {
  const text = String(out || '');
  const field = (k) => text.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim() || '';
  const authority = field('Authority');
  const identifier = field('Identifier');
  const adhoc = /Signature=adhoc/.test(text) || (!authority && /flags=.*adhoc/.test(text));
  const signed = Boolean(identifier) && !/not signed/i.test(text);
  const stable = signed && !adhoc && Boolean(authority);
  const message = !signed
    ? 'Echo.app isn\'t signed, so macOS may ask for these permissions again after every rebuild. Rebuild it with "npm run build-app".'
    : stable
      ? `Echo.app is signed with “${authority}”, so macOS keeps these permissions across rebuilds and updates.`
      : 'Echo.app is signed ad hoc, so macOS forgets these permissions each time it\'s rebuilt. Rebuild it once with "npm run build-app": it then signs with a stable identity and they stay.';
  return { signed, adhoc, stable, authority, identifier, message };
}

/**
 * How the installed Echo.app is signed, or { found: false }.
 * @param {string} [app]
 * @returns {Promise<any>}
 */
export function appSigning(app = path.join(os.homedir(), 'Applications', 'Echo.app')) {
  if (process.platform !== 'darwin' || !fs.existsSync(app)) return Promise.resolve({ found: false });
  return new Promise((resolve) => {
    execFile('/usr/bin/codesign', ['-dv', '--verbose=2', app], { timeout: 5000 }, (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr || ''}`;
      if (err && !/Identifier=/.test(out)) return resolve({ found: true, ...describeSigning('code object is not signed at all') });
      resolve({ found: true, ...describeSigning(out) });
    });
  });
}
