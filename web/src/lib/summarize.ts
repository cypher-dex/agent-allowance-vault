/**
 * The paid "service" of the demo seller: a small extractive summarizer. It runs locally and needs
 * no API key, so the demo has no third-party dependency. A real seller would put inference, data
 * or compute behind the same paywall.
 */
const STOP = new Set(
  "a an and are as at be but by for from has have in into is it its of on or that the their this to was were will with which we you your our they them these those not can than then".split(" "),
);

export function summarize(text: string, maxSentences = 2) {
  const sentences = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const words = (s: string) => s.toLowerCase().match(/[a-z0-9']+/g)?.filter((w) => !STOP.has(w)) ?? [];
  const freq = new Map<string, number>();
  for (const w of words(text)) freq.set(w, (freq.get(w) ?? 0) + 1);
  const scored = sentences.map((s, i) => {
    const ws = words(s);
    const score = ws.reduce((a, w) => a + (freq.get(w) ?? 0), 0) / Math.max(ws.length, 1);
    return { s, i, score };
  });
  const top = [...scored].sort((a, b) => b.score - a.score).slice(0, maxSentences).sort((a, b) => a.i - b.i);
  const keywords = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w]) => w);
  return { summary: top.map((t) => t.s).join(" "), keywords, sentences: sentences.length, words: words(text).length };
}
