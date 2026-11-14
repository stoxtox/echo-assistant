// Echo used to be called VoiceOps. These are the deliberate compatibility shims for that old name,
// kept in one place so they're easy to find (docs/rename.md lists them all):
//   - VOICEOPS_* environment variables still work as their ECHO_* names (an ECHO_* value wins).
//   - logs/voiceops.log becomes logs/echo.log on start.
//   - worktrees made in the old .voiceops-worktrees folder still count as Echo's own worktrees.
//   - a VoiceOps folder or link next to Echo that points at Echo is still recognized as Echo itself.
// Nothing here depends on the rest of Echo, so it can run before config.js reads the environment.
import fs from 'node:fs';
import path from 'node:path';

export const LEGACY_NAME = 'VoiceOps';
export const LEGACY_ENV_PREFIX = 'VOICEOPS_';
export const LEGACY_WORKTREES = '.voiceops-worktrees';
export const LEGACY_LOG = 'voiceops.log';
export const WORKTREES = '.echo-worktrees';
export const LOG = 'echo.log';

/**
 * Copy every VOICEOPS_X variable to ECHO_X unless ECHO_X is already set. The old names stay set,
 * so an older copy of Echo (a rollback, an old launcher) started from here still sees them.
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]} the ECHO_* names that were filled in
 */
export function adoptLegacyEnv(env = process.env) {
  const filled = [];
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith(LEGACY_ENV_PREFIX) || v === undefined) continue;
    const name = 'ECHO_' + k.slice(LEGACY_ENV_PREFIX.length);
    if (env[name] === undefined) {
      env[name] = v;
      filled.push(name);
    }
  }
  return filled;
}

adoptLegacyEnv();

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};

/**
 * Every path that names Echo's folder: the folder itself, its real path, and an old VoiceOps folder
 * name next to it that is a link to it (left by the rename, so old paths keep working).
 * @param {string} appDir
 */
export function appDirAliases(appDir) {
  const own = real(appDir) || appDir;
  const out = new Set([appDir, own]);
  const legacy = path.join(path.dirname(appDir), LEGACY_NAME);
  if (legacy !== appDir && real(legacy) === own) out.add(legacy);
  return [...out];
}

/**
 * Rename logs/voiceops.log to logs/echo.log (once; an existing echo.log is left alone).
 * Safe while something still writes to the old file: the open file just gets the new name.
 * @param {string} logDir
 */
export function migrateLegacyLog(logDir) {
  const from = path.join(logDir, LEGACY_LOG);
  const to = path.join(logDir, LOG);
  try {
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      fs.renameSync(from, to);
      return true;
    }
  } catch {}
  return false;
}

/**
 * The env for a child that may be an older Echo (the supervisor's server after a rollback to a
 * version from before the rename): every ECHO_X also set as VOICEOPS_X (the ECHO_X value wins).
 * @param {NodeJS.ProcessEnv} env
 */
export function withLegacyEnv(env) {
  const out = { ...env };
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith('ECHO_') || v === undefined) continue;
    out[LEGACY_ENV_PREFIX + k.slice('ECHO_'.length)] = v;
  }
  return out;
}
