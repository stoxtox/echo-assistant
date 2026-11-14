// Mail through its own scripting: who the unread mail is from, one message's text, and a draft
// the user can look over. Nothing here ever puts a message on its way: a draft opens in Mail and
// stays a draft (the compose and confirm path owns that step). The pattern and the rules are in
// ./osa.js. What a message says goes to the assistant only.
import { COMMON, callScript, fail } from './osa.js';

export const MAIL = 'Mail';
/** How many unread messages one listing gives, and how much of one message a read gives (characters). */
export const UNREAD_MAX = 15;
export const READ_CHARS = 6000;
export const DRAFT_CHARS = 20000;

// argv: what to do, then
//   unread  max
//   read    the message's id (from unread)  maxChars
//   draft   subject  text  then each address it is for
// Only the inbox (every account's). A draft is made as a window the user can see, with Mail
// brought to the front; the script has no other way out for a message.
export const MAIL_SCRIPT = String.raw`${COMMON}
on run argv
	set |theOp| to item 1 of argv
	set |TB| to character id 9
	if application "Mail" is not running then return "ERR" & |TB| & "not_running"
	try
		with timeout of 5 seconds
			tell application "Mail"
				set |outLines| to {"OK"}
				set |shown| to {}
				if |theOp| is "unread" then
					set |maxCount| to (item 2 of argv) as integer
					set |hits| to (every message of inbox whose read status is false)
					set |hitCount| to count of |hits|
					set end of |outLines| to "count" & |TB| & |hitCount|
					if |hitCount| > |maxCount| then set |hitCount| to |maxCount|
					repeat with |i| from 1 to |hitCount|
						set end of |shown| to item |i| of |hits|
					end repeat
				else if |theOp| is "read" then
					set |wantedId| to (item 2 of argv) as integer
					set |theMsg| to first message of inbox whose id is |wantedId|
					set |wholeText| to (content of |theMsg|) as text
					set end of |outLines| to "size" & |TB| & (count of |wholeText|)
					set end of |outLines| to "text" & |TB| & my escText(my clipText(|wholeText|, (item 3 of argv) as integer))
					set |shown| to {|theMsg|}
				else if |theOp| is "draft" then
					set |newMsg| to make new outgoing message with properties {subject:item 2 of argv, content:item 3 of argv, visible:true}
					set |toCount| to 0
					repeat with |i| from 4 to (count of argv)
						tell |newMsg| to make new to recipient at end of to recipients with properties {address:item |i| of argv}
						set |toCount| to |toCount| + 1
					end repeat
					activate
					set end of |outLines| to "draft" & |TB| & |toCount|
				end if
				repeat with |oneRef| in |shown|
					set |oneMsg| to contents of |oneRef|
					set end of |outLines| to "msg" & |TB| & ((id of |oneMsg|) as text) & |TB| & my escText(subject of |oneMsg|) & |TB| & my escText(sender of |oneMsg|) & |TB| & my isoOf(date received of |oneMsg|)
				end repeat
				return my joinLines(|outLines|)
			end tell
		end timeout
	on error |errText| number |errNum|
		return "ERR" & |TB| & "script" & |TB| & |errNum| & |TB| & my escText(|errText|)
	end try
end run
`;

const MESSAGES = {
  not_found: 'That message is not in the inbox any more (it may have been moved or deleted). List the unread mail again with mail_unread.',
};

const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
const msgOf = (f) => ({ id: Number(f[1]) || 0, subject: f[2] || '', from: f[3] || '', ...(f[4] ? { received: f[4].slice(0, 16) } : {}) });

export class Mail {
  /**
   * @param {{ run: (script: string, args: string[], opts?: { timeoutMs?: number }) => Promise<string>, timeoutMs?: number,
   *   resolve?: ((to: string) => { name: string, handle: string }) | null }} opts
   *   resolve: a contact id or a saved favorite as its real address (QuickActions.resolveRecipient);
   *   the assistant itself only ever sees addresses masked
   */
  constructor({ run, timeoutMs, resolve = null }) {
    this.run = run;
    this.timeoutMs = timeoutMs;
    this.resolve = resolve;
  }

  call(args) {
    return callScript(this.run, MAIL, MAIL_SCRIPT, args, { messages: MESSAGES, ...(this.timeoutMs ? { timeoutMs: this.timeoutMs } : {}) });
  }

  /** The unread mail in the inbox: who each is from and its subject. Never what it says. */
  async unread() {
    const a = await this.call(['unread', String(UNREAD_MAX)]);
    if (a.error) return a;
    const messages = a.rows.filter((f) => f[0] === 'msg').map(msgOf);
    const unread = Number(a.rows.find((f) => f[0] === 'count')?.[1]) || messages.length;
    return { unread, messages, count: messages.length };
  }

  /** One message's text, by the id mail_unread gave. Reading it here does not mark it read. */
  async read(args = {}) {
    const id = Number(args.id);
    if (!Number.isSafeInteger(id) || id <= 0) return fail('not_found', MESSAGES.not_found);
    const a = await this.call(['read', String(id), String(READ_CHARS)]);
    if (a.error) return a;
    const text = a.rows.find((f) => f[0] === 'text')?.[1] || '';
    const size = Number(a.rows.find((f) => f[0] === 'size')?.[1]) || text.length;
    return { ...msgOf(a.rows.find((f) => f[0] === 'msg') || []), text, ...(size > text.length ? { note: `Only the first ${text.length} of ${size} characters are here.` } : {}), count: 1 };
  }

  /** A draft, open in Mail for the user to look over. It stays a draft. */
  async draft(args = {}) {
    const subject = String(args.subject ?? '').trim().slice(0, 500);
    const text = String(args.text ?? '');
    if (!subject && !text.trim()) return fail('bad_draft', 'Give the draft a subject or some text.');
    if (text.length > DRAFT_CHARS) return fail('too_big', `That is ${text.length} characters; a draft from here holds at most ${DRAFT_CHARS}.`);
    const to = [];
    for (const one of Array.isArray(args.to) ? args.to : args.to ? [args.to] : []) {
      let address = String(one).trim();
      if (!EMAIL.test(address)) {
        try {
          address = String(this.resolve?.(address)?.handle || '');
        } catch {
          address = '';
        }
      }
      if (!EMAIL.test(address)) return fail('bad_recipient', 'One of the people it is for has no email address Echo knows. Use a contact id from find_contact that has an email, or the address as the user said it.');
      to.push(address);
    }
    const a = await this.call(['draft', subject, text, ...to]);
    if (a.error) return a;
    return { done: true, drafted: true, to: to.length, note: 'The draft is open in Mail and has NOT gone out. Say so; the user looks it over there.', count: 1 };
  }
}
