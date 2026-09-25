// Downloads Echo's natural voice (Kokoro, ~90 MB) ahead of time, so the first launch
// doesn't have to. Loads the model exactly the way lib/voice.js does (keep the two in sync),
// speaks one word to make sure it works, then exits.
//
//   node scripts/prefetch-voice.js
const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const started = Date.now();
const secs = () => ((Date.now() - started) / 1000).toFixed(0);

console.log('Getting the Kokoro voice ready (about 90 MB the first time; quick if it is already downloaded)…');
// A gentle heartbeat so a slow download doesn't look frozen.
const ticker = setInterval(() => console.log(`  still working… ${secs()}s`), 15000);

try {
  const { KokoroTTS } = await import('kokoro-js');
  const files = new Map();
  let shown = -10;
  const tts = await KokoroTTS.from_pretrained(MODEL, {
    dtype: 'q8',
    device: 'cpu',
    // A simple progress line: "  downloading the voice: 40% of 92 MB"
    progress_callback: (p) => {
      if (p?.status !== 'progress' || !p.total) return;
      files.set(p.file, [p.loaded || 0, p.total]);
      const [got, all] = [...files.values()].reduce((a, [l, t]) => [a[0] + l, a[1] + t], [0, 0]);
      const pct = Math.floor((got / all) * 100);
      if (pct >= shown + 10 || pct === 100) {
        shown = pct;
        console.log(`  downloading the voice: ${pct}% of ${Math.round(all / 1e6)} MB`);
      }
    },
  });
  const audio = await tts.generate('Ready.', { voice: 'af_heart' });
  const bytes = Buffer.from(audio.toWav()).length;
  if (!bytes) throw new Error('the voice produced no audio');
  clearInterval(ticker);
  console.log(`The voice is ready (${secs()}s).`);
  // Exit right away: the voice library can crash while shutting down, and we're done anyway.
  process.exit(0);
} catch (e) {
  clearInterval(ticker);
  console.error(`Couldn't get the voice ready: ${e?.message || e}`);
  console.error('No problem: Echo will download it the first time it starts.');
  process.exit(1);
}
