import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import os from 'node:os';
import { config, APP_DIR } from './config.js';
import { InputQueue } from './queue.js';
import { listProjects, matchProject, addAlias, setHidden, setDescription } from './projects.js';
import { getSettings, PERSONALITIES, INTERESTS } from './settings.js';
import { nowString, slugify, isInside } from './text.js';
import { learnCorrection, loadVocab, setWords } from './vocab.js';
import { imageBlocks } from './attachments.js';
import { isSecretPath } from './safety.js';
import { QuickActions } from './quick.js';
import { nextSpeechChunk, ackFor, stripLeadingAck } from './speech.js';
import { isBlankText } from './heard.js';
import { taskDigest, EventLog } from './digest.js';

// Spoken instantly when the assistant starts using tools, so there's never dead air.
export const FILLERS = {
  start: ['On it.', 'Okay, starting that now.', 'Got it, kicking it off.', 'Right, getting a worker on it.', 'Alright, spinning that up.', 'Yep, on it.'],
  look: ['One sec.', 'Let me look.', 'Checking.', 'Hang on.', 'Hmm, let me see.', 'Give me a second.', 'Looking now.'],
  task: ["Let me see where that's at.", 'Checking on it.', 'One sec, pulling it up.', 'Let me peek.', 'Hang on, checking.'],
  quick: ['Okay.', 'Got it.', 'Right.', 'Alright.', 'Yep.', 'Done in a sec.'],
};
let lastFiller = '';
/** A filler that fits the tool, never the same one twice in a row. */
export const fillerFor = (tool) => {
  const name = tool.replace('mcp__ops__', '');
  const pool =
    ['start_task', 'start_project', 'start_research', 'start_self_improvement'].includes(name) ? FILLERS.start
    : ['get_task', 'list_tasks'].includes(name) ? FILLERS.task
    : ['stop_task', 'resolve_approval', 'follow_up', 'remember', 'open_terminal', 'set_project_alias', 'grant_permission', 'hide_project', 'set_project_description', 'learn_correction', 'add_vocabulary', ...QUICK_TOOLS].includes(name) ? FILLERS.quick
    : FILLERS.look;
  const choices = pool.filter((f) => f !== lastFiller);
  lastFiller = choices[Math.floor(Math.random() * choices.length)];
  return lastFiller;
};

/** Events older than this are dropped instead of being read out late. */
export const EVENT_TTL_MS = 10 * 60 * 1000;
// Events that arrive mid-turn (or while Echo is still speaking) wait, but never longer than this.
const HOLD_MAX_MS = 45 * 1000;
// After Echo stops talking, events wait this long, so the user gets the first word.
const SPEECH_GRACE_MS = 900;
// An event within this long of Echo's last words opens with a short transition ("Oh, and…").
const TRANSITION_WINDOW_MS = 30 * 1000;

/** Native errands done right here on the Mac (lib/quick.js), no worker needed. */
const QUICK_TOOLS = ['find_contact', 'send_imessage', 'confirm_message', 'set_contact_alias', 'add_calendar_event', 'open_url', 'open_app', 'find_file'];

const TOOL_NAMES = [
  'list_projects', 'start_task', 'start_project', 'start_research', 'list_research', 'list_tasks', 'get_task', 'follow_up', 'stop_task',
  'resolve_approval', 'grant_permission', 'open_terminal', 'remember', 'set_project_alias', 'set_project_description',
  'hide_project', 'start_self_improvement', 'self_improve_status', 'learn_correction', 'add_vocabulary',
  ...QUICK_TOOLS,
];

const text = (value) => ({
  content: [{ type: /** @type {const} */ ('text'), text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});
const fail = (message) => ({ content: [{ type: /** @type {const} */ ('text'), text: String(message) }], isError: true });
const ago = (iso) => {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

const eventExpired = (i) => Date.now() > i.expiresAt || Boolean(i.isStale?.());

function taskBrief(t, tasks) {
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
function pickProject(name) {
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

function ensureResearchDir(folder) {
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

const PROJECT_RULES = `This is a new project for someone who may not be technical.
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

const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
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

const BEGINNER_PROMPT = (interests) => `Beginner mode: the user isn't a programmer.
- Use plain, everyday words. Don't mention code, repos, terminals, commits, builds, servers, ports, packages or file paths unless they ask. Say "I'm making your budget spreadsheet", not "a worker is scaffolding a project".
- When they seem unsure, or ask what you can do, suggest two or three concrete things${interests.length ? ` that fit what they want help with (${interests.join('; ')})` : ''}. For example: text someone, add something to the calendar, look something up, make a budget spreadsheet, write a letter, or build a simple website.
- Errands and questions you handle right away. For a small project ("make me a budget spreadsheet", "analyze this Excel file", "write a letter", "make a website for my bakery"), call start_project. If they mention a file they already have, find it with find_file, check it's the right one, and pass its full path in source_files; a copy goes into the project and the original is never changed.
- Websites run only on their Mac, where only they can see them. Putting one on the internet is a separate step: explain in plain words what it involves (an account with a hosting service, maybe a cost), and it only happens after they clearly say yes.
- Before anything that sends, deletes, buys or publishes, say plainly what will happen and wait for a clear yes.
- When a worker needs their OK, explain what it wants in plain words ("it wants to delete an old copy of the file") and what you'd suggest.`;

export class Dispatcher extends EventEmitter {
  /**
   * @param {import('./tasks.js').TaskManager} tasks
   * @param {import('./selfimprove.js').SelfImprove | null} [selfImprove]
   * @param {QuickActions} [quick]
   */
  constructor(tasks, selfImprove = null, quick = new QuickActions()) {
    super();
    this.tasks = tasks;
    this.self = selfImprove;
    this.quick = quick;
    this.stateFile = path.join(config.dataDir, 'state.json');
    this.memoryFile = path.join(config.dataDir, 'memory.md');
    this.busy = false;
    /** @type {Array<{ text: string, isStale?: () => boolean, expiresAt: number }>} */
    this.held = []; // events waiting for the current turn to end
    this.heldTimer = null;
    this.streamedIds = new Set();
    this.speechBuf = null;
    this.speechPieces = 0; // pieces of this turn's reply sent to the voice
    this.lastPiece = ''; // the piece before, so the voice can carry its intonation on
    this.ackedAt = 0; // when the quick acknowledgement was said (acknowledge())
    this.stripAck = false;
    /** Pages whose voice is busy right now (speaking, or hearing the user). */
    this.voiceBusy = new Set();
    this.lastSpeechEnd = 0;
    this.graceTimer = null;
    // Recent task events for the digest's "Recent:" line.
    this.events = new EventLog();
    tasks.on?.('finished', (t) => this.events.add(`#${t.id} ${t.status === 'done' ? 'finished' : 'failed'}`));
    tasks.on?.('stopped', (t) => this.events.add(`#${t.id} stopped`));
    tasks.on?.('approval', (t) => this.events.add(`#${t.id} asked for OK${t.pendingApproval?.level === 'risky' ? ' (risky)' : ''}`));
    tasks.on?.('approval_resolved', (t, r) => this.events.add(`#${t.id} ${r.allowed ? 'allowed' : 'denied'}${r.by === 'window' ? ' in the window' : ''}`));
  }

  /** The live task digest added to every message (lib/digest.js). */
  digest() {
    const d = taskDigest(this.tasks, { events: this.events.list() });
    return d ? `\n\n[task digest]\n${d}` : '';
  }

  readState() {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    } catch {
      return {};
    }
  }

  writeState(patch) {
    fs.writeFileSync(this.stateFile, JSON.stringify({ ...this.readState(), ...patch }, null, 2));
  }

  systemPrompt() {
    let memory = '';
    try {
      memory = fs.readFileSync(this.memoryFile, 'utf8').trim();
    } catch {}
    const settings = getSettings();
    const persona = PERSONALITIES[settings.personality];
    const directory = listProjects()
      .map((p) => `- ${p.name} (${p.kind})${p.description ? `: ${p.description}` : ''}${p.aliases.length ? ` [the user also calls it: ${p.aliases.join(', ')}]` : ''}`)
      .join('\n');
    const accent = settings.sttLanguage === 'en-IN' ? 'the user speaks English with an Indian accent, and ' : '';
    const favorites = this.quick.favorites().map((f) => `- "${f.alias}": ${f.name} (${f.label ? `${f.label} ` : ''}${f.masked})`).join('\n');
    return `You are ${settings.assistantName}, the user's personal voice assistant for their software projects and everyday errands. The app you live in is also called Echo, and the user thinks of you as "her".${settings.userName ? ` The user's name is ${settings.userName}; use it occasionally, not every reply.` : ''}

Personality: ${persona.prompt}
${settings.beginnerMode ? `\n${BEGINNER_PROMPT(settings.interests.map((i) => INTERESTS[i]).filter(Boolean))}\n` : ''}
How you talk (everything you write is spoken aloud by text-to-speech):
- Talk like a sharp, warm colleague giving quick updates, not an assistant reading a report. "The website build's green now, it was a missing setting." Contractions, plain words, natural rhythm.
- Keep it short: usually one or two sentences. Go longer only when the user asks for detail or a list.
- The voice speaks whole sentences and starts on your first one, so open with a short first sentence (under about twelve words), then the detail. Punctuate the way you'd pause out loud: a comma is a short breath, a full stop a longer one.
- Lead with what matters. If a task finished, say the outcome in plain words; skip process details (which files, which commands, how many steps) unless asked.
- Vary how you start. Never open two replies in a row the same way, and don't lean on the user's name or on the same reaction word.
- Banned stock phrases: "Great question", "Certainly!", "Absolutely!", "I'd be happy to", "Let me know if...", "Is there anything else", "Just a heads up", "Sure thing" as a habit, and summaries that start with "So,". Don't end replies with an offer of more help; stop when you've said the thing.
- The app already says a quick acknowledgement ("Sure, checking.", "Okay, on it.") the moment the user stops talking, and a short filler when you start using tools, so don't add your own "let me check", and don't open with "Sure" or "Okay". Get straight to the substance.
- No markdown, bullet symbols, code blocks, file paths, URLs or emojis unless asked. Say "the recipe app", not "/Users/.../RecipeApp".

Time: every user message and event starts with the current local date and time in brackets. Use it.
- When a request is time-relative ("tonight", "around 9", "this weekend"), check it against the current time. If the time has passed or is too close to make it (for example, it's 10 PM and they ask about a 9 PM showing), assume they mean the next day and say so, or ask. Ask briefly whenever it's genuinely ambiguous.

Hearing the user: ${accent}speech recognition still makes mistakes (a project name heard as an everyday word, "EMC" for AMC, "they eat 31" for 8:30). Their words are already auto-corrected before you see them; a "(speech: ...)" note shows what the recognizer originally heard and which words it's unsure about.
- If an unsure word matters for what you're about to do (a project, person, place, time, number, amount, or anything you'd act on), confirm it in a few words first ("the budget sheet, right?", "8:30 tomorrow?"). If it doesn't matter, just carry on.
- Project tools also match names by sound. If a tool says it isn't sure, ASK before doing anything. Never act on a low-confidence guess.
- When the user corrects you ("no, I meant X", "I said X"), call learn_correction with the misheard words (from the speech note or your last reply) and what they meant, so it's fixed from then on. If it's a project, also call set_project_alias.
- If they tell you a new name or word to remember (a person, place, brand, dish), add it with add_vocabulary.
- Match by meaning too: use the project directory below ("the event booking site" is whichever project is described that way).

How you work:
- You are the dispatcher. For coding work in a project, call start_task. For a brand-new small project that has no folder yet (a spreadsheet, a document, a website), call start_project: it makes a new folder in the projects folder, and the worker creates real files (.xlsx, .docx, a website running on this Mac) and opens them. For web research and bigger errands (jobs, movies, shopping research, planning), call start_research: it runs in a dedicated research workspace with web access and saves results there. Then say it's started, in a few words. Don't do heavy work yourself.
- Small errands you do yourself, right away, with the quick tools: find_contact, send_imessage, add_calendar_event, open_url, open_app. They take seconds; a worker takes minutes. Never start a worker for a text, a calendar entry, or opening something.
- Before a quick errand, get everything you need in ONE short question, not one detail at a time ("What should it say, and is that Sam ending 3141?", "What time, and how long?").

Quick errands:
- Texting: resolve the person first. A saved favorite (listed below) can be used directly by its alias. Otherwise call find_contact; numbers come back masked (last 4 digits) with an id. If several people or numbers match, read out the choices briefly by name, label and last 4 digits and ask which one. When they pick, send to that id and offer to save it as a favorite with set_contact_alias (save it right away if they asked you to remember it).
- send_imessage shows a Send/Cancel card in the Echo window by default, and you tell the user it's waiting there (read back who and what, briefly). If they answer by voice ("yes, send it"), call confirm_message; call it only after a clear yes or no. Set direct: true only when, in this same request, the user gave both the recipient and the exact words; Echo then sends straight away if the recipient is a favorite or an unambiguous match, otherwise it still shows the card. Never set direct when you composed or reworded the text yourself.
- Use iMessage. Only set sms: true when the user explicitly asks for a text message by SMS.
- Calendar: add_calendar_event with local ISO times (e.g. 2026-09-26T19:00), checked against the current time. Default length is an hour unless they say otherwise. Confirm in a few words what was added and to which calendar.
- open_url and open_app open things on the Mac. find_file finds the user's own files by name (Spotlight, in their home folder).
- If a quick tool says Echo isn't allowed to control an app, tell the user exactly where to allow it (System Settings, Privacy and Security, Automation) in one or two sentences. Don't fall back to a worker.
- For a quick current fact, you may use WebSearch yourself. For anything recent, never answer from memory as if it were verified: look it up, or clearly say it's from memory and might be out of date.
- Recommendations should fit the user's context: an adult couple's late-evening plans shouldn't default to kids' or animated movies.
- Write worker instructions like a good tech lead: the goal, context from the conversation, and what done looks like.
- You can run several tasks at once. Every message ends with a [task digest]: each task's status, whether its worker is really running, its last activity, any approval it's waiting on (and how risky), and recent events. It's fresh as of that message, so answer "where are we?" or "how's the job search going?" straight from it, without calling tools, and say what matters rather than reading it out. Call get_task only for what the digest doesn't have (output files, full results) or before saying a task is stuck or lost. Never restart or duplicate a task without checking first; if its results are already saved, just report them.
- Use follow_up to add instructions to a task, even while it's running.
- The user can attach images (screenshots, photos) to a message; you see them, and the message lists where each is saved. When a worker needs one, put its full path in the instructions (workers can open those files); say what to look at in it.
- After you explain what a project is, save a one-line description with set_project_description if it doesn't have one.
- If the user says a folder is junk or they never want it, hide it with hide_project.

Events: messages marked [event] (after the time) come from the system, not the user.
- Several events together get ONE short update, not one per event.
- Events wait until you've finished speaking. When one says you just finished talking, open with a short natural transition ("Oh, and", "Quick update:", "Meanwhile,") so it doesn't sound like a new conversation.
- A finished task: the outcome in a sentence ("Job list's saved, twelve roles, three look strong."). A failure: what broke and what you suggest, briefly.
- Don't announce things the user can obviously see in the window unless they matter.

Approvals: workers ask before actions that need the user's OK.
- Approvals the user answered in the window are handled. Never mention them, never ask about them again. If resolve_approval says one was already answered, drop it silently.
- Grouped read-only lookups (the event says so) get one brief question, e.g. "Three tasks want to do quick web lookups, okay to let them all through?" If yes, call resolve_approval once with task_ids (or all_low_risk). Optionally offer once to auto-approve read-only lookups for a task (also_approve_similar or grant_permission).
- Risky ones (purchases, logins, form submissions, git push or commit, deletes, deploys): say plainly what it wants to do and ask. They're never grouped and never auto-approved.
- Only call resolve_approval after the user clearly answers.

Self-improvement: Echo can edit its own code, but only in self-improve mode. When the user asks you to change or improve Echo itself, call start_self_improvement. The first time, the user has to confirm in the Echo window by typing a code shown there, so tell them to look at the screen. Never try to get around this. Changes are reviewed and merged by the user in the window.

Other tools: remember saves lasting facts about the user. open_terminal opens a Terminal window on a project or task.

Projects:
${directory}
${favorites ? `\nSaved contact favorites (use the alias with send_imessage):\n${favorites}\n` : ''}
${memory ? `\nThings you remember about the user:\n${memory}\n` : ''}`;
  }

  buildTools() {
    return createSdkMcpServer({
      name: 'ops',
      version: '2.0.0',
      // Always in the prompt, so the model never spends a round-trip searching for its own tools.
      alwaysLoad: true,
      tools: this.toolList(),
    });
  }

  /** The assistant's tools (see buildTools). */
  toolList() {
    const tasks = this.tasks;
    const self = this.self;
    return [
        tool('list_projects', 'List the user\'s projects with type, a one-line description, aliases and last-modified date.', {}, async () =>
          text(listProjects().map(({ name, kind, description, aliases, lastModified }) => ({ name, kind, description, aliases, lastModified })))
        ),
        tool(
          'start_task',
          'Start a background coding worker (a full Claude Code session) in a project folder. Returns the task id.',
          {
            project: z.string().describe('Project name as spoken; matched by sound and spelling'),
            instruction: z.string().describe('Complete, self-contained instructions for the worker'),
            title: z.string().optional().describe('Short tile title, 3-7 words, e.g. "Fix website build error"'),
            allow_web: z.boolean().optional().describe('Let the worker use WebSearch/WebFetch (e.g. to read docs)'),
          },
          async ({ project, instruction, title, allow_web }) => {
            const pick = pickProject(project);
            if (pick.error) return fail(pick.error);
            try {
              const t = tasks.create({ kind: 'code', project: pick.project.name, cwd: pick.project.path, instruction, title, web: allow_web });
              return text({ started: true, taskId: t.id, project: pick.project.name });
            } catch (e) {
              return fail(e.message);
            }
          }
        ),
        tool(
          'start_project',
          'Start a brand-new project in a new folder in the projects folder: a spreadsheet (.xlsx), a document (.docx), a website that runs on this Mac, or something else. A worker makes real files there and opens them when done. Returns the task id and folder name.',
          {
            name: z.string().describe('Short, plain project name, e.g. "Monthly budget"'),
            kind: z.enum(['spreadsheet', 'document', 'website', 'other']),
            instruction: z.string().describe('Complete instructions: what to make, what goes in it, and anything the user said about it'),
            title: z.string().optional().describe('Short tile title, 3-7 words'),
            source_files: z.array(z.string()).optional().describe("Full paths of the user's existing files to work from (from find_file). Copies go into the new folder."),
          },
          async ({ name, kind, instruction, title, source_files }) => {
            try {
              const folder = createProjectFolder(name);
              let copied = [];
              try {
                copied = copySourceFiles(source_files, folder.dir);
              } catch (e) {
                fs.rmSync(folder.dir, { recursive: true, force: true });
                throw e;
              }
              const full = [PROJECT_RULES, PROJECT_GUIDES[kind] || PROJECT_GUIDES.other, copied.length ? `Files from the user (copied into this folder): ${copied.join(', ')}.` : '', `What the user wants:\n${instruction}`].filter(Boolean).join('\n\n');
              const t = tasks.create({ kind: 'code', project: folder.name, cwd: folder.dir, instruction: full, title: title || name });
              return text({ started: true, taskId: t.id, folder: folder.name, copiedFiles: copied });
            } catch (e) {
              return fail(e.message);
            }
          }
        ),
        tool(
          'start_research',
          'Start a background research/errand worker with web access in the research workspace. It saves results as files there.',
          {
            topic: z.string().describe('Short topic, e.g. "Entry-level supply chain jobs"'),
            instruction: z.string().describe('Complete instructions: what to find, constraints, and what file(s) to save'),
            title: z.string().optional().describe('Short tile title, 3-7 words, e.g. "Fix website build error"'),
            folder: z.string().optional().describe('Existing research folder to continue in (see list_research); omit for a new one'),
          },
          async ({ topic, instruction, title, folder }) => {
            const name = folder ? slugify(folder) : slugify(topic);
            const dir = ensureResearchDir(name);
            try {
              const t = tasks.create({ kind: 'research', project: name, cwd: dir, outputDir: dir, instruction, title: title || topic });
              return text({ started: true, taskId: t.id, folder: name });
            } catch (e) {
              return fail(e.message);
            }
          }
        ),
        tool('list_research', 'List research folders and the files saved in them, newest first.', {}, async () => text(researchFolders())),
        tool('list_tasks', 'List recent tasks with their real status.', { only_active: z.boolean().optional() }, async ({ only_active }) => {
          const all = tasks.list();
          const shown = only_active ? all.filter((t) => tasks.isLive(t.id) || t.status === 'queued') : all.slice(0, 15);
          return text(shown.map((t) => taskBrief(t, tasks)));
        }),
        tool(
          'get_task',
          'Get a task\'s real status: whether it is running right now, last activity, output files, summary and recent log.',
          { task_id: z.number(), log_lines: z.number().optional().describe('How many recent log lines (default 20)') },
          async ({ task_id, log_lines }) => {
            const t = tasks.get(task_id);
            if (!t) return fail(`No task #${task_id}`);
            return text({
              ...taskBrief(t, tasks),
              instruction: t.instruction.slice(0, 1500),
              fullResult: t.result?.slice(0, 3000),
              outputFiles: tasks.outputFiles(t).slice(0, 15),
              costUsd: t.costUsd,
              grants: tasks.grants.describe(t.id),
              ...(t.kind === 'self' && t.self?.review ? { selfReview: { state: t.self.state, stat: t.self.review.stat, checks: Object.fromEntries(Object.entries(t.self.review.checks).map(([k, v]) => [k, v.ok ? 'passed' : 'FAILED'])) } } : {}),
              recentLog: t.log.slice(-(log_lines || 20)).map((e) => `${e.t.slice(11, 19)} ${e.kind}: ${e.text.slice(0, 300)}`),
            });
          }
        ),
        tool(
          'follow_up',
          'Send more instructions to a task. Works while it is running (delivered right away) or after it finished (continues the same session).',
          { task_id: z.number(), message: z.string() },
          async ({ task_id, message }) => {
            try {
              const r = tasks.followUp(task_id, message);
              return text({ ok: true, taskId: r.task.id, delivered: r.delivered });
            } catch (e) {
              return fail(e.message);
            }
          }
        ),
        tool('stop_task', 'Stop a running or queued task. Returns once it has actually stopped.', { task_id: z.number() }, async ({ task_id }) => {
          try {
            const t = await tasks.stop(task_id);
            return text({ id: t.id, status: t.status });
          } catch (e) {
            return fail(e.message);
          }
        }),
        tool(
          'resolve_approval',
          'Approve or deny pending actions, only after the user explicitly answers. One task: task_id. A group of read-only lookups the user answered together: task_ids, or all_low_risk to cover every pending read-only lookup. Groups never cover risky actions (purchases, logins, submissions, git push, deletes, deploys); those need task_id on their own. also_approve_similar auto-approves the same kind of read-only web request from now on.',
          {
            task_id: z.number().optional(),
            task_ids: z.array(z.number()).optional().describe('Several tasks answered at once (read-only lookups only)'),
            all_low_risk: z.boolean().optional().describe('Every pending read-only web lookup, e.g. after "yes, let them all through"'),
            approve: z.boolean(),
            also_approve_similar: z.boolean().optional(),
            scope: z.enum(['task', 'session']).optional().describe('Similar-request grant for just this task (default) or every task until Echo restarts'),
          },
          async ({ task_id, task_ids, all_low_risk, approve, also_approve_similar, scope }) => {
            const opts = { similar: also_approve_similar, scope, by: /** @type {const} */ ('voice') };
            try {
              if (task_ids?.length || all_low_risk) {
                const wanted = new Set(task_ids || []);
                const items = all_low_risk
                  ? tasks.pendingApprovals().filter((a) => a.level !== 'risky' && (!wanted.size || wanted.has(a.taskId)))
                  : [...wanted].map((taskId) => ({ taskId }));
                const r = tasks.resolveMany(items, approve, { ...opts, lowRiskOnly: true });
                const stillWaiting = tasks.pendingApprovals().filter((a) => a.level === 'risky').map((a) => ({ taskId: a.taskId, reason: a.reason }));
                return text({
                  ok: true,
                  approved: approve,
                  resolved: r.resolved,
                  skipped: r.skipped,
                  ...(r.skipped.some((x) => x.why === 'already answered') ? { note: 'Some were already answered in the window. Don\'t mention them.' } : {}),
                  ...(stillWaiting.length ? { riskyStillWaiting: stillWaiting } : {}),
                });
              }
              if (task_id === undefined) return fail('Say which task (task_id), or use task_ids / all_low_risk for a group.');
              const r = tasks.resolveApproval(task_id, approve, opts);
              return text({ ok: true, approved: approve, grantedFromNowOn: r.granted });
            } catch (e) {
              return fail(e.message);
            }
          }
        ),
        tool(
          'grant_permission',
          'Only when the user explicitly asks to stop being asked: auto-approve read-only web requests (kind network_read) or all requests to one website (kind site) for a task or the whole session. Risky actions stay gated regardless.',
          {
            kind: z.enum(['network_read', 'site']),
            scope: z.enum(['task', 'session']),
            task_id: z.number().optional(),
            site: z.string().optional().describe('Hostname for kind=site, e.g. myworkdayjobs.com'),
          },
          async ({ kind, scope, task_id, site }) => {
            if (scope === 'task' && !tasks.get(task_id)) return fail('Say which task.');
            try {
              return text({ ok: true, grants: tasks.grants.grant({ taskId: task_id, scope, kind, site }) });
            } catch (e) {
              return fail(e.message);
            }
          }
        ),
        tool(
          'open_terminal',
          'Open a macOS Terminal window: either live-tailing a task\'s log, or at a project folder.',
          { task_id: z.number().optional(), project: z.string().optional() },
          async ({ task_id, project }) => {
            if (task_id) {
              const t = tasks.get(task_id);
              if (!t) return fail(`No task #${task_id}`);
              openTerminal(t.cwd, `tail -n 200 -f ${JSON.stringify(tasks.logPath(t.id))}`);
              return text(`Opened a terminal following task ${t.id}.`);
            }
            if (!project) return fail('Say which project or task.');
            const pick = pickProject(project);
            if (pick.error) return fail(pick.error);
            openTerminal(pick.project.path);
            return text(`Opened a terminal in ${pick.project.name}.`);
          }
        ),
        tool('remember', 'Save a lasting fact about the user or their preferences to long-term memory.', { fact: z.string() }, async ({ fact }) => {
          fs.appendFileSync(this.memoryFile, `- ${fact.replace(/\n/g, ' ')}\n`);
          return text('Saved.');
        }),
        tool(
          'set_project_alias',
          'Remember that a word or phrase the user said means a project (after they confirmed it).',
          { alias: z.string(), project: z.string().describe('Exact project name') },
          async ({ alias, project }) => {
            try {
              const p = addAlias(alias, project);
              return text(`Saved: "${alias}" means ${p.name}.`);
            } catch (e) {
              return fail(e.message);
            }
          }
        ),
        tool(
          'set_project_description',
          'Save a one-line description of a project so you can recognize it by what it does.',
          { project: z.string().describe('Exact project name'), description: z.string() },
          async ({ project, description }) => {
            try {
              setDescription(project, description);
              return text('Saved.');
            } catch (e) {
              return fail(e.message);
            }
          }
        ),
        tool(
          'hide_project',
          'Hide a junk folder from the project list (or unhide it).',
          { project: z.string().describe('Exact folder name'), hidden: z.boolean() },
          async ({ project, hidden }) => {
            try {
              const p = setHidden(project, hidden);
              return text(`${p.name} is now ${hidden ? 'hidden' : 'visible'}.`);
            } catch (e) {
              return fail(e.message);
            }
          }
        ),
        tool(
          'start_self_improvement',
          'Change or improve Echo itself. Needs the user to confirm in the Echo window the first time; the work happens on a separate branch and the user reviews it before anything changes.',
          { instruction: z.string().describe('Complete description of the change to Echo') },
          async ({ instruction }) => {
            if (!self) return fail('Self-improve mode is not available.');
            try {
              if (self.isUnlocked()) {
                const t = await self.startTask(instruction);
                return text({ started: true, taskId: t.id, note: 'Working on a separate branch. The user will review the diff in the Echo window.' });
              }
              self.requestUnlock(instruction);
              return text({ waitingForUser: true, note: 'A confirmation box with a short code is now showing in the Echo window. Ask the user to type the code there (and their PIN if they set one) and click Confirm. The task starts automatically after that.' });
            } catch (e) {
              return fail(e.message);
            }
          }
        ),
        tool(
          'learn_correction',
          'Remember that the speech recognizer heard `heard` when the user meant `meant` (e.g. "hoe broken" -> "Hoboken"). Used for all future speech.',
          { heard: z.string(), meant: z.string() },
          async ({ heard, meant }) => {
            try {
              learnCorrection(heard, meant);
              return text(`Learned: "${heard}" means "${meant}".`);
            } catch (e) {
              return fail(e.message);
            }
          }
        ),
        tool(
          'add_vocabulary',
          'Add names or words (people, places, brands, dishes) that speech recognition should expect.',
          { words: z.array(z.string()) },
          async ({ words }) => {
            const v = loadVocab();
            setWords([...v.words, ...words]);
            return text(`Added ${words.length} word(s).`);
          }
        ),
        ...this.quickTools(),
        tool('self_improve_status', 'Is self-improve mode unlocked, and is anything waiting for review?', {}, async () => {
          if (!self) return fail('Self-improve mode is not available.');
          // Working means running right now; stopped ones only matter for a day (they can be
          // continued with follow_up, or discarded in the window). Merged and discarded are done.
          const recent = (t) => Date.now() - Date.parse(t.updatedAt) < 24 * 3600 * 1000;
          const selfTasks = tasks.list()
            .filter((t) => t.kind === 'self')
            .map((t) => ({ t, state: selfState(t, tasks) }))
            .filter(({ t, state }) => ['working', 'preparing_review', 'review'].includes(state) || (state === 'stopped' && recent(t)))
            .map(({ t, state }) => ({ id: t.id, state, title: t.title, ...(state === 'stopped' ? { note: 'stopped before finishing; not running' } : {}) }));
          return text({ ...self.status(), pendingRequest: self.status().pendingRequest ? 'waiting for the user to confirm in the window' : null, selfTasks });
        }),
    ];
  }

  /** The native errand tools (lib/quick.js). Errors come back as a sentence to say. */
  quickTools() {
    const quick = this.quick;
    const run = async (fn) => {
      try {
        return text(await fn());
      } catch (e) {
        return fail(e.code === 'permission' ? `Permission needed. Tell the user: ${e.message}` : e.message);
      }
    };
    return [
      tool(
        'find_contact',
        'Search the Mac Contacts app by name, nickname, saved alias or last digits. Returns people with ids and masked numbers/emails (last 4 digits). Fast (cached).',
        { name: z.string().describe('Name as the user said it') },
        ({ name }) => run(() => quick.findContact(name))
      ),
      tool(
        'send_imessage',
        'Send an iMessage through Messages. Shows a Send/Cancel card in the Echo window unless direct is allowed. Every send is logged.',
        {
          to: z.string().describe('A contact id from find_contact, or a saved favorite alias, or a phone number/email the user dictated'),
          text: z.string().describe('The exact message'),
          direct: z.boolean().optional().describe('True only if the user gave both the recipient and the exact text in this same request'),
          sms: z.boolean().optional().describe('Send as SMS instead of iMessage; only when the user explicitly asks'),
        },
        // Safe mode: every message waits on its Send / Cancel card.
        ({ to, text: body, direct, sms }) => run(() => quick.sendMessage({ to, text: body, direct: direct && !getSettings().safeMode, sms }))
      ),
      tool(
        'confirm_message',
        'Send or cancel a message waiting on its confirmation card, after the user clearly says yes or no out loud.',
        { pending_id: z.string(), send: z.boolean() },
        ({ pending_id, send }) => run(() => quick.resolvePending(pending_id, send, 'voice'))
      ),
      tool(
        'set_contact_alias',
        'Save a favorite: a name the user uses for a contact (e.g. "Sam", "mom") pointing at one exact number or email, after they confirmed which one.',
        { alias: z.string(), contact_id: z.string().describe('Id from find_contact') },
        ({ alias, contact_id }) => run(() => quick.setAlias(alias, contact_id))
      ),
      tool(
        'add_calendar_event',
        'Add an event to the Mac Calendar app (the default calendar, or a named one). Times are local ISO, e.g. 2026-09-26T19:00.',
        {
          title: z.string(),
          start: z.string().describe('Local ISO date-time; a date alone (2026-09-26) with all_day'),
          end: z.string().optional().describe('Local ISO date-time; default one hour after start'),
          location: z.string().optional(),
          notes: z.string().optional(),
          alert_minutes: z.number().optional().describe('Alert this many minutes before'),
          calendar: z.string().optional().describe('Calendar name, if the user named one'),
          all_day: z.boolean().optional(),
        },
        (ev) => run(() => quick.addCalendarEvent(ev))
      ),
      tool('open_url', 'Open a web (or mailto) link in the default browser on the Mac.', { url: z.string() }, ({ url }) => run(() => quick.openUrl(url))),
      tool('open_app', 'Open (or bring forward) a Mac app by name, e.g. "Spotify".', { name: z.string() }, ({ name }) => run(() => quick.openApp(name))),
      tool(
        'find_file',
        "Find the user's own files by name with Spotlight (in their home folder), newest first. Use before start_project when they mention a file they have.",
        { name: z.string().describe('Part of the file name, e.g. "budget" or "budget.xlsx"') },
        ({ name }) => run(() => quick.findFiles(name))
      ),
    ];
  }

  start() {
    this.input = new InputQueue();
    const { sessionId } = this.readState();
    this.run(sessionId).catch(() => {});
    if (this.held.length) this.flushEvents();
  }

  async run(resumeId) {
    const gen = (this.gen = (this.gen || 0) + 1);
    try {
      this.q = query({
        prompt: this.input,
        options: {
          cwd: config.roots[0],
          additionalDirectories: config.roots.slice(1),
          model: config.dispatcherModel,
          effort: config.dispatcherEffort,
          resume: resumeId,
          systemPrompt: this.systemPrompt(),
          includePartialMessages: true,
          mcpServers: { ops: this.buildTools() },
          allowedTools: ['Read', 'Glob', 'Grep', 'WebSearch', ...TOOL_NAMES.map((n) => `mcp__ops__${n}`)],
          disallowedTools: ['Bash', 'Edit', 'Write', 'NotebookEdit', 'Agent', 'WebFetch'],
          permissionMode: 'dontAsk',
          settingSources: [],
        },
      });
      for await (const msg of this.q) if (gen === this.gen) this.onMessage(msg);
    } catch (err) {
      if (gen !== this.gen) return;
      this.emit('error', err);
      if (this.busy) this.setBusy(false);
      if (resumeId) {
        // Saved session couldn't be resumed; start a fresh conversation.
        this.writeState({ sessionId: null });
        this.input.close();
        this.input = new InputQueue();
        const next = this.run(undefined);
        if (this.held.length) this.flushEvents();
        return next;
      }
    }
  }

  onMessage(msg) {
    if (msg.type === 'system' && msg.subtype === 'init') {
      this.writeState({ sessionId: msg.session_id });
    } else if (msg.type === 'stream_event' && !msg.parent_tool_use_id) {
      this.onStreamEvent(msg.event);
    } else if (msg.type === 'assistant' && !msg.parent_tool_use_id) {
      const streamed = this.streamedIds.has(msg.message.id);
      for (const block of msg.message.content || []) {
        if (block.type === 'text' && block.text.trim()) {
          if (!streamed) this.emit('say', block.text.trim());
        }
        else if (block.type === 'tool_use') this.emit('activity', `${block.name.replace('mcp__ops__', '')} ${JSON.stringify(block.input).slice(0, 140)}`);
      }
    } else if (msg.type === 'result') {
      this.trackCost(msg);
      this.setBusy(false);
      this.releaseHeld();
      if (msg.subtype !== 'success') this.emit('error', new Error(msg.subtype));
    }
  }

  // Speak sentence by sentence while the reply is still being written, so audio starts sooner.
  onStreamEvent(event) {
    if (event.type === 'message_start') {
      this.streamedIds.add(event.message.id);
      if (this.streamedIds.size > 200) this.streamedIds.clear();
    } else if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
      if (!this.spokeThisTurn && !this.eventTurn) this.emit('speak', fillerFor(event.content_block.name));
      this.spokeThisTurn = true;
    } else if (event.type === 'content_block_start' && event.content_block.type === 'text') {
      this.speechBuf = '';
      this.emit('say_start');
    } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      this.speechBuf += event.delta.text;
      this.spokeThisTurn = true;
      this.emit('say_delta', event.delta.text);
      // Speak whole sentences (lib/speech.js): the first two in one go, so the melody carries.
      let next;
      while ((next = nextSpeechChunk(this.speechBuf, { first: this.speechPieces === 0 }))) {
        this.speechBuf = next.rest;
        this.speakPiece(next.chunk);
      }
    } else if (event.type === 'content_block_stop' && this.speechBuf !== null) {
      if (this.speechBuf.trim()) this.speakPiece(this.speechBuf.trim());
      this.speechBuf = null;
      this.emit('say_end');
    }
  }

  /** One piece of the reply to the voice. After an acknowledgement, a leading "Sure," is dropped. */
  speakPiece(chunk) {
    let piece = chunk;
    if (this.stripAck && this.speechPieces === 0) piece = stripLeadingAck(piece);
    this.stripAck = false;
    this.speechPieces++;
    if (piece.trim().length <= 1) return;
    this.emit('speak', piece.trim(), { prev: this.lastPiece });
    this.lastPiece = piece.trim();
  }

  /**
   * Say a quick acknowledgement the moment the user stops talking (before correction, tools or
   * the reply). Nothing for greetings, thanks or yes/no. Returns what was said, or null.
   * @param {string} said
   */
  acknowledge(said) {
    const ack = ackFor(said);
    if (!ack) return null;
    this.ackedAt = Date.now();
    this.emit('speak', ack);
    return ack;
  }

  /**
   * The page says whether its voice is busy (speaking, or hearing the user). Events wait for
   * it to be quiet, plus a short grace, so they never cut Echo off or talk over the user.
   * @param {any} who  the page (one per connection)
   * @param {boolean} busy
   */
  setVoiceBusy(who, busy) {
    const was = this.voiceBusy.size > 0;
    if (busy) this.voiceBusy.add(who);
    else this.voiceBusy.delete(who);
    if (this.voiceBusy.size) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
      return;
    }
    if (was) this.lastSpeechEnd = Date.now();
    if (this.held.length && !this.busy) {
      clearTimeout(this.graceTimer);
      this.graceTimer = setTimeout(() => {
        this.graceTimer = null;
        if (!this.voiceBusy.size && !this.busy && this.held.length) this.flushEvents();
      }, SPEECH_GRACE_MS);
      this.graceTimer.unref?.();
    }
  }

  /** Held events go in once the turn is over and the voice is quiet (see setVoiceBusy). */
  releaseHeld() {
    if (!this.held.length) return;
    if (this.voiceBusy.size) return; // setVoiceBusy(…, false) flushes after the grace
    this.flushEvents();
  }

  // Apply new settings (personality, name) by restarting the session with a fresh system prompt.
  reload() {
    const { sessionId } = this.readState();
    this.input.close();
    this.q?.close?.();
    this.input = new InputQueue();
    this.run(sessionId).catch(() => {});
    this.afterRestart();
  }

  // The old session's turn (if any) is gone: nothing is busy anymore; deliver held events.
  afterRestart() {
    if (this.busy) this.setBusy(false);
    if (this.held.length) this.flushEvents();
  }

  // total_cost_usd is a running total per session (it carries over on resume), so record the increase.
  trackCost(msg) {
    const total = msg.total_cost_usd || 0;
    const state = this.readState();
    const seen = (state.costSeen || {})[msg.session_id] || 0;
    const delta = total >= seen ? total - seen : total;
    this.writeState({ costSeen: { ...(state.costSeen || {}), [msg.session_id]: total } });
    if (delta > 0) this.emit('cost', delta);
  }

  setBusy(busy) {
    this.busy = busy;
    this.emit('busy', busy);
  }

  /**
   * @param {string} textIn what the user said (already corrected) or typed
   * @param {{ raw?: string, unsure?: string[], lowOverall?: boolean }} [speech] how it was heard
   * @param {Array<{ path: string, mime: string }>} [images] attached images (lib/attachments.js)
   */
  send(textIn, speech = {}, images = []) {
    // Whitespace is never a turn, and neither is a spoken bare "." (a blank transcription).
    if ((!String(textIn || '').trim() || (speech.raw !== undefined && isBlankText(textIn))) && !images.length) return;
    // After an acknowledgement, the tool filler stays quiet and the reply doesn't repeat "Sure".
    const acked = Date.now() - this.ackedAt < 20000;
    this.ackedAt = 0;
    this.spokeThisTurn = acked;
    this.stripAck = acked;
    this.speechPieces = 0;
    this.lastPiece = '';
    this.eventTurn = false;
    this.setBusy(true);
    const notes = [];
    if (speech.raw && speech.raw !== textIn) notes.push(`recognizer heard "${speech.raw}"`);
    if (speech.unsure?.length) notes.push(`not sure about: ${speech.unsure.map((w) => `"${w}"`).join(', ')}`);
    if (speech.lowOverall) notes.push('low confidence overall');
    let body = `[${nowString()}] ${textIn || '(no text, just the attached image' + (images.length > 1 ? 's' : '') + ')'}${notes.length ? `\n(speech: ${notes.join('; ')})` : ''}${this.digest()}`;
    if (!images.length) return this.input.push(body);
    body += `\n(attached image${images.length > 1 ? 's' : ''}, saved at: ${images.map((i) => i.path).join(', ')}. Workers can open these paths.)`;
    this.input.push([...imageBlocks(images), { type: 'text', text: body }]);
  }

  /**
   * Tell the assistant about something that happened. While it's busy with a turn, or Echo is
   * still speaking (or hearing the user), events wait for the turn to end and the voice to go
   * quiet plus a short grace (up to HOLD_MAX_MS), then go in together. Events that went stale in the
   * meantime (isStale() is true, e.g. an approval answered in the window) or are older than
   * ttlMs are dropped, so it never reads out old news.
   * @param {string} event
   * @param {{ isStale?: () => boolean, ttlMs?: number }} [opts]
   */
  notify(event, { isStale, ttlMs = EVENT_TTL_MS } = {}) {
    this.held.push({ text: event, isStale, expiresAt: Date.now() + ttlMs });
    const graceLeft = this.lastSpeechEnd + SPEECH_GRACE_MS - Date.now();
    if (this.input && (this.busy || this.voiceBusy.size || graceLeft > 0)) {
      // Never cut Echo off: wait for the turn to end and the voice to go quiet.
      if (!this.busy && !this.voiceBusy.size && !this.graceTimer) {
        this.graceTimer = setTimeout(() => {
          this.graceTimer = null;
          if (!this.voiceBusy.size && !this.busy) this.flushEvents();
        }, graceLeft);
        this.graceTimer.unref?.();
      }
      this.heldTimer ??= setTimeout(() => {
        this.heldTimer = null;
        this.flushEvents();
      }, HOLD_MAX_MS);
      return;
    }
    this.flushEvents();
  }

  /** Send held events that still matter, as one message. */
  flushEvents() {
    clearTimeout(this.heldTimer);
    this.heldTimer = null;
    clearTimeout(this.graceTimer);
    this.graceTimer = null;
    if (!this.input) return; // start() flushes once the session exists
    const fresh = this.held.splice(0).filter((i) => !eventExpired(i));
    if (!fresh.length) return;
    const newTurn = !this.busy;
    if (newTurn) {
      this.spokeThisTurn = false;
      this.stripAck = false;
      this.speechPieces = 0;
      this.lastPiece = '';
      this.eventTurn = true;
    }
    this.setBusy(true);
    const transition = newTurn && this.lastSpeechEnd && Date.now() - this.lastSpeechEnd < TRANSITION_WINDOW_MS
      ? '\n(You just finished talking to the user: open with a short natural transition, like "Oh, and" or "Quick update:".)'
      : '';
    const body = fresh.map((i) => `[event] ${i.text}`).join('\n') + transition + this.digest();
    this.input.push(`[${nowString()}] ${body}`, 'next', {
      isStale: () => fresh.every(eventExpired),
      // Nothing reached the assistant, so no turn will end: don't stay "busy" forever.
      onDrop: () => {
        if (!this.input.size && this.eventTurn && !this.spokeThisTurn) this.setBusy(false);
      },
    });
  }

  async interrupt() {
    try {
      await this.q?.interrupt();
    } catch {}
  }

  newConversation() {
    this.writeState({ sessionId: null });
    this.input.close();
    this.q?.close?.();
    this.input = new InputQueue();
    this.run(undefined).catch(() => {});
    this.afterRestart();
  }
}
