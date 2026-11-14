# Premium voice, free first, Kokoro as the backup

Echo can speak with a premium voice (ElevenLabs Flash or Cartesia Sonic) while its free credits
last, and with Kokoro (free, local) when they run out, until they're back. It never goes past the
free (or plan) limit, so there's never a bill, even on an account that allows usage-based billing.

## Turn it on

1. Get a key: ElevenLabs (elevenlabs.io → Profile → API keys) or Cartesia (play.cartesia.ai → API keys).
2. Add it to `.env` in the app folder, then restart Echo:
   ```
   ELEVENLABS_API_KEY=…
   CARTESIA_API_KEY=…
   ```
3. Settings → Voice → Voice engine → ElevenLabs or Cartesia, pick a voice, and pick the
   **Backup voice** (a Kokoro voice close to it).

Settings shows what's left ("6,200 of 10,000 free credits left, back to full on Nov 1"), or why the
backup is speaking and until when. The assistant mentions it once when the voice switches, and
once when it's back.

## How it decides, sentence by sentence

| Situation | Who speaks | Until |
|---|---|---|
| Free credits left | premium | |
| This sentence would go past the free limit | Kokoro | the provider's reset (ElevenLabs reports it; Cartesia: the 1st, or `CARTESIA_RESET_DAY`) |
| The provider says the credits are used up | Kokoro | the reset; if unknown, one try every 6 hours |
| The key is refused | Kokoro | one try an hour later |
| No answer within 4 s, or an error | Kokoro, for that sentence | after 3 in a row, 5 minutes |

ElevenLabs' own usage count is checked at most every 10 minutes (`/v1/user/subscription`). Cartesia
has no usage endpoint, so Echo counts the characters it sends against `CARTESIA_MONTHLY_CHARS`
(default 20,000, the free plan). The state is in `data/voice-budget.json`.

## How long the free credits last

Echo said about 850,000 characters from Sept 24 to Oct 1 (about 106,000 a day, a heavy testing
week). Free plans: ElevenLabs 10,000 credits a month (Flash uses about half a credit per character),
Cartesia 20,000 characters. At that pace the free premium voice lasts a few hours a month. To use a
premium voice all the time, a paid plan's characters work the same way: Echo uses the plan's
characters and stops at its limit.

## Compare the voices on this Mac

```
node --env-file-if-exists=.env scripts/voice-bench.js --listen
```

Each voice says the same six Echo-like lines, one sentence at a time, as Echo asks for them. It
prints how long until each sentence's audio is ready, then plays them in a blind order for you to
rate 1 to 5. A run spends about 450 of each premium voice's free characters.

Baseline, Oct 1, Kokoro on this Mac: **p50 2.3 s per sentence** (0.5 s for "On it.", 2.8 s for an
85-character sentence), about 25 ms per character. That's how long a sentence waits before Echo can
start saying it.
