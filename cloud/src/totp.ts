// TOTP (RFC 6238: HMAC-SHA1, 30 s steps, 6 digits), the second factor of the owner's sign-in — Google Authenticator,
// 1Password, Authy… WebCrypto only, so it runs in the Worker and in Bun alike.

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const STEP_S = 30, DIGITS = 6, WINDOW = 1; // ±1 step of clock drift

export function b32encode(b: Uint8Array): string {
  let bits = 0, v = 0, out = "";
  for (const x of b) { v = (v << 8) | x; bits += 8; while (bits >= 5) { out += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) out += B32[(v << (5 - bits)) & 31];
  return out;
}
export function b32decode(s: string): Uint8Array<ArrayBuffer> {
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  const out: number[] = [];
  let bits = 0, v = 0;
  for (const c of clean) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error("bad base32");
    v = (v << 5) | i; bits += 5;
    if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

/** A new 160-bit secret, base32 (what authenticator apps take). */
export const newSecret = () => b32encode(crypto.getRandomValues(new Uint8Array(20)));

export async function hotp(secret: Uint8Array<ArrayBuffer>, counter: number, digits = DIGITS): Promise<string> {
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter));
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** digits).padStart(digits, "0");
}

export const stepAt = (ms = Date.now()) => Math.floor(ms / 1000 / STEP_S);

/** The step the code matches (within ±WINDOW), or null. Steps ≤ `after` were already used: a code works once. */
export async function totpMatch(secretB32: string, code: unknown, after = -1, ms = Date.now()): Promise<number | null> {
  const c = typeof code === "string" ? code.replace(/\s/g, "") : "";
  if (!/^\d{6}$/.test(c)) return null;
  const key = b32decode(secretB32), now = stepAt(ms);
  for (let s = now - WINDOW; s <= now + WINDOW; s++) {
    if (s <= after) continue;
    const want = await hotp(key, s);
    let d = 0; for (let i = 0; i < DIGITS; i++) d |= want.charCodeAt(i) ^ c.charCodeAt(i);
    if (d === 0) return s;
  }
  return null;
}

/** otpauth:// URI for the QR code / manual entry. */
export const otpauthUri = (secret: string, account: string, issuer = "Noop") =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_S}`;
