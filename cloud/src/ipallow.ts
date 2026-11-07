// Optional source-IP allow-list for the Worker (secret HUB_ALLOW_IPS: comma/space-separated IPs or CIDRs, v4 and v6).
// Unset or empty: every IP may connect (auth still applies). Set: anything else gets 403 before reaching the Hub.

function v4(s: string): bigint | null {
  const p = s.split(".");
  if (p.length !== 4) return null;
  let n = 0n;
  for (const x of p) {
    if (!/^\d{1,3}$/.test(x) || Number(x) > 255) return null;
    n = (n << 8n) | BigInt(Number(x));
  }
  return n;
}

function v6(s: string): bigint | null {
  if (!s.includes(":")) return null;
  s = s.replace(/^\[|\]$/g, "").split("%")[0];
  // an embedded IPv4 tail (::ffff:1.2.3.4) becomes two hextets
  const tail = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) { const n = v4(tail[2]); if (n === null) return null; s = `${tail[1]}${(n >> 16n).toString(16)}:${(n & 0xffffn).toString(16)}`; }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [], rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const all = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...rest];
  let n = 0n;
  for (const h of all) {
    if (!/^[0-9a-f]{1,4}$/i.test(h)) return null;
    n = (n << 16n) | BigInt(parseInt(h, 16));
  }
  return n;
}

type Net = { v: 4 | 6; base: bigint; bits: number };

function parseIp(s: string): { v: 4 | 6; n: bigint } | null {
  const a = v4(s);
  if (a !== null) return { v: 4, n: a };
  const b = v6(s);
  if (b === null) return null;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) is the IPv4 address
  if (b >> 32n === 0xffffn) return { v: 4, n: b & 0xffffffffn };
  return { v: 6, n: b };
}

/** Parses the allow-list; entries that don't parse are reported in `bad` (and match nothing). */
export function parseAllowList(raw: string | undefined): { nets: Net[]; bad: string[] } {
  const nets: Net[] = [], bad: string[] = [];
  for (const e of (raw ?? "").split(/[\s,]+/).filter(Boolean)) {
    const [ip, len] = e.split("/");
    const p = parseIp(ip);
    const max = p?.v === 4 ? 32 : 128;
    const bits = len === undefined ? max : /^\d{1,3}$/.test(len) ? Number(len) : -1;
    if (!p || bits < 0 || bits > max) { bad.push(e); continue; }
    const shift = BigInt(max - bits);
    nets.push({ v: p.v, base: (p.n >> shift) << shift, bits });
  }
  return { nets, bad };
}

export function ipAllowed(ip: string | null | undefined, nets: Net[]): boolean {
  const p = ip ? parseIp(ip.trim()) : null;
  if (!p) return false;
  return nets.some((n) => {
    if (n.v !== p.v) return false;
    const shift = BigInt((n.v === 4 ? 32 : 128) - n.bits);
    return (p.n >> shift) << shift === n.base;
  });
}
