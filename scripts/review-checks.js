// Runs the same checks a self-improvement review runs, the same way: `npm run review-checks`.
import { runChecks } from '../lib/selfimprove.js';

const checks = await runChecks(process.cwd());
for (const [name, { ok, output }] of Object.entries(checks)) {
  if (!ok) console.log(`\n--- ${name} ---\n${output}`);
}
console.log(Object.entries(checks).map(([name, { ok }]) => `${name} ${ok ? 'passed' : 'FAILED'}`).join(', '));
process.exit(Object.values(checks).every((c) => c.ok) ? 0 : 1);
