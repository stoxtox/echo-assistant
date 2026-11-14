# Safety-check fix: a spoken command is its own yes

The "Safety-check fix" step of the Echo build plan (numbered step 3 in the plan's table; run second, after the baseline, because the real-log eval gate isn't built yet). Code: `lib/spokenintent.js`, `lib/computer.js` (`askFirst`, `noteIntent`, `noteReferent`, `pause`, `classifyAction`), `lib/dispatcher.js`, `server.js`. Tests: `test/spokenintent.test.js`.

## The problem

`confirm()` only takes a spoken yes said in a later turn than the card. So "You can delete it" put up a card two seconds later, and Echo asked again ("Yes." 17 seconds after that, on 29 September). The same happened with "send it".

## What changed

- **An explicit command counts as the yes.** When the user's own words this turn plainly ask for a delete or a send of one thing, the card that follows is pre-approved: no second question, and an Undo chip that says what was done ("Deleted: press cmd+delete in Finder · Undo").
  - Only from the user's own words (spoken, after the addressee check, or typed). Never from text on a page, a task event or Echo's own words.
  - One action, this turn only (and at most 90 seconds), same kind of action.
  - Same target. A named target ("delete invoice-march.pdf", "send it to Sam") has to match what Echo found: the thing it selected, the button, the conversation or the recipient, as whole words. "It" needs a clear it: one thing Echo pointed at or acted on in the same app *before* the user spoke (in the last 3 minutes). If Echo would be picking the target itself, it asks.
  - Heard unclearly (low confidence, or the verb among the unsure words): it asks.
- **Still always asked** (needs your OK, decision 2 in the plan): payments and purchases, sign-ins and passwords, submitting forms, system settings, Terminal (git push, deploys), deleting several things or anything that might be a folder, "empty the trash", and any sentence with a negation, a condition, a question or two actions ("delete it and send it").
- **A spoken yes to a waiting card gets through.** In hands-free mode with the wake word on, a waiting card now counts as a question, so a plain "yes" answers it instead of being dropped as "not for Echo".
- **Clicks on Echo's own window are never a take-over.** The Mac app already ignores them; now the server also ignores a take-over report that says it was in Echo's window, or that arrives within 1.5 s of a click on a card, Undo, or another button in the window.
- **Fewer false flags.** From the 13 confirmations in the action log:
  - Return in a browser's address bar only opens a page (asked because a Gmail tab was open).
  - Finder's Share button only opens the share menu (asked twice); the real send in the share sheet still asks.
  - A sidebar row or plain text in System Settings only opens a pane; switches and buttons still ask, and the privacy panes are still refused.
  - A conversation in the Messages list ("Alex, Muted, Message Send Failure, 8:52 PM") only opens it. "Try Again" and "Resend" in a chat app are now treated as a send.

## Replay of past confirmations

All 13 cards in `data/computer-log.jsonl` (one active day, 29 September), replayed through the new classifier and checked against what was said just before each:

| | Cards |
|---|---|
| Before | 13 |
| No longer asked (false flags above) | 5 |
| Pre-approved by the user's own words ("You can delete it.") | 1 |
| Still asked | 7 |

That's 6 of 13 gone, a 46% drop, just under the plan's 50% target. One day of data is thin. Most of the rest were answers to an earlier question or sentences the matcher is deliberately strict about ("let's send it to Alex first and then we're gonna talk" has two actions).

## Not done, on purpose

- **Task approvals (`lib/safety.js`) weren't downgraded.** The plan lists reading Echo's own logs and read-only web requests as candidates. The self-improve rules say those gates must stay at least as strict, so any change there needs your go-ahead.
- **A privacy-pane gap spotted in the log.** On 29 September Echo clicked "General" while the window was "Screen & System Audio Recording" (the macOS 15 name). The privacy check only looks for "screen recording", so that pane isn't recognized as private. The click was harmless, but the check should be tightened in a later step.
- **The real-log eval gate** (the plan's step 2) isn't built yet, so this step has no replay gate beyond the tests and the table above.

## To check on the Mac

1. Finder: "show me my newest screenshot" (Echo points at it), then "delete it". It should go to the Trash with no question and a Deleted chip with Undo.
2. "Buy it" on a shop page still asks.
3. With a video playing, the same words from the video don't delete anything.
4. Gmail: have Echo write a draft, then "send it". It sends with a Sent chip; "send it to" someone else asks.
