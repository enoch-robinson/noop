// Shared fleet files (replaces the private git data repo). Lives in the Hub Durable Object's SQLite.
// Each host keeps ~/.agent-hub/data as a local working mirror and syncs it through this API (src/sync.ts).
//
//   GET  /api/files/changes?since=<rev>[&limit=]  → {rev, more, files:[{path, version, hash, deleted, content(base64)|null, rev}]}
//   POST /api/files/commit {msg, changes:[{path, base_version, content(base64)} | {path, base_version, deleted:true}]}
//        → 200 {rev, files:[{path, version, hash, deleted}]} | 409 {conflicts:[path]} (nothing applied) | 400/413 {error}
//        Compare-and-swap per path: base_version must equal the current version (0 = must not exist / be deleted).
//        This is the distributed lock that task claims rely on (exactly one host wins a move).
//   GET  /api/files/history?path=&limit=[&content=1] → {history:[{seq, version, hash, ts, by, msg, deleted, size, content?}]}
//   POST /api/files/revert {path, version, msg?} → {rev, version} (writes the old content as a new version)
//   GET  /api/files/list?prefix=<dir/> → {files:[{path, size, updated, version}]}   (owner read; READABLE prefixes only)
//   GET  /api/files/read?path=        → {path, content (utf8), size, updated, version} | 404
//        Read-only views of the team's rules and memory. config.toml and everything else stay machine-only.
//
// Every write gets its own global `rev` (monotonic), so `changes?since=` pagination never splits a row.
// History keeps ≤ 90 days, ≤ 20k rows and ≤ 30 versions per path, but always the latest row of each path.
// Journals, logs and heartbeats keep no history (their history view is the current row): each write was a full copy,
// and an append-only journal rewritten every minute alone grew history past a gigabyte. Past TARGET.storageBytes the
// daily prune keeps only the latest row of every path.

/** Structural subset of Cloudflare's SqlStorage (also satisfied by a bun:sqlite adapter in tests). */
export interface FilesSql { exec(query: string, ...bindings: any[]): { toArray(): any[] }; readonly databaseSize?: number }

export const MAX_FILE = 1_500_000;          // bytes per file (SQLite row limit is 2 MB)
const PAGE_BYTES = 8_000_000;               // response budget for one changes page
const PAGE_ROWS = 1000;
const HISTORY_DAYS = 90, HISTORY_ROWS = 20_000, HISTORY_PER_PATH = 30;
export { latestOnly };
const LATEST_ONLY_SQL = `(path LIKE 'journal/%' OR path LIKE 'logs/%' OR path LIKE 'fleet/%' OR path IN ('memory/lessons.md', 'memory/judge-feedback.md'))`;

import { TARGET, latestOnly } from "./budget";

const json = (d: unknown, status = 200) => Response.json(d, { status });

export function initFilesSchema(sql: FilesSql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, content BLOB, hash TEXT, version INTEGER NOT NULL,
      updated TEXT, by TEXT, deleted INTEGER NOT NULL DEFAULT 0, rev INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS files_rev ON files (rev);
    CREATE TABLE IF NOT EXISTS history (seq INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT, version INTEGER, hash TEXT,
      content BLOB, ts TEXT, by TEXT, msg TEXT);
    CREATE INDEX IF NOT EXISTS history_path ON history (path, version);
    CREATE TABLE IF NOT EXISTS files_meta (k TEXT PRIMARY KEY, v INTEGER);`);
}

// ---------------------------------------------------------------- helpers
export const b64enc = (u: Uint8Array) => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
export function b64dec(s: string): Uint8Array {
  const bin = atob(s); const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
const bytes = (v: unknown): Uint8Array => v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(0);
/** DO SQLite binds ArrayBuffer for BLOBs. */
const blob = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
export async function sha256hex(u: Uint8Array) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", blob(u)))].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Relative, normalized, no traversal, no git internals. */
export function validPath(p: unknown): p is string {
  if (typeof p !== "string" || !p || p.length > 512 || p.startsWith("/") || p.includes("\\") || p.includes("\0")) return false;
  return p.split("/").every((s) => s && s !== "." && s !== ".." && s !== ".git");
}

function curRev(sql: FilesSql): number { return Number(sql.exec("SELECT v FROM files_meta WHERE k = 'rev'").toArray()[0]?.v ?? 0); }
function setRev(sql: FilesSql, r: number) { sql.exec("INSERT OR REPLACE INTO files_meta (k, v) VALUES ('rev', ?)", r); }

type Row = { path: string; version: number; deleted: number; hash: string | null };
const rowOf = (sql: FilesSql, path: string): Row | undefined =>
  sql.exec("SELECT path, version, deleted, hash FROM files WHERE path = ?", path).toArray()[0] as Row | undefined;
/** Version a writer must name as base: 0 when absent or deleted. */
const liveVersion = (r?: Row) => (r && !r.deleted ? Number(r.version) : 0);

type Prepared = { path: string; base: number; content: Uint8Array | null; hash: string | null };

/** Synchronous check-and-apply: no awaits inside, so the DO cannot interleave another request. */
function applyCas(sql: FilesSql, items: Prepared[], actor: string, msg: string): Response {
  const conflicts = items.filter((it) => liveVersion(rowOf(sql, it.path)) !== it.base).map((it) => it.path);
  if (conflicts.length) return json({ conflicts }, 409);
  let rev = curRev(sql);
  const ts = new Date().toISOString();
  const out: { path: string; version: number; hash: string | null; deleted: boolean }[] = [];
  for (const it of items) {
    const r = rowOf(sql, it.path);
    if (!it.content && liveVersion(r) === 0) { out.push({ path: it.path, version: Number(r?.version ?? 0), hash: null, deleted: true }); continue; } // delete of nothing
    const version = Number(r?.version ?? 0) + 1;
    rev++;
    sql.exec(`INSERT INTO files (path, content, hash, version, updated, by, deleted, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET content = excluded.content, hash = excluded.hash, version = excluded.version,
        updated = excluded.updated, by = excluded.by, deleted = excluded.deleted, rev = excluded.rev`,
      it.path, it.content ? blob(it.content) : null, it.hash, version, ts, actor, it.content ? 0 : 1, rev);
    if (!latestOnly(it.path)) sql.exec("INSERT INTO history (path, version, hash, content, ts, by, msg) VALUES (?, ?, ?, ?, ?, ?, ?)",
      it.path, version, it.hash, it.content ? blob(it.content) : null, ts, actor, msg);
    out.push({ path: it.path, version, hash: it.hash, deleted: !it.content });
  }
  setRev(sql, rev);
  pruneHistory(sql, Date.now(), sql.databaseSize ?? 0);
  return json({ rev, files: out });
}

export function pruneHistory(sql: FilesSql, now = Date.now(), dbBytes = 0) {
  // the prune scans the whole history (rows_read is billed per row, tens of thousands here): once a day, not on every commit
  const last = Number(sql.exec("SELECT v FROM files_meta WHERE k = 'pruned'").toArray()[0]?.v ?? 0);
  if (now - last < 86_400_000) return;
  sql.exec("INSERT OR REPLACE INTO files_meta (k, v) VALUES ('pruned', ?)", now);
  const cutoff = new Date(now - HISTORY_DAYS * 86400_000).toISOString();
  sql.exec(`DELETE FROM history WHERE (ts < ? OR seq <= (SELECT MAX(seq) FROM history) - ?)
    AND seq NOT IN (SELECT MAX(seq) FROM history GROUP BY path)`, cutoff, HISTORY_ROWS);
  sql.exec(`DELETE FROM history WHERE ${LATEST_ONLY_SQL}`);
  // older versions beyond the per-path cap (all but the latest once the database is over its storage target)
  sql.exec(`DELETE FROM history WHERE seq IN (SELECT seq FROM (SELECT seq,
      ROW_NUMBER() OVER (PARTITION BY path ORDER BY seq DESC) AS rn FROM history) WHERE rn > ?)`,
    dbBytes > TARGET.storageBytes ? 1 : HISTORY_PER_PATH);
}

/** Prefixes the owner session may read (rules, memory, agent profiles, closed decisions). Never config / secrets. */
export const READABLE = ["policies/", "memory/", "agents/", "decisions/closed/", "reports/"] as const;
export const readable = (p: unknown): p is string => validPath(String(p ?? "").replace(/\/$/, "") || "x") && READABLE.some((r) => String(p).startsWith(r));
/** Exclusive upper bound for a prefix range scan on the primary key: "a/" → "a0". */
export const prefixEnd = (p: string) => p.slice(0, -1) + String.fromCharCode(p.charCodeAt(p.length - 1) + 1);
const LIST_ROWS = 2000;

/** Read-only routes for the owner: a primary-key range on `files` (never the history table). */
export function handleReadFiles(sql: FilesSql, url: URL): Response | null {
  const p = url.pathname;
  if (p === "/api/files/list") {
    let prefix = url.searchParams.get("prefix") ?? "";
    if (prefix && !prefix.endsWith("/")) prefix += "/";
    if (!readable(prefix)) return json({ error: "prefix not readable" }, 403);
    const rows = sql.exec(`SELECT path, LENGTH(content) AS size, updated, version FROM files
      WHERE path >= ? AND path < ? AND deleted = 0 ORDER BY path LIMIT ?`, prefix, prefixEnd(prefix), LIST_ROWS).toArray();
    return json({ files: rows.map((r) => ({ path: r.path, size: Number(r.size ?? 0), updated: r.updated, version: Number(r.version) })) });
  }
  if (p === "/api/files/read") {
    const path = url.searchParams.get("path");
    if (!validPath(path) || !readable(path)) return json({ error: "path not readable" }, 403);
    const r = sql.exec("SELECT content, updated, version FROM files WHERE path = ? AND deleted = 0", path).toArray()[0];
    if (!r) return json({ error: "not found" }, 404);
    const c = bytes(r.content);
    return json({ path, content: new TextDecoder().decode(c), size: c.length, updated: r.updated, version: Number(r.version) });
  }
  return null;
}

async function body(req: Request): Promise<any> { try { return await req.json(); } catch { return null; } }

// ---------------------------------------------------------------- routes
export async function handleFiles(sql: FilesSql, req: Request, url: URL, actor: string): Promise<Response | null> {
  const p = url.pathname;
  if (!p.startsWith("/api/files/")) return null;

  if (p === "/api/files/changes" && req.method === "GET") {
    const since = Math.max(0, Number(url.searchParams.get("since") ?? 0) || 0);
    const limit = Math.min(PAGE_ROWS, Math.max(1, Number(url.searchParams.get("limit") ?? PAGE_ROWS) || PAGE_ROWS));
    const head = curRev(sql);
    const files: any[] = [];
    let size = 0, last = since, more = false;
    // one row at a time so a page never loads more than its byte budget
    for (;;) {
      const r = sql.exec("SELECT path, content, hash, version, deleted, rev FROM files WHERE rev > ? ORDER BY rev LIMIT 1", last).toArray()[0];
      if (!r) break;
      const c = r.deleted ? null : bytes(r.content);
      if (files.length && (files.length >= limit || size + (c?.length ?? 0) > PAGE_BYTES)) { more = true; break; }
      files.push({ path: r.path, version: Number(r.version), hash: r.hash, deleted: !!r.deleted, content: c ? b64enc(c) : null, rev: Number(r.rev) });
      size += c?.length ?? 0;
      last = Number(r.rev);
    }
    return json({ rev: more ? last : Math.max(last, head), more, files });
  }

  if (p === "/api/files/commit" && req.method === "POST") {
    const b = await body(req);
    const changes = b?.changes;
    if (!Array.isArray(changes) || !changes.length) return json({ error: "changes[] required" }, 400);
    const seen = new Set<string>();
    const items: Prepared[] = [];
    for (const c of changes) {
      if (!validPath(c?.path)) return json({ error: `invalid path: ${String(c?.path).slice(0, 200)}` }, 400);
      if (seen.has(c.path)) return json({ error: `duplicate path: ${c.path}` }, 400);
      seen.add(c.path);
      const base = Number(c.base_version);
      if (!Number.isInteger(base) || base < 0) return json({ error: `bad base_version for ${c.path}` }, 400);
      if (c.deleted === true) { items.push({ path: c.path, base, content: null, hash: null }); continue; }
      if (typeof c.content !== "string") return json({ error: `content (base64) or deleted:true required for ${c.path}` }, 400);
      let content: Uint8Array;
      try { content = b64dec(c.content); } catch { return json({ error: `content is not base64: ${c.path}` }, 400); }
      if (content.length > MAX_FILE) return json({ error: `file too large: ${c.path} is ${content.length} bytes (max ${MAX_FILE}); keep large artifacts outside the data folder` }, 413);
      items.push({ path: c.path, base, content, hash: await sha256hex(content) });
    }
    return applyCas(sql, items, actor, String(b.msg ?? "").slice(0, 500));
  }

  if (p === "/api/files/history" && req.method === "GET") {
    const path = url.searchParams.get("path");
    if (!validPath(path)) return json({ error: "path required" }, 400);
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
    const withContent = url.searchParams.get("content") === "1";
    const rows = latestOnly(path) // no history kept: the current version is all there is
      ? sql.exec("SELECT 0 AS seq, version, hash, CASE WHEN deleted THEN NULL ELSE content END AS content, updated AS ts, by, '' AS msg FROM files WHERE path = ?", path).toArray()
      : sql.exec("SELECT seq, version, hash, content, ts, by, msg FROM history WHERE path = ? ORDER BY seq DESC LIMIT ?", path, limit).toArray();
    return json({
      history: rows.map((r) => {
        const c = r.content == null ? null : bytes(r.content);
        return { seq: Number(r.seq), version: Number(r.version), hash: r.hash, ts: r.ts, by: r.by, msg: r.msg, deleted: c == null, size: c?.length ?? 0,
          ...(withContent ? { content: c ? b64enc(c) : null } : {}) };
      }),
    });
  }

  if (p === "/api/files/revert" && req.method === "POST") {
    const b = await body(req);
    if (!validPath(b?.path) || !Number.isInteger(b?.version)) return json({ error: "{path, version} required" }, 400);
    const h = sql.exec("SELECT content, hash FROM history WHERE path = ? AND version = ? ORDER BY seq DESC LIMIT 1", b.path, b.version).toArray()[0];
    if (!h) return json({ error: `no history for ${b.path} v${b.version} (pruned or never existed)` }, 404);
    const content = h.content == null ? null : bytes(h.content);
    const base = liveVersion(rowOf(sql, b.path));
    const res = applyCas(sql, [{ path: b.path, base, content, hash: content ? String(h.hash) : null }], actor,
      String(b.msg ?? `revert ${b.path} to v${b.version}`).slice(0, 500));
    if (res.status !== 200) return res;
    const r = await res.json() as any;
    return json({ rev: r.rev, version: r.files[0].version });
  }

  return json({ error: "not found" }, 404);
}
