// The one answer endpoint every owner channel posts to (buttons, push actions, the card page, integrations).
// It parses the body; the Hub turns a valid answer into an owner feed event, which reaches the fleet's
// decision dispatch (src/cli.ts handleReplies) through the owner→fleet inbox — the same path as a typed reply.

/** `parseAnswer({card: "d-0012", choice: "A"}) → {text: "D-0012 A", ref: "D-0012"}`; `{error}` when malformed. */
export function parseAnswer(b: unknown): { text: string; ref: string } | { error: string } {
  const body = (b ?? {}) as Record<string, unknown>;
  if (typeof body.card !== "string" || body.card.length > 12) return { error: "card required: a D-/P-/L- id like D-0012" };
  if (typeof body.choice !== "string") return { error: "choice required: a string" };
  const card = body.card.trim().toUpperCase();
  const choice = body.choice.trim();
  if (!/^[DLP]-[A-Z]?\d{4}$/.test(card)) return { error: "card required: a D-/P-/L- id like D-0012" };
  if (!choice || choice.length > 500) return { error: "choice required (1-500 chars)" };
  return { text: `${card} ${choice}`, ref: card };
}

/** The option key an answer points at: leading letter/number of the choice ("B: wait" → "B"); free text → "". */
export function choiceKey(choice: string): string {
  return (choice.trim().match(/^([A-Za-z]|\d+)(?=$|[\s:：.)、,，-])/)?.[1] ?? "").toUpperCase();
}

/** True when the choice selects an option the card marks risk:"high" — those take a second, deliberate step before
 *  the answer is recorded. A free-text answer (no leading key) on a card with any high-risk option confirms too:
 *  otherwise "merge it now" would walk past the gate that the option buttons are subject to. `content` is the
 *  card's markdown from the synced files table (open cards only: answers to closed cards are dropped before this
 *  runs, and a judge-card veto bypasses the gate). Legacy cards without options_json carry no risk data and stay
 *  one-step. */
export function needsConfirm(content: string, choice: string): boolean {
  const json = content.match(/^options_json: (\[.*\])\s*$/m)?.[1];
  if (!json) return false;
  try {
    const options = JSON.parse(json) as { key?: string; risk?: string }[];
    const key = choiceKey(choice);
    if (!key) return options.some((o) => o.risk === "high"); // free text on a gated card confirms as well
    return options.some((o) => typeof o.key === "string" && o.key.toUpperCase() === key && o.risk === "high");
  } catch { return false; }
}
