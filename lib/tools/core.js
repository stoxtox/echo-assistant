// The assistant's core tools: tasks, projects, research, approvals, memory, vocabulary,
// self-improvement (lib/dispatcher.js allTools). Moved out of the dispatcher unchanged.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { text, fail, TOO_QUIET } from './result.js';
import { taskBrief, PROJECT_GUIDES, PROJECT_RULES, pickProject, openTerminal, selfState, researchFolders, ensureResearchDir, createProjectFolder, copySourceFiles } from './projects.js';
import { slugify } from '../text.js';
import { listProjects, addAlias, setHidden, setDescription } from '../projects.js';
import { learnCorrection, loadVocab, setWords } from '../vocab.js';
import { recallMemory } from '../memory.js';
import { addRule, removeRule } from '../rules.js';
import { flagOn } from '../flags.ts';
import { SELF_IMPROVE_UNAVAILABLE } from '../devcopy.js';
import { isExplicitCorrection } from '../corrections.ts';
import { computerTools } from '../computer.js';
import { appTools } from './apps.js';
import { recipeTools } from '../recipes.js';
import { executorTools } from '../executor.js';
import { xdTools } from './xd.js';
import { fileTools } from './files.js';
import { copyConversation } from '../copytalk.js';


/** @param {any} d the dispatcher (lib/dispatcher.js) */
export function coreTools(d) {
  const tasks = d.tasks;
  const self = d.self;
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
          attach_screen: z.boolean().optional().describe('Give the worker what was on screen at your last look_at_screen (a redacted screenshot as a temporary file, and its text). For "fix the error on my screen".'),
        },
        async ({ project, instruction, title, allow_web, attach_screen }) => {
          const pick = pickProject(project);
          if (pick.error) return fail(pick.error);
          const shot = attach_screen ? d.screenForWorker() : null;
          if (shot?.error) return fail(shot.error);
          try {
            const t = tasks.create({ kind: 'code', project: pick.project.name, cwd: pick.project.path, instruction: shot ? `${instruction}\n\n${shot.note}` : instruction, title, web: allow_web });
            d.screen?.attachToTask(t.id, shot?.file);
            return text({ started: true, taskId: t.id, project: pick.project.name, ...(shot ? { screenAttached: true } : {}) });
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
        {
          task_id: z.number(),
          message: z.string(),
          attach_screen: z.boolean().optional().describe('Also give the worker what was on screen at your last look_at_screen'),
        },
        async ({ task_id, message, attach_screen }) => {
          const shot = attach_screen ? d.screenForWorker() : null;
          if (shot?.error) return fail(shot.error);
          try {
            const r = tasks.followUp(task_id, shot ? `${message}\n\n${shot.note}` : message);
            d.screen?.attachToTask(r.task.id, shot?.file);
            return text({ ok: true, taskId: r.task.id, delivered: r.delivered, ...(shot ? { screenAttached: true } : {}) });
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
            // A risky yes has to be clearly the user's: a faint or clipped one is asked about once more.
            if (approve && tasks.pendingApprovals().some((a) => a.taskId === task_id && a.level === 'risky') && !d.clearYes(`approval:${task_id}`)) return fail(TOO_QUIET);
            const r = tasks.resolveApproval(task_id, approve, opts);
            return text({ ok: true, approved: approve, grantedFromNowOn: r.granted });
          } catch (e) {
            return fail(e.message);
          }
        }
      ),
      tool(
        'grant_permission',
        'Only when the user explicitly asks to stop being asked: auto-approve read-only web requests (kind network_read), all requests to one website (kind site), or read-only access to Echo\'s own code, logs and settings (kind echo_read) for a task or the whole session. Risky actions (including any write to Echo or its port) stay gated regardless.',
        {
          kind: z.enum(['network_read', 'echo_read', 'site']),
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
      ...(flagOn('rules')
        ? [
            tool(
              'remember_rule',
              'Keep a rule the user gave about how they always want something done (lib/rules.js): followed every time, in every session, and shown in Settings. The same rule said again, or its opposite, replaces the old one.',
              { rule: z.string().describe('The rule in their words, e.g. "Never save the file unless I ask"'), app: z.string().optional().describe('Only in this app, e.g. "Adobe XD"'), said: z.string().optional().describe('What they said, word for word') },
              async ({ rule, app, said }) => {
                const { rule: r, replaced } = addRule(rule, { app, said });
                return text(replaced ? `Kept, replacing "${replaced.text}": ${r.text}` : `Kept: ${r.text}${r.app ? ` (in ${r.app})` : ''}`);
              },
            ),
            tool('forget_rule', 'Drop a rule the user takes back, by its words.', { rule: z.string().describe('The rule, roughly in its words') }, async ({ rule }) => {
              const gone = removeRule(rule);
              return gone ? text(`Dropped: ${gone.text}`) : fail(`No rule like "${rule}".`);
            }),
          ]
        : []),
      tool('show_sky', 'Open the Sky in the Echo window: every day the user has talked with Echo drawn as a constellation (a star for each thing they said), which can be played as a tune. For "show me my sky", "show me my day", "play today", "play my day". play: true also plays today.', { play: z.boolean().optional() }, async ({ play }) => {
        d.emit('show_sky', play === true);
        return text(play ? "The Sky is open and today is playing. Say one short line at most; the tune is the answer." : 'The Sky is open on today. They can click a day\'s name to hear it, a star to ring it, and drag to walk back through their days.');
      }),
      tool('demo', 'The short show Echo gives when the user asks it to show someone what it can do ("show him what you can do", "give her a demo", "show off"). Returns four steps to do in order, now. Never answer such a request with a list of features.', { guest: z.string().optional().describe("The guest's first name, if known") }, async ({ guest }) => {
        const who = String(guest || '').replace(/[^\p{L} '-]/gu, '').trim().slice(0, 30);
        return text([
          'Do these four things in order, each with ONE short spoken sentence, and nothing else in between. No list of features, no "I can also". If a step fails, say so in three words and go on.',
          `1. SEE. look_at_screen, then point_at one thing that is on screen right now and say what it is${who ? `, speaking to ${who}` : ''} ("I can see the screen: that's the …").`,
          `2. MAKE. write_file a small, good-looking web page on the Desktop called hello${who ? `-${who.toLowerCase().split(' ')[0]}` : ''}.html that greets ${who || 'the guest'} by name and shows today's date, and open it ("And I can make things: a page for you.").`,
          '3. DO. One real action in the app that is in front (scroll that page, or switch the page to dark with one more write_file), saying what you are doing as you do it.',
          '4. THE SKY. show_sky with play true, and say only: "And every day we talk becomes a constellation. This is today."',
          `Then stop, and end with: "${who ? `${who}, w` : 'W'}hat should I do next?"`,
        ].join('\n'));
      }),
      tool('pin_note', 'Keep one short line on the user\'s screen as a small note they can drag and close (it stays across restarts; at most five). For "pin that", "keep that on screen", "leave that number up". The line itself, not a sentence about it: "Renewal date: 3 March".', { text: z.string().describe('The line to keep, at most about 20 words') }, async ({ text: line }) => {
        const t = String(line || '').replace(/\s+/g, ' ').trim().slice(0, 160);
        if (!t) return fail('Say what to pin.');
        d.emit('pin_note', t);
        return text('Pinned on their screen. Say so in a few words.');
      }),
      tool('copy_conversation', 'Copy this conversation (what the user and Echo have said this session) to the Mac\'s clipboard as plain text, for pasting somewhere else. For "copy this conversation", "copy the session we just had", "copy what we talked about". minutes: only the last so many minutes.', { minutes: z.number().min(1).max(600).optional() }, async ({ minutes }) => {
        const r = await copyConversation({ minutes });
        if (r.ok) return text(`Copied ${r.lines} lines to the clipboard. Say so in a few words; they can paste it anywhere.`);
        return fail(r.why === 'nothing_kept' ? 'There is nothing to copy: the conversation log is off (Settings, You & privacy, "Keep a conversation log") or nothing has been said yet.' : 'The clipboard did not take it.');
      }),
      tool('keep_watch', 'Keep an eye on a window for the user: Echo checks its text by itself every few seconds (read-only, no picture, the app need not be in front) and you are told when it finishes, fails, stops changing, or its time is up. For a build or tests running in Terminal, a download, an install, another assistant writing its reply. Up to three at once.', {
        what: z.string().describe('What is being watched, in a few words: "the Echo rebuild", "Claude\'s reply"'),
        app: z.string().describe('The app it is in: "Terminal", "Claude", "Google Chrome"'),
        done_text: z.array(z.string()).max(8).optional().describe('Words that will appear when it has finished: "tests passed", "Build succeeded", "Done in"'),
        fail_text: z.array(z.string()).max(8).optional().describe('Words that will appear if it failed: "error", "FAILED", "not ok"'),
        when_it_stops_changing: z.boolean().optional().describe('Also end when the window stops changing for a while (a reply being written has ended; a job has gone quiet). On by itself when no done_text is given'),
        minutes: z.number().min(1).max(60).optional().describe('How long to watch at most (15 if not said)'),
      }, async ({ what, app, done_text, fail_text, when_it_stops_changing, minutes }) => {
        if (!d.screen) return fail('Watching needs the Echo Mac app.');
        const r = d.watcher.start({ what, app, until: done_text, fail: fail_text, quiet: when_it_stops_changing === true, minutes });
        if (r.error) return fail(r.error);
        return text(`Watching ${String(what || app)} in ${app}. Echo checks it by itself; you will get a [watch] event when it ends. Tell the user in a few words that you are keeping an eye on it, and go on with what they want next.`);
      }),
      tool('stop_watch', 'Stop keeping an eye on something (the one in that app, or all of them when nothing is named).', { which: z.string().optional().describe('The app or the thing; left out: all of them') }, async ({ which }) => {
        const n = d.watcher.stop(which || '');
        return text(n ? `Stopped watching ${n === 1 ? 'it' : `${n} things`}.` : 'Nothing was being watched.');
      }),
      tool('keep_thread', 'Keep track of what you and the user are in the middle of, so their next "next", "that one" or "send it" needs no fresh look at everything. Call it when you start going through a set of things together, each time you move to another one, and when you have written something for them that is not sent yet. Only what you give changes; new items start a new thread. It comes back to you with each of their messages.', {
        doing: z.string().optional().describe('What the two of you are doing, in a few words: "going through three Claude chats"'),
        items: z.array(z.string()).max(12).optional().describe('The things you are going through, in order, a few words each'),
        at: z.number().int().optional().describe('The one you are on now (1 is the first); 0 when between things. Moving on marks the one before as done'),
        done: z.array(z.number().int()).optional().describe('Others that are handled (1 is the first)'),
        draft: z.string().optional().describe('Words you wrote for them that are typed or ready but NOT sent; "" once sent or dropped'),
        where: z.string().optional().describe('The app or place it is in'),
        clear: z.boolean().optional().describe('True when the whole thing is finished or dropped'),
      }, async ({ doing, items, at, done, draft, where, clear }) => {
        if (clear) { d.thread.clear(); return text('Thread cleared.'); }
        const t = d.thread.keep({ ...(doing !== undefined ? { doing } : {}), ...(items ? { items } : {}), ...(where !== undefined ? { where } : {}), ...(draft !== undefined ? { draft } : {}), ...(done ? { done: done.map((n) => n - 1) } : {}), ...(at !== undefined ? { at: at - 1 } : {}) });
        const n = d.thread.next();
        return text(`Kept. ${t.items.length ? `${t.done.length} of ${t.items.length} done${t.at >= 0 ? `, on number ${t.at + 1}` : ''}${n >= 0 ? `, next is number ${n + 1}` : ', none left'}.` : ''}${t.draft ? ' A draft is waiting to be sent.' : ''}`.trim());
      }),
      tool('save_idea', "Note something the user wishes Echo could do and can't yet (a new ability, a mode, a fix), in their words, for the people who build Echo. Kept on this Mac (npm run ideas reads them). It builds nothing: never promise that it will be built or when.", { idea: z.string().describe('What they wished for, in a sentence or two'), said: z.string().optional().describe('Their own words, if short') }, async ({ idea, said }) => {
        const file = path.join(path.dirname(d.memoryFile), 'ideas.jsonl');
        fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), idea: String(idea).replace(/\s+/g, ' ').trim().slice(0, 600), ...(said ? { said: String(said).replace(/\s+/g, ' ').trim().slice(0, 300) } : {}) })}\n`, { mode: 0o600 });
        return text('Noted for the people who build Echo. Nothing was built.');
      }),
      tool('remember', 'Save a lasting fact about the user or their preferences to long-term memory.', { fact: z.string() }, async ({ fact }) => {
        fs.appendFileSync(d.memoryFile, `- ${fact.replace(/\n/g, ' ')}\n`);
        return text('Saved.');
      }),
      tool('recall', 'Look up older things you remember about the user by topic (a name, place, plan, preference). Returns the matching notes in full.', { topic: z.string().describe('A few words, e.g. "Mira birthday" or "coffee order"') }, async ({ topic }) => {
        let memory = '';
        try {
          memory = fs.readFileSync(d.memoryFile, 'utf8');
        } catch {}
        const found = recallMemory(memory, topic);
        return text(found.length ? found.map((f) => `- ${f}`).join('\n') : `Nothing saved about "${topic}".`);
      }),
      tool('hand_off', 'Only on a (quick turn) message: pass this turn to the main model before writing anything, when it needs reasoning, several steps, a worker, the screen, or you are unsure. Anything written before it is thrown away, never said.', {}, async () => text(await d.handOff())),
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
          // Installed and shipped copies never edit their own code (lib/devcopy.js).
          if (!self.available) return text(SELF_IMPROVE_UNAVAILABLE);
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
        'Remember that the speech recognizer hears `heard` when the user means `meant` (e.g. "hoe broken" -> "Hoboken"). From then on, when it is heard you get a note that it may be `meant` (nothing is replaced). Only when the user has just told you that you misheard ("I said X", "no, it\'s X", "it\'s called X"); never on your own guess (ask them instead).',
        { heard: z.string(), meant: z.string() },
        async ({ heard, meant }) => {
          try {
            // A rewrite of every future sentence is learned only from the user's own correction,
            // never from a guess: a guessed one once turned every "Silver Lake" into something else.
            if (!isExplicitCorrection(d.turn?.user || '')) {
              return fail('Not learned: the user has not said you misheard. Ask them what they said (spell it back) instead of guessing; learn it once they correct you.');
            }
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
      ...d.quickTools(),
      ...fileTools(d),
      ...appTools(d),
      ...d.screenTools(),
      ...computerTools(d.computer, { clearYes: (key) => d.clearYes(key) }),
      ...recipeTools(d.recipes),
      ...executorTools(d.executor),
      ...xdTools(d),
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
