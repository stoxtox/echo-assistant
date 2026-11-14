// Switches for parts of how Echo works (ECHO_CORE_PLAN.md, the core plan). A new
// behavior ships behind one; once it is how Echo works, the switch stays for a while, on, so it can
// be turned off in Settings → Labs if it misbehaves; and when it has proven itself the switch goes,
// with the old path (as `hints` and `verify` did in October). One registry, so a typo in a flag
// name fails the type check.
//
// Where a flag's value comes from, strongest first:
//   ECHO_FLAG_<NAME>=1|0 in the environment (tests, replay, a quick try)
//   settings.core.<name> in data/settings.json (POST /api/settings { core: { policy: false } })
//   the default below
import { getSettings } from './settings.js';

type FlagSpec = { readonly default: boolean; readonly label: string; readonly about: string };

export const FLAGS = {
  policy: { default: true, label: 'Ask by what an action does', about: 'Echo asks by what an action does, not by words in a label: undoable edits never ask; save, delete, close ask unless you said so; send, buy, submit, settings always ask.' },
  windowCrop: { default: true, label: 'Look at just the window you are in', about: "When Echo looks at the screen, it sees the window you're working in (with a small margin) instead of the whole display: a sharper picture of what matters, and a smaller one to send. It can still ask for the whole screen (the menu bar, the Dock)." },
  milestones: { default: true, label: 'Keep going while it gets somewhere', about: "Echo no longer stops after 25 steps on the Mac and asks \"keep going?\": it carries on while each step gets somewhere, says a line of progress every 20 steps, and stops when it's stuck (most recent steps did nothing, or the same thing keeps failing) or at a firm 120 steps or 20 minutes." },
  critic: { default: true, label: 'Check before saying done', about: "For a job on the Mac with several steps, Echo first says what done means, and before it tells you it's done, a separate check looks at the screen and judges each point (it never sees what Echo claimed). Echo says done only if it passes; otherwise it keeps working or tells you honestly what's left." },
  rules: { default: true, label: 'Rules you give Echo', about: "When you tell Echo how you always want something done (\"never save unless I ask\", \"keep the footer at the bottom in XD\"), it keeps it as a rule: followed every time, in every session, and listed in Settings → General, where you can remove any." },
  skills: { default: true, label: 'Skills Echo learns', about: "When a job in an app is checked done, Echo keeps how it did it; when a job like it has worked twice, that way becomes a skill it follows the next time instead of working it out again. Settings → General lists them, each with a Remove button. (Needs \"Check before saying done\" on.)" },
  catchUp: { default: true, label: 'Catch me up', about: "Ask \"what did I miss?\", \"catch me up\" or say \"I'm back\" and Echo tells you at once, without waiting on the model, what happened since you last talked: tasks that finished or didn't, what's waiting for your OK or still going, updates that came in, and a job on the Mac that's still open." },
  // Off: it needs an API key and changes what you are billed for.
  messages: { default: false, label: 'The Messages API for the conversation', about: 'The conversation talks to the Messages API directly, with Echo running its own tool loop (needs ANTHROPIC_API_KEY): faster first words and cheaper turns. Off: the Agent SDK with your Claude sign-in.' },
} as const satisfies Record<string, FlagSpec>;

export type FlagName = keyof typeof FLAGS;
export type FlagSource = 'env' | 'settings' | 'default';

const truthy = (v: string) => /^(1|true|on|yes)$/i.test(v.trim());
const falsy = (v: string) => /^(0|false|off|no)$/i.test(v.trim());

/** The environment variable for a flag: core.policy → ECHO_FLAG_POLICY. */
export const envName = (name: FlagName): string => `ECHO_FLAG_${name.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`;

type Sources = { settings?: { core?: unknown }; env?: NodeJS.ProcessEnv };

/** A flag's value and where it came from. */
export function flagState(name: FlagName, { settings = getSettings(), env = process.env }: Sources = {}): { on: boolean; source: FlagSource } {
  const raw = env[envName(name)];
  if (raw !== undefined && (truthy(raw) || falsy(raw))) return { on: truthy(raw), source: 'env' };
  const core = settings.core;
  if (core && typeof core === 'object' && typeof (core as Record<string, unknown>)[name] === 'boolean') {
    return { on: (core as Record<string, boolean>)[name] === true, source: 'settings' };
  }
  return { on: FLAGS[name].default, source: 'default' };
}

/** Is this flag on? */
export const flagOn = (name: FlagName, sources: Sources = {}): boolean => flagState(name, sources).on;

/** Every flag with its value, source and description (for Settings and the scorecard). */
export function allFlags(sources: Sources = {}) {
  return (Object.keys(FLAGS) as FlagName[]).map((name) => ({ name, ...flagState(name, sources), label: FLAGS[name].label, about: FLAGS[name].about, envName: envName(name) }));
}
