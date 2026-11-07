// Card buttons per channel, built from a card's structured options (CardOption). One button per *keyed* option;
// the key travels in the action id (`answer:<card>:<key>`), which every callback endpoint turns into the same
// owner message a typed reply would be (`D-0012 A`) — so buttons carry no new semantics, only reach.
import type { CardOption } from "./server";

/** Options that can be buttons: keyed ones only ("A", "1", "all"; free-form labels fall back to typed replies).
 *  A proposals batch gets all/none only — a numbered button would resolve the batch and reject every unpicked
 *  item, which is never what a single tap means. */
export function buttonOptions(kind: string | undefined, choices?: CardOption[]): CardOption[] {
  if (!choices?.length) return [];
  const keyed = choices.filter((o) => o.key && /^[\w-]{1,20}$/.test(o.key));
  return kind === "proposals" ? keyed.filter((o) => /^(all|none)$/i.test(o.key)) : keyed;
}

/** Button text: the option label minus its "A: "/"1. " prefix (the key rides in the action id), capped to the
 *  channel's limit. Labels without the key prefix stay whole — "all（全做）" is not stripped to "（全做）". */
export function buttonLabel(o: CardOption, cap: number): string {
  const m = o.key ? o.label.match(new RegExp(`^\\s*${o.key}\\s*[:：.)、，,]\\s*(\\S.*)$`, "i")) : null;
  const label = (m?.[1] ?? o.label).trim();
  return label.length > cap ? `${label.slice(0, cap - 1).trimEnd()}…` : label;
}

/** Slack payload for a card with buttons: the full text stays as the notification fallback (Slack shows it while
 *  blocks are collapsed), plus one Block Kit button per option. Recommended → primary; risky → danger style and
 *  Slack's own confirm dialog (the channel-side second step of the high-risk gate). */
export function slackBody(text: string, ref: string | undefined, kind: string | undefined, choices?: CardOption[]): Record<string, unknown> {
  const btns = buttonOptions(kind, choices);
  if (!ref || !btns.length) return { text };
  return {
    text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: text.slice(0, 2900) } },
      { type: "actions", elements: btns.slice(0, 25).map((o) => { // actions block holds max 25 elements
        const el: Record<string, unknown> = { type: "button", action_id: `answer:${ref}:${o.key}`,
          text: { type: "plain_text", text: buttonLabel(o, 75) || o.key, emoji: true }, // Slack button text cap: 75
          // risk beats recommendation in color: a merge option the agent likes still shows red + the confirm dialog
          style: o.risk === "high" ? "danger" : o.recommended ? "primary" : undefined };
        if (o.risk === "high") el.confirm = { title: { type: "plain_text", text: "高风险操作" },
          text: { type: "mrkdwn", text: "这个选项会执行受限操作（合并 / 发布等），再确认一次。" },
          confirm: { type: "plain_text", text: "确认执行" }, deny: { type: "plain_text", text: "取消" } };
        return el;
      }) },
    ],
  };
}

/** Discord Message Components: buttons in rows of 5 (API max). High-risk options have no native confirm dialog on
 *  Discord — they render as links to the card page (whose confirm step posts {confirm:true}); without a base URL
 *  they stay danger-styled and the Worker refuses unconfirmed clicks with a pointer to the page. */
export function discordComponents(ref: string, choices: CardOption[], base?: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < Math.min(choices.length, 25); i += 5) // max 5 components per action row, 5 rows per message
    rows.push({ type: 1, components: choices.slice(i, i + 5).map((o) => {
      if (o.risk === "high" && base) return { type: 2, style: 5, url: `${base.replace(/\/$/, "")}/card/${ref}`,
        label: buttonLabel(o, 80) || o.key };
      return { type: 2, style: o.risk === "high" ? 4 : o.recommended ? 1 : 2,
        label: buttonLabel(o, 80) || o.key, custom_id: `answer:${ref}:${o.key}` };
    }) });
  return rows;
}

/** ntfy banner buttons (X-Actions): up to 3 (ntfy's hard cap — a longer menu simply has no buttons there). Safe
 *  options become http POSTs to the Worker's /api/answer (confirm:true — one tap, the banner clears); high-risk
 *  ones open the card page instead, whose confirm step is the second tap. The token is the answer-only secret:
 *  the Actions header hands it to the ntfy server (a third party), so it must never be HUB_TOKEN; its whole blast
 *  radius is "answer cards, nothing else". */
export function ntfyActions(ref: string, choices: CardOption[], base: string, token: string): string {
  if (!ref || !base || !token || !choices.length) return "";
  const origin = base.replace(/\/$/, "");
  // ntfy splits the header on "," and ";" between params, so values containing either (or "=", which would parse
  // as a key=value param) must be quoted; quotes and newlines never survive into a label (HTTP headers can't carry
  // newlines anyway).
  const labelOf = (o: CardOption) => buttonLabel(o, 30).replace(/["';\n]/g, " ").replace(/\s+/g, " ").trim() || o.key;
  const quoted = (v: string) => (/[;,=]/.test(v) ? `"${v}"` : v);
  const safeToken = token.replace(/[^\w.-]/g, ""); // the token rides a param list: specials would break the parse
  return choices.slice(0, 3).map((o) => o.risk === "high"
    ? `view, ${quoted(labelOf(o))}, ${origin}/card/${ref}, clear=true`
    : `http, ${quoted(labelOf(o))}, ${origin}/api/answer, method=POST, headers.Authorization=Bearer ${safeToken}, ` +
      `body='${JSON.stringify({ card: ref, choice: o.key, confirm: true })}', clear=true`).join("; ");
}

/** RFC 2047 encoded-word: HTTP header values must be latin-1 bytes, and Bun's fetch throws on a UTF-8 label —
 *  losing the whole push. ntfy decodes encoded-words in every header (documented for Actions too), so a value
 *  carrying non-ASCII goes out as =?UTF-8?B?...?= and arrives intact. */
export const rfc2047 = (v: string) => /[^\x00-\x7f]/.test(v)
  ? `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`
  : v;
