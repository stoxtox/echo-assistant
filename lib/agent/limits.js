// Computer use: how far a run may go and how long things wait (split out of lib/computer.js).

/** Actions a single run may take before Echo stops and hands back. */
export const MAX_STEPS = 25;
/** A run stops after this long, whatever it's doing. */
export const RUN_TIMEOUT_MS = 5 * 60 * 1000;
/** A confirmation card expires (and the action is dropped) after this long. */
export const CONFIRM_TTL_MS = 2 * 60 * 1000;
/** wait_for waits at most this long. */
export const MAX_WAIT_MS = 30 * 1000;
/** Each wait request to the app is at most this long (under the bridge's own time-out). */
export const WAIT_CHUNK_MS = 12 * 1000;

export const ACTIONS = ['click', 'type_text', 'press_keys', 'scroll', 'wait_for', 'hover', 'drag', 'clear_field'];

/** A driving session ends after this long with nothing said and nothing done. */
export const SESSION_IDLE_MS = 60 * 1000;
/** A driving session never lasts longer than this, however busy. */
export const SESSION_MAX_MS = 30 * 60 * 1000;
/** Before retrying a missed focus, wait this long. */
export const FOCUS_RETRY_MS = 350;
/** After Allow is clicked on a card, the focus is on Echo's window: a moment to settle before the target app is brought back and the step runs. */
export const CONFIRM_SETTLE_MS = 400;

/** How long a step's `expect` waits for what should appear. */
export const EXPECT_MS = 2500;

/** How long an undo chip stays up after a send or delete Echo did (Gmail's own Undo lasts about as long). */
export const UNDO_MS = 9000;

/** A click or key the Mac app reports this soon after one in Echo's own window (a card's Allow, Undo) isn't a take-over. */
export const ECHO_INPUT_GRACE_MS = 1500;

/**
 * A step allowed in Echo's window that the Mac app stops this soon after the Allow click, before it
 * did anything, is tried once more: the hand leaving the card (a scroll, trackpad momentum) isn't
 * taking over. The Mac app only ignores such input since its rebuild after Oct 1, 2026.
 */
export const ALLOW_RETRY_MS = 4000;

/** How long a detail the user confirmed after hearing it read back can be typed again without asking. */
export const READBACK_TTL_MS = 30 * 60 * 1000;

/** What Echo says when the user takes over a step with their own mouse or keyboard. */
// "Okay, go ahead" sounded like permission for something; this says what happened.
export const TAKE_OVER_LINE = "Okay, I've stopped.";

/** A mid-run instruction waits this long for the assistant's next step, then goes in as a new turn. */
export const INSTRUCTION_TTL_MS = 60 * 1000;

/** Play-along (a game or anything else done turn by turn): how long after the user's click Echo looks, and how long with no click ends it. */
export const PLAY_SETTLE_MS = 450;
export const PLAY_IDLE_MS = 5 * 60 * 1000;
