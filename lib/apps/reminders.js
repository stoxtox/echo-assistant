// Reminders through its own scripting: what is still to do, add one, tick one off.
// The pattern and the rules are in ./osa.js.
import { COMMON, callScript, dateArgs, localDate, fail } from './osa.js';

export const REMINDERS = 'Reminders';
/** How many reminders one listing gives. */
export const LIST_MAX = 30;

// argv: what to do, then
//   list      list name ("" for every list)  max
//   add       title  list name ("" for the usual one)  due ("0" none, "1" a time, "2" a whole day)
//             year  month  day  seconds  notes
//   complete  id or exact title
// A listing asks each list for its open reminders' ids, names and dates in three questions, not
// one reminder at a time (Reminders answers slowly).
export const REMINDERS_SCRIPT = String.raw`${COMMON}
on run argv
	set |theOp| to item 1 of argv
	set |TB| to character id 9
	if application "Reminders" is not running then return "ERR" & |TB| & "not_running"
	try
		with timeout of 5 seconds
			tell application "Reminders"
				set |outLines| to {"OK"}
				if |theOp| is "list" then
					set |listName| to item 2 of argv
					set |maxCount| to (item 3 of argv) as integer
					if |listName| is "" then
						set |theLists| to every list
					else
						set |theLists| to {first list whose name is |listName|}
					end if
					set |total| to 0
					set |given| to 0
					repeat with |oneRef| in |theLists|
						set |curList| to contents of |oneRef|
						set |listTitle| to name of |curList|
						set |remIds| to id of (reminders of |curList| whose completed is false)
						set |total| to |total| + (count of |remIds|)
						if |given| < |maxCount| and (count of |remIds|) > 0 then
							set |remNames| to name of (reminders of |curList| whose completed is false)
							set |remDues| to due date of (reminders of |curList| whose completed is false)
							repeat with |i| from 1 to (count of |remIds|)
								if |given| ≥ |maxCount| or |i| > (count of |remNames|) or |i| > (count of |remDues|) then exit repeat
								set end of |outLines| to "rem" & |TB| & my escText(item |i| of |remIds|) & |TB| & my escText(item |i| of |remNames|) & |TB| & my isoOf(item |i| of |remDues|) & |TB| & my escText(|listTitle|)
								set |given| to |given| + 1
							end repeat
						end if
					end repeat
					set end of |outLines| to "count" & |TB| & |total|
				else
					if |theOp| is "add" then
						if item 3 of argv is "" then
							set |theList| to default list
						else
							set |theList| to first list whose name is (item 3 of argv)
						end if
						set |theRem| to make new reminder at end of reminders of |theList| with properties {name:item 2 of argv}
						if item 9 of argv is not "" then set body of |theRem| to item 9 of argv
						if item 4 of argv is "1" then set due date of |theRem| to my makeDate(item 5 of argv, item 6 of argv, item 7 of argv, item 8 of argv)
						if item 4 of argv is "2" then set allday due date of |theRem| to my makeDate(item 5 of argv, item 6 of argv, item 7 of argv, 0)
					else
						set |theRef| to item 2 of argv
						if |theRef| starts with "x-apple-reminder://" then
							set |theRem| to reminder id |theRef|
						else
							set |theRem| to first reminder whose name is |theRef| and completed is false
						end if
						set completed of |theRem| to true
					end if
					set |doneText| to "0"
					if completed of |theRem| then set |doneText| to "1"
					set end of |outLines| to "rem" & |TB| & my escText(id of |theRem|) & |TB| & my escText(name of |theRem|) & |TB| & my isoOf(due date of |theRem|) & |TB| & my escText(name of container of |theRem|) & |TB| & |doneText|
				end if
				return my joinLines(|outLines|)
			end tell
		end timeout
	on error |errText| number |errNum|
		return "ERR" & |TB| & "script" & |TB| & |errNum| & |TB| & my escText(|errText|)
	end try
end run
`;

const MESSAGES = {
  not_found: 'There is no reminder (or no list) by that name or id. List them first with reminders_list and use the id.',
};

const remOf = (f) => ({ id: f[1] || '', title: f[2] || '', ...(f[3] ? { due: f[3].slice(0, 16) } : {}), ...(f[4] ? { list: f[4] } : {}) });

export class Reminders {
  /** @param {{ run: (script: string, args: string[], opts?: { timeoutMs?: number }) => Promise<string>, timeoutMs?: number }} opts */
  constructor({ run, timeoutMs }) {
    this.run = run;
    this.timeoutMs = timeoutMs;
  }

  call(args) {
    return callScript(this.run, REMINDERS, REMINDERS_SCRIPT, args, { messages: MESSAGES, ...(this.timeoutMs ? { timeoutMs: this.timeoutMs } : {}) });
  }

  /** The reminders not yet done: in one list, or in all of them. */
  async list(args = {}) {
    const a = await this.call(['list', String(args.list ?? '').trim().slice(0, 200), String(LIST_MAX)]);
    if (a.error) return a;
    const reminders = a.rows.filter((f) => f[0] === 'rem').map(remOf);
    const open = Number(a.rows.find((f) => f[0] === 'count')?.[1]) || reminders.length;
    return { open, reminders, count: reminders.length };
  }

  /** A new reminder, with a day or a time when one was said. */
  async add(args = {}) {
    const title = String(args.title ?? '').trim().slice(0, 500);
    if (!title) return fail('bad_reminder', 'The reminder needs a title.');
    const due = args.due === undefined || args.due === '' ? null : localDate(args.due);
    if (args.due && !due) return fail('bad_date', `Couldn't read the date "${String(args.due).slice(0, 40)}". Use a local date like 2026-10-03, or a date and time like 2026-10-03T14:00.`);
    const kind = !due ? '0' : String(args.due).trim().length === 10 ? '2' : '1';
    const a = await this.call(['add', title, String(args.list ?? '').trim().slice(0, 200), kind, ...dateArgs(due || new Date(0)), String(args.notes ?? '').slice(0, 2000)]);
    if (a.error) return a;
    return { done: true, added: remOf(a.rows.find((f) => f[0] === 'rem') || []), count: 1 };
  }

  /** Tick one off, by the id reminders_list gave (or its exact title); read back. */
  async complete(args = {}) {
    const ref = String(args.reminder ?? '').trim();
    if (!ref) return fail('not_found', MESSAGES.not_found);
    const a = await this.call(['complete', ref]);
    if (a.error) return a;
    const f = a.rows.find((x) => x[0] === 'rem') || [];
    if (f[5] !== '1') return { done: false, ...remOf(f), note: 'NOT confirmed: Reminders still shows it as not done. Don\'t tell the user it is ticked off.', count: 0 };
    return { done: true, completed: remOf(f), count: 1 };
  }
}
