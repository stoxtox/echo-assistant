// Which Node.js Echo needs. Echo's newer modules are TypeScript, which Node runs directly from
// 22.18 on (type stripping, no build step), so older Node can't start it. This file stays plain
// JavaScript on purpose: it has to run on an old Node to say why an update can't go in.
// The same floor is checked in scripts/launcher.sh, scripts/install.sh and package.json "engines".

export const MIN_NODE = '22.18.0';

/** "22.18.0" or "v22.18" → [22, 18, 0]. */
export function parseNode(v) {
  const m = String(v || '').trim().replace(/^v/, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : null;
}

/**
 * Does Node `version` meet `range`? Only the forms Echo uses: ">=22.18", ">=22.18.0", "22.18",
 * or nothing (anything goes). An unreadable range is treated as met, so a typo can't lock out
 * every update.
 * @param {string} version @param {string | undefined} range
 */
export function nodeSatisfies(version, range) {
  if (!range) return true;
  const want = parseNode(String(range).replace(/^\s*>=\s*/, ''));
  const have = parseNode(version);
  if (!want) return true;
  if (!have) return false;
  for (let i = 0; i < 3; i++) if (have[i] !== want[i]) return have[i] > want[i];
  return true;
}

/** "22.18" for a range like ">=22.18.0", for messages. */
export const rangeFloor = (range) => String(range || '').replace(/^\s*>=\s*/, '').replace(/\.0$/, '');
