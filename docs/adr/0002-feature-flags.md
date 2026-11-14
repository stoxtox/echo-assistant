# 0002. Every core change ships behind a feature flag

*Accepted, October 2026.*

## Context

The core rebuild changes how Echo hears, decides and acts. A change can look right in tests and
still be worse in a real room. It must be possible to turn a new behavior off in seconds, compare
old and new on the same days, and remove the old path only once the new one has proven itself.

## Decision

- `lib/flags.ts` holds one typed registry of flags (`FLAGS`), each with a default and a one-line
  description. A misspelled flag name fails the type check.
- A flag's value comes from, strongest first: `ECHO_FLAG_<NAME>=1|0` in the environment (tests,
  replay, a quick try), then `settings.core.<name>` (data/settings.json, also
  `POST /api/settings { "core": { "<name>": true } }`), then the default.
- New behavior starts **off**. It is switched on after a day of real use, and its old path is
  deleted after a week with no regression on the scorecard. A flag that has been on everywhere for
  two weeks is removed from the registry along with the old code.

## Exceptions

- `hints` and `verify` started **on** (Oct 2026, the owner's decision) and have since been removed with
  their old paths (the automatic rewrite of speech; counting any change on screen as done).
- Since Oct 3 every remaining switch except `messages` is **on** by default: they are how Echo works,
  and Settings → Labs is where one is turned off if it misbehaves. `messages` stays off (it needs an
  API key and changes billing).

## Considered

- *A remote flag service*: needed later for other people's copies (kill switches), not now; the
  registry is the place it will plug in.
- *Branches instead of flags*: can't compare old and new on the same live install.

## Consequences

- Every core patch names its flag and its removal plan.
- `settings.core` only keeps short names with true/false values; unknown names are ignored.
