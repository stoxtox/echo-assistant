#!/usr/bin/env node
// Golden tasks (Stage 5): every task in the eval suite (lib/evalsuite.js, on the simulated Mac)
// run three times; a task passes only when all three runs succeed (said done AND really done; for
// the stress tasks, which can't be done, said so instead of claiming it).
// Each run is kept in <data>/golden/results.jsonl, where the scorecard (npm run scorecard) reads
// its "golden tasks passing all 3 runs".
//
//   npm run golden                     run, print, keep the results (Echo's data folder)
//   npm run golden -- --runs 5         more runs per task
//   npm run golden -- --data DIR       keep them in another data folder
//   npm run golden -- --dry            run and print only
//   ECHO_FLAG_CRITIC=0 npm run golden  with a Labs switch off
//   --gate                             exit 1 unless every task passes every run (the release gate)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
// Echo's data folder, worked out here rather than from lib/config.js: config reads the folder once,
// when it's first imported, and the simulated runs below must get the throwaway one (importing it
// first made them write their settings into Echo's real settings.json).
const dataDir = path.resolve(opt('--data') || process.env.ECHO_DATA_DIR || path.join(import.meta.dirname, '..', 'data'));
const runs = Math.max(1, Math.min(10, Number(opt('--runs')) || 3));

// The simulated runs keep their own throwaway data (settings, logs).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-golden-'));
process.env.ECHO_DATA_DIR = tmp;
process.env.ECHO_LOG_DIR = path.join(tmp, 'logs');
const { saveSettings } = await import('../lib/settings.js');
const { runSuite, ALL_TASKS, SHEET_TASKS, STRESS_TASKS } = await import('../lib/evalsuite.js');
saveSettings({ computerUse: true, pointer: true, screenAware: true });
const logFile = path.join(tmp, 'computer-log.jsonl');
const driver = 'v2';
const tasks = [...ALL_TASKS, ...SHEET_TASKS, ...STRESS_TASKS];
// The stress tasks can't be done (a dead button, a signed-out page): they pass when Echo says so.
const honesty = new Set(STRESS_TASKS.map((t) => t.id));

const at = new Date().toISOString();
const rows = [];
for (let run = 1; run <= runs; run++) {
  const { results } = await runSuite(driver, { logFile, tasks });
  for (const r of results) {
    const pass = honesty.has(r.id) ? !r.falseSuccess : Boolean(r.success);
    rows.push({ at, task: r.id, group: r.group, run, pass, claimed: Boolean(r.claimed), falseSuccess: Boolean(r.falseSuccess), steps: r.steps, ms: Math.round(r.ms), driver, where: 'simulated', ...(honesty.has(r.id) ? { honesty: true } : {}) });
  }
}
fs.rmSync(tmp, { recursive: true, force: true });

const byTask = new Map();
for (const r of rows) byTask.set(r.task, [...(byTask.get(r.task) || []), r]);
const passAll = [...byTask.values()].filter((rs) => rs.every((r) => r.pass));
const lies = rows.filter((r) => r.falseSuccess).length;
console.log(`Golden tasks (simulated Mac, driver ${driver}): ${passAll.length} of ${byTask.size} pass all ${runs} runs (${Math.round((passAll.length / byTask.size) * 100)}%). Said "done" when it wasn't: ${lies} of ${rows.length} runs.`);
const failing = [...byTask.entries()].filter(([, rs]) => !rs.every((r) => r.pass));
for (const [task, rs] of failing) console.log(`  ${task}: ${rs.map((r) => (r.pass ? 'pass' : r.falseSuccess ? 'LIE' : 'fail')).join(' ')}`);
if (args.includes('--gate') && (passAll.length < byTask.size || lies > 0)) {
  console.error('Golden tasks: not every task passed every run, so the gate is closed.');
  process.exitCode = 1;
}
if (!args.includes('--dry')) {
  const file = path.join(dataDir, 'golden', 'results.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`Kept in ${file}`);
}
