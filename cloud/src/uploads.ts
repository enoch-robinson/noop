// The owner's images sent with a chat message (POST /api/uploads, then POST /api/messages {attachments}).
// Shared by the Worker and the local hub server (src/server.ts) so both accept the same files.

export const MAX_UPLOAD = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
const UPLOAD_TYPES = /^image\/(png|jpeg|gif|webp|heic|heif|avif|bmp)$/;

/** The image's real type from its first bytes. Phone clients often send no type, "image/jpg" or
 * "application/octet-stream" for photos; trusting the bytes is both more lenient and safer. */
export function sniffImage(head: Uint8Array, declared = ""): string {
  const b = (i: number) => head[i] ?? -1;
  const ascii = (i: number, n: number) => String.fromCharCode(...head.slice(i, i + n));
  if (b(0) === 0x89 && ascii(1, 3) === "PNG") return "image/png";
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return "image/jpeg";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  if (ascii(0, 2) === "BM") return "image/bmp";
  if (ascii(4, 4) === "ftyp") {
    const brand = ascii(8, 4);
    if (/^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(brand)) return brand.startsWith("mif") || brand.startsWith("msf") ? "image/heif" : "image/heic";
    if (/^avi[fs]$/.test(brand)) return "image/avif";
  }
  return declared === "image/jpg" ? "image/jpeg" : declared;
}

/** Why the owner's upload is refused (null: it is taken). SVG is refused: it can carry script. */
export function uploadProblem(type: string, size: number): { error: string; status: number } | null {
  if (!UPLOAD_TYPES.test(type)) return { error: "images only (png, jpeg, gif, webp, heic, bmp)", status: 415 };
  if (size > MAX_UPLOAD) return { error: "image too large (10 MB max)", status: 413 };
  if (!size) return { error: "empty file", status: 400 };
  return null;
}

/** A stored upload's id: unique, and safe as a file name and a URL segment. */
export const uploadId = (name: string) =>
  `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${(name || "image").replace(/[^\w.\-]/g, "_").slice(-80)}`;

/** A message's attachments: up to 10 paths of the hub's own media ("/media/<id>"); null when malformed. */
export function ownerAttachments(v: unknown): string[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > MAX_ATTACHMENTS) return null;
  return v.every((x) => typeof x === "string" && /^\/media\/[\w][\w.\-]*$/.test(x) && !x.includes("..")) ? (v as string[]) : null;
}

/** Media is served from the app's own origin: anything a browser could run as a page (HTML, SVG, XML, JS…) is sent as a
 *  download, never rendered, and every response is sandboxed — an uploaded file must not be able to read the session. */
export function mediaHeaders(type: string, name: string): Record<string, string> {
  const t = String(type || "application/octet-stream").toLowerCase();
  const inline = /^(image\/(png|jpe?g|gif|webp|avif|heic|heif|bmp)|video\/[\w.+-]+|audio\/[\w.+-]+|application\/pdf|text\/plain)(;|$)/.test(t);
  return {
    "content-type": inline ? t : "application/octet-stream",
    "content-disposition": `${inline ? "inline" : "attachment"}; filename="${name.replace(/[^\w.\-]/g, "_")}"`,
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
    "cache-control": "private, max-age=31536000",
  };
}
