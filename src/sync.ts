// Data sync: ~/.noop/data is a local working mirror of the fleet files stored in the owner's own
// Cloudflare Worker (cloud/src/files.ts). Agents and code keep reading/writing plain files; this module
//   pull()        applies remote changes since the last seen rev (remote wins for paths changed on both sides,
//                 except pure appends on both sides, which are merged so journals/memory don't lose lines),
//   commitPush()  sends local changes (vs. the recorded hashes) through the compare-and-swap commit API;
//                 a 409 means someone else changed one of our base versions → pull, and return false if we lost,
//   revertLocal() / resetToUpstream() discard local edits.
// Machine-local state next to DATA: noop.toml (cloud url + machine token), sync.json (rev + per-path version/hash),
// sync-base/ (content of each path as last synced; used to revert and to merge appends), sync.lock (cross-process).
// Modes: remote (noop.toml has [cloud] url + [server] token) · HUB_SYNC=local (no remote; commits are no-ops) ·
//        HUB_SYNC_FAKE=<sqlite file> (offline tests: the real Worker module over bun:sqlite, in-process).
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import { LAZY_PUSH_MS, PULL_MIN_MS, latestOnly } from "../cloud/src/budget";

export const MAX_FILE = 1_500_000;

// ------------------------------------------------------------------ locations (resolved lazily so tests can repoint DATA)
let dataDir = "", homeDir = "";
/** home defaults to the folder containing the mirror. */
export function setSyncData(dir: string, home = dirname(dir)) { dataDir = dir; homeDir = home; transport = undefined; }
const D = () => dataDir;
const HOME = () => homeDir;
export const hubTomlPath = () => process.env.HUB_CONF || join(HOME(), "noop.toml");
const STATE = () => join(HOME(), "sync.json");
const BASE = () => join(HOME(), "sync-base");
const LOCK = () => join(HOME(), "sync.lock");

// ------------------------------------------------------------------ machine-local bootstrap config (noop.toml)
export function readHubToml(): Record<string, any> {
  try { return existsSync(hubTomlPath()) ? Bun.TOML.parse(readFileSync(hubTomlPath(), "utf8")) as any : {}; } catch { return {}; }
}
/** Merge sections into noop.toml (string values only). */
export function writeHubToml(patch: Record<string, Record<string, string>>) {
  const cur = readHubToml();
  for (const [s, kv] of Object.entries(patch)) cur[s] = { ...(cur[s] ?? {}), ...kv };
  const q = (v: unknown) => JSON.stringify(String(v));
  const text = "# machine-local Noop bootstrap (never synced): your Worker URL + this machine's token\n" +
    Object.entries(cur).map(([s, kv]) => `[${s}]\n${Object.entries(kv as object).map(([k, v]) => `${k} = ${q(v)}`).join("\n")}\n`).join("\n");
  mkdirSync(dirname(hubTomlPath()), { recursive: true });
  writeFileSync(hubTomlPath(), text);
  try { chmodSync(hubTomlPath(), 0o600); } catch {}
}

// ------------------------------------------------------------------ transport
export type Reply = { status: number; json: any } | null; // null = network failure
export type Transport = ((path: string, init?: { method?: string; body?: unknown }) => Promise<Reply>) & { meter?: { requests: number; rowsWritten: number } };
let transport: Transport | null | undefined;
export function setTransport(t: Transport | null) { transport = t; }

function httpTransport(url: string, token: string): Transport {
  const base = url.replace(/\/$/, "");
  return async (path, init = {}) => {
    try {
      const r = await fetch(base + path, {
        method: init.method ?? "GET", body: init.body === undefined ? undefined : JSON.stringify(init.body),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Noop-Host": process.env.HUB_HOST || require("node:os").hostname().split(".")[0] }, signal: AbortSignal.timeout(60_000),
      });
      return { status: r.status, json: await r.json().catch(() => ({})) };
    } catch { return null; }
  };
}

/** In-process fake: the real Worker module over a bun:sqlite file (shared by all processes using the same file). */
export async function fakeTransport(file: string, actor = hostname()): Promise<Transport> {
  const { Database } = await import("bun:sqlite");
  const { initFilesSchema, handleFiles } = await import("../cloud/src/files");
  const db = new Database(file, { create: true });
  db.exec("PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL;");
  const conv = (v: unknown) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v);
  const sql = {
    exec(q: string, ...b: any[]) {
      if (!b.length && q.trim().replace(/;\s*$/, "").includes(";")) { db.exec(q); return { toArray: () => [] }; }
      const rows = db.query(q).all(...b.map(conv) as any[]);
      return { toArray: () => rows as any[] };
    },
  };
  initFilesSchema(sql);
  const meter = { requests: 0, rowsWritten: 0 }; // what the free plan would bill (rows changed; Cloudflare also counts index rows)
  const changes = () => Number((db.query("SELECT total_changes() AS n").get() as { n: number }).n);
  const t: Transport = async (path, init = {}) => {
    meter.requests++;
    const c0 = changes();
    const req = new Request(`http://fake${path}`, { method: init.method ?? "GET", body: init.body === undefined ? undefined : JSON.stringify(init.body) });
    // a real DO runs one request at a time; BEGIN IMMEDIATE gives the same isolation across processes
    db.exec("BEGIN IMMEDIATE");
    try {
      const r = await handleFiles(sql, req, new URL(req.url), process.env.HUB_HOST || actor);
      db.exec("COMMIT");
      meter.rowsWritten += changes() - c0;
      return r ? { status: r.status, json: await r.json() } : { status: 404, json: {} };
    } catch (e) { db.exec("ROLLBACK"); throw e; }
  };
  t.meter = meter;
  return t;
}

async function getTransport(): Promise<Transport | null> {
  if (transport !== undefined) return transport;
  if (process.env.HUB_SYNC_FAKE) return (transport = await fakeTransport(process.env.HUB_SYNC_FAKE));
  if (process.env.HUB_SYNC === "local") return (transport = null);
  const h = readHubToml();
  const url = h.cloud?.url, token = h.server?.token;
  return (transport = url && token ? httpTransport(String(url), String(token)) : null);
}
/** The shared config names a different Worker (the hub moved, e.g. to another account): switch this machine to it. */
export function adoptCloudUrl(url: unknown): boolean {
  const next = String(url ?? "").replace(/\/$/, "");
  if (!/^https:\/\//.test(next) || process.env.HUB_SYNC_FAKE || process.env.HUB_SYNC === "local") return false;
  const cur = String(readHubToml().cloud?.url ?? "").replace(/\/$/, "");
  if (!cur || cur === next) return false;
  writeHubToml({ cloud: { url: next } });
  transport = undefined;
  console.error(`sync: the hub moved, now syncing with ${next}`);
  return true;
}
export async function syncMode(): Promise<"remote" | "local"> { return (await getTransport()) ? "remote" : "local"; }

// ------------------------------------------------------------------ pacing (Cloudflare free plan: cloud/src/budget.ts)
/** Clock and intervals, replaceable in tests. pullMinMs: a pull this soon after the last one is skipped (commits still
 *  detect races through compare-and-swap). lazyPushMs: changes only to journals/heartbeats wait this long, or ride along
 *  with the next real change. */
export const syncTiming = { now: () => Date.now(), pullMinMs: PULL_MIN_MS, lazyPushMs: LAZY_PUSH_MS };
const lastPull = new Map<string, number>(), lastPush = new Map<string, number>(); // per mirror (tests switch between hosts)

// ------------------------------------------------------------------ state
type Entry = { v: number; h: string; m: number; s: number };
type State = { rev: number; files: Record<string, Entry> };
function loadState(): State {
  try { return JSON.parse(readFileSync(STATE(), "utf8")); } catch { return { rev: 0, files: {} }; }
}
function saveState(s: State) {
  mkdirSync(HOME(), { recursive: true });
  const tmp = `${STATE()}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(s));
  renameSync(tmp, STATE());
}

const hash = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

/** Paths never synced: machine-local config, logs, git leftovers, editor/tmp files. */
export function ignored(rel: string): boolean {
  const parts = rel.split("/");
  const first = parts[0], name = parts[parts.length - 1];
  if (first === ".git" || first.startsWith(".git.bak") || first === "logs" || rel === "config.local.toml") return true;
  return /^\.sync-tmp-|\.tmp$|~$|\.sw[po]$|^\.DS_Store$|^#.*#$/.test(name) || parts.includes(".git");
}

function walk(dir = D(), rel = "", out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (ignored(r)) continue;
    if (e.isDirectory()) walk(join(dir, e.name), r, out);
    else if (e.isFile()) out.push(r);
  }
  return out;
}

function readLocal(rel: string): Uint8Array | null {
  try { return new Uint8Array(readFileSync(join(D(), rel))); } catch { return null; }
}
function writeAtomic(abs: string, data: Uint8Array) {
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = join(dirname(abs), `.sync-tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(tmp, data);
  renameSync(tmp, abs);
}
function setBase(rel: string, data: Uint8Array | null) {
  const f = join(BASE(), rel);
  if (data) writeAtomic(f, data); else rmSync(f, { force: true });
}
const getBase = (rel: string): Uint8Array | null => { try { return new Uint8Array(readFileSync(join(BASE(), rel))); } catch { return null; } };
function stamp(rel: string): { m: number; s: number } {
  try { const st = statSync(join(D(), rel)); return { m: st.mtimeMs, s: st.size }; } catch { return { m: -1, s: -1 }; }
}

export type Change = { path: string; base_version: number; content?: string; deleted?: true; _bytes?: Uint8Array; _hash?: string };

/** Local changes vs. the recorded state. Updates mtime/size stamps of unchanged files in `st`. */
export function scan(st: State): Change[] {
  const changes: Change[] = [];
  const seen = new Set<string>();
  for (const rel of walk()) {
    seen.add(rel);
    const e = st.files[rel];
    const { m, s } = stamp(rel);
    if (e && e.m === m && e.s === s) continue;
    const data = readLocal(rel);
    if (!data) continue;
    if (data.length > MAX_FILE) { console.error(`sync: skipping ${rel} (${data.length} bytes > ${MAX_FILE}); keep large files outside the data folder`); continue; }
    const h = hash(data);
    if (e && e.h === h) { e.m = m; e.s = s; continue; }
    changes.push({ path: rel, base_version: e?.v ?? 0, content: b64(data), _bytes: data, _hash: h });
  }
  for (const [rel, e] of Object.entries(st.files)) if (!seen.has(rel) && !ignored(rel)) changes.push({ path: rel, base_version: e.v, deleted: true });
  return changes;
}

// ------------------------------------------------------------------ cross-process lock (CLI commands vs. the daemon)
// The lock only serializes concurrent syncs — the versioned commit settles real races (409 → pull → rebase) — so it
// must never wedge or kill a process: a crashed holder is broken as stale, and a waiter that times out (holder
// alive but slow, e.g. a big push over a cold Worker) breaks the lock and proceeds. This used to throw
// "lock held for over a minute", which killed whichever process hit it — on a host that meant the daemon dying
// and the fleet idling until something restarted it. Exported for tests; tokenized so a broken holder's cleanup
// never removes the next holder's lock.
export async function withLock<T>(fn: () => Promise<T>, timeoutMs = 60_000): Promise<T> {
  mkdirSync(HOME(), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  const token = join(LOCK(), String(process.pid));
  for (;;) {
    try { mkdirSync(LOCK()); try { writeFileSync(token, ""); } catch {} break; } catch {
      let age = 0;
      try { age = Date.now() - statSync(LOCK()).mtimeMs; } catch { continue; } // released between mkdir and stat: race for it again
      if (age > 120_000 || Date.now() > deadline) { // stale holder, or a live one too slow to keep waiting on
        console.error(`sync: lock ${LOCK()} held for ${Math.round(age / 1000)}s — breaking it and syncing anyway`);
        rmSync(LOCK(), { recursive: true, force: true });
        continue;
      }
      await Bun.sleep(50);
    }
  }
  try { return await fn(); } finally { // the lock may have been broken and taken over while we ran: only clean up our own token
    try { rmSync(token, { force: true }); if (existsSync(LOCK()) && readdirSync(LOCK()).length === 0) rmSync(LOCK(), { recursive: true, force: true }); } catch {}
  }
}

// ------------------------------------------------------------------ pull
const dec = new TextDecoder("utf-8", { fatal: true });
const text = (b: Uint8Array | null) => { if (!b) return null; try { return dec.decode(b); } catch { return null; } };

/** Both sides only appended to the common base → remote + our appended tail. Journals of the same day start
 *  with the same header even without a base. Append-only paths that diverged otherwise merge by line union;
 *  anything else: null (remote wins, local edit reported lost). Never emits conflict markers. */
/** Append-only paths: lines are only ever added, so any two versions merge by union (never conflict markers). */
export const appendOnly = (rel: string) =>
  rel.startsWith("journal/") || rel.startsWith("logs/") || rel === "memory/lessons.md" || rel === "memory/judge-feedback.md";

const MARKER = /^(<{7}|={7}|>{7})( |$)/;
export const hasConflictMarkers = (s: string) => s.split("\n").some((l) => MARKER.test(l));

/** Line union: remote in order, then local lines remote lacks (multiset-aware, so repeated lines survive). */
export function unionLines(local: string, remote: string): string {
  const have = new Map<string, number>();
  const rl = remote.split("\n").filter((l) => !MARKER.test(l));
  if (rl[rl.length - 1] === "") rl.pop();
  for (const l of rl) have.set(l, (have.get(l) ?? 0) + 1);
  const out = [...rl];
  for (const l of local.split("\n").filter((l) => !MARKER.test(l))) {
    const n = have.get(l) ?? 0;
    if (n > 0) have.set(l, n - 1); else if (l !== "") out.push(l);
  }
  return out.join("\n") + "\n";
}

export function mergeAppend(rel: string, base: Uint8Array | null, local: Uint8Array, remote: Uint8Array): Uint8Array | null {
  const l = text(local), r = text(remote);
  if (l == null || r == null) return null;
  const fast = mergeTail(rel, base, l, r);
  if (fast != null) return new TextEncoder().encode(fast);
  return appendOnly(rel) ? new TextEncoder().encode(unionLines(l, r)) : null;
}

function mergeTail(rel: string, base: Uint8Array | null, l: string, r: string): string | null {
  let b = text(base);
  if (b == null) {
    if (!rel.startsWith("journal/")) return null;
    const head = l.split("\n")[0];
    if (head !== r.split("\n")[0]) return null;
    b = head + "\n";
    while (l.startsWith(b + "\n") && r.startsWith(b + "\n")) b += "\n";
  }
  if (!b || !l.startsWith(b) || !r.startsWith(b)) return null;
  const tail = l.slice(b.length);
  return r + (r.endsWith("\n") || !r ? "" : "\n") + tail;
}

type Remote = { path: string; version: number; hash: string | null; deleted: boolean; content: string | null };

/** Apply one remote row. Returns "lost" when a local edit was overwritten. */
function applyRemote(st: State, f: Remote): "ok" | "merged" | "lost" {
  if (ignored(f.path) || f.path.includes("..")) return "ok";
  const abs = join(D(), f.path);
  const e = st.files[f.path];
  if (e && e.v >= f.version) return "ok"; // our own commit echoing back (local may have moved on since)
  const local = readLocal(f.path);
  const lh = local ? hash(local) : null;
  const remote = f.deleted || f.content == null ? null : unb64(f.content);
  const modified = lh !== (e?.h ?? null);
  let outcome: "ok" | "merged" | "lost" = "ok";
  let write: Uint8Array | null = remote;
  if (modified && lh !== f.hash) {
    const merged = local && remote ? mergeAppend(f.path, getBase(f.path), local, remote) : null;
    if (merged) { write = merged; outcome = "merged"; } else if (local || remote) outcome = "lost";
    if (outcome === "lost") console.error(`sync: ${f.path} changed remotely and locally — keeping the remote version`);
  }
  if (write) { if (!local || hash(write) !== lh) writeAtomic(abs, write); } else rmSync(abs, { force: true });
  setBase(f.path, remote);
  if (remote) st.files[f.path] = { v: f.version, h: f.hash ?? hash(remote), ...(outcome === "merged" ? { m: -1, s: -1 } : stamp(f.path)) };
  else delete st.files[f.path];
  return outcome;
}

async function _pull(st: State, t: Transport): Promise<{ ok: boolean; lost: Set<string>; seen: Set<string> }> {
  const lost = new Set<string>(), seen = new Set<string>();
  for (let page = 0; page < 10_000; page++) {
    const r = await t(`/api/files/changes?since=${st.rev}`);
    if (!r || r.status !== 200) { if (r) console.error(`sync: pull failed ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`); return { ok: false, lost, seen }; }
    for (const f of r.json.files as Remote[]) { seen.add(f.path); if (applyRemote(st, f) === "lost") lost.add(f.path); }
    st.rev = r.json.rev;
    saveState(st);
    if (!r.json.more) break;
  }
  return { ok: true, lost, seen };
}

export async function pull(opts: { force?: boolean } = {}): Promise<boolean> {
  const t = await getTransport();
  if (!t) return true;
  if (!opts.force && syncTiming.now() - (lastPull.get(HOME()) ?? -Infinity) < syncTiming.pullMinMs) return true;
  return withLock(async () => {
    const ok = (await _pull(loadState(), t)).ok;
    if (ok) lastPull.set(HOME(), syncTiming.now());
    return ok;
  });
}

// ------------------------------------------------------------------ replaced Worker
// A Worker moved to another account or restored from a copy has lower revs than ours: `changes?since=` returns
// nothing forever and every commit conflicts. Detected in commitPush; rebase() re-learns it.
/** Re-learn every path from the replaced Worker. Our files are at least as new as its copy, so where they differ ours
 *  win (append-only files merge) and the next commit pushes them; paths only it has are written here. */
async function rebase(st: State, t: Transport): Promise<boolean> {
  console.error(`sync: the Worker was replaced (its history is behind ours at rev ${st.rev}); re-syncing every path, local versions win`);
  const next: State = { rev: 0, files: {} };
  for (let page = 0; page < 10_000; page++) {
    const r = await t(`/api/files/changes?since=${next.rev}`);
    if (!r || r.status !== 200) return false;
    for (const f of r.json.files as Remote[]) {
      if (ignored(f.path) || f.path.includes("..") || f.deleted || f.content == null) continue;
      const remote = unb64(f.content), local = readLocal(f.path);
      setBase(f.path, remote);
      if (!local) {
        if (st.files[f.path]) { next.files[f.path] = { v: f.version, h: f.hash ?? hash(remote), m: -1, s: -1 }; continue; } // we deleted it since
        writeAtomic(join(D(), f.path), remote);
        next.files[f.path] = { v: f.version, h: f.hash ?? hash(remote), ...stamp(f.path) };
        continue;
      }
      if (hash(local) === (f.hash ?? hash(remote))) { next.files[f.path] = { v: f.version, h: hash(local), ...stamp(f.path) }; continue; }
      const merged = appendOnly(f.path) ? mergeAppend(f.path, null, local, remote) : null;
      if (merged) writeAtomic(join(D(), f.path), merged);
      next.files[f.path] = { v: f.version, h: f.hash ?? hash(remote), m: -1, s: -1 }; // differs → the next scan pushes ours
    }
    next.rev = r.json.rev;
    if (!r.json.more) break;
  }
  st.rev = next.rev; st.files = next.files;
  saveState(st);
  return true;
}

// ------------------------------------------------------------------ commit
function recordCommitted(st: State, changes: Change[], files: { path: string; version: number; hash: string | null; deleted: boolean }[]) {
  const byPath = new Map(changes.map((c) => [c.path, c]));
  for (const f of files) {
    const c = byPath.get(f.path);
    if (f.deleted) { delete st.files[f.path]; setBase(f.path, null); continue; }
    st.files[f.path] = { v: f.version, h: f.hash ?? c?._hash ?? "", ...stamp(f.path) };
    if (c?._bytes) setBase(f.path, c._bytes);
    // edited again while the request was in flight → force a rehash next scan
    if (c?._hash && f.hash !== c._hash) st.files[f.path].m = -1;
  }
}

const wire = (c: Change[]) => c.map(({ _bytes, _hash, ...w }) => w);

/** Commit all local changes. true = pushed (or nothing to do / local mode / only journals and heartbeats changed,
 *  which wait for the next real change or LAZY_PUSH_MS); false = lost a race or offline. force: push those too. */
export async function commitPush(msg: string, opts: { force?: boolean } = {}): Promise<boolean> {
  const t = await getTransport();
  if (!t) return true;
  return withLock(async () => {
    const st = loadState();
    for (let attempt = 0; attempt < 4; attempt++) {
      const changes = scan(st);
      if (!changes.length) { saveState(st); return true; }
      const lazy = changes.every((c) => latestOnly(c.path));
      if (lazy && !opts.force && syncTiming.now() - (lastPush.get(HOME()) ?? -Infinity) < syncTiming.lazyPushMs) { saveState(st); return true; }
      const r = await t("/api/files/commit", { method: "POST", body: { msg, changes: wire(changes) } });
      if (!r) { saveState(st); return false; } // offline: changes stay pending locally
      if (r.status === 429) { lastPush.set(HOME(), syncTiming.now()); saveState(st); return false; } // over the Worker's budget: later
      if (r.status === 200) { recordCommitted(st, changes, r.json.files); lastPush.set(HOME(), syncTiming.now()); saveState(st); return true; }
      if (r.status !== 409) { console.error(`sync: commit rejected ${r.status}: ${JSON.stringify(r.json).slice(0, 300)}`); saveState(st); return false; }
      const conflicts: string[] = r.json.conflicts ?? [];
      const { ok, lost, seen } = await _pull(st, t);
      if (!ok) return false;
      // a real race leaves the winner's row after our rev, so the pull brings it; none at all → the Worker was replaced
      if (conflicts.length && !conflicts.some((p) => seen.has(p))) { if (!(await rebase(st, t))) return false; continue; }
      if (conflicts.some((p) => lost.has(p))) return false; // someone else won (e.g. claimed the task)
    }
    return false;
  });
}

/** Restore paths (relative to DATA) to their last-synced content (delete if they did not exist). */
export function revertLocal(paths: string[]) {
  for (const rel of paths) {
    const b = getBase(rel);
    if (b) writeAtomic(join(D(), rel), b); else rmSync(join(D(), rel), { force: true });
  }
}

/** Discard every local edit and re-pull. */
export async function resetToUpstream(): Promise<boolean> {
  const t = await getTransport();
  if (!t) return true;
  return withLock(async () => {
    const st = loadState();
    revertLocal(scan(st).map((c) => c.path));
    for (const e of Object.values(st.files)) e.m = -1;
    return (await _pull(st, t)).ok;
  });
}

/** One-line status for diagnostics. */
export async function syncStatus(): Promise<string> {
  const mode = await syncMode();
  const st = loadState();
  const pending = mode === "remote" ? scan(structuredClone(st)).length : 0;
  return `${mode}${mode === "remote" ? ` → ${readHubToml().cloud?.url ?? process.env.HUB_SYNC_FAKE}` : ""} · rev ${st.rev} · ${Object.keys(st.files).length} files · ${pending} pending`;
}

/** Drop machine sync state (tests / re-init). */
export function resetSyncState() { rmSync(STATE(), { force: true }); rmSync(BASE(), { recursive: true, force: true }); }
export const _test = { loadState };
