// One tolerant reader for the owner's typed replies ("a", "B：等一下", "1，3", "就先等等"). Buttons post keys, but
// text is the fallback on every channel. The parse never guesses: words that could mean two options come back
// `{unrecognized}` and the caller decides (map via the brain, store as a free-form answer, or ask) — a reply is
// never silently dropped.
import type { CardOption } from "./server";

/** Full-width latin/digits and CJK punctuation collapse to their ASCII shape ("Ｂ" → "B", "１，３" → "1,3"). */
export const asciiFold = (s: string) => s
  .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/[，、]/g, ",")
  .trim();

/** Leading option key of an answer ("B: merge…" → "B"; "1, 3" → "1,3"); free text → the whole text, lower-cased.
 *  The scorer's normalizer: what "which option was picked" means once a reply is already mapped to an option. */
export function choice(s: string | undefined): string {
  const t = asciiFold(s ?? "");
  const m = t.match(/^([A-Za-z]|\d+(?:\s*[,，]\s*\d+)*)(?=$|[\s:：.)、,，])/);
  return m ? m[1].replace(/\s/g, "").replace(/，/g, ",").toUpperCase() : t.toLowerCase();
}

export type ParsedReply = { choice: string; how: "key" | "label" | "fragment" } | { unrecognized: string };

/** Map a typed reply onto a card's options, most explicit reading first:
 *  the key alone ("A", "ｂ") → a key list ("1，3") → the label echoed back ("B: wait" / "wait") → a fragment that
 *  lands inside exactly one label ("先等等" inside "B: 等一下"). A fragment is reported as `how: "fragment"` — it is
 *  the fuzzy reading, and the caller gates high-risk options on it. Anything ambiguous or unrelated is not a choice. */
export function parseChoice(answer: string, choices: CardOption[]): ParsedReply {
  const t = asciiFold(answer).replace(/[。．.!！?？；;、，,：:]+$/u, ""); // trailing sentence punctuation is never part of an answer
  const keyed = choices.filter((o) => o.key);
  const byKey = (k: string) => keyed.find((o) => o.key.toUpperCase() === k);
  const stripped = (o: CardOption) => o.label.replace(new RegExp(`^\\s*${o.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:：.)、，,]?\\s*`), "").trim() || o.label;
  const one = byKey(t.toUpperCase());
  if (one) return { choice: one.key, how: "key" };
  const parts = t.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1 && parts.every((p) => byKey(p.toUpperCase())))
    return { choice: parts.map((p) => byKey(p.toUpperCase())!.key).join(","), how: "key" };
  const squash = (s: string) => s.replace(/\s/g, ""); // a dropped space ("B：wait" for "B: wait") is still a deliberate echo
  const echoes = keyed.filter((o) => squash(asciiFold(o.label)) === squash(t) || squash(stripped(o)) === squash(t));
  if (echoes.length === 1) return { choice: echoes[0].key, how: "label" };
  const hits = keyed.filter((o) => { const label = asciiFold(stripped(o)); return label.length >= 2 && (label.includes(t) || t.includes(label)); });
  if (hits.length === 1) return { choice: hits[0].key, how: "fragment" };
  return { unrecognized: answer };
}
