// Running cost totals per day, split into the assistant you talk to and its workers.
// These are API-equivalent estimates from the Agent SDK. On a Claude plan (claude.ai login)
// they count toward your plan's usage limits rather than being billed in dollars.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { getSettings } from './settings.js';
import { readJson, writeJson } from './atomic.js';

const file = () => path.join(config.dataDir, 'costs.json');
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });

export function loadCosts() {
  const c = readJson(file(), null);
  return c && typeof c === 'object' && c.days ? c : { days: {} };
}

/**
 * @param {'assistant' | 'workers' | 'dispatcher'} kind 'dispatcher' is the assistant's own conversation
 *   (lib/dispatcher.js): it counts toward 'assistant' and is also tracked on its own for the cost guard.
 */
export function addCost(kind, usd, day = today()) {
  const c = loadCosts();
  c.days[day] ||= { assistant: 0, workers: 0 };
  const d = c.days[day];
  const add = (k) => (d[k] = Number(((d[k] || 0) + usd).toFixed(6)));
  if (kind === 'dispatcher') {
    add('dispatcher');
    add('assistant');
  } else add(kind);
  writeJson(file(), c);
  return costSummary(c);
}

export function costSummary(c = loadCosts()) {
  const d = { assistant: 0, workers: 0, dispatcher: 0, ...c.days[today()] };
  const all = Object.values(c.days).reduce((s, x) => s + x.assistant + x.workers, 0);
  return { today: { ...d, total: d.assistant + d.workers }, warnAt: dispatcherWarnUsd(), overWarn: dispatcherWarnUsd() > 0 && d.dispatcher >= dispatcherWarnUsd(), allTime: all, since: Object.keys(c.days).sort()[0] || today(), assistantTrackedSince: c.assistantTrackedSince || null };
}

/** The Settings threshold for the dispatcher's daily cost (0 = never warn). */
function dispatcherWarnUsd() {
  return Number(getSettings().dispatcherCostWarnUsd) || 0;
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
  writeJson(file(), c);
}
