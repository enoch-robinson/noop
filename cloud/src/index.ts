// noop coordination plane — runs in the owner's own Cloudflare account (free plan). Not a shared service.
// One Durable Object (SQLite) holds: chat feed, owner→fleet inbox, the fleet's status/settings snapshot, media.
// The machines (which run Claude/Codex) only make outbound HTTPS calls here; nothing needs to reach them.
//
// Client API (same shape as the local hub server):
//   GET /api/feed?since=  · WS /api/stream?token=  · POST /api/messages {text, reply_to?, attachments?: ["/media/<id>"]}
//   GET /api/status  · GET|PUT /api/settings  · POST /api/media (multipart) · GET /media/<id>
//   POST /api/uploads (multipart `file`; the owner's images for a message: image/*, ≤ 10 MB) → {url: "/media/<id>"}
// Fleet API (primary host):
//   POST /api/events (event)  · PUT /api/host/state {status, settings}  · GET /api/host/inbox?after=<seq>
//   POST /api/host/revoke-sessions (HUB_TOKEN only)
// Auth: HUB_TOKEN is the machine (fleet) credential. The owner logs in with an emailed one-time code:
//   POST /api/auth/start {email} → mail code · POST /api/auth/verify {email, code} → {session} · POST /api/auth/logout
// Web Push (owner session): GET /api/push/vapid · POST /api/push/subscribe {subscription, device_label}
//   · POST /api/push/unsubscribe {endpoint} · POST /api/push/test · POST /api/push/answer {ref, answer}
// Owner answers (owner session): POST /api/answer {card, choice} — the one endpoint every channel's buttons post to;
//   it lands in the feed and the owner→fleet inbox exactly like a typed `D-0012 A` reply. ntfy banner buttons post
//   here too, with the answer-only HUB_ANSWER_TOKEN instead of an owner session.
// Channel button callbacks: POST /api/slack/interactive (HMAC via HUB_SLACK_SIGNING_SECRET) ·
//   POST /api/discord/interactive (Ed25519 via HUB_DISCORD_PUBLIC_KEY) — they verify their own signature and
//   converge on the same ownerMessage path as /api/answer.
// MCP (Claude / ChatGPT connectors): /mcp + OAuth 2.1 at /oauth/* and /.well-known/oauth-* — see mcp.ts and docs/mcp.md.
// Every other /api/* and /media/* needs Bearer <HUB_TOKEN|session> (or ?token= for WebSocket / <img>).
import { DurableObject } from "cloudflare:workers";
import { needsConfirm, parseAnswer } from "./answer";
import { cardPage, parseCard } from "./card";
import { parseSlackPayload, verifySlack } from "./slack";
import { parseDiscordClick, verifyDiscord } from "./discord";
import { b64dec, b64enc, handleFiles, handleReadFiles, initFilesSchema } from "./files";
import { FREE, LEAN, SHED, TARGET, latestOnly } from "./budget";
import { CHANNEL_SLUG, channelsView, taskHistory, taskInfo } from "./tools";
import { CODE_RE, newCode, normCode } from "./authcode";
import { newSecret, otpauthUri, totpMatch } from "./totp";
import { mediaHeaders, ownerAttachments, sniffImage, uploadId, uploadProblem } from "./uploads";
import { sendMail, type SmtpCfg } from "./smtp";
import { EmailMessage } from "cloudflare:email";

const b64 = (t: string) => btoa(String.fromCharCode(...new TextEncoder().encode(t)));
async function cfMail(binding: SendEmail, from: string, to: string, subject: string, text: string) {
  const raw = [`From: Noop <${from}>`, `To: ${to}`, `Subject: =?UTF-8?B?${b64(subject)}?=`,
    `Message-ID: <${crypto.randomUUID()}@${from.split("@")[1]}>`, `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", b64(text)].join("\r\n");
  await binding.send(new EmailMessage(from, to, raw));
}
import { sendPush, type PushSub, type Vapid } from "./push";
import { CORS, Mcp } from "./mcp";
import { ipAllowed, parseAllowList } from "./ipallow";
import { notificationFor, type NotifyRules } from "../../app/notify";

interface Env {
  HUB: DurableObjectNamespace<Hub>; HUB_TOKEN: string; ASSETS: Fetcher;
  HUB_OWNER_EMAIL?: string; // comma-separated allow-list
  HUB_SMTP?: string;        // JSON SmtpCfg
  EMAIL?: SendEmail;        // Cloudflare Email Routing binding (no SMTP needed)
  HUB_MAIL_FROM?: string;   // sender on a domain with Email Routing on, e.g. noop@example.com
  HUB_VAPID_PUBLIC?: string;  // b64url raw P-256 point
  HUB_VAPID_PRIVATE?: string; // JWK JSON
  HUB_MOVED_TO?: string;    // the hub moved to another Worker (e.g. another account): forward every request there
  HUB_SLACK_SIGNING_SECRET?: string; // Slack button clicks (/api/slack/interactive): the Slack app's signing secret
  HUB_DISCORD_PUBLIC_KEY?: string;   // Discord button clicks (/api/discord/interactive): the app's Ed25519 public key (hex)
  HUB_ANSWER_TOKEN?: string;         // answer-only bearer for ntfy banner buttons: their Actions header hands the
  // token to the ntfy server (a third party), so it must never be HUB_TOKEN; scoped to POST /api/answer below
  HUB_ALLOW_IPS?: string;   // optional source-IP allow-list (IPs / CIDRs, comma or space separated); set → everyone else gets 403
}

const json = (d: unknown, status = 200) => Response.json(d, { status });
const CHUNK = 1_000_000; // SQLite row limit is 2 MB
const MAX_MEDIA = 30_000_000;
const STALE_MS = 3 * 60_000;
// Free-plan budget (cloud/src/budget.ts): every request and every row read/written is metered below.
const SHEDDABLE = new Set(["system", "daemon", "notice"]);
const HOT = new Set(["status", "host_seen"]), HOT_PERSIST_MS = 5 * 60_000;
const CODE_TTL = 10 * 60_000, CODE_TRIES = 5, RESEND_MS = 60_000, SENDS_PER_HOUR = 10, SEEN_EVERY = 3600_000;
// Wrong code guesses are capped per UTC day across every code (authcode.ts: 31^8 codes), so guessing can't add up over
// weeks. Past the cap nobody can verify until 00:00 UTC — a lockout, not a way in.
const FAILS_PER_DAY = 20;
// Owner sessions (app, browser, MCP access tokens) die after this long unused.
const SESSION_IDLE_MS = 30 * 86_400_000;
const TOTP_MISSING = "还没有绑定两步验证（验证器 App），任何人都无法登录：先在你的主机上运行 noop 2fa setup";

const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
function sameStr(a: string, b: string) { // constant-time for equal lengths
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const normEmail = (e: unknown) => typeof e === "string" ? e.trim().toLowerCase() : "";
const validEmail = (e: string) => e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    // Moved: machines still pointing here keep working (and pick up the new [cloud] url from the shared config).
    // IP allow-list (HUB_ALLOW_IPS): checked before anything else, static assets included
    if (env.HUB_ALLOW_IPS?.trim()) {
      const { nets, bad } = parseAllowList(env.HUB_ALLOW_IPS);
      if (bad.length) console.error(`HUB_ALLOW_IPS: ignored ${bad.join(" ")}`);
      const ip = req.headers.get("cf-connecting-ip") ?? "";
      if (!ipAllowed(ip, nets)) return ipBlocked(req, ip);
    }
    if (env.HUB_MOVED_TO) return fetch(new Request(env.HUB_MOVED_TO.replace(/\/$/, "") + url.pathname + url.search, req));
    const mcp = isMcpPath(url.pathname);
    if (mcp && req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (!mcp && !url.pathname.startsWith("/api/") && !url.pathname.startsWith("/media/")) return env.ASSETS.fetch(req);
    if (!env.HUB_TOKEN) return json({ error: "HUB_TOKEN secret not set" }, 500);
    return env.HUB.get(env.HUB.idFromName("hub")).fetch(req);
  },
};

/** Turned away by HUB_ALLOW_IPS. The visitor sees its own public IP (nothing else), so the owner can add a phone's
 *  network from the phone itself: JSON for the app and API clients, a small page for a browser. */
function ipBlocked(req: Request, ip: string): Response {
  const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
  const msg = `这个网络的出口 IP ${ip || "未知"} 不在允许名单（HUB_ALLOW_IPS）里`;
  if (!(req.headers.get("accept") ?? "").includes("text/html"))
    return Response.json({ error: "ip_blocked", ip, message: msg }, { status: 403, headers });
  const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return new Response(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Noop：IP 未放行</title><style>:root{color-scheme:light dark}body{margin:0;font:16px/1.6 -apple-system,system-ui,sans-serif;background:Canvas;color:CanvasText}
main{max-width:420px;margin:18vh auto;padding:0 16px}h1{font-size:20px;margin:0 0 12px}.ip{font:600 24px/1.3 ui-monospace,Menlo,monospace;user-select:all;padding:12px 14px;border:1px solid #8884;border-radius:8px;word-break:break-all}
p{color:GrayText;font-size:14px}</style></head><body><main><h1>这个网络还没放行</h1><div class="ip">${esc(ip || "未知")}</div>
<p>这是你当前网络的出口 IP。要从这里使用 Noop，把它加到 Worker 的 HUB_ALLOW_IPS 里（可以写网段，如 1.2.3.0/24；手机流量常用 IPv6，地址会变，写它的 /64 网段）。</p></main></body></html>`,
    { status: 403, headers: { ...headers, "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" } });
}

const isMcpPath = (p: string) => p === "/mcp" || p.startsWith("/oauth/") || p.startsWith("/.well-known/oauth-") || p === "/.well-known/openid-configuration";

type Ev = { id: string; ts: string; from: string; kind: string; text: string; ref?: string; [k: string]: unknown };

export class Hub extends DurableObject<Env> {
  sql: SqlStorage;
  mcp: Mcp;
  /** Every cursor since the last settle(): their rowsRead / rowsWritten are what Cloudflare bills. */
  cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
  usage = { day: "", requests: 0, rowsRead: 0, rowsWritten: 0 };
  usageSaved = 0;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const raw = ctx.storage.sql, cursors = this.cursors;
    this.sql = { exec: (q: string, ...b: SqlStorageValue[]) => { const c = raw.exec(q, ...b); cursors.push(c); return c; }, get databaseSize() { return raw.databaseSize; } } as unknown as SqlStorage;
    // a host keeps one hibernating socket open for "inbox has something"; its keepalive never wakes this object
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.sql.exec(`CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, json TEXT);
      CREATE TABLE IF NOT EXISTS inbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT);
      CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS media (id TEXT, n INTEGER, type TEXT, data BLOB, PRIMARY KEY (id, n));
      CREATE TABLE IF NOT EXISTS auth_codes (email TEXT PRIMARY KEY, hash TEXT, expires INTEGER, attempts INTEGER);
      CREATE TABLE IF NOT EXISTS auth_sends (email TEXT, ts INTEGER, sent INTEGER);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, email TEXT, created INTEGER, last_seen INTEGER, ua TEXT);
      CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, session TEXT, p256dh TEXT, auth TEXT, label TEXT, created INTEGER);`);
    initFilesSchema(this.sql);
    // scope: "owner" (app / browser) or "mcp" (an OAuth access token for a Claude / ChatGPT connector: /mcp only)
    try { this.sql.exec("ALTER TABLE sessions ADD COLUMN scope TEXT"); } catch { /* exists */ }
    try { Object.assign(this.usage, JSON.parse(String(raw.exec("SELECT v FROM kv WHERE k = 'usage'").toArray()[0]?.v ?? "{}"))); } catch { /* fresh */ }
    // events.ref, indexed: a task's conversation is read by ref, never by scanning every event's JSON (rows_read is billed per row)
    try { this.sql.exec("ALTER TABLE events ADD COLUMN ref TEXT"); } catch { /* exists */ }
    this.sql.exec("CREATE INDEX IF NOT EXISTS events_ref ON events (ref)");
    if (this.sql.exec("SELECT v FROM kv WHERE k = 'events_ref_filled'").toArray().length === 0) {
      this.sql.exec("UPDATE events SET ref = json_extract(json, '$.ref') WHERE ref IS NULL");
      this.sql.exec("INSERT OR REPLACE INTO kv (k, v) VALUES ('events_ref_filled', '1')");
    }
    this.mcp = new Mcp({
      sql: this.sql,
      status: () => this.statusView(),
      events: (after, limit) => this.sql.exec("SELECT seq, json FROM events WHERE seq > ? ORDER BY seq LIMIT ?", after, limit).toArray()
        .map((r) => ({ seq: r.seq as number, ev: JSON.parse(r.json as string) })),
      say: (text, ref) => this.ownerMessage(text, ref),
      enqueue: (op) => this.toInbox({ type: "op", op }),
      hostOnline: () => this.hostOnline(),
      startCode: async (email) => { const r = await this.auth("/api/auth/start", new Request("https://hub/api/auth/start", { method: "POST", body: JSON.stringify({ email }) })); return { status: r.status, body: await r.json() }; },
      checkCode: (email, code, totp, ctx) => this.checkCode(email, code, totp, ctx),
      newSession: (email, ua) => this.newSession(email, ua),
      dropSession: async (raw) => { this.sql.exec("DELETE FROM sessions WHERE id = ?", await sha256(raw)); },
    });
  }

  statusView() { return { ...(this.get("status") ?? {}), hub: { online: this.hostOnline(), seen: this.get("host_seen") } }; }

  /** Sign-in check shared by /api/auth/verify and the OAuth sign-in page: the emailed code AND the authenticator's
   *  TOTP (mandatory; bound only from a machine with `noop 2fa setup`). A success is a new sign-in: the owners are told
   *  by email (and in the feed), so a sign-in they didn't make is noticed at once. */
  async checkCode(rawEmail: unknown, rawCode: unknown, rawTotp: unknown, ctx?: { req: Request; via: string }): Promise<{ email?: string; error?: string; status?: number }> {
    const email = normEmail(rawEmail), code = normCode(rawCode), totp = typeof rawTotp === "string" ? rawTotp.replace(/\s/g, "") : "";
    const tf = this.totp();
    if (!tf) return { error: TOTP_MISSING, status: 403 };
    if (!validEmail(email) || !CODE_RE.test(code) || !/^\d{6}$/.test(totp)) return { error: "请填写邮箱验证码和两步验证码", status: 400 };
    const r = this.sql.exec("SELECT hash, expires, attempts FROM auth_codes WHERE email = ?", email).toArray()[0];
    if (!r || (r.expires as number) < Date.now()) return { error: "验证码无效或已过期，请重新获取", status: 401 };
    if ((r.attempts as number) >= CODE_TRIES) return { error: "尝试次数太多，请重新获取验证码", status: 401 };
    const day = new Date().toISOString().slice(0, 10), fails = this.get("auth_fails");
    const failed = fails?.day === day ? Number(fails.n) || 0 : 0;
    if (failed >= FAILS_PER_DAY) return { error: "今天验证失败次数太多，已锁定到 UTC 0 点", status: 429 };
    this.sql.exec("UPDATE auth_codes SET attempts = attempts + 1 WHERE email = ?", email);
    const fail = (error: string) => {
      this.set("auth_fails", { day, n: failed + 1 });
      if (failed + 1 >= FAILS_PER_DAY) {
        this.sql.exec("DELETE FROM auth_codes");
        this.alert("登录已锁定", [`今天验证已经错了 ${FAILS_PER_DAY} 次，到 UTC 0 点前任何人都无法登录。`, ...(ctx ? this.origin(ctx.req) : []),
          "", "如果不是你本人在试：有人在猜你的验证码。已有的登录不受影响。"]);
      }
      return { error, status: 401 };
    };
    if (!sameStr(await sha256(`${email}:${code}`), r.hash as string)) return fail("邮箱验证码不对");
    // the email code was right: a wrong TOTP keeps it (within its CODE_TRIES), so the owner can retype just the TOTP
    const step = await totpMatch(tf.secret, totp, tf.last ?? -1);
    if (step === null) {
      if (ctx) this.alert("两步验证码错误", [`有人输对了 ${email} 的邮箱验证码，但两步验证码不对。`, ...this.origin(ctx.req),
        "", "如果不是你本人：你的邮箱可能已经被盗，请立即修改邮箱密码。"]);
      return fail("两步验证码不对（或已用过），请看验证器 App 上的最新数字");
    }
    this.set("totp", { ...tf, last: step }); // each code works once
    this.sql.exec("DELETE FROM auth_codes WHERE email = ?", email);
    this.sql.exec("DELETE FROM kv WHERE k = 'cli_code'");
    if (ctx) this.alert("新登录", [`账号：${email}`, `方式：${ctx.via}`, ...this.origin(ctx.req),
      "", "如果是你本人，无需处理。",
      "如果不是你：在你的主机上运行 noop revoke-sessions，立即踢掉所有登录（手机、浏览器、MCP 连接器），再检查这个邮箱是否被盗。"]);
    return { email };
  }
  /** The bound authenticator, or null (then nobody can sign in). */
  totp(): { secret: string; last?: number; bound?: number } | null { const t = this.get("totp"); return t?.secret ? t : null; }
  async newSession(email: string, ua: string) {
    if (!this.ownerOk(email)) throw new Error("not an owner");
    const session = hex(crypto.getRandomValues(new Uint8Array(32))), now = Date.now();
    this.sql.exec("INSERT INTO sessions (id, email, created, last_seen, ua, scope) VALUES (?, ?, ?, ?, ?, ?)",
      await sha256(session), email, now, now, ua.slice(0, 300), ua.startsWith("mcp:") ? "mcp" : "owner");
    return session;
  }

  // ---- security alerts
  /** How to send mail, or null when email isn't set up (codes then go through `noop login`). */
  mailer(): ((to: string, subject: string, text: string) => Promise<void>) | null {
    let smtp: SmtpCfg | null = null;
    try { smtp = this.env.HUB_SMTP ? JSON.parse(this.env.HUB_SMTP) : null; } catch {}
    if (smtp?.host) return (to, subject, text) => sendMail(smtp!, to, subject, text);
    if (this.env.EMAIL && this.env.HUB_MAIL_FROM) return (to, subject, text) => cfMail(this.env.EMAIL!, this.env.HUB_MAIL_FROM!, to, subject, text);
    return null;
  }
  /** Where a request came from, for an alert: time, IP and place (Cloudflare's view), device. */
  origin(req: Request): string[] {
    const cf = (req as Request & { cf?: Record<string, unknown> }).cf ?? {};
    const place = [cf.country, cf.region, cf.city].filter(Boolean).join(" ");
    return [`时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}（北京时间）`,
      `IP：${req.headers.get("cf-connecting-ip") ?? "未知"}${place ? `（${place}）` : ""}${cf.asOrganization ? ` · ${cf.asOrganization}` : ""}`,
      `设备：${(req.headers.get("user-agent") ?? "未知").slice(0, 200)}`];
  }
  /** A security event: mailed to every HUB_OWNER_EMAIL address and put in the feed. Never blocks or fails the request. */
  alert(title: string, lines: string[]) {
    this.append({ from: "hub", kind: "notice", text: `🔐 ${title}\n${lines.filter(Boolean).join("\n")}` });
    const send = this.mailer();
    if (!send) return;
    const text = `Noop 安全提醒：${title}\n\n${lines.join("\n")}\n`;
    this.ctx.waitUntil(Promise.all(this.owners().map((to) => send(to, `Noop 安全提醒：${title}`, text)
      .catch((err) => console.error(`alert mail to ${to}: ${err}`)))));
  }

  // ---- free-plan budget. Past the daily allowance every DO operation of that kind errors until 00:00 UTC, so the Hub
  // meters itself (requests, and the rows each query really read and wrote) and gets frugal well before the cap:
  // "lean" persists hot state rarely, "shed" refuses fleet chatter (heartbeats, journals, routine notices).
  mem = new Map<string, string>();
  flushed = new Map<string, number>();
  today() {
    const day = new Date().toISOString().slice(0, 10);
    if (this.usage.day !== day) this.usage = { day, requests: 0, rowsRead: 0, rowsWritten: 0 };
    return this.usage;
  }
  /** Count the rows of every query since the last call; persist the counters every few minutes. */
  settle(requests = 1) {
    const u = this.today();
    u.requests += requests;
    for (const c of this.cursors.splice(0)) { u.rowsRead += c.rowsRead; u.rowsWritten += c.rowsWritten; }
    if (Date.now() - this.usageSaved > 5 * 60_000) {
      this.usageSaved = Date.now();
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO kv (k, v) VALUES ('usage', ?)", JSON.stringify(u)); // unmetered: a few hundred rows a day
    }
  }
  /** The tightest of today's allowances, as a fraction of the free plan. */
  used() { const u = this.today(); return Math.max(u.requests / FREE.requests, u.rowsRead / FREE.rowsRead, u.rowsWritten / FREE.rowsWritten); }
  level(): "ok" | "lean" | "shed" { const f = this.used(); return f < LEAN ? "ok" : f < SHED ? "lean" : "shed"; }
  usageView() {
    return { ...this.today(), level: this.level(), dbBytes: this.ctx.storage.sql.databaseSize, free: FREE, target: TARGET,
      sockets: { owner: this.ctx.getWebSockets("owner").length, host: this.ctx.getWebSockets("host").length } };
  }

  get(k: string): any {
    const m = this.mem.get(k);
    if (m !== undefined) return JSON.parse(m);
    const r = this.sql.exec("SELECT v FROM kv WHERE k = ?", k).toArray()[0];
    if (r) this.mem.set(k, r.v as string);
    return r ? JSON.parse(r.v as string) : null;
  }
  /** Writes only when the value changed. Hot keys (status, host_seen) are kept in memory and persisted at most every
   *  HOT_PERSIST_MS (longer when the budget is tight): losing a few minutes of them on eviction is harmless, the daemon re-sends. */
  set(k: string, v: unknown) {
    const s = JSON.stringify(v);
    if (this.mem.get(k) === s) return;
    if (!this.mem.has(k) && this.sql.exec("SELECT v FROM kv WHERE k = ?", k).toArray()[0]?.v === s) { this.mem.set(k, s); return; }
    this.mem.set(k, s);
    if (HOT.has(k)) {
      const lvl = this.level(), every = lvl === "ok" ? HOT_PERSIST_MS : lvl === "lean" ? HOT_PERSIST_MS * 6 : Infinity;
      if (Date.now() - (this.flushed.get(k) ?? 0) < every) return;
    }
    this.flushed.set(k, Date.now());
    this.sql.exec("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)", k, s);
  }
  touchHost() { this.set("host_seen", Date.now()); }

  append(e: Partial<Ev>): Ev {
    const ev = { id: crypto.randomUUID(), ts: new Date().toISOString(), ...e } as Ev;
    this.sql.exec("INSERT INTO events (ts, json, ref) VALUES (?, ?, ?)", ev.ts, JSON.stringify(ev), typeof ev.ref === "string" ? ev.ref : null);
    if (Math.random() < 0.02) this.sql.exec("DELETE FROM events WHERE seq <= (SELECT MAX(seq) - 5000 FROM events)");
    const s = JSON.stringify(ev);
    for (const ws of this.ctx.getWebSockets("owner")) try { ws.send(s); } catch {}
    try { this.mcp.onEvent(ev); } catch (err) { console.error(`mcp: ${err}`); }
    this.pruneMedia();
    const n = this.notification(ev);
    if (n) this.ctx.waitUntil(this.pushAll(n.payload, n.urgency).catch((err) => console.error(`push: ${err}`)));
    return ev;
  }

  /** Media older than settings `media_days` (7, 14, 30 or 90; 7 by default) goes, checked at most hourly. Ids start with Date.now(). */
  pruneMedia(force = false) {
    const now = Date.now();
    if (!force && now - (this.get("media_pruned") ?? 0) < 3_600_000) return;
    this.set("media_pruned", now);
    const s = this.get("settings");
    const want = Number(s?.current?.media_days ?? s?.effective?.media_days);
    const days = [7, 14, 30, 90].includes(want) ? want : 7;
    this.sql.exec("DELETE FROM media WHERE instr(id, '-') = 14 AND CAST(substr(id, 1, 13) AS INTEGER) < ?", now - days * 86_400_000);
  }

  /** Owner→fleet inbox. A waiting long-poll from the primary daemon is answered at once (no polling delay). */
  inboxWaiters = new Set<() => void>();
  acked = 0;
  /** Per-session answer timestamps for the soft throttle below (in-memory is fine: one DO instance, worst case a
   *  restart resets it). Bounds a runaway client or a stolen session to a human pace: the owner events this endpoint
   *  writes are exempt from SHED shedding, so without this an authenticated loop could exhaust the day's free-plan
   *  row writes in minutes and stall the whole account until 00:00 UTC (AGENTS.md hard rule). */
  answerTimes = new Map<string, number[]>();
  /** 20/min and 100/hour per session; returns {error, retry_after} when over. */
  throttled(session: string): { error: string; retry_after: number } | null {
   const now = Date.now();
   const times = (this.answerTimes.get(session) ?? []).filter((t) => now - t < 3600_000);
   if (times.length >= 100 || times.filter((t) => now - t < 60_000).length >= 20)
     return { error: "too many answers; slow down", retry_after: 60 };
   times.push(now);
   this.answerTimes.set(session, times);
   return null;
  }
  toInbox(item: Record<string, unknown>) {
    this.sql.exec("INSERT INTO inbox (json) VALUES (?)", JSON.stringify(item));
    for (const w of [...this.inboxWaiters]) w();
    for (const ws of this.ctx.getWebSockets("host")) try { ws.send('{"type":"inbox"}'); } catch {}
  }

  ownerMessage(text: string, ref?: string, attachments?: string[], thread = false, via?: string): Ev {
    const ev = this.append({ from: "owner", kind: "owner", text, ref, ...(via ? { via } : {}), ...(attachments?.length ? { attachments } : {}), ...(thread ? { thread } : {}) });
    this.toInbox({ type: "message", event: ev });
    if (!this.hostOnline()) this.append({ from: "hub", kind: "system", text: "收到。团队的电脑暂时都不在线，上线后会马上处理。", ref: ev.id });
    return ev;
  }

  /** True while `decisions/open/<id>.md` has no live row in the synced files: a click on an already-answered card
   *  must not re-enter the inbox. Sync lag ≤ one commit cycle makes this a fast pre-filter; the fleet-side check
   *  (cli.ts handleReplies drops replies to closed cards) stays the real idempotency. One primary-key read. */
  cardGone(id: string): boolean {
    try { return this.sql.exec("SELECT 1 FROM files WHERE path = ? AND deleted = 0", `decisions/open/${id}.md`).toArray().length === 0; }
    catch { return false; }
  }

  /** The synced card file's text (open by default, closed for receipts), or "" when absent. One primary-key read. */
  cardContent(id: string, closed = false): string {
    try {
      const r = this.sql.exec("SELECT content FROM files WHERE path = ? AND deleted = 0", `decisions/${closed ? "closed" : "open"}/${id}.md`).toArray()[0];
      if (!r || r.content == null) return "";
      const bytes = r.content instanceof Uint8Array ? r.content : new Uint8Array(r.content as ArrayBuffer);
      return new TextDecoder().decode(bytes);
    } catch { return ""; }
  }

  /** Does this choice pick a risk:"high" option? False for anything unreadable — the fleet-side gates stay the wall. */
  confirmNeeded(id: string, choice: string): boolean {
    return needsConfirm(this.cardContent(id), choice);
  }

  /** Is this card closed BY THE JUDGE (the receipt whose veto button is legitimate)? The veto exemption elsewhere
   *  (409 / confirm gate) applies to judge-ruled cards only, so "override …" cannot smuggle an answer past
   *  the gates onto an open or owner-closed card. */
  judgeClosed(id: string): boolean {
    return /^judge/.test(parseCard(this.cardContent(id, true))?.meta.answered_by ?? "");
  }

  /** The single-card page. No session → the SPA's login flow (?ref=); answered cards render their final state. */
  async cardPage(req: Request, p: string, url: URL): Promise<Response> {
    const raw = (() => { try { return decodeURIComponent(p.slice("/card/".length)); } catch { return ""; } })();
    const id = raw.toUpperCase();
    if (!/^[DLP]-[A-Z]?\d{4}$/.test(id)) return json({ error: "not found" }, 404);
    const who = await this.who(req, url);
    if (!who) return Response.redirect(`${url.origin}/?ref=${encodeURIComponent(id)}`, 302);
    const open = this.cardContent(id), closed = open ? "" : this.cardContent(id, true);
    if (!open && !closed) return json({ error: "not found" }, 404);
    // a machine's HUB_TOKEN never rides the page: its answers would 403 anyway, and the page holds no other secret
    const token = who === "machine" ? "" : this.credential(req, url);
    return new Response(cardPage(id, !!open, open || closed, token, url.origin), { headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store", // the page embeds the session credential: no bfcache / heuristic retention
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    } });
  }

  /** Ephemeral note on the clicker's own screen (never a channel message), best effort, response_url only. */
  slackEphemeral(responseUrl: string, text: string) {
    if (!/^https:\/\/hooks\.slack\.com\//.test(responseUrl)) return;
    void fetch(responseUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) }).catch(() => {});
  }

  /** Slack button click: same ownerMessage as /api/answer, keyed by the shared "slack" throttle bucket. */
  async slackInteractive(req: Request): Promise<Response> {
    const secret = this.env.HUB_SLACK_SIGNING_SECRET;
    if (!secret) return json({ error: "slack interactive not configured" }, 503);
    const body = await req.text();
    if (body.length > 1_000_000) return json({ error: "body too large" }, 413); // Slack payloads are tiny; read it anyway to verify the signature
    if (!(await verifySlack(secret, req.headers.get("x-slack-signature") ?? "", req.headers.get("x-slack-timestamp") ?? "", body)))
      return json({ error: "invalid signature" }, 403);
    const { clicks, responseUrl } = parseSlackPayload(body);
    if (!clicks.length) return json({ error: "no answer action" }, 400); // other interactions: Slack gets no UI change
    const slow = this.throttled("slack"); // user-triggered: one request per human click
    if (slow) return json(slow, { status: 429, headers: { "retry-after": String(slow.retry_after) } });
    const { card, choice } = clicks[0]; // one click per payload in practice; a multi-select tap sends one message
    const vetoable = /^(override|veto)\b/i.test(choice) && this.judgeClosed(card); // the receipt card is closed: its veto rides through
    if (this.cardGone(card) && !vetoable) { this.slackEphemeral(responseUrl, `${card} 已经处理过了`); return json({ ok: true }); }
    if (/^(override|veto)\b/i.test(choice) && !vetoable) { this.slackEphemeral(responseUrl, `无法否决：${card} 不是 judge 代答的卡`); return json({ ok: true }); }
    this.ownerMessage(`${card} ${choice}`, card, undefined, false, "button:slack");
    this.slackEphemeral(responseUrl, `✅ 已记录：${card} → ${choice}`);
    return json({ ok: true });
  }

  /** Discord interaction: PING handshake, or a component click → ownerMessage; the reply is ephemeral (flags 64),
   *  so an answered card never becomes channel noise. */
  async discordInteractive(req: Request): Promise<Response> {
    const pub = this.env.HUB_DISCORD_PUBLIC_KEY;
    if (!pub) return json({ error: "discord interactive not configured" }, 503);
    const body = await req.text();
    if (body.length > 1_000_000) return json({ error: "body too large" }, 413);
    const v = await verifyDiscord(pub, req.headers.get("x-signature-ed25519") ?? "", req.headers.get("x-signature-timestamp") ?? "", body);
    if (v === "bad") return json({ error: "invalid signature" }, 403);
    const b = (() => { try { return JSON.parse(body) as any; } catch { return {}; } })();
    if (v === "unsupported") { // no Ed25519 here: PING still passes so app setup completes, but clicks are never recorded
      if (b?.type === 1) return json({ type: 1 });
      return json({ type: 4, data: { content: "此处暂时无法安全应答，请到网页端处理这张卡。", flags: 64 } });
    }
    if (b?.type === 1) return json({ type: 1 }); // PING
    const click = parseDiscordClick(b);
    if (!click) return json({ type: 4, data: { content: "未识别的按钮。", flags: 64 } });
    const slow = this.throttled("discord");
    if (slow) return json({ type: 4, data: { content: "点得太快了，稍等几秒再试。", flags: 64 } });
    // a judge receipt is already closed: its veto button (and only it) rides through the already-answered filter
    const vetoable = /^(override|veto)\b/i.test(click.choice) && this.judgeClosed(click.card);
    if (this.cardGone(click.card) && !vetoable) return json({ type: 4, data: { content: `${click.card} 已经处理过了`, flags: 64 } });
    if (/^(override|veto)\b/i.test(click.choice) && !vetoable)
      return json({ type: 4, data: { content: `无法否决：${click.card} 不是 judge 代答的卡`, flags: 64 } });
    // Discord buttons have no native confirm: high-risk choices are refused here and pointed at the card page,
    // whose confirm step posts /api/answer with {confirm:true} (notify renders high-risk buttons as links already)
    if (!vetoable && this.confirmNeeded(click.card, click.choice))
      return json({ type: 4, data: { content: `⚠️ 「${click.choice}」是高风险操作：打开 ${new URL(req.url).origin}/card/${click.card} 确认后执行`, flags: 64 } });
    this.ownerMessage(`${click.card} ${click.choice}`, click.card, undefined, false, "button:discord");
    return json({ type: 4, data: { content: `✅ 已记录：${click.card} → ${click.choice}`, flags: 64 } });
  }

  // ---- web push
  vapid(): Vapid | null {
    const { HUB_VAPID_PUBLIC: pub, HUB_VAPID_PRIVATE: priv, HUB_OWNER_EMAIL: owner } = this.env;
    if (!pub || !priv) return null;
    try { return { publicKey: pub, privateJwk: JSON.parse(priv), subject: `mailto:${(owner ?? "").split(",")[0].trim() || "owner@example.com"}` }; } catch { return null; }
  }

  /** Which events become a phone notification, honoring settings.current.notify_prefs. */
  notification(ev: Ev): { payload: Record<string, unknown>; urgency: "normal" | "high" } | null {
    const kind = ev.kind;
    const note = notificationFor(ev, (this.get("settings")?.current?.notify_prefs ?? {}) as NotifyRules);
    if (!note) return null;
    const ref = typeof ev.ref === "string" ? ev.ref : undefined;
    // one-tap banner actions for the safe options only: high-risk ones need their confirm step, so the banner's
    // buttons skip them and a tap opens the app / card page instead (the typed answer from there is deliberate)
    const choices = Array.isArray(ev.choices) ? (ev.choices as { label: unknown; risk?: string }[]) : [];
    const labels = (choices.length ? choices.filter((c) => c.risk !== "high").map((c) => String(c.label))
      : Array.isArray(ev.options) ? ev.options.map(String) : []);
    const opts = labels.map((o) => o.slice(0, 20)).slice(0, 3);
    const decisions = (this.get("status")?.decisions ?? []) as { held?: boolean }[];
    return {
      urgency: kind === "decision" || kind === "login" ? "high" : "normal",
      payload: {
        ...note,
        ref, kind, options: kind === "decision" || kind === "menu" ? opts : [],
        url: ref ? `/?ref=${encodeURIComponent(ref)}` : "/", tag: ref ?? kind,
        badge: decisions.filter((d) => !d.held).length,
      },
    };
  }

  async pushAll(payload: unknown, urgency: "normal" | "high", only?: string) {
    const v = this.vapid();
    if (!v) return { sent: 0, removed: 0, error: "vapid not configured" };
    const rows = only ? this.sql.exec("SELECT * FROM push_subs WHERE session = ?", only).toArray() : this.sql.exec("SELECT * FROM push_subs").toArray();
    let sent = 0, removed = 0;
    await Promise.all(rows.map(async (r) => {
      const sub: PushSub = { endpoint: r.endpoint as string, keys: { p256dh: r.p256dh as string, auth: r.auth as string } };
      const tag = (payload as { tag?: string }).tag;
      const st = await sendPush(sub, payload, v, { ttl: 86400, urgency, topic: tag }).catch(() => 0);
      if (st === 404 || st === 410) { this.sql.exec("DELETE FROM push_subs WHERE endpoint = ?", sub.endpoint); removed++; }
      else if (st >= 200 && st < 300) sent++;
      else console.error(`push ${new URL(sub.endpoint).host}: HTTP ${st}`);
    }));
    return { sent, removed, total: rows.length };
  }

  async push(p: string, req: Request, who: "machine" | { session: string; scope: string }): Promise<Response> {
    if (p === "/api/push/vapid") { const v = this.vapid(); return v ? json({ publicKey: v.publicKey }) : json({ error: "push not configured" }, 503); }
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    const b = (await req.json().catch(() => ({}))) as any;
    if (p === "/api/push/answer") {
      const ref = typeof b?.ref === "string" ? b.ref.trim().toUpperCase() : "", answer = typeof b?.answer === "string" ? b.answer.trim() : "";
      if (!ref || !answer) return json({ error: "ref and answer required" }, 400);
      const vetoable = /^(override|veto)\b/i.test(answer) && this.judgeClosed(ref); // same veto rules as /api/answer
      const slow = this.throttled(who === "machine" ? "push" : who.session); // same human-pace bucket, before the 409s
      if (slow) return json(slow, { status: 429, headers: { "retry-after": String(slow.retry_after) } });
      if (this.cardGone(ref) && !vetoable) return json({ error: `${ref} is already resolved`, ref }, 409);
      if (/^(override|veto)\b/i.test(answer) && !vetoable) return json({ error: `${ref} is not a judge-ruled card; veto does not apply`, ref }, 409);
      if (!vetoable && this.confirmNeeded(ref, answer))
        return json({ error: "confirm required for a high-risk choice: open the card instead", ref }, 409);
      return json(this.ownerMessage(`${ref} ${answer}`, ref, undefined, false, "push_action:web"));
    }
    if (who === "machine") return json({ error: "owner session required" }, 403);
    if (p === "/api/push/subscribe") {
      const s = b?.subscription;
      if (typeof s?.endpoint !== "string" || !/^https:\/\/|^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(s.endpoint) || typeof s?.keys?.p256dh !== "string" || typeof s?.keys?.auth !== "string")
        return json({ error: "invalid subscription" }, 400);
      this.sql.exec(`INSERT INTO push_subs (endpoint, session, p256dh, auth, label, created) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET session = excluded.session, p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label`,
        s.endpoint, who.session, s.keys.p256dh, s.keys.auth, String(b.device_label ?? "").slice(0, 80), Date.now());
      return json({ ok: true });
    }
    if (p === "/api/push/unsubscribe") {
      this.sql.exec("DELETE FROM push_subs WHERE endpoint = ? AND session = ?", String(b?.endpoint ?? ""), who.session);
      return json({ ok: true });
    }
    if (p === "/api/push/test") {
      const r = await this.pushAll({ title: "Noop", body: "测试通知：手机推送已开通。", kind: "notice", url: "/", tag: "test", options: [], badge: 0 }, "normal", who.session);
      return json({ ok: true, ...r });
    }
    return json({ error: "not found" }, 404);
  }

  hostOnline() { if (this.ctx.getWebSockets("host").length) return true; const seen = this.get("host_seen"); return !!seen && Date.now() - seen < STALE_MS; }
  /** The primary pushes live agent activity only while someone looks: tell it when that changes. */
  tellWatchers() {
    const n = this.ctx.getWebSockets("owner").filter((ws) => ws.readyState === WebSocket.OPEN).length;
    for (const ws of this.ctx.getWebSockets("host")) try { ws.send(JSON.stringify({ type: "watchers", n })); } catch {}
  }
  /** Owner clients that asked for status frames (?v=2) get the dashboard pushed instead of polling for it. */
  pushStatus() {
    const s = JSON.stringify({ $status: this.statusView() });
    for (const ws of this.ctx.getWebSockets("v2")) try { ws.send(s); } catch {}
  }

  // ---- auth
  credential(req: Request, url: URL) {
    const h = req.headers.get("authorization") ?? "";
    return h.startsWith("Bearer ") ? h.slice(7).trim() : url.searchParams.get("token") ?? ""; // WebSocket / <img> can't send headers
  }
  /** The owner allow-list (HUB_OWNER_EMAIL). Empty only before email is set up, when codes are shown by `noop login`. */
  owners() { return (this.env.HUB_OWNER_EMAIL ?? "").split(",").map(normEmail).filter(Boolean); }
  ownerOk(email: unknown) { const o = this.owners(); return !o.length || o.includes(normEmail(email)); }
  /** "machine" for HUB_TOKEN, the session for an owner session, null otherwise. A session whose email left the
   *  allow-list, or that went unused for SESSION_IDLE_MS, is deleted on sight. */
  async who(req: Request, url: URL): Promise<"machine" | { session: string; scope: "owner" | "mcp" } | null> {
    const t = this.credential(req, url);
    if (!t) return null;
    if (sameStr(t, this.env.HUB_TOKEN)) return "machine";
    if (!/^[0-9a-f]{64}$/.test(t)) return null;
    const id = await sha256(t); // store only hashes of session ids
    const r = this.sql.exec("SELECT last_seen, email, ua, scope FROM sessions WHERE id = ?", id).toArray()[0];
    if (!r) return null;
    const now = Date.now();
    if (!this.ownerOk(r.email) || now - (r.last_seen as number) > SESSION_IDLE_MS) {
      this.sql.exec("DELETE FROM sessions WHERE id = ?", id);
      this.sql.exec("DELETE FROM push_subs WHERE session = ?", id);
      return null;
    }
    if (now - (r.last_seen as number) > SEEN_EVERY) this.sql.exec("UPDATE sessions SET last_seen = ? WHERE id = ?", now, id);
    const scope = r.scope === "mcp" || (r.scope == null && String(r.ua ?? "").startsWith("mcp:")) ? "mcp" : "owner";
    return { session: id, scope };
  }

  async auth(p: string, req: Request): Promise<Response> {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    const body = (await req.json().catch(() => null)) as { email?: unknown; code?: unknown } | null;
    const now = Date.now();
    if (p === "/api/auth/start") {
      const email = normEmail(body?.email);
      if (!validEmail(email)) return json({ error: "invalid email" }, 400);
      const owners = this.owners();
      // Only the allow-list may sign in: anyone else is told so at once, with no code, no mail and no row written.
      if (owners.length && !owners.includes(email)) return json({ error: "这个邮箱不允许登录" }, 403);
      if (!this.totp()) return json({ error: "totp_not_setup", message: TOTP_MISSING }, 403); // no mail for a sign-in that can't finish
      // No email set up yet: the code is shown on the owner's own machine instead (`noop login`, needs the machine key).
      const send = this.mailer(), cli = !send;
      this.sql.exec("DELETE FROM auth_sends WHERE ts < ?", now - 3600_000);
            const recent = this.sql.exec("SELECT COUNT(*) AS n FROM auth_sends WHERE email = ? AND ts > ?", email, now - RESEND_MS).one().n as number;
      if (recent) return json({ error: "请稍等一分钟再重新获取验证码" }, 429);
      const sent = this.sql.exec("SELECT COUNT(*) AS n FROM auth_sends WHERE sent = 1").one().n as number;
      if (sent >= SENDS_PER_HOUR) return json({ error: "验证码发送太频繁，请一小时后再试" }, 429);
      const isOwner = owners.includes(email) || (cli && !owners.length);
      this.sql.exec("INSERT INTO auth_sends (email, ts, sent) VALUES (?, ?, ?)", email, now, isOwner ? 1 : 0);
      if (!isOwner) return json({ error: "这个邮箱不允许登录" }, 403); // no allow-list and email set up: nobody is the owner
      const code = newCode();
      this.sql.exec("INSERT OR REPLACE INTO auth_codes (email, hash, expires, attempts) VALUES (?, ?, ?, 0)", email, await sha256(`${email}:${code}`), now + CODE_TTL);
      if (cli) { this.set("cli_code", { email, code, expires: now + CODE_TTL }); return json({ ok: true, delivery: "cli" }); }
      try {
        const subject = `Noop 登录验证码：${code}`;
        const text = `你的 Noop 登录验证码是：\n\n    ${code}\n\n10 分钟内有效。\n\n如果不是你本人操作，请忽略这封邮件。\n`;
        await send!(email, subject, text);
      } catch (err) {
        console.error(`auth mail failed: ${err}`);
        this.sql.exec("DELETE FROM auth_codes WHERE email = ?", email);
        return json({ error: "验证码邮件发送失败，请稍后再试" }, 502);
      }
      return json({ ok: true });
    }
    if (p === "/api/auth/verify") {
      const r = await this.checkCode(body?.email, body?.code, (body as { totp?: unknown } | null)?.totp, { req, via: "App / 浏览器登录" });
      if (!r.email) return json({ error: r.error }, r.status ?? 401);
      return json({ session: await this.newSession(r.email, req.headers.get("user-agent") ?? "") });
    }
    if (p === "/api/auth/logout") {
      const w = await this.who(req, new URL(req.url));
      if (w && w !== "machine") {
        this.sql.exec("DELETE FROM sessions WHERE id = ?", w.session);
        this.sql.exec("DELETE FROM push_subs WHERE session = ?", w.session);
      }
      return json({ ok: true });
    }
    return json({ error: "not found" }, 404);
  }

  async fetch(req: Request): Promise<Response> {
    try { return await this.handle(req); } finally { this.settle(); }
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname, m = req.method;

    if (p.startsWith("/api/auth/")) return this.auth(p, req);
    if (isMcpPath(p)) return this.mcp.fetch(req, await this.who(req, url));
    // channel callbacks carry their own signature (Slack HMAC / Discord Ed25519), not a Bearer credential
    if (p === "/api/slack/interactive" && m === "POST") return this.slackInteractive(req);
    if (p === "/api/discord/interactive" && m === "POST") return this.discordInteractive(req);
    // the single-card page: no session → the SPA's login flow (same ?ref= target pushes already use)
    if (p.startsWith("/card/") && m === "GET") return this.cardPage(req, p, url);
    const who = await this.who(req, url);
    // a connector's OAuth token is for /mcp only: never the owner API (settings, machine key via /api/host/join, …)
    if (who && who !== "machine" && who.scope === "mcp") return json({ error: "forbidden" }, 403);
    // ntfy banner buttons hold the answer-only token (HUB_ANSWER_TOKEN): the bypass below admits it to exactly ONE
    // route, POST /api/answer — it may record card answers, nothing else. Scope it to the path, or a null who
    // would pass every "owner unless machine" route below, up to /api/host/join which hands out HUB_TOKEN. (The
    // Actions header hands this token to the ntfy server, a third party, so it must never be HUB_TOKEN.)
    const pushAnswer = !who && p === "/api/answer" && m === "POST" && !!this.env.HUB_ANSWER_TOKEN && sameStr(this.credential(req, url), this.env.HUB_ANSWER_TOKEN);
    if (!who && !pushAnswer) return json({ error: "unauthorized" }, 401);
    if (p.startsWith("/api/push/")) return this.push(p, req, who);
    if (p === "/api/answer" && m === "POST") { // one answer endpoint for every channel; a machine never answers
      if (who === "machine") return json({ error: "owner session required" }, 403);
      const body = (await req.json().catch(() => ({}))) as any;
      const a = parseAnswer(body);
      if ("error" in a) return json({ error: a.error }, 400);
      const veto = /^(override|veto)\b/i.test(a.choice);
      const vetoable = veto && this.judgeClosed(a.ref); // only a judge receipt may be vetoed — "override …" on an
      // open or owner-closed card is refused here instead of slipping past both gates as a literal answer
      const slow = this.throttled(who ? who.session : "push"); // ahead of the 409s: state probes share the human bucket
      if (slow) return json(slow, { status: 429, headers: { "retry-after": String(slow.retry_after) } });
      // resolved cards take only a veto of a judge ruling (the receipt flow); everything else is answered once
      if (this.cardGone(a.ref) && !vetoable) return json({ error: `${a.ref} is already resolved` }, 409);
      if (veto && !vetoable) return json({ error: `${a.ref} is not a judge-ruled card; veto does not apply` }, 409);
      // high-risk options take two deliberate steps: without {confirm:true} the answer is refused and the client
      // (card page, app) shows its confirm state. Slack's own dialog gates its clicks; the typed chat path never
      // comes through here, so `D-0012 A` on a gated card keeps working.
      if (!vetoable && !body.confirm && this.confirmNeeded(a.ref, a.choice))
        return json({ error: "confirm required for a high-risk choice", card: a.ref, choice: a.choice }, 409);
      const via = pushAnswer ? "push_action:ntfy" // banner actions carry the answer-only token
        : typeof body.via === "string" && body.via ? body.via.replace(/[^\w:-]/g, "").slice(0, 24) : "card_page:web";
      return json(this.ownerMessage(a.text, a.ref, undefined, false, via));
    }
    if ((p === "/api/files/list" || p === "/api/files/read") && m === "GET") { // owner (and machine) read of READABLE prefixes
      const r = handleReadFiles(this.sql, url);
      if (r) return r;
    }
    if (p === "/api/files/commit" && m === "POST" && this.level() === "shed") { // over budget: heartbeats and journals wait
      const b = (await req.clone().json().catch(() => null)) as { changes?: { path?: string }[] } | null;
      if (b?.changes?.length && b.changes.every((c) => latestOnly(String(c.path ?? ""))))
        return Response.json({ error: "over the daily budget", retry_after: 600 }, { status: 429, headers: { "retry-after": "600" } });
    }
    if (p.startsWith("/api/files/")) {
      const ownerOnly = p === "/api/files/history" || p === "/api/files/revert";
      if (ownerOnly ? who === "machine" : who !== "machine") return json({ error: "forbidden" }, 403);
      const actor = who === "machine" ? (req.headers.get("x-noop-host") ?? "machine") : "owner";
      const rev0 = Number(this.sql.exec("SELECT COALESCE(MAX(rev), 0) AS n FROM files").one().n);
      const r = await handleFiles(this.sql, req, url, actor);
      if (r && m === "POST") { // tasks / decisions changed → MCP resources/updated
        const paths = this.sql.exec("SELECT path FROM files WHERE rev > ?", rev0).toArray().map((x) => String(x.path));
        const uris = new Set<string>();
        for (const f of paths) {
          const t = f.match(/^tasks\/[^/]+\/(T-[^/]+)\.md$/)?.[1];
          if (t) { uris.add(`noop://tasks/${t}`); uris.add("noop://status"); }
          if (f.startsWith("decisions/")) uris.add("noop://decisions");
        }
        if (uris.size) this.mcp.onChanged([...uris]);
      }
      if (r) return r;
    }
    // Two-factor binding, from a machine only (the machine key is the root of trust; a stolen mailbox can't bind):
    //   GET /api/host/2fa → {bound, since} · POST /api/host/2fa/setup → {secret, uri} (pending)
    //   POST /api/host/2fa/confirm {totp} → binds the pending secret once a code from the app matches it
    if (p.startsWith("/api/host/2fa")) {
      if (who !== "machine") return json({ error: "forbidden" }, 403);
      const host = req.headers.get("x-noop-host") ?? "持有机器密钥的主机";
      if (p === "/api/host/2fa" && m === "GET") { // also what `noop security` can't see from config.toml: the live allow-list
        const t = this.totp(), allow = parseAllowList(this.env.HUB_ALLOW_IPS);
        return json({ bound: !!t, since: t?.bound ?? null, allow_ips: this.env.HUB_ALLOW_IPS?.trim() ? allow.nets.length : null });
      }
      if (p === "/api/host/2fa/setup" && m === "POST") {
        const secret = newSecret();
        this.set("totp_pending", { secret, expires: Date.now() + 10 * 60_000 });
        return json({ secret, uri: otpauthUri(secret, this.owners()[0] ?? "owner") });
      }
      if (p === "/api/host/2fa/confirm" && m === "POST") {
        const { totp } = (await req.json().catch(() => ({}))) as { totp?: unknown };
        const pend = this.get("totp_pending");
        if (!pend?.secret || pend.expires < Date.now()) return json({ error: "没有待确认的绑定（10 分钟内有效），重新运行 noop 2fa setup" }, 400);
        const step = await totpMatch(pend.secret, totp);
        if (step === null) return json({ error: "两步验证码不对：确认手机时间准确，输入验证器 App 上的最新数字" }, 400);
        const was = !!this.totp();
        this.set("totp", { secret: pend.secret, last: step, bound: Date.now() });
        this.sql.exec("DELETE FROM kv WHERE k = 'totp_pending'"); this.mem.delete("totp_pending");
        this.alert(was ? "两步验证已换绑" : "两步验证已开启", [`操作方：${host}`, `时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}（北京时间）`,
          "", was ? "旧的验证器从现在起失效。如果不是你本人操作：有人拿到了你的机器密钥，立即检查你的主机。" : "从现在起，登录需要邮箱验证码 + 验证器 App 上的两步验证码。"]);
        return json({ ok: true, replaced: was });
      }
      return json({ error: "not found" }, 404);
    }
    if (p === "/api/host/login-code") { // `noop login` on the owner's machine, when email isn't configured
      if (who !== "machine") return json({ error: "forbidden" }, 403);
      const c = this.get("cli_code");
      return c && c.expires > Date.now() ? json(c) : json({ error: "no pending code" }, 404);
    }
    if (p === "/api/host/join" && m === "POST") { // a new machine, approved by the owner's login, gets the machine key
      if (who === "machine") return json({ error: "forbidden" }, 403);
      const { host } = (await req.json().catch(() => ({}))) as { host?: string };
      this.append({ from: "hub", kind: "notice", text: `新机器 ${String(host ?? "?").slice(0, 60)} 已加入团队。` });
      return json({ token: this.env.HUB_TOKEN });
    }
    if (p === "/api/host/revoke-sessions" && m === "POST") {
      await req.text().catch(() => ""); // drain body
      if (who !== "machine") return json({ error: "forbidden" }, 403);
      const n = this.sql.exec("SELECT COUNT(*) AS n FROM sessions").one().n;
      this.sql.exec("DELETE FROM sessions");
      this.sql.exec("DELETE FROM push_subs");
      // connectors too: a refresh token would otherwise mint a fresh session right back
      this.sql.exec("DELETE FROM oauth_refresh");
      this.sql.exec("DELETE FROM oauth_codes");
      this.sql.exec("DELETE FROM auth_codes");
      this.alert("所有登录已撤销", [`${n} 个登录（手机、浏览器、MCP 连接器）已被踢下线，需要重新用邮箱验证码登录。`, `操作方：${req.headers.get("x-noop-host") ?? "持有机器密钥的主机"}`]);
      return json({ ok: true, revoked: n });
    }
    // Moving the hub to another Cloudflare account, one page at a time (media blobs are large):
    //   GET /api/host/export → {tables: {name: rows}} · GET /api/host/export?table=t&offset=0&limit=50 → {rows}
    //   POST /api/host/import {table, rows, reset} (reset empties the table first)
    if (p === "/api/host/export" && m === "GET") {
      if (who !== "machine") return json({ error: "forbidden" }, 403);
      const t = url.searchParams.get("table");
      const names = this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").toArray().map((r) => r.name as string);
      if (!t) return json({ tables: Object.fromEntries(names.map((n) => [n, this.sql.exec(`SELECT COUNT(*) AS n FROM "${n}"`).one().n])) });
      if (!names.includes(t)) return json({ error: "no such table" }, 404);
      // ?after=<rowid of the last row> walks the table by key; ?offset= (old copiers) re-reads every skipped row
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 1000), after = url.searchParams.get("after");
      const rows = (after != null
        ? this.sql.exec(`SELECT rowid AS _rowid, * FROM "${t}" WHERE rowid > ? ORDER BY rowid LIMIT ?`, Number(after), limit)
        : this.sql.exec(`SELECT rowid AS _rowid, * FROM "${t}" ORDER BY rowid LIMIT ? OFFSET ?`, limit, Number(url.searchParams.get("offset") ?? 0))).toArray().map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) =>
        [k, v instanceof ArrayBuffer ? { $b64: b64enc(new Uint8Array(v)) } : v])));
      return json({ rows });
    }
    if (p === "/api/host/import" && m === "POST") {
      if (who !== "machine") return json({ error: "forbidden" }, 403);
      const { table: t, rows, reset } = (await req.json()) as { table: string; rows: Record<string, unknown>[]; reset?: boolean };
      const known = new Set(this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").toArray().map((r) => r.name as string));
      if (!known.has(t)) return json({ error: "no such table" }, 404);
      this.ctx.storage.transactionSync(() => {
        if (reset) this.sql.exec(`DELETE FROM "${t}"`);
        for (const r of rows) {
          const cols = Object.keys(r).filter((c) => c !== "_rowid"); // the export's paging key
          const vals = cols.map((c) => { const v = r[c] as any; return v && typeof v === "object" && "$b64" in v ? b64dec(v.$b64) : v; });
          this.sql.exec(`INSERT OR REPLACE INTO "${t}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`, ...vals);
        }
      });
      return json({ ok: true, n: rows.length });
    }
    if (p === "/api/stream") {
      if (req.headers.get("upgrade") !== "websocket") return json({ error: "websocket expected" }, 426);
      const [client, server] = Object.values(new WebSocketPair());
      // ?v=2 clients take {"$status": …} frames, so they need not poll /api/status
      this.ctx.acceptWebSocket(server, url.searchParams.get("v") === "2" ? ["owner", "v2"] : ["owner"]);
      this.tellWatchers();
      return new Response(null, { status: 101, webSocket: client });
    }
    if (p === "/api/usage" && m === "GET") return json(this.usageView());

    if (p === "/api/feed") {
      const since = url.searchParams.get("since") ?? "";
      const rows = this.sql.exec("SELECT json FROM (SELECT seq, json FROM events WHERE ts > ? ORDER BY ts DESC LIMIT 300) ORDER BY seq", since).toArray();
      return json({ events: rows.map((r) => JSON.parse(r.json as string)) });
    }

    if (p === "/api/messages" && m === "POST") {
      const { text = "", reply_to, attachments, thread } = (await req.json()) as { text?: string; reply_to?: string; attachments?: unknown; thread?: unknown };
      const files = ownerAttachments(attachments);
      if (files === null) return json({ error: "bad attachments" }, 400);
      if (files.some((f) => !this.sql.exec("SELECT 1 FROM media WHERE id = ? LIMIT 1", f.slice(7)).toArray().length))
        return json({ error: "attachment not found" }, 400);
      if (!text.trim() && !files.length) return json({ error: "text required" }, 400);
      return json(this.ownerMessage(text, reply_to, files, thread === true && /^T-/.test(reply_to ?? ""), "text:chat"));
    }

    // The owner's images for a message (paste / drop / pick in the app): images only, ≤ 10 MB, kept with the media.
    if (p === "/api/uploads" && m === "POST") {
      const f = (await req.formData().catch(() => null))?.get("file") as File | null;
      if (!f || typeof f === "string") return json({ error: "file required" }, 400);
      const bytes = new Uint8Array(await f.arrayBuffer());
      const type = sniffImage(bytes.subarray(0, 16), f.type);
      const bad = uploadProblem(type, f.size);
      if (bad) return json({ error: bad.error }, bad.status);
      const id = uploadId(f.name);
      for (let i = 0, n = 0; i < bytes.length; i += CHUNK, n++)
        this.sql.exec("INSERT INTO media (id, n, type, data) VALUES (?, ?, ?, ?)", id, n, type, bytes.slice(i, i + CHUNK));
      return json({ url: `/media/${id}` });
    }

    if (p === "/api/status") return json(this.statusView());

    if (p === "/api/settings" && m === "GET") return json(this.get("settings") ?? { current: {}, effective: {}, options: {} });
    if (p === "/api/tasks" && m === "GET") {
      return json(taskHistory(this.mcp.store(), { query: url.searchParams.get("q") ?? "", offset: Number(url.searchParams.get("offset")), limit: Number(url.searchParams.get("limit")) }));
    }
    if (p === "/api/tasks/get" && m === "GET") {
      const t = taskInfo(this.mcp.store(), url.searchParams.get("id") ?? "");
      if (!t) return json({ error: "not found" }, 404);
      // its whole conversation, however far back: the feed the app holds only has the newest events
      const refs = [t.id, ...t.decisions];
      const rows = this.sql.exec(`SELECT json FROM events WHERE ref IN (${refs.map(() => "?").join(",")}) ORDER BY seq`, ...refs).toArray();
      return json({ ...t, events: rows.map((r) => JSON.parse(r.json as string)) });
    }
    if (p === "/api/tasks/cancel" && m === "POST") { // owner: cancel a task; the primary host acts on it
      if (who === "machine") return json({ error: "forbidden" }, 403);
      const { id, done } = (await req.json().catch(() => ({}))) as { id?: string; done?: boolean };
      if (!id || !/^T-[\w]*\d{4}$/.test(id)) return json({ error: "id required" }, 400);
      this.toInbox({ type: "cancel", id, done: done === true });
      return json({ ok: true });
    }
    if (p === "/api/channels" && m === "GET") return json(channelsView(this.mcp.store()));
    if (p === "/api/channels" && m === "POST") { // owner: edit a channel's goal / archive it; the primary writes the file
      if (who === "machine") return json({ error: "forbidden" }, 403);
      const { slug, goal, archived } = (await req.json().catch(() => ({}))) as { slug?: string; goal?: unknown; archived?: unknown };
      if (!slug || !CHANNEL_SLUG.test(slug)) return json({ error: "slug required" }, 400);
      this.toInbox({ type: "channel", slug, ...(typeof goal === "string" ? { goal: goal.slice(0, 500) } : {}), ...(typeof archived === "boolean" ? { archived } : {}) });
      return json({ ok: true });
    }
    if (p === "/api/fleet/update" && m === "POST") { // owner: every machine updates to the latest code; the primary acts on it
      if (who === "machine") return json({ error: "forbidden" }, 403);
      this.toInbox({ type: "update" });
      return json({ ok: true });
    }
    if (p === "/api/settings" && m === "PUT") {
      const patch = await req.json();
      this.toInbox({ type: "settings", patch });
      const view = this.get("settings") ?? { current: {} };
      const deep = (a: any, b: any): any => { const o = { ...a }; for (const [k, v] of Object.entries(b ?? {})) o[k] = v && typeof v === "object" && !Array.isArray(v) ? deep(o[k] ?? {}, v) : v; return o; };
      view.current = deep(view.current ?? {}, patch);
      this.set("settings", view);
      if (patch && typeof patch === "object" && "media_days" in patch) this.pruneMedia(true);
      return json(view);
    }

    if (p === "/api/media" && m === "POST") {
      const f = (await req.formData()).get("file") as File | null;
      if (!f) return json({ error: "file required" }, 400);
      if (f.size > MAX_MEDIA) return json({ error: "file too large" }, 413);
      const id = `${Date.now()}-${f.name.replace(/[^\w.\-]/g, "_")}`;
      const buf = new Uint8Array(await f.arrayBuffer());
      for (let i = 0, n = 0; i < buf.length; i += CHUNK, n++)
        this.sql.exec("INSERT INTO media (id, n, type, data) VALUES (?, ?, ?, ?)", id, n, f.type || "application/octet-stream", buf.slice(i, i + CHUNK));
      return json({ url: `/media/${id}` });
    }
    if (p.startsWith("/media/")) {
      const id = decodeURIComponent(p.slice(7));
      const rows = this.sql.exec("SELECT type, data FROM media WHERE id = ? ORDER BY n", id).toArray();
      if (!rows.length) return json({ error: "not found" }, 404);
      const parts = rows.map((r) => new Uint8Array(r.data as ArrayBuffer));
      return new Response(new Blob(parts), { headers: mediaHeaders(rows[0].type as string, id) });
    }

    // ---- fleet side
    if (p === "/api/events" && m === "POST") {
      const e = (await req.json()) as Partial<Ev>;
      // over budget, routine fleet chatter is dropped (still in the local journal); what the owner must see still goes through
      if (this.level() === "shed" && SHEDDABLE.has(String(e.kind ?? ""))) return json({ dropped: "write budget" });
      return json(this.append(e));
    }
    if (p === "/api/host/state" && m === "PUT") {
      const { status, settings } = (await req.json()) as { status?: unknown; settings?: unknown };
      // over budget the dashboard refreshes at most every 10 minutes
      const shed = this.level() === "shed" && Date.now() - (this.flushed.get("status_at") ?? 0) < 10 * 60_000;
      if (status && !shed) { this.flushed.set("status_at", Date.now()); this.set("status", status); this.mcp.onChanged(["noop://status"]); this.pushStatus(); }
      if (settings) this.set("settings", settings);
      this.touchHost();
      // watchers: owner clients connected right now. With none, the primary skips live-activity-only refreshes.
      return json({ ok: true, watchers: this.ctx.getWebSockets("owner").length, level: this.level() });
    }
    if (p === "/api/host/stream") { // the daemon's hibernating socket: a nudge per inbox item instead of a long-poll
      if (who !== "machine") return json({ error: "forbidden" }, 403);
      if (req.headers.get("upgrade") !== "websocket") return json({ error: "websocket expected" }, 426);
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, ["host"]);
      this.touchHost();
      this.pushStatus();
      this.tellWatchers();
      return new Response(null, { status: 101, webSocket: client });
    }
    if (p === "/api/host/inbox") {
      const after = Number(url.searchParams.get("after") ?? 0);
      if (after > this.acked) { this.sql.exec("DELETE FROM inbox WHERE seq <= ?", after); this.acked = after; } // acked
      this.touchHost();
      const read = () => this.sql.exec("SELECT seq, json FROM inbox ORDER BY seq LIMIT 50").toArray()
        .map((r) => ({ seq: r.seq as number, ...JSON.parse(r.json as string) }));
      let items = read();
      // long-poll (?wait=<s>, ≤ 25): hold the request until something arrives, so an owner message reaches the
      // daemon in milliseconds instead of on its next poll
      const wait = Math.max(0, Math.min(Number(url.searchParams.get("wait")) || 0, 25)) * 1000;
      if (!items.length && wait) {
        await new Promise<void>((res) => {
          const done = () => { clearTimeout(t); this.inboxWaiters.delete(done); res(); };
          const t = setTimeout(done, wait);
          this.inboxWaiters.add(done);
          req.signal?.addEventListener?.("abort", done);
        });
        this.touchHost();
        items = read();
      }
      return json({ items });
    }
    return json({ error: "not found" }, 404);
  }

  webSocketMessage() { this.settle(1 / 20); } // incoming frames bill as 1/20 of a request (pings are auto-answered)
  webSocketClose(ws: WebSocket) {
    try { ws.close(); } catch {}
    const tags = this.ctx.getTags(ws);
    if (tags.includes("host")) { this.touchHost(); this.pushStatus(); }
    if (tags.includes("owner")) this.tellWatchers();
    this.settle(0);
  }
}

