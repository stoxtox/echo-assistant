// Projects, research folders and task summaries for the assistant's tools (moved out of
// lib/dispatcher.js unchanged).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { config, APP_DIR } from '../config.js';
import { isInside } from '../text.js';
import { matchProject } from '../projects.js';
import { isSecretPath } from '../safety.js';

/** "12s ago", "5 min ago", "2 h ago". */
export const ago = (iso) => {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

export function taskBrief(t, tasks) {
  return {
    id: t.id,
    kind: t.kind,
    project: t.project,
    title: t.title,
    status: t.status,
    actuallyRunningNow: tasks.isLive(t.id),
    lastActivity: ago(t.lastActivityAt || t.updatedAt),
    pendingApproval: t.pendingApproval && tasks.isApprovalPending(t.id) ? { reason: t.pendingApproval.reason, risky: t.pendingApproval.level === 'risky' } : null,
    summary: t.summary,
    ...(t.kind === 'self' ? { selfReview: selfState(t, tasks) } : {}),
  };
}

/**
 * Where a self-improvement task really is. Its saved state can say "working" after the worker
 * stopped (the user stopped it, or Echo went down), and while the review is being prepared.
 */
export function selfState(t, tasks) {
  const s = t.self?.state;
  if (s !== 'working' || tasks.isLive(t.id) || t.status === 'queued') return s;
  return ['done', 'failed'].includes(t.status) ? 'preparing_review' : 'stopped';
}

/** Resolve a spoken project name, or explain why we need to ask. */
export function pickProject(name) {
  const m = matchProject(name);
  if (m.project) return { project: m.project };
  const guesses = m.candidates.length ? `My best guesses: ${m.candidates.join(', ')}.` : 'Nothing sounds close.';
  return {
    error: `Not sure which project "${name}" means (confidence ${m.confidence}). ${guesses} Don't act yet: ask the user, e.g. "Did you mean ${m.candidates[0] || '...'}?" When they confirm, call again with the exact project name and save what they said with set_project_alias.`,
  };
}

export function openTerminal(cwd, command) {
  const sh = `cd ${JSON.stringify(cwd)}${command ? `; ${command}` : ''}`;
  const script = `tell application "Terminal"\n activate\n do script ${JSON.stringify(sh)}\nend tell`;
  execFile('osascript', ['-e', script]);
}

export function researchFolders() {
  try {
    return fs
      .readdirSync(config.researchDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => {
        const dir = path.join(config.researchDir, d.name);
        const files = fs.readdirSync(dir).filter((f) => !f.startsWith('.'));
        const modified = files.reduce((m, f) => Math.max(m, fs.statSync(path.join(dir, f)).mtimeMs), fs.statSync(dir).mtimeMs);
        return { folder: d.name, files: files.slice(0, 12), lastModified: new Date(modified).toISOString().slice(0, 16) };
      })
      .filter((f) => path.join(config.researchDir, f.folder) !== config.attachmentsDir)
      .sort((a, b) => b.lastModified.localeCompare(a.lastModified));
  } catch {
    return [];
  }
}

export function ensureResearchDir(folder) {
  const dir = path.join(config.researchDir, folder);
  fs.mkdirSync(dir, { recursive: true });
  // Lets you open Claude Code in the research folder yourself with web access already on.
  const settings = path.join(config.researchDir, '.claude', 'settings.json');
  if (!fs.existsSync(settings)) {
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ permissions: { allow: ['WebSearch', 'WebFetch'] } }, null, 2));
  }
  return dir;
}

/** What a new project's worker is told, by kind: real files the user can open, opened when done. */
export const PROJECT_GUIDES = {
  spreadsheet: `Make a real Excel workbook (.xlsx) that opens in Excel or Numbers. Use Node: in a hidden ".build" subfolder run "npm init -y" and "npm install exceljs", and keep your script there. Use real formulas (totals, averages), a bold frozen header row, sensible column widths, and currency, percent and date formats. Read the file back to check it. Save it in the project folder with a plain name like "Monthly Budget.xlsx".`,
  document: `Make a real Word document (.docx) that opens in Word or Pages. Use Node: in a hidden ".build" subfolder run "npm init -y" and "npm install docx", and keep your script there. Use clear headings, a readable font and good spacing. Save it in the project folder with a plain name like "Cover Letter.docx".`,
  website: `Build a simple, good-looking website in this folder. Prefer plain HTML, CSS and JavaScript with no build step unless the request really needs more. Run it on this Mac only: start a small static server that keeps running after you finish, bound to 127.0.0.1 on a free port between 8100 and 8999 (never ${config.port}), for example: nohup python3 -m http.server PORT --bind 127.0.0.1 > .server.log 2>&1 &. Then open it with: open http://localhost:PORT. Write a DEPLOY.md that explains in plain, non-technical steps how it could be put online later (for example Netlify Drop or GitHub Pages): which account is needed, what it costs, and what the user would click. Do not deploy or publish anything; that always needs the user's approval.`,
  other: `Save the results as real files the user can open (a spreadsheet, a document, or a short Markdown summary), with plain names.`,
};

export const PROJECT_RULES = `This is a new project for someone who may not be technical.
- Keep the folder tidy: only files the user cares about at the top level; helper scripts and packages go in a hidden ".build" subfolder.
- Files the user gave you were copied into this folder. Never change them; write new files (for example "Budget - analyzed.xlsx").
- When the main file is ready, open it for the user with the open command (open "Monthly Budget.xlsx").
- In your summary, say what you made and what's in it, in everyday words.`;

/** A folder name that's safe on macOS and readable in Finder: "monthly budget!" -> "Monthly budget". */
export function projectFolderName(name) {
  const clean = String(name || '')
    .replace(/[/\\:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[._\s]+/, '')
    .slice(0, 60)
    .trim();
  return clean ? clean[0].toUpperCase() + clean.slice(1) : 'New project';
}

/** Make a new, unused folder for a project in the projects folder ("Budget", "Budget 2", …). */
export function createProjectFolder(name, root = config.roots[0]) {
  const base = projectFolderName(name);
  fs.mkdirSync(root, { recursive: true });
  for (let n = 1; n < 1000; n++) {
    const folder = n === 1 ? base : `${base} ${n}`;
    const dir = path.join(root, folder);
    if (fs.existsSync(dir)) continue;
    fs.mkdirSync(dir);
    return { name: folder, dir };
  }
  throw new Error('Too many projects with that name.');
}

export const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
/** Copy the user's own files into a new project (the originals are never touched). Returns the copied names. */
export function copySourceFiles(paths, dir, home = os.homedir()) {
  const copied = [];
  for (const p of paths || []) {
    const src = path.resolve(String(p));
    if (!isInside(src, home) || isInside(src, APP_DIR) || isInside(src, config.dataDir) || isSecretPath(src)) throw new Error(`I can't use ${path.basename(src)} from there.`);
    const st = fs.statSync(src, { throwIfNoEntry: false });
    if (!st?.isFile()) throw new Error(`There's no file at ${src}. Use find_file to look it up.`);
    if (st.size > MAX_SOURCE_BYTES) throw new Error(`${path.basename(src)} is too big to copy (over 100 MB).`);
    let dest = path.join(dir, path.basename(src));
    for (let n = 2; fs.existsSync(dest); n++) dest = path.join(dir, `${path.parse(src).name} ${n}${path.extname(src)}`);
    fs.copyFileSync(src, dest);
    copied.push(path.basename(dest));
  }
  return copied;
}

/** Only in a copy that can change itself (the dev copy): the public build leaves it out. */
