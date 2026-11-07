// Remote MCP server for noop: lets Claude (claude.ai connectors, Claude Code) and ChatGPT (connectors / developer mode)
// read the fleet's state, talk to it like the owner does in chat, and receive live events.
//
// Transport: MCP Streamable HTTP (spec 2025-06-18 / 2025-11-25), hand-rolled JSON-RPC — no SDK dependency.
//   POST   /mcp  one JSON-RPC message → application/json response (202 for notifications / responses)
//   POST   tools/call that reports progress (or wait_for_events) with Accept: text/event-stream → SSE: notifications/progress, then the response
//   GET    /mcp  Accept: text/event-stream → server→client notifications for this Mcp-Session-Id; Last-Event-ID resumes any stream
//   DELETE /mcp  ends the session
// Sessions: 400 without Mcp-Session-Id, 404 when unknown or idle > 24h (client re-initializes); MCP-Protocol-Version validated.
// Every SSE message has an id (<stream>.<seq>) and is kept for replay (15 min / 500 per stream); `retry:` hint, keep-alive comments.
// notifications/cancelled aborts the matching in-flight request (no response is sent); resources/list_changed when open tasks/decisions change.
// Notifications: every hub event as notifications/message (logger "noop", honours logging/setLevel), and
//   notifications/resources/updated for subscribed resources (noop://status, noop://feed, noop://tasks/<id>).
//   Clients that ignore notifications can poll with the `wait_for_events` tool.
// Auth (Bearer): HUB_TOKEN, an owner session, or an OAuth 2.1 access token (which *is* an owner session, minted by
//   /oauth/token after the owner signs in with the email code). Unauthenticated → 401 + WWW-Authenticate pointing at
//   /.well-known/oauth-protected-resource, which leads to /.well-known/oauth-authorization-server:
//   POST /oauth/register (dynamic client registration, public clients + PKCE S256 only)
//   GET|POST /oauth/authorize (email-code sign-in page) · POST /oauth/token (authorization_code, refresh_token)
// Never exposed: merge, release, settings, machine credentials.

import { type Ev, type FileRow, type ToolStore, type WriteOp, DECISION_ID, TASK_ID, feedView, getTask, listDecisions, listTasks, runTool, statusView, toolsFor } from "./tools";
export { parseDoc, listTasks, getTask, listDecisions } from "./tools";

export interface McpSql { exec(query: string, ...bindings: any[]): { toArray(): any[] } }

/** What the MCP layer needs from the Hub Durable Object. */
export interface McpHost {
  sql: McpSql;
  status(): any;
  /** Events with seq > after (oldest first). */
  events(after: number, limit: number): { seq: number; ev: Ev }[];
  /** Same as POST /api/messages from the owner. */
  say(text: string, ref?: string): Ev;
  /** Hands a write to the primary daemon (owner→fleet inbox), which performs it on the data repo. */
  enqueue(op: WriteOp): void;
  /** Is the primary daemon connected? (writes queue until it is) */
  hostOnline?(): boolean;
  /** Email-code sign-in, reused from /api/auth/*. */
  startCode(email: string): Promise<{ status: number; body: any }>;
  /** Checks the code; on success returns the email (no browser session is created). */
  /** Email code + the authenticator's TOTP (mandatory second factor). */
  checkCode(email: string, code: string, totp: string, ctx?: { req: Request; via: string }): Promise<{ email?: string; error?: string }>;
  /** Creates an owner session for this email; returns the raw bearer token. */
  newSession(email: string, ua: string): Promise<string>;
  dropSession(raw: string): Promise<void>;
}

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const SERVER_INFO = { name: "noop", title: "Noop", version: "1.0.0" };
const LEVELS = ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"];
const OAUTH_CODE_TTL = 5 * 60_000;

export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id",
  "access-control-expose-headers": "mcp-session-id, www-authenticate",
};
const json = (d: unknown, status = 200, h: Record<string, string> = {}) => Response.json(d, { status, headers: { ...CORS, ...h } });
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const rand = (n = 32) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
export const b64url = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const pkceChallenge = async (verifier: string) => b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function initMcpSchema(sql: McpSql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS oauth_clients (id TEXT PRIMARY KEY, json TEXT, created INTEGER);
    CREATE TABLE IF NOT EXISTS oauth_codes (hash TEXT PRIMARY KEY, client_id TEXT, redirect_uri TEXT, challenge TEXT, email TEXT, expires INTEGER);
    CREATE TABLE IF NOT EXISTS oauth_refresh (hash TEXT PRIMARY KEY, client_id TEXT, email TEXT, session TEXT, created INTEGER);
    CREATE TABLE IF NOT EXISTS mcp_sessions (id TEXT PRIMARY KEY, level TEXT, subs TEXT, created INTEGER, last INTEGER);
    CREATE TABLE IF NOT EXISTS mcp_events (session TEXT, stream TEXT, seq INTEGER, data TEXT, ts INTEGER, PRIMARY KEY (session, stream, seq));`);
  for (const col of ["version TEXT", "g_seen INTEGER DEFAULT 0"]) { // added after the first deploy
    try { sql.exec(`ALTER TABLE mcp_sessions ADD COLUMN ${col}`); } catch { /* exists */ }
  }
}

// ---------------------------------------------------------------- hub data (files table mirrors ~/.agent-hub/data)

const textOf = (c: unknown) => typeof c === "string" ? c : new TextDecoder().decode(c instanceof ArrayBuffer ? new Uint8Array(c) : c as Uint8Array);
export function readFile(sql: McpSql, path: string): FileRow | null {
  const r = sql.exec("SELECT content, updated FROM files WHERE path = ? AND deleted = 0", path).toArray()[0];
  return r ? { path, text: textOf(r.content), updated: r.updated as string } : null;
}
// Listings are kept per directory until a file under it changes: the task history, a task's page and the MCP resource
// list all list tasks/ and decisions/, a few hundred rows each, while what changed since is a few rows of the files_rev index.
const listCache = new WeakMap<McpSql, Map<string, { rev: number; rows: FileRow[] }>>();
function listDir(sql: McpSql, dir: string): FileRow[] {
  let cache = listCache.get(sql);
  if (!cache) listCache.set(sql, cache = new Map());
  const hit = cache.get(dir);
  if (hit) {
    const changed = sql.exec("SELECT path, rev FROM files WHERE rev > ? ORDER BY rev", hit.rev).toArray();
    if (!changed.some((r) => String(r.path).startsWith(dir))) {
      if (changed.length) hit.rev = Number(changed[changed.length - 1].rev);
      return hit.rows;
    }
  }
  const rev = Number(sql.exec("SELECT MAX(rev) AS n FROM files").toArray()[0]?.n ?? 0);
  const rows = sql.exec("SELECT path, content, updated FROM files WHERE path >= ? AND path < ? AND deleted = 0 ORDER BY path DESC LIMIT 2000",
    dir, dir.slice(0, -1) + "0").toArray().map((r) => ({ path: r.path as string, text: textOf(r.content), updated: r.updated as string }));
  cache.set(dir, { rev, rows });
  return rows;
}

const MCP_TOOLS = toolsFor("mcp");

// ---------------------------------------------------------------- server
// Streams. Every SSE message carries `id: <stream>.<seq>` and is kept per session in mcp_events (bounded by count and age),
// so a client that reconnects with Last-Event-ID gets exactly what it missed on *that* stream:
//   "g"      the session's standalone GET stream (one live connection per session; a new GET replaces the old one)
//   "p<hex>" the SSE response to one POST (progress notifications, then the JSON-RPC response)
type Live = { session: string; stream: string; write: (s: string) => void; close: () => void };
type Who = "machine" | { session: string; scope?: string };
type Ctx = { signal?: AbortSignal; progress?: (progress: number, total?: number, message?: string) => void };

export const SESSION_IDLE_MS = 24 * 3600_000;
const REPLAY_KEEP_MS = 15 * 60_000, REPLAY_MAX = 500, RETRY_MS = 3000;
const sseMsg = (id: string, m: unknown) => `id: ${id}\nevent: message\ndata: ${JSON.stringify(m)}\n\n`;
const rpcErr = (status: number, code: number, message: string) => json({ jsonrpc: "2.0", id: null, error: { code, message } }, status);

export class Mcp {
  /** Every open SSE connection (GET and POST). */
  streams = new Set<Live>();
  conns = new Map<string, Live>(); // `${session} ${stream}` → live connection
  waiters = new Set<() => void>();
  inflight = new Map<string, { ac: AbortController; stream?: string }>(); // `${session} ${JSON(id)}`
  keepAliveMs = 15_000;
  progressEveryMs = 5_000;
  private listSig: string | undefined;
  constructor(private h: McpHost) { initMcpSchema(h.sql); }

  // -------- live events
  /** Called by the Hub for every appended event. */
  onEvent(ev: Ev) {
    for (const w of [...this.waiters]) w();
    const uris = ["noop://feed"];
    for (const id of new Set([ev.ref, ...String(ev.text ?? "").matchAll(/\bT-[\w]*\d{4}\b/g)].map((x) => (Array.isArray(x) ? x[0] : x)).filter((x): x is string => typeof x === "string" && TASK_ID.test(x))))
      uris.push(`noop://tasks/${id}`);
    if (ev.kind === "decision") uris.push("noop://decisions");
    this.broadcast({ level: ev.kind === "decision" ? "warning" : ev.kind === "system" ? "debug" : "info", data: ev }, uris, ev.kind === "decision" && this.listChanged());
  }
  /** Status snapshot or task/decision files changed. */
  onChanged(uris: string[]) { this.broadcast(null, uris, uris.some((u) => u.startsWith("noop://tasks/") || u === "noop://decisions") && this.listChanged()); }

  /** Did the set of listed resources (open tasks, open decisions) change since we last looked? */
  listChanged() {
    const sig = this.resourceList().map((r) => r.uri).sort().join(" ");
    const changed = this.listSig !== undefined && sig !== this.listSig;
    this.listSig = sig;
    return changed;
  }

  broadcast(log: { level: string; data: unknown } | null, uris: string[], listChanged = false) {
    const now = Date.now();
    const rows = this.h.sql.exec("SELECT id, level, subs, g_seen FROM mcp_sessions WHERE g_seen > 0").toArray();
    for (const row of rows) {
      const sid = row.id as string;
      // Keep writing for a disconnected stream for a while, so a reconnect with Last-Event-ID can replay it.
      if (!this.conns.has(`${sid} g`) && now - Number(row.g_seen) > REPLAY_KEEP_MS) continue;
      const min = LEVELS.indexOf((row.level as string) || "info");
      if (log && LEVELS.indexOf(log.level) >= min) this.send(sid, "g", { jsonrpc: "2.0", method: "notifications/message", params: { level: log.level, logger: "noop", data: log.data } });
      const subs: string[] = JSON.parse(row.subs as string || "[]");
      for (const uri of uris) if (subs.includes(uri)) this.send(sid, "g", { jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri, title: uri } });
      if (listChanged) this.send(sid, "g", { jsonrpc: "2.0", method: "notifications/resources/list_changed" });
    }
  }

  /** Stores the message for replay and writes it to the live connection of that stream, if any. */
  send(session: string, stream: string, msg: unknown) {
    const sql = this.h.sql;
    const seq = Number(sql.exec("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM mcp_events WHERE session = ? AND stream = ?", session, stream).toArray()[0]?.n ?? 1);
    sql.exec("INSERT INTO mcp_events (session, stream, seq, data, ts) VALUES (?, ?, ?, ?, ?)", session, stream, seq, JSON.stringify(msg), Date.now());
    if (seq % 50 === 0) sql.exec("DELETE FROM mcp_events WHERE session = ? AND ((stream = ? AND seq <= ?) OR ts < ?)", session, stream, seq - REPLAY_MAX, Date.now() - REPLAY_KEEP_MS);
    this.conns.get(`${session} ${stream}`)?.write(sseMsg(`${stream}.${seq}`, msg));
  }

  /** Opens an SSE response bound to (session, stream). */
  connect(session: string, stream: string, version: string, req: Request, replayAfter?: number): { live: Live; res: Response } {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const w = writable.getWriter(), enc = new TextEncoder(), key = `${session} ${stream}`;
    let timer: ReturnType<typeof setInterval> | undefined, closed = false;
    const live: Live = {
      session, stream,
      write: (s) => { if (!closed) w.write(enc.encode(s)).catch(() => live.close()); },
      close: () => {
        if (closed) return;
        closed = true;
        if (timer) clearInterval(timer);
        this.streams.delete(live);
        if (this.conns.get(key) === live) this.conns.delete(key);
        if (stream === "g") this.h.sql.exec("UPDATE mcp_sessions SET g_seen = ? WHERE id = ?", Date.now(), session);
        w.close().catch(() => {});
      },
    };
    this.conns.get(key)?.close(); // one live connection per stream
    this.conns.set(key, live);
    this.streams.add(live);
    live.write(`retry: ${RETRY_MS}\n\n`);
    if (replayAfter !== undefined) {
      for (const r of this.h.sql.exec("SELECT seq, data FROM mcp_events WHERE session = ? AND stream = ? AND seq > ? ORDER BY seq", session, stream, replayAfter).toArray())
        live.write(`id: ${stream}.${r.seq}\nevent: message\ndata: ${r.data}\n\n`);
    } else if (version >= "2025-11-25") { // prime the client with an event id so it can resume even before the first message
      const n = Number(this.h.sql.exec("SELECT COALESCE(MAX(seq), 0) AS n FROM mcp_events WHERE session = ? AND stream = ?", session, stream).toArray()[0]?.n ?? 0);
      live.write(`id: ${stream}.${n}\ndata: \n\n`);
    }
    timer = setInterval(() => live.write(": ping\n\n"), this.keepAliveMs);
    req.signal?.addEventListener?.("abort", () => live.close());
    return { live, res: new Response(readable, { headers: { ...CORS, "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no", "mcp-session-id": session } }) };
  }

  /** The session row if it exists and hasn't expired; expired sessions are dropped. */
  session(sid: string): { id: string; version: string } | null {
    if (!sid) return null;
    const r = this.h.sql.exec("SELECT id, version, last FROM mcp_sessions WHERE id = ?", sid).toArray()[0];
    if (!r) return null;
    if (Number(r.last) < Date.now() - SESSION_IDLE_MS) { this.endSession(sid); return null; }
    return { id: sid, version: (r.version as string) || "2025-03-26" };
  }
  endSession(sid: string) {
    this.h.sql.exec("DELETE FROM mcp_sessions WHERE id = ?", sid);
    this.h.sql.exec("DELETE FROM mcp_events WHERE session = ?", sid);
    for (const s of [...this.streams]) if (s.session === sid) s.close();
    for (const [k, f] of this.inflight) if (k.startsWith(`${sid} `)) f.ac.abort();
  }

  // -------- HTTP
  async fetch(req: Request, who: Who | null): Promise<Response> {
    const url = new URL(req.url), base = url.origin;
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const p = url.pathname;
    if (p.startsWith("/.well-known/oauth-protected-resource")) return json(this.resourceMeta(base));
    if (p.startsWith("/.well-known/oauth-authorization-server") || p.startsWith("/.well-known/openid-configuration")) return json(this.asMeta(base));
    if (p === "/oauth/register" && req.method === "POST") return this.register(req);
    if (p === "/oauth/authorize") return this.authorize(req, url);
    if (p === "/oauth/token" && req.method === "POST") return this.token(req);
    if (p !== "/mcp") return json({ error: "not found" }, 404);
    if (!who) return json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "unauthorized" } }, 401,
      { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource", scope="noop"` });
    if (!["GET", "POST", "DELETE"].includes(req.method)) return json({ error: "method not allowed" }, 405, { allow: "GET, POST, DELETE, OPTIONS" });

    const pv = req.headers.get("mcp-protocol-version");
    if (pv && !PROTOCOL_VERSIONS.includes(pv)) return rpcErr(400, -32600, `unsupported MCP-Protocol-Version: ${pv} (supported: ${PROTOCOL_VERSIONS.join(", ")})`);
    const sidHeader = req.headers.get("mcp-session-id") ?? "";

    let msg: any;
    if (req.method === "POST") {
      try { msg = await req.json(); } catch { return rpcErr(400, -32700, "parse error"); }
      if (!Array.isArray(msg) && msg?.method === "initialize") return this.initialize(msg, who, base);
    }
    // Everything but initialize needs a live session (spec: 400 without the header, 404 once it's gone → re-initialize).
    if (!sidHeader) return rpcErr(400, -32600, "Mcp-Session-Id header required");
    const sess = this.session(sidHeader);
    if (!sess) return rpcErr(404, -32001, "session not found; initialize a new one");
    this.h.sql.exec("UPDATE mcp_sessions SET last = ? WHERE id = ?", Date.now(), sess.id);

    if (req.method === "GET") return this.openStream(req, sess);
    if (req.method === "DELETE") { this.endSession(sess.id); return new Response(null, { status: 204, headers: CORS }); }

    if (Array.isArray(msg)) { // JSON-RPC batches only exist in 2025-03-26
      if (sess.version !== "2025-03-26" || !msg.length || msg.some((m) => m?.method === "initialize")) return rpcErr(400, -32600, "batching is not supported in this protocol version");
      const out = (await Promise.all(msg.map((m) => this.handle(m, sess.id, who, base)))).filter((r) => r);
      return out.length ? json(out) : new Response(null, { status: 202, headers: CORS });
    }
    const isRequest = msg && typeof msg.method === "string" && "id" in msg;
    if (!isRequest) { // notification or response → 202 Accepted
      const r = await this.handle(msg, sess.id, who, base);
      return r ? json(r, 400) : new Response(null, { status: 202, headers: CORS });
    }
    const wantsSse = (req.headers.get("accept") ?? "").includes("text/event-stream");
    const token = msg.params?._meta?.progressToken;
    const streams = msg.method === "tools/call" && (token !== undefined || msg.params?.name === "wait_for_events");
    if (!wantsSse || !streams) {
      const r = await this.handle(msg, sess.id, who, base);
      return r ? json(r) : new Response(null, { status: 202, headers: CORS });
    }
    // SSE response: progress notifications for this request first, then its response; resumable via GET + Last-Event-ID.
    const stream = `p${rand(6)}`;
    const { live, res } = this.connect(sess.id, stream, sess.version, req);
    let last = -1;
    const ctx: Ctx = {
      progress: token === undefined ? undefined : (progress, total, message) => {
        if (progress <= last) return; // progress MUST increase
        last = progress;
        this.send(sess.id, stream, { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress, ...(total !== undefined ? { total } : {}), ...(message ? { message } : {}) } });
      },
    };
    this.handle(msg, sess.id, who, base, ctx, stream).then((r) => {
      if (r) this.send(sess.id, stream, r);
      (this.conns.get(`${sess.id} ${stream}`) ?? live).close();
    });
    return res;
  }

  async initialize(msg: any, who: Who, base: string): Promise<Response> {
    const id = rand(16), now = Date.now();
    const v = PROTOCOL_VERSIONS.includes(msg.params?.protocolVersion) ? msg.params.protocolVersion : PROTOCOL_VERSIONS[0];
    for (const r of this.h.sql.exec("SELECT id FROM mcp_sessions WHERE last < ?", now - SESSION_IDLE_MS).toArray()) this.endSession(r.id as string);
    this.h.sql.exec("INSERT INTO mcp_sessions (id, level, subs, created, last, version, g_seen) VALUES (?, 'info', '[]', ?, ?, ?, 0)", id, now, now, v);
    if (this.listSig === undefined) this.listChanged();
    return json(await this.rpc(msg, id, who, base), 200, { "mcp-session-id": id });
  }

  /** rpc() with cancellation: notifications/cancelled for this request aborts it and suppresses the response. */
  async handle(m: any, sid: string, who: Who, base: string, ctx: Ctx = {}, stream?: string): Promise<any | null> {
    if (!m || typeof m !== "object" || !("id" in m) || typeof m.method !== "string") return this.rpc(m, sid, who, base, ctx);
    const key = `${sid} ${JSON.stringify(m.id)}`, ac = new AbortController();
    this.inflight.set(key, { ac, stream });
    try {
      const r = await this.rpc(m, sid, who, base, { ...ctx, signal: ac.signal });
      return ac.signal.aborted ? null : r;
    } finally { if (this.inflight.get(key)?.ac === ac) this.inflight.delete(key); }
  }

  openStream(req: Request, sess: { id: string; version: string }): Response {
    if (!(req.headers.get("accept") ?? "").includes("text/event-stream")) return json({ error: "Accept: text/event-stream required" }, 406);
    const lastId = req.headers.get("last-event-id");
    if (lastId) {
      const m = lastId.match(/^(g|p[0-9a-f]+)\.(\d+)$/);
      if (!m) return rpcErr(400, -32600, "bad Last-Event-ID");
      const [, stream, seq] = m;
      const { live, res } = this.connect(sess.id, stream, sess.version, req, Number(seq));
      if (stream === "g") this.h.sql.exec("UPDATE mcp_sessions SET g_seen = ? WHERE id = ?", Date.now(), sess.id);
      // A finished POST stream: replay, then close (its response was the last message).
      else if (![...this.inflight.values()].some((f) => f.stream === stream)) queueMicrotask(() => live.close());
      return res;
    }
    this.h.sql.exec("UPDATE mcp_sessions SET g_seen = ? WHERE id = ?", Date.now(), sess.id);
    return this.connect(sess.id, "g", sess.version, req).res;
  }

  // -------- JSON-RPC
  resourceList() {
    return [
      { uri: "noop://status", name: "status", title: "Fleet status", mimeType: "application/json" },
      { uri: "noop://feed", name: "feed", title: "Latest feed events", mimeType: "application/json" },
      { uri: "noop://decisions", name: "decisions", title: "Open decisions", mimeType: "application/json" },
      ...listDecisions(this.store(), "open", 100).filter((d) => d.id).map((d) => ({ uri: `noop://decisions/${d.id}`, name: d.id!, title: `${d.id} ${d.question ?? ""}`, mimeType: "application/json" })),
      ...listTasks(this.store(), "open", "", 50).map((t) => ({ uri: `noop://tasks/${t.id}`, name: t.id, title: `${t.id} ${t.title}`, mimeType: "application/json" })),
    ];
  }

  async rpc(m: any, sid: string, who: Who, base: string, ctx: Ctx = {}): Promise<any | null> {
    if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") return m && "id" in m && !("result" in m || "error" in m) ? err(m.id ?? null, -32600, "invalid request") : null;
    const isNote = !("id" in m);
    const ok = (result: unknown) => (isNote ? null : { jsonrpc: "2.0", id: m.id, result });
    const p = m.params ?? {};
    try {
      switch (m.method) {
        case "initialize": {
          const v = PROTOCOL_VERSIONS.includes(p.protocolVersion) ? p.protocolVersion : PROTOCOL_VERSIONS[0];
          return ok({ protocolVersion: v, serverInfo: SERVER_INFO,
            // Same feature set in every supported version. Tools are fixed (listChanged false); the resource list follows open tasks/decisions.
            capabilities: { tools: { listChanged: false }, resources: { subscribe: true, listChanged: true }, logging: {} },
            instructions: "noop is the owner's AI agent fleet. Read state with get_status / list_tasks / list_decisions / get_feed. "
              + "Talk to the fleet with send_message, hand it work with create_task, adjust work with amend_task / set_priority / reassign_task / cancel_task, "
              + "answer decision cards with answer_decision, write durable memory with remember, correct or delete it with edit_memory (read it with read_memory). "
              + "Live events arrive as notifications/message on the GET stream (resumable with Last-Event-ID); without notifications, poll with wait_for_events." });
        }
        case "ping": return ok({});
        case "logging/setLevel":
          if (!LEVELS.includes(p.level)) return err(m.id, -32602, "unknown level");
          this.h.sql.exec("UPDATE mcp_sessions SET level = ? WHERE id = ?", p.level, sid);
          return ok({});
        case "tools/list": return ok({ tools: MCP_TOOLS.map(({ write, only, ...t }) => t) });
        case "tools/call": {
          const r = await this.call(String(p.name ?? ""), p.arguments ?? {}, base, ctx);
          return r === null ? null : ok(r);
        }
        case "resources/list": return ok({ resources: this.resourceList() });
        case "resources/templates/list": return ok({ resourceTemplates: [
          { uriTemplate: "noop://tasks/{id}", name: "task", title: "A task", mimeType: "application/json" },
          { uriTemplate: "noop://decisions/{id}", name: "decision", title: "A decision card", mimeType: "application/json" }] });
        case "resources/read": {
          const data = this.resource(String(p.uri ?? ""));
          if (data === undefined) return err(m.id, -32002, "resource not found");
          return ok({ contents: [{ uri: p.uri, mimeType: "application/json", text: JSON.stringify(data, null, 1) }] });
        }
        case "resources/subscribe": case "resources/unsubscribe": {
          const uri = String(p.uri ?? "");
          const row = this.h.sql.exec("SELECT subs FROM mcp_sessions WHERE id = ?", sid).toArray()[0];
          if (!row) return err(m.id, -32600, "unknown session");
          const subs = new Set<string>(JSON.parse(row.subs as string || "[]"));
          if (m.method === "resources/subscribe") subs.add(uri); else subs.delete(uri);
          this.h.sql.exec("UPDATE mcp_sessions SET subs = ? WHERE id = ?", JSON.stringify([...subs].slice(-200)), sid);
          return ok({});
        }
        case "notifications/cancelled": {
          if (p.requestId !== undefined) this.inflight.get(`${sid} ${JSON.stringify(p.requestId)}`)?.ac.abort(p.reason);
          return null;
        }
        case "notifications/initialized": case "notifications/roots/list_changed": case "notifications/progress": return null;
        default: return isNote ? null : err(m.id, -32601, `method not found: ${m.method}`);
      }
    } catch (e) { return isNote ? null : err(m.id, -32603, String((e as Error)?.message ?? e)); }
  }

  resource(uri: string): unknown {
    if (uri === "noop://status") return this.statusView();
    if (uri === "noop://feed") return this.feed(undefined, 50);
    if (uri === "noop://decisions") return listDecisions(this.store());
    const d = uri.match(/^noop:\/\/decisions\/(.+)$/)?.[1];
    if (d) return DECISION_ID.test(d) ? listDecisions(this.store(), "open", 100).find((x) => x.id === d) : undefined;
    const t = uri.match(/^noop:\/\/tasks\/(.+)$/)?.[1];
    if (t && TASK_ID.test(t)) return getTask(this.store(), t) ?? undefined;
    return undefined;
  }

  statusView() { return statusView(this.store()); }


  feed(cursor: number | undefined, limit: number) { return feedView(this.store(), cursor, limit); }
  lastSeq() { return Number(this.h.sql.exec("SELECT COALESCE(MAX(seq), 0) AS n FROM events").toArray()[0]?.n ?? 0); }

  /** The tool layer's view of this Hub: the files mirror for reads, the daemon (via the inbox) for writes. */
  store(): ToolStore {
    const h = this.h;
    return {
      read: (p) => readFile(h.sql, p), list: (d) => listDir(h.sql, d), status: () => h.status(),
      events: (after, limit) => h.events(after, limit), lastSeq: () => this.lastSeq(),
      act: async (op) => {
        // owner-equivalent messages stay messages; everything else is performed by the daemon that owns the data
        if (op.tool === "send_message") { const ev = h.say(op.text, op.reply_to); return { ok: true, id: ev.id, ts: ev.ts }; }
        if (op.tool === "answer_decision") { const ev = h.say(`${op.id} ${op.answer}`, op.id); return { ok: true, id: ev.id }; }
        h.enqueue(op);
        return { ok: true, queued: true, host_online: h.hostOnline?.() ?? undefined,
          note: "Handed to the fleet's primary machine, which applies it within seconds and reports in the feed (watch with wait_for_events)." };
      },
    };
  }

  async call(name: string, a: any, base: string, ctx: Ctx = {}): Promise<any | null> {
    const out = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 1) }], structuredContent: Array.isArray(data) ? { items: data } : data });
    const bad = (message: string) => ({ content: [{ type: "text", text: message }], isError: true });
    if (name === "wait_for_events") {
      const cursor = Number(a?.cursor) || 0, ms = Math.max(1, Math.min(Number(a?.timeout_seconds) || 30, 50)) * 1000, total = ms / 1000;
      if (this.lastSeq() <= cursor) {
        const t0 = Date.now(), { signal, progress } = ctx;
        progress?.(0, total, "waiting for fleet events");
        await new Promise<void>((res) => {
          const done = () => { clearTimeout(t); if (tick) clearInterval(tick); this.waiters.delete(done); signal?.removeEventListener("abort", done); res(); };
          const t = setTimeout(done, ms);
          const tick = progress && setInterval(() => progress(Math.min(total, (Date.now() - t0) / 1000), total, "waiting for fleet events"), this.progressEveryMs);
          signal?.addEventListener("abort", done);
          this.waiters.add(done);
          if (signal?.aborted) done();
        });
        if (signal?.aborted) return null; // cancelled: no response
      }
      return out(this.feed(cursor, 100));
    }
    if (!MCP_TOOLS.some((t) => t.name === name)) return bad(`unknown tool: ${name}`);
    const r = await runTool(this.store(), name, a, base);
    return r.ok ? out(r.data) : bad(r.error);
  }

  // -------- OAuth 2.1 (authorization server + protected resource, same origin)
  resourceMeta(base: string) {
    return { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["noop"], bearer_methods_supported: ["header"], resource_name: "Noop" };
  }
  asMeta(base: string) {
    return { issuer: base, authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/oauth/token`, registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"], scopes_supported: ["noop"] };
  }

  async register(req: Request) {
    const b = (await req.json().catch(() => null)) as any;
    const uris = Array.isArray(b?.redirect_uris) ? b.redirect_uris.filter((u: unknown) => typeof u === "string" && okRedirect(u)) : [];
    if (!uris.length || uris.length !== b.redirect_uris.length) return json({ error: "invalid_redirect_uri", error_description: "https (or http://localhost) redirect_uris required" }, 400);
    const n = Number(this.h.sql.exec("SELECT COUNT(*) AS n FROM oauth_clients WHERE created > ?", Date.now() - 3600_000).toArray()[0]?.n ?? 0);
    if (n >= 30) return json({ error: "temporarily_unavailable" }, 429);
    const client = { client_id: `mcp-${rand(12)}`, client_id_issued_at: Math.floor(Date.now() / 1000), redirect_uris: uris,
      client_name: String(b.client_name ?? "").slice(0, 100) || new URL(uris[0]).host, token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] };
    this.h.sql.exec("INSERT INTO oauth_clients (id, json, created) VALUES (?, ?, ?)", client.client_id, JSON.stringify(client), Date.now());
    return json(client, 201);
  }
  client(id: string) { const r = this.h.sql.exec("SELECT json FROM oauth_clients WHERE id = ?", id).toArray()[0]; return r ? JSON.parse(r.json as string) : null; }

  async authorize(req: Request, url: URL): Promise<Response> {
    const f: Record<string, string> = Object.fromEntries(url.searchParams);
    if (req.method === "POST") Object.assign(f, Object.fromEntries([...(await req.formData()).entries()].map(([k, v]) => [k, String(v)])));
    const client = this.client(f.client_id ?? "");
    if (!client) return page("无法授权", `<p>未知的应用（client_id）。请在客户端里重新添加 Noop。</p>`, 400);
    if (!client.redirect_uris.includes(f.redirect_uri)) return page("无法授权", `<p>回调地址和注册的不一致。</p>`, 400);
    if (!okRedirect(f.redirect_uri)) return page("无法授权", `<p>这个回调地址不在允许范围内。</p>`, 400); // clients registered before the host allow-list
    const back = (q: Record<string, string>) => {
      const u = new URL(f.redirect_uri);
      for (const [k, v] of Object.entries({ ...q, ...(f.state ? { state: f.state } : {}) })) u.searchParams.set(k, v);
      return new Response(null, { status: 302, headers: { location: u.toString() } });
    };
    if (f.response_type !== "code") return back({ error: "unsupported_response_type" });
    if (!f.code_challenge || f.code_challenge_method !== "S256") return back({ error: "invalid_request", error_description: "PKCE S256 required" });
    if (req.method === "POST" && f.step === "deny") return back({ error: "access_denied" });

    const keep = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope", "resource"]
      .filter((k) => f[k]).map((k) => `<input type="hidden" name="${k}" value="${esc(f[k])}">`).join("");
    const who = `<p><b>${esc(client.client_name)}</b> 想访问你的 Noop：查看任务、决策和动态，以你的名义给团队发消息、回答决策。</p>
      <p class="muted">授权后会跳回 <code>${esc(new URL(f.redirect_uri).host)}</code>。不是你本人发起的请直接关闭页面。</p>`;
    const emailForm = (msg = "") => page("授权 Noop", `${who}${msg}<form method="post">${keep}<input type="hidden" name="step" value="send">
      <label>邮箱<input name="email" type="email" required autofocus value="${esc(f.email)}"></label>
      <div class="row"><button>发送验证码</button><button name="step" value="deny" class="ghost" formnovalidate>拒绝</button></div></form>`);
    const codeForm = (msg = "") => page("授权 Noop", `${who}${msg}<form method="post">${keep}<input type="hidden" name="step" value="verify">
      <input type="hidden" name="email" value="${esc(f.email)}">
      <label>验证码（已发到 ${esc(f.email)}${f.delivery === "cli" ? "；邮件未配置，请在你的电脑上运行 <code>noop login</code> 查看" : ""}）
      <input name="code" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="12" required autofocus autocomplete="one-time-code" style="text-transform:uppercase;letter-spacing:.15em"></label>
      <label>两步验证码（验证器 App 上的 6 位数字）
      <input name="totp" inputmode="numeric" pattern="\\d{6}" maxlength="6" required autocomplete="off"></label>
      <input type="hidden" name="delivery" value="${esc(f.delivery)}">
      <div class="row"><button>授权</button><button name="step" value="deny" class="ghost" formnovalidate>拒绝</button></div></form>`);
    const note = (s: string) => `<p class="err">${esc(s)}</p>`;

    if (req.method !== "POST") return emailForm();
    if (f.step === "send") {
      const r = await this.h.startCode(String(f.email ?? ""));
      if (r.status !== 200) return emailForm(note(r.body?.message ?? r.body?.error ?? "发送失败"));
      f.delivery = r.body?.delivery ?? "";
      return codeForm();
    }
    if (f.step === "verify") {
      const r = await this.h.checkCode(String(f.email ?? ""), String(f.code ?? ""), String(f.totp ?? ""),
        { req, via: `MCP 连接器授权：${String(client.client_name).slice(0, 60)}（回调 ${new URL(f.redirect_uri).host}）` });
      if (!r.email) return codeForm(note(r.error ?? "验证码不对"));
      const code = rand(32);
      this.h.sql.exec("DELETE FROM oauth_codes WHERE expires < ?", Date.now());
      this.h.sql.exec("INSERT INTO oauth_codes (hash, client_id, redirect_uri, challenge, email, expires) VALUES (?, ?, ?, ?, ?, ?)",
        await sha256(code), client.client_id, f.redirect_uri, f.code_challenge, r.email, Date.now() + OAUTH_CODE_TTL);
      return back({ code });
    }
    return emailForm();
  }

  async token(req: Request): Promise<Response> {
    const ct = req.headers.get("content-type") ?? "";
    const b: Record<string, string> = ct.includes("json") ? ((await req.json().catch(() => ({}))) as any)
      : Object.fromEntries([...new URLSearchParams(await req.text())]);
    const fail = (error: string, d?: string) => json({ error, ...(d ? { error_description: d } : {}) }, 400, { "cache-control": "no-store" });
    const client = this.client(b.client_id ?? "");
    if (!client) return json({ error: "invalid_client" }, 401);
    let email: string;
    if (b.grant_type === "authorization_code") {
      const h = await sha256(String(b.code ?? ""));
      const r = this.h.sql.exec("SELECT * FROM oauth_codes WHERE hash = ?", h).toArray()[0];
      this.h.sql.exec("DELETE FROM oauth_codes WHERE hash = ?", h); // single use
      if (!r || (r.expires as number) < Date.now() || r.client_id !== client.client_id) return fail("invalid_grant");
      if (b.redirect_uri && b.redirect_uri !== r.redirect_uri) return fail("invalid_grant", "redirect_uri mismatch");
      if (!b.code_verifier || (await pkceChallenge(b.code_verifier)) !== r.challenge) return fail("invalid_grant", "PKCE verification failed");
      email = r.email as string;
    } else if (b.grant_type === "refresh_token") {
      const h = await sha256(String(b.refresh_token ?? ""));
      const r = this.h.sql.exec("SELECT * FROM oauth_refresh WHERE hash = ?", h).toArray()[0];
      if (!r || r.client_id !== client.client_id) return fail("invalid_grant");
      this.h.sql.exec("DELETE FROM oauth_refresh WHERE hash = ?", h); // rotate
      this.h.sql.exec("DELETE FROM sessions WHERE id = ?", r.session); // the old access token goes with it
      email = r.email as string;
    } else return fail("unsupported_grant_type");
    const access = await this.h.newSession(email, `mcp:${client.client_name}`.slice(0, 300));
    const refresh = rand(32);
    this.h.sql.exec("INSERT INTO oauth_refresh (hash, client_id, email, session, created) VALUES (?, ?, ?, ?, ?)",
      await sha256(refresh), client.client_id, email, await sha256(access), Date.now());
    return json({ access_token: access, token_type: "Bearer", refresh_token: refresh, scope: "noop" }, 200, { "cache-control": "no-store" });
  }
}

const err = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
// Connectors that may receive an authorization code: Claude (claude.ai / claude.com) and ChatGPT, plus local clients
// (Claude Code, MCP Inspector) on loopback. A code sent anywhere else would hand the owner's fleet to that site.
const REDIRECT_HOSTS = ["claude.ai", "claude.com", "chatgpt.com", "chat.openai.com"];
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];
export function okRedirect(u: string) {
  try {
    const x = new URL(u);
    if (x.hash || x.username || x.password) return false;
    if (LOOPBACK.includes(x.hostname)) return x.protocol === "http:" || x.protocol === "https:";
    return x.protocol === "https:" && !x.port && REDIRECT_HOSTS.some((h) => x.hostname === h || x.hostname.endsWith(`.${h}`));
  } catch { return false; }
}

function page(title: string, body: string, status = 200) {
  return new Response(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
:root{color-scheme:light dark;--bg:#fff;--fg:#111;--mut:#666;--line:#e4e4e7;--acc:#111}
@media (prefers-color-scheme:dark){:root{--bg:#111113;--fg:#ededed;--mut:#9a9a9a;--line:#2a2a2e;--acc:#ededed}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,system-ui,sans-serif}
main{max-width:400px;margin:12vh auto;padding:0 20px}h1{font-size:20px;margin:0 0 16px}
label{display:block;margin:16px 0 6px;color:var(--mut);font-size:13px}
input:not([type=hidden]){display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:9px 10px;border:1px solid var(--line);border-radius:6px;background:transparent;color:var(--fg);font:inherit}
.row{display:flex;gap:8px;margin-top:16px}button{padding:8px 14px;border-radius:6px;border:1px solid var(--acc);background:var(--acc);color:var(--bg);font:inherit;cursor:pointer}
button.ghost{background:transparent;color:var(--fg);border-color:var(--line)}.muted{color:var(--mut);font-size:13px}.err{color:#e5484d}code{font-size:13px}
</style></head><body><main><h1>${esc(title)}</h1>${body}</main></body></html>`,
  { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" } });
}
