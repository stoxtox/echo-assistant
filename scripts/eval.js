#!/usr/bin/env node
// The computer-use eval harness (lib/evalsuite.js): runs the 30-task suite on the simulated Mac
// with the Sept 28–29 driver ('legacy') and today's ('v0'), and prints task success, false
// success, steps and time against the report's targets. Nothing touches the real screen, and all
// data goes to a throwaway folder.
//
//   npm run eval              both drivers, a summary
//   npm run eval -- --json    the full results as JSON
//   npm run eval -- --tasks   every task's outcome
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-eval-'));
process.env.ECHO_DATA_DIR = tmp;
process.env.ECHO_LOG_DIR = path.join(tmp, 'logs');
const { saveSettings } = await import('../lib/settings.js');
const { runSuite, runAddressee, STRESS_TASKS, ALL_TASKS } = await import('../lib/evalsuite.js');
saveSettings({ computerUse: true, pointer: true, screenAware: true });

const logFile = path.join(tmp, 'computer-log.jsonl');
const legacy = await runSuite('legacy', { logFile });
const now = await runSuite('v0', { logFile });
// Phase 1: the 60-task suite, with the executor (refs, batching) and instant local commands.
const all = { legacy: await runSuite('legacy', { logFile, tasks: ALL_TASKS }), v0: await runSuite('v0', { logFile, tasks: ALL_TASKS }), v1: await runSuite('v1', { logFile, tasks: ALL_TASKS }) };
const stressLegacy = await runSuite('legacy', { logFile, tasks: STRESS_TASKS });
const stressNow = await runSuite('v0', { logFile, tasks: STRESS_TASKS });
// Phase 2: everything, plus the local UI grounder for apps with no labels.
const v2 = await runSuite('v2', { logFile, tasks: ALL_TASKS });
const stressV2 = await runSuite('v2', { logFile, tasks: STRESS_TASKS });
const addressee = runAddressee();
fs.rmSync(tmp, { recursive: true, force: true });

const args = process.argv.slice(2);
if (args.includes('--json')) {
  console.log(JSON.stringify({ phase0: { legacy, v0: now }, phase1: all, stress: { legacy: stressLegacy, v0: stressNow, v2: stressV2 }, phase2: v2, addressee }, null, 2));
  process.exit(0);
}
const pct = (x) => `${Math.round(x * 100)}%`;
const row = (m) => `${m.driver.padEnd(7)} success ${String(m.success).padStart(2)}/${m.tasks} (${pct(m.successRate).padStart(4)})  false success ${m.falseSuccess} (${pct(m.falseSuccessRate)} of "done")  honest failures ${m.honestFailure}  median ${m.medianSteps} steps, ${m.medianSeconds} s`;
console.log('Phase 0 suite (30 tasks)');
console.log(row(legacy.metrics));
console.log(row(now.metrics));
console.log('by group (v0):', Object.entries(now.metrics.byGroup).map(([g, v]) => `${g} ${v}`).join(', '));
console.log('Phase 0 targets: success ≥70%, false success <3%, median ≤6 steps, ≤40 s');
console.log('\nPhase 1 suite (60 tasks)');
for (const k of ['legacy', 'v0', 'v1']) console.log(`${row(all[k].metrics)}  instant commands ${all[k].metrics.commandSeconds} s`);
console.log('Phase 1 targets: success ≥85%, false success <1%, median ≤4 steps, ≤20 s, commands <0.8 s\n');
const stressRow = (m) => `stress ${m.driver.padEnd(7)} success ${m.success}/${m.tasks}  false success ${m.falseSuccess}  honest failures ${m.honestFailure}`;
console.log(stressRow(stressLegacy.metrics));
console.log(stressRow(stressNow.metrics));
console.log(stressRow(stressV2.metrics));
console.log(`\nPhase 2 (v2, 60 tasks): ${row(v2.metrics)}`);
console.log('Phase 2 targets: success ≥90%, median ≤15 s, first visible feedback <0.3 s (the heard cue: see PROGRESS.md)');
const ad = (k, m) => `addressee ${k.padEnd(7)} dropped real ${pct(m.falseReject)} (asked ${m.asked})  accepted noise ${pct(m.falseAccept)} (asked ${m.askedNoise})  of ${m.n}`;
console.log(ad('legacy', addressee.legacy));
console.log(ad('v0', addressee.v0));
if (args.includes('--tasks')) {
  for (let i = 0; i < now.results.length; i++) {
    const a = legacy.results[i], b = now.results[i];
    const tag = (r) => (r.success ? 'ok  ' : r.falseSuccess ? 'LIE ' : 'fail');
    console.log(`${b.id.padEnd(24)} legacy ${tag(a)}  v0 ${tag(b)}  (${b.steps} steps, ${(b.ms / 1000).toFixed(1)} s)`);
  }
}
