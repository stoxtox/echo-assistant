// Which installed app a spoken name means: "Chrome" is Google Chrome, "Word" is Microsoft Word,
// "XD" is Adobe XD. Only when exactly one app clearly fits; otherwise none (Echo then asks).

const words = (s: string): string[] => s.toLowerCase().replace(/\.app$/, '').match(/[\p{L}\p{N}]+/gu) || [];

export function closestApp(name: string, apps: readonly string[]): string | null {
  const want = words(name);
  if (!want.length) return null;
  const exact = apps.find((a) => words(a).join(' ') === want.join(' '));
  if (exact) return exact;
  // Every word said is a whole word of the app's name; the fewest extra words wins, if only one does.
  const fits = apps
    .map((a) => ({ a, w: words(a) }))
    .filter(({ w }) => want.every((x) => w.includes(x)))
    .map(({ a, w }) => ({ a, extra: w.length - want.length }));
  if (!fits.length) return null;
  const best = Math.min(...fits.map((f) => f.extra));
  const top = [...new Set(fits.filter((f) => f.extra === best).map((f) => f.a))];
  return top.length === 1 ? (top[0] ?? null) : null;
}
