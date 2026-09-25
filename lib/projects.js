import fs from 'node:fs';
import path from 'node:path';
import { config, APP_DIR } from './config.js';

const SKIP = new Set(['node_modules', '.git', path.basename(APP_DIR)]);
const storeFile = () => path.join(config.dataDir, 'projects.json');

// Aliases are learned per install, when the user confirms what they meant.
const DEFAULT_STORE = {
  aliases: {},
  hidden: ['untitled folder'],
  descriptions: {},
};

/* ---------- Persistent aliases / hidden / descriptions ---------- */

export function loadStore() {
  try {
    const saved = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    return { aliases: {}, hidden: [], descriptions: {}, ...saved };
  } catch {
    return structuredClone(DEFAULT_STORE);
  }
}

function saveStore(store) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(storeFile(), JSON.stringify(store, null, 2));
}

export function addAlias(alias, projectName) {
  const project = listProjects({ includeHidden: true }).find((p) => p.name === projectName);
  if (!project) throw new Error(`No project named "${projectName}"`);
  const store = loadStore();
  store.aliases[alias.trim().toLowerCase()] = project.name;
  saveStore(store);
  return project;
}

export function setHidden(projectName, hidden) {
  const project = listProjects({ includeHidden: true }).find((p) => p.name === projectName);
  if (!project) throw new Error(`No project named "${projectName}"`);
  const store = loadStore();
  store.hidden = store.hidden.filter((n) => n !== project.name);
  if (hidden) store.hidden.push(project.name);
  saveStore(store);
  return project;
}

export function setDescription(projectName, description) {
  const project = listProjects({ includeHidden: true }).find((p) => p.name === projectName);
  if (!project) throw new Error(`No project named "${projectName}"`);
  const store = loadStore();
  store.descriptions[project.name] = description.trim().slice(0, 200);
  saveStore(store);
  return project;
}

/* ---------- Discovery ---------- */

function detectKind(dir, entries) {
  const kinds = [];
  if (entries.includes('package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.next) kinds.push('Next.js');
      else if (deps.vite) kinds.push('Vite');
      else if (deps.expo || deps['react-native']) kinds.push('React Native');
      else kinds.push('Node');
    } catch {
      kinds.push('Node');
    }
  }
  if (entries.some((e) => e.endsWith('.xcodeproj') || e.endsWith('.xcworkspace'))) kinds.push('iOS/Xcode');
  if (entries.includes('pubspec.yaml')) kinds.push('Flutter');
  if (entries.some((e) => e.endsWith('.py'))) kinds.push('Python');
  if (entries.some((e) => e.endsWith('.html')) && !kinds.length) kinds.push('Static web');
  return kinds.length ? kinds.join(' + ') : 'Folder';
}

function newestMtime(dir, entries) {
  let newest = fs.statSync(dir).mtimeMs;
  for (const e of entries) {
    if (SKIP.has(e)) continue;
    try {
      newest = Math.max(newest, fs.statSync(path.join(dir, e)).mtimeMs);
    } catch {}
  }
  return newest;
}

const autoDescCache = new Map();
/** One-line description from package.json or the README's first paragraph. */
function autoDescription(dir, entries) {
  if (autoDescCache.has(dir)) return autoDescCache.get(dir);
  let desc = '';
  try {
    if (entries.includes('package.json')) desc = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).description || '';
  } catch {}
  const readme = entries.find((e) => /^readme(\.md|\.txt)?$/i.test(e)) || entries.find((e) => /^how to use/i.test(e));
  if (!desc && readme) {
    try {
      const head = fs.readFileSync(path.join(dir, readme), 'utf8').slice(0, 4000);
      const para = head
        .split(/\n\s*\n/)
        .map((p) => p.replace(/[#>*_`]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim())
        .find((p) => p.length > 25 && !/^(!|<|\||```|npm |yarn |this project was bootstrapped)/i.test(p));
      desc = para || '';
    } catch {}
  }
  if (!desc && entries.includes('index.html')) {
    try {
      desc = (fs.readFileSync(path.join(dir, 'index.html'), 'utf8').match(/<title>([^<]{3,120})<\/title>/i) || [])[1] || '';
    } catch {}
  }
  desc = desc.trim().slice(0, 160);
  autoDescCache.set(dir, desc);
  return desc;
}

export function listProjects({ includeHidden = false } = {}) {
  const store = loadStore();
  const hidden = new Set(store.hidden);
  const aliasesFor = {};
  for (const [alias, name] of Object.entries(store.aliases)) (aliasesFor[name] ||= []).push(alias);
  const out = [];
  for (const root of config.roots) {
    let names = [];
    try {
      names = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of names) {
      // "_research" and dot-folders are Echo' own workspaces, not projects.
      if (!d.isDirectory() || /^[._]/.test(d.name) || SKIP.has(d.name)) continue;
      if (!includeHidden && hidden.has(d.name)) continue;
      const dir = path.join(root, d.name);
      let entries = [];
      try {
        entries = fs.readdirSync(dir);
      } catch {
        continue;
      }
      out.push({
        name: d.name,
        path: dir,
        kind: detectKind(dir, entries),
        description: store.descriptions[d.name] || autoDescription(dir, entries),
        aliases: aliasesFor[d.name] || [],
        hidden: hidden.has(d.name),
        git: entries.includes('.git'),
        hasClaudeMd: entries.includes('CLAUDE.md') || entries.includes('AGENTS.md'),
        lastModified: new Date(newestMtime(dir, entries)).toISOString().slice(0, 10),
      });
    }
  }
  return out.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
}

/* ---------- Matching spoken names ---------- */

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
// "Garden Project" -> "garden", "Budget2" -> "budget", "the fit track app" -> "fittrack"
const base = (s) =>
  norm(String(s).toLowerCase().replace(/\b(the|my|project|app|website|site|folder|repo)\b/g, '')).replace(/\d+$/, '') || norm(s);

/**
 * A coarse sound-alike key: consonants grouped by how speech recognition confuses them.
 * "football" and "Foodbowl" both become "FTPL"; "fit track" and "FitTrack" both "FTLK".
 */
export function phoneticKey(s) {
  let w = String(s).toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return '';
  w = w
    .replace(/ph/g, 'f')
    .replace(/ck/g, 'k')
    .replace(/sh|ch/g, 'x')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/g(?=[eiy])/g, 'j')
    .replace(/q/g, 'k')
    .replace(/x/g, 'ks');
  const map = { b: 'P', p: 'P', d: 'T', t: 'T', g: 'K', k: 'K', c: 'K', s: 'S', z: 'S', f: 'F', v: 'F', l: 'L', r: 'L', m: 'N', n: 'N', j: 'J' };
  let key = /[aeiou]/.test(w[0]) ? 'A' : '';
  for (const ch of w) {
    const code = map[ch];
    if (code && key[key.length - 1] !== code) key += code;
  }
  return key;
}

export function jaroWinkler(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array(a.length).fill(false);
  const bm = new Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (!bm[j] && a[i] === b[j]) {
        am[i] = bm[j] = true;
        matches++;
        break;
      }
    }
  }
  if (!matches) return 0;
  let t = 0;
  for (let i = 0, k = 0; i < a.length; i++) {
    if (!am[i]) continue;
    while (!bm[k]) k++;
    if (a[i] !== b[k++]) t++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

function score(query, project) {
  const q = norm(query);
  const qb = base(query);
  const n = norm(project.name);
  const nb = base(project.name);
  if (!q) return 0;
  if (q === n) return 1;
  if (project.aliases.some((a) => norm(a) === q || base(a) === qb)) return 0.99;
  if (qb === nb) return 0.97;
  if (nb.length >= 3 && qb.length >= 3 && (nb.startsWith(qb) || qb.startsWith(nb))) return 0.9;
  if (nb.length >= 4 && (q.includes(nb) || n.includes(qb))) return 0.85;
  const pq = phoneticKey(qb);
  const pn = phoneticKey(nb);
  const phon = pq.length >= 2 && pq === pn ? 0.82 : jaroWinkler(pq, pn) * 0.7;
  const spell = jaroWinkler(qb, nb) * 0.85;
  return Math.max(phon, spell);
}

/**
 * Match a spoken name. Returns { project, confidence, candidates }.
 * `project` is only set when confident enough to act without asking.
 */
export function matchProject(query, { includeHidden = true } = {}) {
  const projects = listProjects({ includeHidden });
  const ranked = projects
    .map((p) => ({ p, s: score(query, p) }))
    .sort((a, b) => b.s - a.s);
  const [best, second] = ranked;
  if (!best) return { project: null, confidence: 0, candidates: [] };
  const clearWinner = !second || best.s - second.s > 0.08;
  const confident = best.s >= 0.97 || (best.s >= 0.85 && clearWinner);
  return {
    project: confident ? best.p : null,
    confidence: Number(best.s.toFixed(2)),
    candidates: ranked.filter((r) => r.s >= 0.55).slice(0, 3).map((r) => r.p.name),
  };
}

/** Back-compat helper: only returns a project when the match is confident. */
export function resolveProject(name) {
  return matchProject(name).project;
}
