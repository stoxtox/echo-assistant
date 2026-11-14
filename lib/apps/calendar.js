// Calendar through its own scripting: what is on today, or between two days. Adding an event is
// lib/quick.js addCalendarEvent (the add_calendar_event tool). The pattern and the rules are in
// ./osa.js. What an event says goes to the assistant only.
import { COMMON, callScript, dateArgs, localDate, fail } from './osa.js';

export const CALENDAR = 'Calendar';
/** How many events one reading gives, and the longest stretch of days it covers. */
export const EVENTS_MAX = 40;
export const RANGE_DAYS = 62;

// argv: from (year month day seconds), to (the same), max.
// Every event that touches the stretch: it starts before the end and ends after the start.
export const CALENDAR_SCRIPT = String.raw`${COMMON}
on run argv
	set |TB| to character id 9
	if application "Calendar" is not running then return "ERR" & |TB| & "not_running"
	try
		with timeout of 5 seconds
			set |fromDate| to my makeDate(item 1 of argv, item 2 of argv, item 3 of argv, item 4 of argv)
			set |toDate| to my makeDate(item 5 of argv, item 6 of argv, item 7 of argv, item 8 of argv)
			set |maxCount| to (item 9 of argv) as integer
			tell application "Calendar"
				set |outLines| to {"OK"}
				set |total| to 0
				repeat with |calRef| in (every calendar)
					set |curCal| to contents of |calRef|
					set |calName| to name of |curCal|
					set |hits| to (every event of |curCal| whose (start date < |toDate|) and (end date > |fromDate|))
					repeat with |evRef| in |hits|
						set |total| to |total| + 1
						if |total| ≤ |maxCount| then
							set |curEvent| to contents of |evRef|
							set |dayText| to "0"
							if allday event of |curEvent| then set |dayText| to "1"
							set end of |outLines| to "ev" & |TB| & my escText(summary of |curEvent|) & |TB| & my isoOf(start date of |curEvent|) & |TB| & my isoOf(end date of |curEvent|) & |TB| & |dayText| & |TB| & my escText(location of |curEvent|) & |TB| & my escText(|calName|)
						end if
					end repeat
				end repeat
				set end of |outLines| to "count" & |TB| & |total|
				return my joinLines(|outLines|)
			end tell
		end timeout
	on error |errText| number |errNum|
		return "ERR" & |TB| & "script" & |TB| & |errNum| & |TB| & my escText(|errText|)
	end try
end run
`;

const DAY_MS = 24 * 3600 * 1000;

export class Calendar {
  /** @param {{ run: (script: string, args: string[], opts?: { timeoutMs?: number }) => Promise<string>, timeoutMs?: number, now?: () => number }} opts */
  constructor({ run, timeoutMs, now = Date.now }) {
    this.run = run;
    this.timeoutMs = timeoutMs;
    this.now = now;
  }

  /**
   * The events of today, of one day (`from`), or of every day from `from` to `to` (both included),
   * soonest first.
   */
  async events(args = {}) {
    const today = new Date(this.now());
    today.setHours(0, 0, 0, 0);
    const from = args.from ? localDate(args.from) : today;
    const last = args.to ? localDate(args.to) : from;
    if (!from || !last) return fail('bad_date', `Couldn't read the date "${String((from ? args.to : args.from) ?? '').slice(0, 40)}". Use a local date like 2026-10-03.`);
    from.setHours(0, 0, 0, 0);
    // The end is the midnight after the last day (by the calendar, so a day the clocks change is still whole).
    const to = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
    if (to <= from) return fail('bad_date', 'The last day is before the first.');
    if (to.getTime() - from.getTime() > RANGE_DAYS * DAY_MS) return fail('too_big', `That is more than ${RANGE_DAYS} days. Ask for a shorter stretch.`);
    const a = await callScript(this.run, CALENDAR, CALENDAR_SCRIPT, [...dateArgs(from), ...dateArgs(to), String(EVENTS_MAX)], { ...(this.timeoutMs ? { timeoutMs: this.timeoutMs } : {}) });
    if (a.error) return a;
    const events = a.rows.filter((f) => f[0] === 'ev')
      .map((f) => ({ title: f[1] || '', start: (f[2] || '').slice(0, 16), end: (f[3] || '').slice(0, 16), ...(f[4] === '1' ? { all_day: true } : {}), ...(f[5] ? { location: f[5] } : {}), calendar: f[6] || '' }))
      .sort((x, y) => x.start.localeCompare(y.start));
    const total = Number(a.rows.find((f) => f[0] === 'count')?.[1]) || events.length;
    const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return {
      from: day(from), to: day(last), events,
      // Calendar's scripting answers with an event's first day only, so a weekly meeting that began earlier isn't here.
      note: `${total > events.length ? `Only ${events.length} of ${total} are here. ` : ''}Repeating events that began before ${day(from)} may be missing: say "that I can see" rather than "nothing else".`,
      count: events.length,
    };
  }
}
