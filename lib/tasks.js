import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config.js';
import { Grants, classifyCommand, classifyOutside, realPath, mayBeJobFile, isViewable, riskReason, isSecretPath, selfMayRead, selfReadableRoots, isReadOnlyCommand, touchesSelfPort } from './safety.js';
import { sandboxNode } from './nodesandbox.js';
import { isScreenShot } from './screen.js';
import { InputQueue } from './queue.js';
import { ownKill } from './ownprocs.js';
import { nowString, spokenSummary, isInside, shortTitle } from './text.js';
import { writeTitles } from './titles.js';
import { getSettings } from './settings.js';

const SUMMARY_RULES = `Your FINAL message is read aloud to the user by a voice assistant, so make it ONLY a short spoken summary:
- 2 to 4 complete sentences, under 70 words, plain conversational English.
- No markdown, lists, URLs, file paths or code. Say "I saved the list in the job-search folder", not the path.
- Say what you did, the key result, and anything the user must decide. Put detailed findings in files, not in the summary.`;

const BASE_PROMPT = `You are a background worker dispatched by the user's voice assistant (Echo).
The user is not watching this terminal. They talk to the assistant, which relays your results by voice.
- Work autonomously. Make reasonable assumptions and note them instead of asking.
- If you are truly blocked on a decision only the user can make, stop and end your turn with one clear question.
- Do the work yourself. If you use subagents, wait for them: never end your turn while work is still running in the background.
- Do not end your turn until the real output (code changes, saved files) exists.
- Do not commit, push, deploy, publish, log in anywhere, buy anything, or submit forms unless the instruction explicitly says to. Risky commands are gated and will ask the user for approval.
- Never type or handle passwords or payment details. Opening a page in the user's browser for them to finish is fine.`;

const KIND_PROMPTS = {
  code: `- Verify your work (build, typecheck, tests) when the project supports it.`,
  research: `This is research or a personal errand, not coding. You are in a dedicated research folder.
- Use WebSearch and WebFetch for anything current (jobs, showtimes, prices, news). Never answer from memory about recent things.
- Save results as clear Markdown files in the current folder (lists with links, sources and dates). Update existing files in this folder rather than duplicating them.
- Keep recommendations fit for the user's context (for example, an adult couple's late-evening plans shouldn't default to kids' movies).`,
  self: `You are improving Echo itself, working in an isolated git worktree (your current folder). The live app keeps running from a different folder you must not change.
- Read SELF_IMPROVE.md in the current folder first; it is the rulebook for this work.
- You may read the live Echo folder, its logs and its data (conversations, tasks, audit log) without asking, with the Read/Grep/Glob tools or read-only commands (cat, grep, git log, curl GET to /api/health…). Writes, deletes, process kills and POSTs to the live app still need approval. .env files and the PIN file are off-limits.
- A plain \`node <script>\` or \`node -e "…"\` that names the live folder (a dry run, a report over its data) runs without asking in Node's read-only sandbox: it reads your worktree and the live code, data and logs, writes only to your worktree and temp folders, and can't start other processes. If it fails with ERR_ACCESS_DENIED it needed more than that; run it another way (that asks). Stopping processes you started yourself (your smoke server) doesn't ask either, even on a line that also starts or checks them.
- Only edit files inside the current folder. Do not commit; Echo shows the user a diff and commits only after they approve.
- A follow-up continues this same task on the same branch and worktree, even after a merge; build on what is there.
- Before finishing, run \`npm run review-checks\` and fix failures. It runs the tests and type check exactly as the review does (clean environment, throwaway data folder, a free port, packages installed if package.json or the lockfile changed or node_modules is stale). Tests must not depend on a fixed port.
- Never start the server on port ${config.port}. For a smoke test use: ECHO_PORT=4799 ECHO_DATA_DIR=$(mktemp -d) node server.js
- Keep the safety gates (lib/safety.js and the PreToolUse hooks) at least as strict as they are now.`,
};

const LIVE = new Set(['queued', 'running', 'waiting_approval']);
/** Approval levels that are read-only web lookups: fine to ask about as a group. */
import { flagOn } from './flags.ts';
import { readJson, writeJson } from './atomic.js';
import { costSummary } from './costs.js';

/**
 * A commit and nothing riskier: no amend, no skipping hooks, no push or history rewrite, and
 * every other part of the line would run without asking anyway.
 * @param {string} command @param {{ passes: (cmd: string) => boolean }} o
 */
export function plainLocalCommit(command, { passes }) {
  const c = String(command || '');
  if (/--amend|--no-verify|(^|\s)-n\b|--allow-empty|\bpush\b|\breset\b|\brebase\b|--force|\bcd\s+(?!\.(?:\s|$|&|;))/.test(c)) return false;
  // The rest of the line, with the commit taken out, must be fine on its own.
  const rest = c.replace(/\bgit\s+commit\b(?:\s+(?:-[am]+|--message(?:=\S+)?|-m\s+(?:"[^"]*"|'[^']*'|\S+)|"[^"]*"|'[^']*'))*/g, 'true');
  return passes(rest);
}

export const LOW_RISK = new Set(['network_read', 'network_site']);
/** A waiting approval the assistant already asked about gets one short reminder after this long, then nothing. */
export const APPROVAL_REMIND_MS = 3 * 60 * 1000;
const TERMINAL = new Set(['done', 'failed', 'stopped', 'interrupted']);
const WAITING_WORDS = /\b(in the background|i'?ll wait|waiting (for|on) (the|their|its)|once (they|it|the agents?) (finish|complete|report)|agents? (are|is) (still )?running)\b/i;

/** The day's limit (Settings): no new worker run once today's spending has reached it. */
function checkDaily() {
  const daily = Number(getSettings().dailyBudgetUsd) || 0;
  if (daily > 0 && costSummary().today.total >= daily) {
    throw new Error(`Today's spending has reached the $${daily} daily limit in Settings, so no new worker starts today. To start one anyway, raise the limit in Settings → You & privacy.`);
  }
}

export class TaskManager extends EventEmitter {
  /** @param {{ queryFn?: (params: { prompt: any, options: any }) => AsyncIterable<any>, titleQueryFn?: (params: { prompt: any, options: any }) => AsyncIterable<any>, settleMs?: number, exitGraceMs?: number, home?: string, remindMs?: number }} [opts] Swap in fake query() functions (and shorter waits, another home folder) for tests. */
  constructor({ queryFn = sdkQuery, titleQueryFn = undefined, settleMs = config.followUpSettleMs, exitGraceMs = config.workerExitGraceMs, home = os.homedir(), remindMs = APPROVAL_REMIND_MS } = {}) {
    super();
    this.home = home;
    this.remindMs = remindMs;
    this.queryFn = queryFn;
    this.titleQueryFn = titleQueryFn;
    this.settleMs = settleMs;
    this.exitGraceMs = exitGraceMs;
    // Safe mode (set up for new users) makes approvals stricter.
    this.strict = () => Boolean(getSettings().safeMode);
    this.grants = new Grants({ strict: () => this.strict() });
    this.tasks = new Map();
    this.live = new Map(); // id -> live run state
    this.answered = new Map(); // task id -> its last answered approval { id, allowed, by, ... }
    this.nextId = 1;
    this.paused = false; // true while Echo prepares to restart
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.mkdirSync(config.logDir, { recursive: true });
    this.file = path.join(config.dataDir, 'tasks.json');
    this.load();
  }

  /* ---------- persistence ---------- */

  load() {
    try {
      const saved = readJson(this.file, []);
      for (const t of Array.isArray(saved) ? saved : []) {
        t.kind ||= 'code';
        t.cwd ||= t.projectPath;
        if (!t.titled) t.title = shortTitle(t.instruction);
        if (LIVE.has(t.status)) t.status = 'interrupted';
        t.pendingApproval = null;
        this.tasks.set(t.id, t);
        this.nextId = Math.max(this.nextId, t.id + 1);
      }
    } catch {}
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    const all = [...this.tasks.values()].map((t) => ({ ...t, log: t.log.slice(-200) }));
    writeJson(this.file, all);
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 200);
  }

  /* ---------- queries ---------- */

  list() {
    return [...this.tasks.values()].sort((a, b) => b.id - a.id);
  }

  get(id) {
    return this.tasks.get(Number(id)) || null;
  }

  isLive(id) {
    return this.live.has(Number(id));
  }

  logPath(id) {
    return path.join(config.logDir, `task-${id}.log`);
  }

  /** Files a research task has saved, newest first. */
  outputFiles(task) {
    if (!task.outputDir) return [];
    try {
      return fs
        .readdirSync(task.outputDir, { recursive: true })
        .filter((f) => !String(f).startsWith('.') && fs.statSync(path.join(task.outputDir, String(f))).isFile())
        .map((f) => ({ file: String(f), modified: fs.statSync(path.join(task.outputDir, String(f))).mtime.toISOString() }))
        .sort((a, b) => b.modified.localeCompare(a.modified));
    } catch {
      return [];
    }
  }

  /** Files the worker wrote or edited (from its log), plus saved research output. */
  filesTouched(task) {
    const seen = new Map();
    for (const e of task.log) {
      const m = e.kind === 'tool' && e.text.match(/^(Write|Edit) (.+)$/);
      const abs = m && path.resolve(task.cwd, m[2]);
      if (m && !seen.has(abs)) seen.set(abs, m[1] === 'Write' ? 'created' : 'edited');
    }
    for (const f of this.outputFiles(task)) {
      const abs = path.join(task.outputDir, f.file);
      if (!seen.has(abs)) seen.set(abs, 'saved');
    }
    // Documents made by scripts (e.g. a spreadsheet built with Python) don't show up as Write calls.
    const claimedByOthers = new Set();
    for (const other of this.tasks.values()) {
      if (other.id === task.id) continue;
      for (const e of other.log) {
        const m = e.kind === 'tool' && e.text.match(/^(Write|Edit) (.+)$/);
        if (m) claimedByOthers.add(path.resolve(other.cwd, m[2]));
      }
    }
    for (const abs of documentsChangedDuring(task)) if (!seen.has(abs) && !claimedByOthers.has(abs)) seen.set(abs, 'saved');
    return [...seen].filter(([p]) => fs.existsSync(p)).map(([p, how]) => ({ path: p, name: path.basename(p), how }));
  }

  /** Replace rule-based titles with short ones written by a small model (runs in the background). */
  backfillTitles() {
    if (this.titling) return (this.titleAgain = true);
    const pending = [...this.tasks.values()].filter((t) => !t.titled);
    if (!pending.length) return;
    this.titling = true;
    writeTitles(pending.map((t) => ({ id: t.id, instruction: t.instruction })), this.titleQueryFn)
      .then((titles) => {
        for (const t of pending) {
          if (titles[t.id]) this.update(t, { title: titles[t.id], titled: true });
          else t.titled = true; // don't retry forever
        }
      })
      .catch((e) => console.error('[titles]', e.message))
      .finally(() => {
        this.titling = false;
        if (this.titleAgain) {
          this.titleAgain = false;
          this.backfillTitles();
        }
      });
  }

  /* ---------- state changes ---------- */

  update(task, patch) {
    Object.assign(task, patch, { updatedAt: new Date().toISOString() });
    this.emit('update', task);
    if ('status' in patch) this.saveNow();
    else this.save();
  }

  log(task, kind, text) {
    if (!text) return;
    const entry = { t: new Date().toISOString(), kind, text: String(text) };
    task.log.push(entry);
    task.lastActivityAt = entry.t;
    if (task.log.length > 500) task.log.splice(0, task.log.length - 500);
    fs.appendFileSync(this.logPath(task.id), `[${entry.t.slice(11, 19)}] ${kind.toUpperCase().padEnd(6)} ${entry.text}\n`);
    this.emit('log', task, entry);
  }

  finish(task, status, patch = {}) {
    // What the user approved for this job's files ends with the job (a follow-up asks once more).
    this.grants.endJob(task.id);
    this.update(task, { ...patch, status, pendingApproval: null, finishedAt: new Date().toISOString() });
    if (status === 'done' || status === 'failed') this.emit('finished', task);
    else if (status === 'stopped') this.emit('stopped', task);
  }

  /**
   * Create a task.
   * kind: 'code' (a project), 'research' (web research / personal errands) or 'self' (Echo itself).
   * @param {{ kind?: 'code' | 'research' | 'self', project: string, cwd: string, outputDir?: string, instruction: string, title?: string, web?: boolean, self?: any }} opts
   */
  create({ kind = 'code', project, cwd, outputDir, instruction, title = '', web = false, self = null }) {
    if (this.paused) throw new Error('Echo is restarting; try again in a moment.');
    checkDaily();
    const task = {
      id: this.nextId++,
      kind,
      project,
      cwd,
      projectPath: cwd,
      outputDir: outputDir || null,
      web: Boolean(web || kind === 'research'),
      self,
      title: title.trim() || shortTitle(instruction),
      titled: Boolean(title.trim()),
      instruction,
      status: 'queued',
      sessionId: null,
      summary: '',
      result: '',
      costUsd: 0,
      turns: 0,
      autoContinues: 0,
      pendingApproval: null,
      resumeAfterRestart: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      log: [],
    };
    this.tasks.set(task.id, task);
    this.log(task, 'you', instruction);
    if (!task.titled) this.backfillTitles();
    this.enqueue(task, `Current date and time: ${nowString()}.\n\n${instruction}`);
    return task;
  }

  /** Send more instructions. Delivered mid-run if the worker is busy, else resumes the session. */
  followUp(id, message, { restart = false } = {}) {
    const task = this.get(id);
    if (!task) throw new Error(`No task #${id}`);
    if (this.paused) throw new Error('Echo is restarting; try again in a moment.');
    const live = this.live.get(task.id);
    // Starting it again is a new worker run: the day's limit applies (not to picking up after a
    // restart), checked before anything is written down.
    if (!live && task.status !== 'queued' && !restart) checkDaily();
    this.log(task, 'you', message);
    if (live) {
      live.expected++;
      live.input.push(message, 'next');
      return { task, delivered: 'mid-run' };
    }
    if (task.status === 'queued') {
      task.nextPrompt += `\n\n${message}`;
      return { task, delivered: 'queued' };
    }
    // Going on after its own limit: the limit counts again from here, so it stops at the next one.
    if (task.overBudget) this.update(task, { overBudget: false, budgetBase: task.costUsd });
    // Listeners run before the worker starts (self-improvement tasks reopen their worktree here).
    this.emit('follow_up', task, message);
    this.enqueue(task, `Current date and time: ${nowString()}.\n\n${message}`);
    return { task, delivered: 'resumed' };
  }

  enqueue(task, prompt) {
    task.nextPrompt = prompt;
    task.autoContinues = 0;
    this.update(task, { status: 'queued', resumeAfterRestart: false });
    this.pump();
  }

  pump() {
    if (this.paused) return;
    while (this.live.size < config.maxConcurrentWorkers) {
      const next = [...this.tasks.values()].find((t) => t.status === 'queued' && !this.live.has(t.id));
      if (!next) return;
      this.run(next);
    }
  }

  /* ---------- running a worker ---------- */

  /** @returns {import('@anthropic-ai/claude-agent-sdk').Options} */
  workerOptions(task, live) {
    const askUser = async (reason, verdict = null) => {
      const approval = {
        id: randomUUID().slice(0, 8),
        reason,
        level: verdict?.level || 'risky',
        hosts: verdict?.hosts || [],
        createdAt: new Date().toISOString(),
        // What one yes covers for the rest of this task, when it covers more than this one action.
        ...(verdict?.covers ? { covers: verdict.covers } : {}),
      };
      this.log(task, 'ask', reason);
      this.update(task, { status: 'waiting_approval', pendingApproval: approval });
      const answered = new Promise((resolve) => (live.approval = { ...approval, resolve }));
      this.emit('approval', task);
      const allowed = await answered;
      const by = live.lastAnswer?.id === approval.id ? live.lastAnswer.by : null;
      if (live.approval?.id === approval.id) live.approval = null;
      if (!live.abort.signal.aborted) this.update(task, { status: 'running', pendingApproval: null });
      const where = by === 'window' ? ' in the window' : by === 'voice' ? ' by voice' : '';
      this.log(task, allowed ? 'ok' : 'deny', `${allowed ? 'Approved' : 'Denied'} by you${where}`);
      return allowed;
    };
    const DENIED = 'The user denied this action. Do not retry it; continue without it or explain what is needed.';
    const decide = (allowed, reason) => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: allowed ? 'allow' : 'deny', permissionDecisionReason: reason },
    });

    /** @typedef {import('@anthropic-ai/claude-agent-sdk').HookCallback} HookCallback */
    /** @typedef {import('@anthropic-ai/claude-agent-sdk').PreToolUseHookInput} PreToolUseHookInput */

    // PreToolUse hooks run before permission rules, so they hold even when the user's
    // Claude Code settings auto-approve commands.
    /** @type {(input: any) => Promise<any>} */
    const gateBash = async (input) => {
      const command = input.tool_input?.command || '';
      const selfTask = task.kind === 'self';
      const strict = this.strict();
      const passes = (cmd) => !riskReason('Bash', { command: cmd }, { grants: this.grants, taskId: task.id, selfTask, strict });
      if (passes(command)) return {};
      const verdict = classifyCommand(command, { selfTask, strict });
      // Stage 2 (policy flag): a plain local commit in the task's own folder is routine (never
      // denied in 773 requests). Amending, skipping hooks, or anything else risky still asks.
      if (verdict.reason === 'git commit' && flagOn('policy') && plainLocalCommit(command, { passes })) {
        this.log(task, 'note', `Allowed without asking (a local commit): ${command.slice(0, 200)}`);
        return {};
      }
      // A self task stopping its own test processes (temp or verify folders, the test port) needn't
      // ask, even in a line that also starts and checks them, as long as the rest wouldn't ask either.
      if (selfTask && verdict.reason === 'kills processes') {
        const own = ownKill(command, { worktree: task.cwd, since: Date.parse(task.startedAt || task.createdAt), restOk: passes });
        if (own.ok) {
          this.log(task, 'note', `Allowed without asking (${own.why}): ${command.slice(0, 200)}`);
          return {};
        }
      }
      // A node script that names Echo's folder (a dry run, a report over its data) runs read-only
      // in Node's permission sandbox instead of asking: it can't write to Echo or read secrets.
      if ((selfTask || this.grants.echoRead(task.id)) && verdict.reason === 'touches Echo itself' && !touchesSelfPort(command)) {
        const boxed = sandboxNode(command, { own: task.cwd });
        if (boxed) {
          this.log(task, 'note', `Allowed without asking, read-only on Echo (Node's permission sandbox): ${command.slice(0, 200)}`);
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'allow',
              permissionDecisionReason: "Runs read-only on Echo in Node's permission sandbox (writes only to the task folder and temp folders, no child processes).",
              updatedInput: { ...input.tool_input, command: boxed },
            },
          };
        }
      }
      const allowed = await askUser(`${verdict.reason}: ${command.slice(0, 300)}`, verdict);
      return decide(allowed, allowed ? 'Approved by the user' : DENIED);
    };

    // Subagents must run in the foreground so a worker never ends before its work is done.
    /** @type {(input: any) => Promise<any>} */
    const foregroundAgents = async (input) => {
      if (!input.tool_input?.run_in_background) return {};
      this.log(task, 'note', 'Running subagent in the foreground so results are waited for');
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { ...input.tool_input, run_in_background: false },
        },
      };
    };

    // Ordinary workers can't change Echo, and read it only once you've allowed that (a read-only
    // grant for the task or session). Self-improvement workers can only write in their worktree.
    /** @type {(input: any) => Promise<any>} */
    const guardPaths = async (input) => {
      const i = input.tool_input || {};
      const p = i.file_path || i.notebook_path || i.path;
      if (!p) return {};
      const abs = path.resolve(task.cwd, p);
      const writes = /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(input.tool_name);
      if (task.kind === 'self') {
        if (writes && !isInside(abs, task.cwd)) return decide(false, `Self-improvement tasks may only edit files inside ${task.cwd}.`);
        if (isSecretPath(abs, input.tool_name)) return decide(false, 'Secrets are off-limits.');
        // Reading the live app, its logs and data is fine without asking.
        if (selfMayRead(input.tool_name, abs)) return decide(true, 'Self-improvement tasks may read the live Echo.');
        return {};
      }
      if (selfReadableRoots().some((root) => isInside(abs, root))) {
        if (!selfMayRead(input.tool_name, abs)) return decide(false, writes || isSecretPath(abs, input.tool_name)
          ? 'Echo itself is off-limits to ordinary tasks. Ask the user to use self-improve mode instead.'
          : 'Only reading Echo is possible from an ordinary task.');
        if (this.grants.echoRead(task.id)) return decide(true, "The user allowed this task to read Echo's code.");
        const verdict = { level: 'echo_read', reason: "reads Echo's own code (read-only)", hosts: [] };
        const allowed = await askUser(`${verdict.reason}: ${input.tool_name} ${abs}`, verdict);
        return decide(allowed, allowed ? 'Approved by the user' : DENIED);
      }
      return {};
    };

    // Anything Claude Code would normally prompt for (e.g. paths outside the project).
    /** @type {import('@anthropic-ai/claude-agent-sdk').CanUseTool} */
    const canUseTool = async (toolName, input, { blockedPath }) => {
      if (!blockedPath) return { behavior: 'allow', updatedInput: input };
      const readsEcho = task.kind === 'self' || this.grants.echoRead(task.id);
      if (readsEcho && selfMayRead(toolName, path.resolve(task.cwd, blockedPath))) return { behavior: 'allow', updatedInput: input };
      // A read-only shell command (already past the Bash gate) looking at Echo's folders.
      if (readsEcho && toolName === 'Bash' && isReadOnlyCommand(String(input.command || '')) && selfMayRead('Read', path.resolve(task.cwd, blockedPath))) return { behavior: 'allow', updatedInput: input };
      // Images the user attached in the chat may be read (only read) by any worker.
      if (toolName === 'Read' && isInside(path.resolve(task.cwd, blockedPath), config.attachmentsDir) && !isSecretPath(blockedPath)) return { behavior: 'allow', updatedInput: input };
      // So may the temporary, redacted screenshot of the user's screen handed to this task (lib/screen.js).
      if (toolName === 'Read' && isScreenShot(path.resolve(task.cwd, blockedPath))) return { behavior: 'allow', updatedInput: input };
      // Outside the task's folder. Files the user already approved for this job (changing them
      // again, reading them, opening them to check the result) don't ask twice; the first write
      // asks once, saying what the yes covers. Everything else asks every time, as before.
      const verdict = task.kind === 'self' ? null : classifyOutside(toolName, input, blockedPath, { cwd: task.cwd, home: this.home });
      if (verdict && this.grants.covers(task.id, verdict)) {
        this.log(task, 'note', `Allowed without asking (you approved this job's files): ${toolName} ${String(blockedPath).slice(0, 200)}`);
        return { behavior: 'allow', updatedInput: input };
      }
      const covers = verdict?.level === 'job_files' && verdict.writes.length ? jobCovers(task, verdict, this.home) : null;
      // Still a risky question to the user and the assistant: asked on its own, a clear yes needed.
      return (await askUser(`${toolName} outside the task folder: ${blockedPath}`, { level: 'risky', hosts: [], covers }))
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: DENIED };
    };

    return {
      cwd: task.cwd,
      abortController: live.abort,
      resume: task.sessionId || undefined,
      model: config.workerModel,
      permissionMode: 'acceptEdits',
      canUseTool,
      allowedTools: task.web ? ['WebSearch', 'WebFetch'] : [],
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', timeout: 24 * 3600, hooks: [gateBash] },
          { matcher: 'Agent|Task', hooks: [foregroundAgents] },
          { matcher: 'Read|Edit|Write|MultiEdit|NotebookEdit|Glob|Grep', hooks: [guardPaths] },
        ],
      },
      settingSources: task.kind === 'code' ? ['user', 'project', 'local'] : ['user'],
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: [BASE_PROMPT, KIND_PROMPTS[task.kind] || KIND_PROMPTS.code, SUMMARY_RULES].join('\n\n'),
      },
    };
  }

  run(task) {
    const live = {
      abort: new AbortController(),
      approval: null,
      input: new InputQueue(),
      expected: 1, // prompts sent that still need a result
      results: 0,
      bgAgents: new Map(),
      waitingForAgents: false,
      startedAt: Date.now(),
      endStatus: null,
    };
    this.live.set(task.id, live);
    live.input.push(task.nextPrompt);
    delete task.nextPrompt;
    this.update(task, { status: 'running', startedAt: task.startedAt || new Date().toISOString(), finishedAt: null });

    live.done = (async () => {
      try {
        const q = this.queryFn({ prompt: live.input, options: this.workerOptions(task, live) });
        for await (const msg of q) this.onMessage(task, live, msg);
      } catch (err) {
        if (!live.abort.signal.aborted) {
          this.log(task, 'error', err.message);
          live.endStatus ??= { status: 'failed', patch: { summary: spokenSummary(`That task failed: ${err.message}`) } };
        }
      } finally {
        this.settle(task, live);
      }
    })();
    return live.done;
  }

  /** The worker is over: record how it ended, once (a forced end may get here before the SDK does). */
  settle(task, live) {
    live.input.close();
    clearTimeout(live.settleTimer);
    clearTimeout(live.exitTimer);
    if (this.live.get(task.id) !== live) return; // already settled (stop() or a forced end)
    this.live.delete(task.id);
    if (live.checkpointed) this.update(task, { status: 'interrupted', pendingApproval: null });
    else if (live.endStatus && (live.forcedEnd || !live.abort.signal.aborted)) this.finish(task, live.endStatus.status, live.endStatus.patch);
    else if (live.abort.signal.aborted) this.finish(task, 'stopped');
    else this.finish(task, 'failed', { summary: task.summary || 'The worker stopped unexpectedly without a result.' });
    this.pump();
  }

  /**
   * The final result is in: close the session. If it doesn't wind down (a child process or
   * background job keeping it open), end it anyway so the task never sits at "running".
   */
  endSession(task, live) {
    live.input.close();
    clearTimeout(live.exitTimer);
    live.exitTimer = setTimeout(() => {
      if (this.live.get(task.id) !== live) return;
      this.log(task, 'note', "The worker's session didn't close after its final answer; ending it");
      live.forcedEnd = true;
      live.abort.abort();
      // Give the SDK a moment to unwind, then settle regardless.
      live.exitTimer = setTimeout(() => this.settle(task, live), 5000);
    }, this.exitGraceMs);
  }

  onMessage(task, live, msg) {
    // A new turn is under way, so an earlier result wasn't the last one.
    if (msg.type === 'assistant' || msg.type === 'tool_progress' || (msg.type === 'system' && msg.subtype === 'session_state_changed' && msg.state === 'running')) {
      clearTimeout(live.settleTimer);
      live.settleTimer = null;
    }
    if (msg.type === 'system' && msg.subtype === 'init') {
      this.update(task, { sessionId: msg.session_id });
    } else if (msg.type === 'system' && msg.subtype === 'background_tasks_changed') {
      live.bgAgents = new Map(
        (msg.tasks || []).filter((t) => !t.ambient && !/bash|shell/i.test(t.task_type || '')).map((t) => [t.task_id, t.description])
      );
      if (live.waitingForAgents && live.bgAgents.size === 0) {
        live.waitingForAgents = false;
        this.continueTask(task, live, 'Your background agents have finished. Use their results to complete the original task, save the real output, then give your spoken summary.');
      }
    } else if (msg.type === 'assistant' && !msg.parent_tool_use_id) {
      for (const block of msg.message.content || []) {
        if (block.type === 'text' && block.text.trim()) this.log(task, 'claude', block.text);
        else if (block.type === 'tool_use') this.log(task, 'tool', describeTool(block));
      }
    } else if (msg.type === 'result') {
      live.results++;
      const ok = msg.subtype === 'success';
      const text = ok ? msg.result || '' : `Stopped: ${msg.subtype}`;
      // total_cost_usd is a running total for the session; record only what this turn added.
      const total = msg.total_cost_usd ?? 0;
      const prev = live.costSeen ?? task.costUsd;
      const delta = total >= prev ? total - prev : total;
      live.costSeen = total;
      if (delta > 0) this.emit('cost', task, delta);
      this.update(task, { result: text, costUsd: task.costUsd + delta, turns: task.turns + 1 });
      // One task's limit (Settings): it stops there, and the user decides whether it goes on.
      const limit = Number(getSettings().taskBudgetUsd) || 0;
      if (limit > 0 && task.costUsd - (task.budgetBase || 0) >= limit && !task.overBudget) {
        this.update(task, { overBudget: true });
        this.emit('budget', task, limit);
        this.stop(task.id, { why: `Stopped at the $${limit} limit for one task (Settings → Account & AI). Ask to continue it to go on.` }).catch(() => {});
        return;
      }
      if (!ok) {
        this.log(task, 'error', text);
        live.endStatus = { status: 'failed', patch: { summary: spokenSummary(`The worker hit an error: ${msg.subtype.replace(/_/g, ' ')}.`) } };
        this.endSession(task, live);
        return;
      }
      if (live.results < live.expected) {
        // A follow-up is still queued inside the session, or (often) the CLI folded it into the
        // turn that just ended, and no result of its own will ever come. If the worker stays
        // quiet, treat this result as the last one instead of waiting forever.
        clearTimeout(live.settleTimer);
        const armSettle = () => {
          live.settleTimer = setTimeout(() => {
            if (this.live.get(task.id) !== live) return;
            if (live.approval) return armSettle(); // waiting on you, not idle
            this.log(task, 'note', 'Follow-ups were answered in the last turn; finishing');
            live.expected = live.results;
            this.completeTurn(task, live, text);
          }, this.settleMs);
        };
        armSettle();
        return;
      }
      this.completeTurn(task, live, text);
    }
  }

  /** The worker answered everything it was sent: finish, or nudge it on if it stopped too early. */
  completeTurn(task, live, text) {
    const reason = this.needsContinue(task, live, text);
    if (reason === 'agents') {
      live.waitingForAgents = true;
      this.log(task, 'note', `Waiting for ${live.bgAgents.size} background agent(s) before finishing`);
      return;
    }
    if (reason) return this.continueTask(task, live, reason);

    this.log(task, 'done', 'Finished');
    live.endStatus = { status: 'done', patch: { summary: spokenSummary(text) || 'Done.' } };
    this.endSession(task, live);
  }

  /** Detect a worker that ended its turn before the real work was saved. */
  needsContinue(task, live, text) {
    if (live.bgAgents.size > 0) return 'agents';
    if (task.autoContinues >= 2) return null;
    if (WAITING_WORDS.test(text)) {
      return 'You ended your turn while saying work is still running in the background. Nothing is waiting for you anymore: finish the task yourself now, save the real output, then give your spoken summary.';
    }
    if (task.kind === 'research') {
      const since = live.startedAt - 5000;
      const fresh = this.outputFiles(task).some((f) => Date.parse(f.modified) >= since);
      if (!fresh && text.length < 1500) {
        return 'You ended without saving anything in the research folder. Save your findings as a Markdown file in the current folder (with links and sources), then give your spoken summary. If you truly found nothing, save a short note saying what you searched.';
      }
    }
    return null;
  }

  continueTask(task, live, message) {
    task.autoContinues++;
    this.log(task, 'note', `Auto-continuing: ${message.slice(0, 120)}`);
    live.expected++;
    live.input.push(message);
  }

  /* ---------- approvals, stopping, restarts ---------- */

  /** Is this exact approval still waiting for an answer? */
  isApprovalPending(taskId, approvalId) {
    const approval = this.live.get(Number(taskId))?.approval;
    return Boolean(approval && (!approvalId || approval.id === approvalId));
  }

  /** Everything waiting for an answer right now, oldest first. */
  pendingApprovals() {
    const out = [];
    for (const [taskId, live] of this.live) {
      const a = live.approval;
      if (!a) continue;
      const t = this.get(taskId);
      out.push({ taskId, approvalId: a.id, level: a.level, reason: a.reason, hosts: a.hosts, createdAt: a.createdAt, project: t?.project, title: t?.title, ...(a.covers ? { covers: a.covers.text } : {}) });
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * How the message being written to the assistant now should treat a task's waiting approval,
   * and remember that it did: 'new' the first time it is shown, 'remind' once when it has waited
   * remindMs since then, 'asked' every other time (say nothing unless the user brings it up).
   * Null when nothing is waiting. The window shows the approval all along, whatever this says.
   * @param {number} taskId @param {number} [now]
   * @returns {'new' | 'asked' | 'remind' | null}
   */
  approvalMention(taskId, now = Date.now()) {
    const a = this.live.get(Number(taskId))?.approval;
    if (!a) return null;
    if (!a.toldAt) {
      a.toldAt = now;
      return 'new';
    }
    if (!a.remindedAt && now - a.toldAt >= this.remindMs) {
      a.remindedAt = now;
      return 'remind';
    }
    return 'asked';
  }

  /** When a waiting approval was first shown to the assistant and when it was reminded of it (0: not yet). Null once answered. */
  approvalTold(taskId, approvalId) {
    const a = this.live.get(Number(taskId))?.approval;
    return a && a.id === approvalId ? { toldAt: a.toldAt || 0, remindedAt: a.remindedAt || 0 } : null;
  }

  /**
   * Answer a task's pending approval. Throws an error with code 'stale' when it's no longer
   * pending (already answered, or approvalId names an older request).
   * @param {number} id
   * @param {boolean} allow
   * @param {{ similar?: boolean, scope?: 'task' | 'session', approvalId?: string, by?: 'window' | 'voice' }} [opts]
   */
  resolveApproval(id, allow, { similar = false, scope = 'task', approvalId = undefined, by = 'voice' } = {}) {
    const task = this.get(id);
    if (!task) throw new Error(`No task #${id}`);
    const live = this.live.get(task.id);
    const approval = live?.approval;
    const last = this.answered.get(task.id);
    if (!approval || (approvalId && approval.id !== approvalId)) {
      const earlier = last && (!approvalId || last.id === approvalId) ? last : null;
      const why = earlier
        ? `It was already answered ${earlier.by === 'window' ? 'in the window' : 'by voice'} (${earlier.allowed ? 'approved' : 'denied'}), so there's nothing to do and no need to mention it.`
        : approval ? 'That request was already answered; a newer one is waiting.' : 'It may have been answered already.';
      throw Object.assign(new Error(`Task #${task.id} has nothing waiting for approval right now (status: ${task.status}). ${why}`), { code: 'stale' });
    }
    let granted = null;
    // Approving a read of Echo's own code approves reading it for the rest of the task
    // (or every task until Echo restarts, with scope 'session' and similar).
    if (allow && approval.level === 'echo_read') {
      granted = this.grants.grant({ taskId: task.id, scope: similar ? scope : 'task', kind: 'echo_read' });
      this.log(task, 'grant', `Read-only access to Echo's code (${similar ? scope : 'task'}): ${JSON.stringify(granted)}`);
    } else if (allow && similar) {
      if (approval.level === 'network_read') granted = this.grants.grant({ taskId: task.id, scope, kind: 'network_read' });
      else if (approval.level === 'network_site' && approval.hosts.length) {
        for (const site of approval.hosts) granted = this.grants.grant({ taskId: task.id, scope, kind: 'site', site });
      }
      if (granted) this.log(task, 'grant', `Auto-approving similar requests (${scope}): ${JSON.stringify(granted)}`);
    }
    // A yes to a job's first write outside its folder covers what the question said, for this
    // task only (whatever scope was asked for): those files again, and looking at the result.
    if (allow && approval.covers) {
      this.grants.grantPaths(task.id, approval.covers.entries);
      granted = { ...(granted || {}), jobFiles: approval.covers.text };
      this.log(task, 'grant', `For the rest of this job, without asking again: ${approval.covers.text}`);
    }
    // Answered from now on, even before the worker wakes up: stale events and double clicks see it.
    live.approval = null;
    live.lastAnswer = { id: approval.id, by };
    const record = { id: approval.id, level: approval.level, reason: approval.reason, allowed: Boolean(allow), by, at: new Date().toISOString() };
    this.answered.set(task.id, record);
    this.emit('approval_resolved', task, record);
    approval.resolve(Boolean(allow));
    return { task, granted, level: approval.level, by };
  }

  /**
   * Answer several approvals at once. Skips ones that are no longer pending; with lowRiskOnly,
   * risky ones are skipped too (they must be answered one by one).
   * @param {Array<{ taskId: number, approvalId?: string }>} items
   * @param {boolean} allow
   * @param {{ similar?: boolean, scope?: 'task' | 'session', by?: 'window' | 'voice', lowRiskOnly?: boolean }} [opts]
   */
  resolveMany(items, allow, { similar = false, scope = 'task', by = 'voice', lowRiskOnly = false } = {}) {
    const resolved = [];
    const skipped = [];
    const granted = [];
    for (const { taskId, approvalId } of items) {
      const approval = this.live.get(Number(taskId))?.approval;
      if (approval && lowRiskOnly && !LOW_RISK.has(approval.level)) {
        skipped.push({ taskId, why: 'risky: ask about it on its own' });
        continue;
      }
      try {
        const r = this.resolveApproval(taskId, allow, { similar, scope, approvalId, by });
        resolved.push(Number(taskId));
        if (r.granted) granted.push(r.granted);
      } catch (e) {
        skipped.push({ taskId, why: e.code === 'stale' ? 'already answered' : e.message });
      }
    }
    return { resolved, skipped, granted };
  }

  /** @param {number} id @param {{ why?: string }} [o] why: what the log says stopped it */
  async stop(id, { why = 'Stopped by you' } = {}) {
    const task = this.get(id);
    if (!task) throw new Error(`No task #${id}`);
    const live = this.live.get(task.id);
    this.log(task, 'stop', why);
    if (live) {
      live.approval?.resolve(false);
      live.abort.abort();
      await Promise.race([live.done, new Promise((r) => setTimeout(r, 5000))]);
      // The SDK didn't wind down in time; treat it as stopped anyway.
      if (this.live.get(task.id) === live) this.settle(task, live);
    } else if (task.status === 'queued') {
      this.finish(task, 'stopped');
    }
    return task;
  }

  /** Wait until no worker is running, up to ms. Returns true if idle. */
  async waitForIdle(ms) {
    const deadline = Date.now() + ms;
    while (this.live.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
    return this.live.size === 0;
  }

  /** Before a restart: stop running workers, remembering to resume them afterwards. */
  async checkpointAll() {
    this.paused = true;
    const running = [...this.live.entries()];
    for (const [id, live] of running) {
      const task = this.get(id);
      live.checkpointed = true;
      task.resumeAfterRestart = true;
      this.log(task, 'note', 'Paused for a Echo restart; will resume automatically');
      live.approval?.resolve(false);
      live.abort.abort();
    }
    for (const t of this.tasks.values()) if (t.status === 'queued') t.resumeAfterRestart = true;
    await Promise.race([Promise.allSettled(running.map(([, l]) => l.done)), new Promise((r) => setTimeout(r, 8000))]);
    for (const [id] of running) {
      const t = this.get(id);
      if (LIVE.has(t.status)) t.status = 'interrupted';
    }
    this.saveNow();
    return running.map(([id]) => id);
  }

  /** After a restart: resume tasks that were checkpointed. */
  resumeCheckpointed() {
    const resumed = [];
    for (const t of this.tasks.values()) {
      if (!t.resumeAfterRestart || !(TERMINAL.has(t.status) || t.status === 'queued')) continue;
      if (t.status === 'queued' || !t.sessionId) {
        t.resumeAfterRestart = false;
        this.enqueue(t, `Current date and time: ${nowString()}.\n\n${t.instruction}`);
      } else {
        this.followUp(t.id, 'Echo restarted while you were working. Continue exactly where you left off and finish the original task.', { restart: true });
      }
      resumed.push(t.id);
    }
    return resumed;
  }
}

/* ---------- one yes for the job's own files ---------- */

const KNOWN_FOLDERS = { Desktop: 'on your Desktop', Documents: 'in your Documents folder', Downloads: 'in your Downloads folder', Pictures: 'in your Pictures folder', Movies: 'in your Movies folder', Music: 'in your Music folder' };

/** "on your Desktop", "in the site folder": where a folder is, in words. */
function placeWords(dir, home) {
  const rel = path.relative(realPath(home) || home, dir);
  if (!rel) return 'in your home folder';
  return (!rel.includes(path.sep) && KNOWN_FOLDERS[rel]) || `in the ${path.basename(dir)} folder`;
}

/**
 * Folders outside the task's own that its instruction names by full path (/Users/…/site,
 * ~/Desktop/site, quoted when the path has spaces): the job's target folders. Only ones that
 * exist and that one yes may cover as a whole (lib/safety.js mayBeJobFile).
 * @param {{ instruction: string, cwd: string }} task @param {string} [home]
 * @returns {Array<{ path: string, dir: true }>}
 */
export function jobFolders(task, home = os.homedir()) {
  const text = String(task.instruction || '');
  const found = [...text.matchAll(/["'`]((?:~\/|\/)[^"'`\n]+)["'`]/g), ...text.matchAll(/(?:^|[\s(])((?:~\/|\/)[^\s"'`()<>]+)/g)].map((m) => m[1].replace(/[.,;:!?]+$/, ''));
  const root = realPath(task.cwd) || task.cwd;
  const out = new Map();
  for (const raw of found) {
    const abs = realPath(raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw);
    if (!abs || isInside(abs, root) || isInside(root, abs)) continue;
    if (fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory() && mayBeJobFile(abs, { home, dir: true })) out.set(abs, { path: abs, dir: /** @type {const} */ (true) });
  }
  return [...out.values()];
}

/**
 * What one yes to a job's write outside its folder covers, derived from that request (the worker
 * isn't asked to predict): each file it writes, or, when the task's instruction names a folder
 * that file is in, the files in that folder. Nothing else the instruction names rides along: a
 * different file asks its own question when the worker first writes it. `text` is the question's
 * wording ("replace hello.html on your Desktop and open it to check the result"); `entries` is
 * exactly what the yes approves for this task.
 * @param {{ instruction: string, cwd: string }} task
 * @param {{ writes: string[], edit?: boolean }} verdict from classifyOutside
 * @param {string} [home]
 */
export function jobCovers(task, verdict, home = os.homedir()) {
  const folders = jobFolders(task, home);
  const entries = new Map();
  for (const p of verdict.writes) {
    const e = folders.find((f) => isInside(p, f.path)) || { path: p, dir: false };
    entries.set(e.path, e);
  }
  const say = (e) => (e.dir ? `files in the ${path.basename(e.path)} folder ${placeWords(path.dirname(e.path), home)}` : `${path.basename(e.path)} ${placeWords(path.dirname(e.path), home)}`);
  const [first, ...rest] = [...entries.values()];
  const verb = first.dir || verdict.edit ? 'change' : fs.existsSync(first.path) ? 'replace' : 'create';
  const look = [first, ...rest].some((e) => e.dir || isViewable(e.path)) ? ` and open ${first.dir || rest.length ? 'them' : 'it'} to check the result` : '';
  return { text: `${verb} ${[first, ...rest].map(say).join(' and ')}${look}`, entries: [first, ...rest] };
}

const DOC_EXT = /\.(xlsx|xls|csv|docx|doc|pdf|pptx|md|txt|html|png|jpg|json)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '.next', 'dist', 'build', '__pycache__', '.claude']);

/** Document-type files in the task folder (two levels deep) modified while the task ran. */
function documentsChangedDuring(task) {
  const from = Date.parse(task.startedAt || task.createdAt) - 2000;
  const running = LIVE.has(task.status);
  const lastLog = task.log.length ? task.log[task.log.length - 1].t : task.updatedAt;
  const to = running ? Date.now() : Date.parse(task.finishedAt || lastLog) + 2000;
  const out = [];
  const walk = (dir, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name.startsWith('~$')) continue; // hidden and Office lock files
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 2 && !SKIP_DIRS.has(e.name)) walk(abs, depth + 1);
      } else if (DOC_EXT.test(e.name)) {
        const m = fs.statSync(abs).mtimeMs;
        if (m >= from && m <= to) out.push(abs);
      }
      if (out.length >= 20) return;
    }
  };
  walk(task.cwd, 0);
  return out;
}

function describeTool(block) {
  const i = block.input || {};
  const short = (s) => String(s).split('\n')[0].slice(0, 160);
  switch (block.name) {
    case 'Bash': return `$ ${short(i.command)}`;
    case 'Read': case 'Write': case 'Edit': return `${block.name} ${i.file_path}`;
    case 'Glob': case 'Grep': return `${block.name} ${i.pattern}`;
    case 'WebSearch': return `Search: ${short(i.query)}`;
    case 'WebFetch': return `Fetch: ${short(i.url)}`;
    case 'TodoWrite': return `Plan: ${(i.todos || []).map((t) => t.content).join(' · ').slice(0, 200)}`;
    default: return `${block.name} ${short(JSON.stringify(i))}`;
  }
}
