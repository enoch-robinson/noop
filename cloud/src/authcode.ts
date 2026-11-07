// Login codes: 8 characters from 31 letters and digits that can't be misread (no 0/O, 1/I/L): 31^8 ≈ 8.5 × 10^11.
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789", CODE_LEN = 8;
export function newCode() { // unbiased: bytes ≥ 248 (= 8 × 31) are redrawn
  let s = "";
  const a = new Uint8Array(1);
  while (s.length < CODE_LEN) { crypto.getRandomValues(a); if (a[0] < 248) s += CODE_ALPHABET[a[0] % 31]; }
  return s;
}
/** What the owner typed → the canonical code: case-insensitive, spaces and dashes ignored. */
export const normCode = (c: unknown) => typeof c === "string" ? c.toUpperCase().replace(/[\s-]/g, "") : "";
export const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LEN}}$`);
