// Running cost totals per day, split into the assistant you talk to and its workers.
// These are API-equivalent estimates from the Agent SDK. On a Claude plan (claude.ai login)
// they count toward your plan's usage limits rather than being billed in dollars.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const file = () => path.join(config.dataDir, 'costs.json');
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });

export function loadCosts() {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    return { days: {} };
  }
}

/** @param {'assistant' | 'workers'} kind */
export function addCost(kind, usd, day = today()) {
  const c = loadCosts();
  c.days[day] ||= { assistant: 0, workers: 0 };
  c.days[day][kind] = Number((c.days[day][kind] + usd).toFixed(6));
  fs.writeFileSync(file(), JSON.stringify(c, null, 2));
  return costSummary(c);
}

export function costSummary(c = loadCosts()) {
  const d = c.days[today()] || { assistant: 0, workers: 0 };
  const all = Object.values(c.days).reduce((s, x) => s + x.assistant + x.workers, 0);
  return { today: { ...d, total: d.assistant + d.workers }, allTime: all, since: Object.keys(c.days).sort()[0] || today(), assistantTrackedSince: c.assistantTrackedSince || null };
}

/** First run: count what earlier tasks already cost, by the day they ran. */
export function backfillWorkerCosts(tasks) {
  if (fs.existsSync(file())) return;
  const c = { days: {}, assistantTrackedSince: new Date().toISOString() };
  for (const t of tasks) {
    if (!t.costUsd) continue;
    const day = new Date(t.createdAt).toLocaleDateString('en-CA', { timeZone: config.timezone });
    c.days[day] ||= { assistant: 0, workers: 0 };
    c.days[day].workers += t.costUsd;
  }
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(c, null, 2));
}
