# Measuring how well Echo listens

Before changing how Echo listens, measure it on your own voice. Echo keeps each sentence you say
(only on this Mac), you label a batch, and a report shows the real numbers. The same labelled clips
are the test set for comparing speech engines and for every later change to listening.

## 1. Keep recordings

Settings → Privacy & safety → **Keep voice recordings on this Mac**. It's on by default in the
developer copy and off everywhere else. Clips go to `data/listening/clips/<id>.wav`, for 30 days and
at most 3,000 clips (about 500 MB). They're never sent anywhere.

Every clip is kept, whatever happened to it: the ones Echo answered, the ones it set aside as "not
for me", the ones that came out blank. Every line in `data/stt-log.jsonl` about a clip carries its id
as `rec`, so each recording can be followed to its fate.

## 2. Label them

```
node scripts/listen-review.js            # 40 at a time; --since 2026-10-02, --limit 100, --redo
```

Each clip plays, then two questions: was it meant for Echo (y/n), and what did you actually say
(Enter if Echo heard it right; `-` if nothing was said). Clips Echo set aside or couldn't transcribe
come first. Labels are saved after every answer in `data/listening/labels.json`.

## 3. Read the numbers

```
node scripts/listen-report.js            # --since 2026-10-02
```

| Number | What it means | Goal |
|---|---|---|
| Meant for Echo, never got them | false drops: you talked to Echo and it ignored you | under 1% |
| Not meant for Echo, answered | false accepts: the TV, a call, talking to yourself | under 3% |
| Word error rate | wrong, missing or extra words, for what Echo used, Whisper alone and the live preview | as low as possible |
| Speech to text p50 / p90 | from the end of the clip to text | under 0.3 s |
| Answered twice | the same sentence went through twice in a row | 0 |

## 4. Compare engines

```
node scripts/listen-report.js --export /tmp/my-voice
node scripts/stt-bench.js --clips /tmp/my-voice/clips.txt
```

`--export` copies the labelled clips and writes `clips.txt` (`<id>|<mic>|<what you said>`), the
format `stt-bench.js` reads.
