// Discord interactions (/api/discord/interactive): verify Ed25519 over `<timestamp><raw body>` (Discord's scheme),
// then answer the PING handshake or turn a component click (custom_id `answer:<card>:<choice>`) into an owner
// inbox message. Kept free of `cloudflare:workers` so bun test can import it (same pattern as answer.ts).

const te = new TextEncoder();
const fromHex = (h: string): Uint8Array<ArrayBuffer> | null => {
  if (!/^[0-9a-f]+$/i.test(h) || h.length % 2) return null;
  const u = new Uint8Array(h.length / 2);
  for (let i = 0; i < u.length; i++) u[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return u;
};

export type DiscordVerify = "ok" | "bad" | "unsupported";
/** "unsupported" means this runtime's WebCrypto has no Ed25519 (Workers and Bun both have it; a locked-down build
 *  may not). The caller must degrade rather than record: an unverifiable click is an unauthenticated write. */
export async function verifyDiscord(publicKeyHex: string, sigHex: string, ts: string, body: string): Promise<DiscordVerify> {
  const key = fromHex(publicKeyHex), sig = fromHex(sigHex);
  if (!key || key.length !== 32 || !sig || sig.length !== 64) return "bad";
  if (!/^\d+$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return "bad";
  try {
    const k = await crypto.subtle.importKey("raw", key, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, k, sig, te.encode(ts + body)) ? "ok" : "bad";
  } catch { return "unsupported"; }
}

export type Click = { card: string; choice: string };
/** A MESSAGE_COMPONENT click on one of our buttons; null for everything else (PING, autocomplete, other apps'). */
export function parseDiscordClick(b: unknown): Click | null {
  const cid = (b as any)?.data?.custom_id;
  const m = typeof cid === "string" ? cid.match(/^answer:([DLP]-[A-Z]?\d{4}):(.{1,300})$/is) : null;
  return m ? { card: m[1].toUpperCase(), choice: m[2].trim() } : null;
}
