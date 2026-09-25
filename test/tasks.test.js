import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, fakeQuery, say, result, bg, until, wait } from './helpers.js';

const dirs = sandbox('tasks');
const { TaskManager } = await import('../lib/tasks.js');
const { APP_DIR } = await import('../lib/config.js');
const project = path.join(dirs.projects, 'Demo');
fs.mkdirSync(project, { recursive: true });

function manager(script) {
  const fq = fakeQuery(script);
  const tm = new TaskManager({ queryFn: fq.queryFn });
  const finished = [];
  tm.on('finished', (t) => finished.push({ id: t.id, status: t.status }));
  return { tm, fq, finished };
}

test('a normal task finishes once, with a short spoken summary', async () => {
  const { tm, finished } = manager(() => [say('Working'), result('## Done\nFixed the build. See /Users/me/Demo/src/app.ts and https://example.com/log for details.')]);
  const t = tm.create({ project: 'Demo', cwd: project, instruction: 'Fix the build' });
  await until(() => t.status === 'done', 3000, 'done');
  await wait(50);
  assert.deepEqual(finished, [{ id: t.id, status: 'done' }]);
  assert.ok(!/https?:|\/Users/.test(t.summary), t.summary);
  assert.match(t.result, /https:\/\/example.com/, 'full result is kept for get_task');
});

test('the worker is told the current date and time', async () => {
  const { tm, fq } = manager(() => [result('ok')]);
  const t = tm.create({ project: 'Demo', cwd: project, instruction: 'Find showtimes' });
  await until(() => t.status === 'done');
  assert.match(fq.calls[0].prompts[0], /^Current date and time: \w+day, /);
});

test('a worker that ends while background agents run is not reported done', async () => {
  let release;
  const agentsDone = new Promise((r) => (release = r));
  const { tm, fq, finished } = manager(async (turn) => {
    if (turn === 0) {
      setTimeout(() => release(), 100);
      return [bg([{ task_id: 'a1', task_type: 'local_agent', description: 'search jobs' }]), result('Three agents are running in the background. I\'ll wait for them.')];
    }
    return [result('Saved 24 jobs to jobs.md.')];
  });
  const t = tm.create({ project: 'Demo', cwd: project, instruction: 'Search jobs' });
  await wait(60);
  assert.equal(t.status, 'running', 'must not be done while agents run');
  assert.equal(finished.length, 0);
  // The agents finish: the SDK reports an empty background list.
  await agentsDone;
  const live = tm.live.get(t.id);
  tm.onMessage(t, live, bg([]));
  await until(() => t.status === 'done', 3000, 'done after agents');
  assert.match(fq.calls[0].prompts[1], /background agents have finished/);
  assert.equal(t.summary, 'Saved 24 jobs to jobs.md.');
  assert.equal(finished.length, 1);
});

test('"I\'ll wait for results" without real output triggers an auto-continue', async () => {
  const { tm, fq } = manager((turn) => [result(turn === 0 ? 'The searches are running in the background.' : 'All done, saved the list.')]);
  const t = tm.create({ project: 'Demo', cwd: project, instruction: 'x' });
  await until(() => t.status === 'done');
  assert.equal(fq.calls[0].prompts.length, 2);
  assert.equal(t.autoContinues, 1);
});

test('research tasks must save a file before they count as done', async () => {
  const out = path.join(dirs.research, 'movies');
  fs.mkdirSync(out, { recursive: true });
  const { tm, fq } = manager((turn) => {
    if (turn === 1) fs.writeFileSync(path.join(out, 'amc.md'), '# AMC');
    return [result(turn === 0 ? 'Found some movies.' : 'Saved the movie list.')];
  });
  const t = tm.create({ kind: 'research', project: 'Research: movies', cwd: out, outputDir: out, instruction: 'AMC movies' });
  await until(() => t.status === 'done');
  assert.match(fq.calls[0].prompts[1], /without saving anything/);
  assert.deepEqual(tm.outputFiles(t).map((f) => f.file), ['amc.md']);
  assert.deepEqual(fq.calls[0].options.allowedTools, ['WebSearch', 'WebFetch'], 'research gets web access');
});

test('agents are forced into the foreground', async () => {
  let hookOut;
  const { tm } = manager(async (turn, text, options) => {
    const hook = options.hooks.PreToolUse.find((m) => m.matcher.includes('Agent')).hooks[0];
    hookOut = await hook({ tool_name: 'Agent', tool_input: { prompt: 'x', run_in_background: true } }, 'id', { signal: new AbortController().signal });
    return [result('ok')];
  });
  const t = tm.create({ project: 'Demo', cwd: project, instruction: 'x' });
  await until(() => t.status === 'done');
  assert.equal(hookOut.hookSpecificOutput.updatedInput.run_in_background, false);
});

test('stop returns only once the task is really stopped', async () => {
  const { tm, finished } = manager(() => new Promise(() => {})); // never finishes on its own
  const t = tm.create({ project: 'Demo', cwd: project, instruction: 'long job' });
  await until(() => t.status === 'running');
  const stopped = await tm.stop(t.id);
  assert.equal(stopped.status, 'stopped');
  assert.equal(tm.isLive(t.id), false);
  assert.equal(finished.length, 0, 'a stop you asked for is not announced as finished');
});

test('follow-ups are delivered to a running task instead of failing', async () => {
  let unblock;
  const gate = new Promise((r) => (unblock = r));
  const { tm, fq } = manager(async (turn) => {
    if (turn === 0) {
      await gate;
      return [result('first part done')];
    }
    return [result('added the extra step too')];
  });
  const t = tm.create({ project: 'Demo', cwd: project, instruction: 'part one' });
  await until(() => t.status === 'running');
  const r = tm.followUp(t.id, 'also do part two');
  assert.equal(r.delivered, 'mid-run');
  unblock();
  await until(() => t.status === 'done');
  assert.equal(fq.calls.length, 1, 'same session');
  assert.deepEqual(fq.calls[0].prompts.slice(1), ['also do part two']);
  assert.equal(t.summary, 'added the extra step too', 'done only after the follow-up was handled');
});

test('follow-up on a finished task resumes its session', async () => {
  const { tm, fq } = manager(() => [result('ok')]);
  const t = tm.create({ project: 'Demo', cwd: project, instruction: 'x' });
  await until(() => t.status === 'done');
  const r = tm.followUp(t.id, 'one more thing');
  assert.equal(r.delivered, 'resumed');
  await until(() => t.status === 'done' && fq.calls.length === 2);
  assert.equal(fq.calls[1].options.resume, 'session-1');
});

test('approvals: risky commands wait for you; "approve all like this" stops repeat prompts', async () => {
  const WORKDAY = `curl -s -X POST 'https://x.wd1.myworkdayjobs.com/wday/cxs/x/Careers/jobs' -d '{}'`;
  const decisions = [];
  const { tm } = manager(async (turn, text, options) => {
    const gate = options.hooks.PreToolUse.find((m) => m.matcher === 'Bash').hooks[0];
    for (const command of [WORKDAY, WORKDAY.replace('limit', 'offset'), 'git push']) {
      const out = await gate({ tool_name: 'Bash', tool_input: { command } }, 'id', { signal: new AbortController().signal });
      decisions.push(out.hookSpecificOutput?.permissionDecision || 'no prompt');
    }
    return [result('ok')];
  });
  const approvals = [];
  tm.on('approval', (t) => approvals.push(t.pendingApproval));
  const t = tm.create({ kind: 'research', project: 'jobs', cwd: project, outputDir: project, instruction: 'jobs' });
  await until(() => approvals.length === 1);
  assert.equal(approvals[0].level, 'network_read');
  tm.resolveApproval(t.id, true, { similar: true });
  await until(() => approvals.length === 2);
  assert.equal(approvals[1].level, 'risky', 'git push still asks');
  tm.resolveApproval(t.id, false);
  await until(() => decisions.length >= 3);
  assert.deepEqual(decisions.slice(0, 3), ['allow', 'no prompt', 'deny']);
  await tm.stop(t.id);
  assert.throws(() => tm.resolveApproval(t.id, true), /nothing waiting for approval/);
});

test('ordinary workers cannot read or edit Echo itself', async () => {
  let denied;
  const { tm } = manager(async (turn, text, options) => {
    const guard = options.hooks.PreToolUse.find((m) => m.matcher.includes('Edit')).hooks[0];
    denied = await guard({ tool_name: 'Edit', tool_input: { file_path: path.join(APP_DIR, 'lib', 'safety.js') } }, 'id', { signal: new AbortController().signal });
    return [result('ok')];
  });
  const t = tm.create({ project: 'Demo', cwd: project, instruction: 'x' });
  await until(() => t.status === 'done');
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
});

test('restart: running tasks are checkpointed and resumed afterwards', async () => {
  const { tm } = manager(() => new Promise(() => {}));
  const t = tm.create({ project: 'Demo', cwd: project, instruction: 'long job' });
  await until(() => t.status === 'running' && t.sessionId);
  const ids = await tm.checkpointAll();
  assert.deepEqual(ids, [t.id]);
  assert.equal(t.status, 'interrupted');

  // A fresh process loads the saved state and resumes the task in its old session.
  const next = manager(() => [result('picked up where I left off')]);
  const again = next.tm.get(t.id);
  assert.equal(again.resumeAfterRestart, true);
  assert.deepEqual(next.tm.resumeCheckpointed(), [t.id]);
  await until(() => again.status === 'done');
  const call = next.fq.calls.at(-1);
  assert.equal(call.options.resume, t.sessionId);
  assert.match(call.prompts[0], /restarted while you were working/);
});

test('a crash in the worker is reported as failed exactly once', async () => {
  const { tm, finished } = manager(() => {
    throw new Error('boom');
  });
  const t = tm.create({ project: 'Demo', cwd: project, instruction: 'x' });
  await until(() => t.status === 'failed');
  await wait(50);
  assert.equal(finished.filter((f) => f.id === t.id).length, 1);
  assert.match(t.summary, /boom/);
});
