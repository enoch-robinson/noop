// Slack interactive callbacks (/api/slack/interactive): prove the request really is Slack, then pull the clicked
// buttons out of the urlencoded payload. The Hub turns each click into the same owner inbox message /api/answer
// writes — buttons and typed replies converge on one path. Kept free of `cloudflare:workers` so bun test can
// import it (same pattern as answer.ts / files.ts).

const te = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
function sameStr(a: string, b: string) { // constant-time for equal lengths
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Slack's v0 scheme: HMAC-SHA256 over `v0:<timestamp>:<raw body>`. Timestamps older than 5 min are refused:
 *  everything before that point is a replay of a captured click. */
export async function verifySlack(secret: string, sig: string, ts: string, body: string): Promise<boolean> {
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > 300) return false;
  if (!/^v0=[0-9a-f]{64}$/.test(sig)) return false;
  const key = await crypto.subtle.importKey("raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return sameStr(`v0=${hex(await crypto.subtle.sign("HMAC", key, te.encode(`v0:${t}:${body}`)))}`, sig);
}

export type Click = { card: string; choice: string };
const ANSWER_ID = /^answer:([DLP]-[A-Z]?\d{4}):(.{1,300})$/is; // only our own buttons carry this shape (case kept loose like parseAnswer)

/** The `payload=` form field Slack posts on a button click; other action_ids (workflow buttons, shortcuts) are
 *  ignored, not errors — a workspace may share one Slack app with unrelated interactions. */
export function parseSlackPayload(body: string): { clicks: Click[]; responseUrl: string } {
  let v: any;
  try { v = JSON.parse(new URLSearchParams(body).get("payload") ?? ""); } catch { return { clicks: [], responseUrl: "" }; }
  const clicks = (Array.isArray(v?.actions) ? v.actions : []).map((a: any) => {
    const m = typeof a?.action_id === "string" ? a.action_id.match(ANSWER_ID) : null;
    return m ? { card: m[1].toUpperCase(), choice: m[2].trim() } : null;
  }).filter(Boolean) as Click[];
  return { clicks, responseUrl: typeof v?.response_url === "string" ? v.response_url : "" };
}
