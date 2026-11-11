// Data sync: host mirror (src/sync.ts) against the real Worker files module (cloud/src/files.ts) over bun:sqlite.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, appendFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as sync from "../src/sync";

let W = "", t: sync.Transport;
const hosts = { a: "", b: "" };
/** Point the sync module at one host's mirror (each host has its own DATA, state and lock). */
const as = (h: "a" | "b") => { sync.setSyncData(hosts[h]); sync.setTransport(t); return hosts[h]; };
const put = (h: "a" | "b", rel: string, s: string | Uint8Array) => { const f = join(hosts[h], rel); mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, s); };
const get = (h: "a" | "b", rel: string) => readFileSync(join(hosts[h], rel), "utf8");
const api = (path: string, body?: unknown) => t(path, body === undefined ? {} : { method: "POST", body });

beforeAll(async () => {
  W = mkdtempSync(join(tmpdir(), "hub-sync-"));
  hosts.a = join(W, "a", "data"); hosts.b = join(W, "b", "data");
  mkdirSync(hosts.a, { recursive: true }); mkdirSync(hosts.b, { recursive: true });
  t = await sync.fakeTransport(join(W, "worker.sqlite"), "test");
  // these tests check sync semantics; pacing (pull debounce, lazy journal pushes) is test/budget.test.ts's
  sync.syncTiming.pullMinMs = 0; sync.syncTiming.lazyPushMs = 0;
});
afterAll(() => { try { rmSync(W, { recursive: true, force: true }); } catch {} }); // Windows keeps the open worker.sqlite locked

test("push, pull, binary-safe, ignored paths", async () => {
  const bin = new Uint8Array(256).map((_, i) => i);
  as("a");
  put("a", "tasks/inbox/T-0001.md", "---\nid: T-0001\n---\nhello\n");
  put("a", "media/blob.bin", bin);
  put("a", "config.local.toml", "secret = 1\n");
  put("a", "logs/daemon.log", "x\n");
  put("a", "agents/x/.notes.md.swp", "tmp");
  expect(await sync.commitPush("a: seed")).toBe(true);
  as("b");
  expect(await sync.pull()).toBe(true);
  expect(get("b", "tasks/inbox/T-0001.md")).toContain("hello");
  expect(new Uint8Array(readFileSync(join(hosts.b, "media/blob.bin")))).toEqual(bin);
  expect(existsSync(join(hosts.b, "config.local.toml"))).toBe(false);
  expect(existsSync(join(hosts.b, "logs"))).toBe(false);
  expect(existsSync(join(hosts.b, "agents/x/.notes.md.swp"))).toBe(false);
  expect(await sync.commitPush("b: nothing")).toBe(true); // nothing changed
});

test("task claim race: exactly one host wins, loser gets the winner's state", async () => {
  const claim = (h: "a" | "b") => {
    const src = join(hosts[h], "tasks/inbox/T-0001.md");
    put(h, "tasks/active/T-0001.md", readFileSync(src, "utf8").replace("id: T-0001", `id: T-0001\nclaimed_by: ${h}`));
    unlinkSync(src);
  };
  as("a"); claim("a");
  as("b"); claim("b");
  as("a"); expect(await sync.commitPush("[a] claim T-0001")).toBe(true);
  as("b"); expect(await sync.commitPush("[b] claim T-0001")).toBe(false);
  sync.revertLocal(["tasks/active/T-0001.md", "tasks/inbox/T-0001.md"]); // what core.claim does on false
  expect(get("b", "tasks/active/T-0001.md")).toContain("claimed_by: a");
  expect(existsSync(join(hosts.b, "tasks/inbox/T-0001.md"))).toBe(false);
  expect(await sync.commitPush("b: after loss")).toBe(true); // nothing left to push
});

test("non-conflicting changes in a lost commit stay pending and push later", async () => {
  as("a"); put("a", "decisions/open/D-1.md", "a\n"); expect(await sync.commitPush("a")).toBe(true);
  as("b"); put("b", "decisions/open/D-1.md", "b\n"); put("b", "fleet/hosts/b.json", "{}");
  expect(await sync.commitPush("b")).toBe(false); // D-1 lost to a
  expect(get("b", "decisions/open/D-1.md")).toBe("a\n");
  expect(await sync.commitPush("b retry")).toBe(true); // heartbeat still goes up
  as("a"); await sync.pull(); expect(get("a", "fleet/hosts/b.json")).toBe("{}");
});

test("concurrent appends to the same journal merge instead of losing lines", async () => {
  as("a"); put("a", "journal/2026-11-02.md", "# Journal 2026-11-02\n\n- 09:00 a one\n"); expect(await sync.commitPush("a")).toBe(true);
  as("b"); await sync.pull();
  as("a"); appendFileSync(join(hosts.a, "journal/2026-11-02.md"), "- 09:01 a two\n"); expect(await sync.commitPush("a")).toBe(true);
  as("b"); appendFileSync(join(hosts.b, "journal/2026-11-02.md"), "- 09:01 b one\n"); expect(await sync.commitPush("b")).toBe(true);
  as("a"); await sync.pull();
  expect(get("a", "journal/2026-11-02.md")).toBe("# Journal 2026-11-02\n\n- 09:00 a one\n- 09:01 a two\n- 09:01 b one\n");
  // same-day journal created on both hosts without a common base: headers line up
  as("a"); put("a", "journal/2026-11-03.md", "# Journal 2026-11-03\n\n- a\n"); expect(await sync.commitPush("a")).toBe(true);
  as("b"); put("b", "journal/2026-11-03.md", "# Journal 2026-11-03\n\n- b\n"); expect(await sync.commitPush("b")).toBe(true);
  expect(get("b", "journal/2026-11-03.md")).toBe("# Journal 2026-11-03\n\n- a\n- b\n");
});

test("deletes propagate; reset discards local edits", async () => {
  as("a"); unlinkSync(join(hosts.a, "media/blob.bin")); expect(await sync.commitPush("a: rm")).toBe(true);
  as("b"); await sync.pull(); expect(existsSync(join(hosts.b, "media/blob.bin"))).toBe(false);
  put("b", "decisions/open/D-1.md", "scribble"); put("b", "junk.md", "x");
  expect(await sync.resetToUpstream()).toBe(true);
  expect(get("b", "decisions/open/D-1.md")).toBe("a\n");
  expect(existsSync(join(hosts.b, "junk.md"))).toBe(false);
  // recreate a deleted path (base_version 0 again)
  put("b", "media/blob.bin", "again"); expect(await sync.commitPush("b")).toBe(true);
  as("a"); await sync.pull(); expect(get("a", "media/blob.bin")).toBe("again");
});

test("worker API: 409 applies nothing, history, revert, pagination, size limit, path validation", async () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  let r = await api("/api/files/commit", { msg: "x", changes: [{ path: "p/one.md", base_version: 0, content: b64("1") }] });
  expect(r!.status).toBe(200);
  const v1 = r!.json.files[0].version;
  r = await api("/api/files/commit", { msg: "x", changes: [{ path: "p/two.md", base_version: 0, content: b64("2") }, { path: "p/one.md", base_version: 0, content: b64("bad") }] });
  expect(r!.status).toBe(409); expect(r!.json.conflicts).toEqual(["p/one.md"]);
  expect((await api("/api/files/history?path=p/two.md"))!.json.history).toEqual([]); // atomic: two.md not written
  r = await api("/api/files/commit", { msg: "edit", changes: [{ path: "p/one.md", base_version: v1, content: b64("1b") }] });
  expect(r!.status).toBe(200);
  const h = (await api("/api/files/history?path=p/one.md&content=1"))!.json.history;
  expect(h.map((x: any) => x.version)).toEqual([v1 + 1, v1]);
  expect(Buffer.from(h[1].content, "base64").toString()).toBe("1");
  r = await api("/api/files/revert", { path: "p/one.md", version: v1 });
  expect(r!.status).toBe(200); expect(r!.json.version).toBe(v1 + 2);
  const all: any[] = [];
  for (let since = 0, more = true; more;) { const p = (await t(`/api/files/changes?since=${since}&limit=2`))!.json; all.push(...p.files); since = p.rev; more = p.more; }
  expect(Buffer.from(all.find((f) => f.path === "p/one.md").content, "base64").toString()).toBe("1");
  expect(new Set(all.map((f) => f.path)).size).toBe(all.length);
  r = await api("/api/files/commit", { msg: "big", changes: [{ path: "big.bin", base_version: 0, content: Buffer.alloc(1_500_001).toString("base64") }] });
  expect(r!.status).toBe(413);
  for (const bad of ["../x", "/abs", ".git/config", "a//b", "a/./b"]) {
    r = await api("/api/files/commit", { msg: "x", changes: [{ path: bad, base_version: 0, content: b64("x") }] });
    expect(r!.status).toBe(400);
  }
});

test("history pruning keeps the latest row of each path", async () => {
  const { initFilesSchema, pruneHistory } = await import("../cloud/src/files");
  const { Database } = await import("bun:sqlite");
  const db = new Database(":memory:");
  const sql = { exec: (q: string, ...b: any[]) => { if (!b.length && q.includes(";")) { db.exec(q); return { toArray: () => [] }; } const rows = db.query(q).all(...b); return { toArray: () => rows as any[] }; } };
  initFilesSchema(sql);
  const old = new Date(Date.now() - 100 * 86400_000).toISOString();
  for (const [p, v] of [["a", 1], ["a", 2], ["b", 1]] as const) sql.exec("INSERT INTO history (path, version, ts) VALUES (?, ?, ?)", p, v, old);
  pruneHistory(sql);
  expect(sql.exec("SELECT path, version FROM history ORDER BY path").toArray()).toEqual([{ path: "a", version: 2 }, { path: "b", version: 1 }]);
});

test("history pruning caps versions per path and drops journals and heartbeats", async () => {
  const { initFilesSchema, pruneHistory } = await import("../cloud/src/files");
  const { Database } = await import("bun:sqlite");
  const db = new Database(":memory:");
  const sql = { exec: (q: string, ...b: any[]) => { if (!b.length && q.includes(";")) { db.exec(q); return { toArray: () => [] }; } const rows = db.query(q).all(...b); return { toArray: () => rows as any[] }; } };
  initFilesSchema(sql);
  const ts = new Date().toISOString();
  for (let v = 1; v <= 40; v++) for (const p of ["tasks/done/T-1.md", "journal/2026-11-06.md", "fleet/hosts/a.json"])
    sql.exec("INSERT INTO history (path, version, ts) VALUES (?, ?, ?)", p, v, ts);
  pruneHistory(sql);
  const rows = sql.exec("SELECT path, COUNT(*) AS n, MIN(version) AS lo, MAX(version) AS hi FROM history GROUP BY path ORDER BY path").toArray();
  expect(rows).toEqual([{ path: "tasks/done/T-1.md", n: 30, lo: 11, hi: 40 }]);
});

test("worker API: a journal keeps no history; its history view is the current version", async () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  let v = 0;
  for (const text of ["- a\n", "- a\n- b\n", "- a\n- b\n- c\n"]) {
    const r = await api("/api/files/commit", { msg: "beat", changes: [{ path: "journal/2026-01-01.md", base_version: v, content: b64(text) }] });
    expect(r!.status).toBe(200); v = r!.json.files[0].version;
  }
  const h = (await api("/api/files/history?path=journal/2026-01-01.md&content=1"))!.json.history;
  expect(h.map((x: any) => x.version)).toEqual([v]);
  expect(Buffer.from(h[0].content, "base64").toString()).toBe("- a\n- b\n- c\n");
});

test("own commit echoing back on the next pull does not clobber newer local edits", async () => {
  as("a"); put("a", "config.toml", "v1\n"); expect(await sync.commitPush("a")).toBe(true);
  put("a", "config.toml", "v2 local\n");
  expect(await sync.pull()).toBe(true);
  expect(get("a", "config.toml")).toBe("v2 local\n");
  expect(await sync.commitPush("a v2")).toBe(true);
  as("b"); await sync.pull(); expect(get("b", "config.toml")).toBe("v2 local\n");
});

test("append-only files merge by union when both sides diverged; nothing ever gets conflict markers", async () => {
  const enc = (s: string) => new TextEncoder().encode(s), dec = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null);
  // journal where local no longer starts with base (an old line was edited) → union, no markers
  const base = "# Journal\n\n- 1 a\n", local = "# Journal\n\n- 1 a (edited)\n- 2 local\n", remote = "# Journal\n\n- 1 a\n- 3 remote\n";
  const m = dec(sync.mergeAppend("journal/x.md", enc(base), enc(local), enc(remote)))!;
  expect(m).toBe("# Journal\n\n- 1 a\n- 3 remote\n- 1 a (edited)\n- 2 local\n");
  expect(sync.hasConflictMarkers(m)).toBe(false);
  // markers already present in either input are dropped, both sides' lines kept
  const dirty = "- x\n<<<<<<< HEAD\n- y\n=======\n- z\n>>>>>>> 1668512 (up)\n";
  expect(dec(sync.mergeAppend("memory/lessons.md", null, enc(dirty), enc("- x\n- w\n")))).toBe("- x\n- w\n- y\n- z\n");
  // repeated identical lines survive as many times as either side has them
  expect(sync.unionLines("a\na\nb\n", "a\nc\n")).toBe("a\nc\na\nb\n");
  // non-append files are never merged textually: remote wins, no markers
  expect(sync.mergeAppend("decisions/closed/D-1.md", enc("q\n"), enc("q\nlocal\n"), enc("r\n"))).toBeNull();

  // end to end: diverged journal on two hosts plus a decision edited on both
  as("a"); put("a", "journal/2026-12-01.md", "# J\n\n- a1\n"); put("a", "decisions/closed/D-9.md", "---\nid: D-9\n---\nbase\n");
  expect(await sync.commitPush("a")).toBe(true);
  as("b"); await sync.pull();
  as("a"); put("a", "journal/2026-12-01.md", "# J\n\n- a1 fixed\n- a2\n"); put("a", "decisions/closed/D-9.md", "---\nid: D-9\n---\nfrom a\n");
  expect(await sync.commitPush("a")).toBe(true);
  as("b"); put("b", "journal/2026-12-01.md", "# J\n\n- a1\n- b1\n"); put("b", "decisions/closed/D-9.md", "---\nid: D-9\n---\nfrom b\n");
  await sync.pull();
  const j = get("b", "journal/2026-12-01.md");
  for (const l of ["- a1 fixed", "- a2", "- b1"]) expect(j).toContain(l);
  expect(get("b", "decisions/closed/D-9.md")).toBe("---\nid: D-9\n---\nfrom a\n");
  for (const f of [j, get("b", "decisions/closed/D-9.md")]) expect(sync.hasConflictMarkers(f)).toBe(false);
});

test("a replaced Worker (older copy, lower revs) is re-learned and our newer files pushed to it", async () => {
  as("a");
  put("a", "fleet/hosts/a.json", "{\"seen\":1}\n");
  put("a", "tasks/inbox/T-0900.md", "v1\n");
  expect(await sync.commitPush("a: seed")).toBe(true);
  for (const n of [2, 3, 4]) { put("a", "fleet/hosts/a.json", `{"seen":${n}}\n`); expect(await sync.commitPush(`a: beat ${n}`)).toBe(true); }
  // the new Worker holds an older copy: beat v1, the task, plus a file this host never saw; its revs are far lower
  const old = await sync.fakeTransport(join(W, "worker-copy.sqlite"), "copy");
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  expect((await old("/api/files/commit", { method: "POST", body: { msg: "copy", changes: [
    { path: "fleet/hosts/a.json", base_version: 0, content: b64("{\"seen\":1}\n") },
    { path: "tasks/inbox/T-0900.md", base_version: 0, content: b64("v1\n") },
    { path: "decisions/open/D-0900.md", base_version: 0, content: b64("from the copy\n") },
  ] } }))!.status).toBe(200);
  sync.setSyncData(hosts.a); sync.setTransport(old);
  put("a", "fleet/hosts/a.json", "{\"seen\":5}\n");
  put("a", "tasks/inbox/T-0901.md", "new\n");
  expect(await sync.commitPush("a: beat 5")).toBe(true);
  const read = async (p: string) => {
    const r = await old(`/api/files/history?path=${p}&limit=1&content=1`);
    return Buffer.from(r!.json.history[0].content, "base64").toString();
  };
  expect(await read("fleet/hosts/a.json")).toBe("{\"seen\":5}\n");
  expect(await read("tasks/inbox/T-0901.md")).toBe("new\n");
  expect(get("a", "decisions/open/D-0900.md")).toBe("from the copy\n");
  expect(await sync.commitPush("a: settled")).toBe(true);
  put("a", "fleet/hosts/a.json", "{\"seen\":6}\n");
  expect(await sync.commitPush("a: beat 6")).toBe(true); // normal CAS again
  expect(await read("fleet/hosts/a.json")).toBe("{\"seen\":6}\n");
  sync.setTransport(t);
});

test("sync lock: stale or slow holders are broken, never fatal; cleanup only removes our own token", async () => {
  as("a");
  const lock = join(dirname(hosts.a), "sync.lock"); // the lock lives next to the mirror (HOME), not inside it
  // a crashed holder (lock older than 2 min) is broken at once instead of throwing
  mkdirSync(lock, { recursive: true });
  utimesSync(lock, new Date(Date.now() - 130_000), new Date(Date.now() - 130_000));
  expect(await sync.pull({ force: true })).toBe(true);
  expect(existsSync(lock)).toBe(false); // pull's cleanup removed the (now empty) lock dir
  // a holder that is alive but slow: the waiter breaks the lock after its timeout and proceeds
  const slow = sync.withLock(async () => { await Bun.sleep(150); });
  expect(await sync.withLock(async () => "broke through", 50)).toBe("broke through");
  await slow; // the broken holder's cleanup must not remove the new holder's lock, and the last one out closes
  expect(existsSync(lock)).toBe(false);
  // and sync still works normally afterwards
  put("a", "tasks/inbox/T-0902.md", "after lock\n");
  expect(await sync.commitPush("a: after lock")).toBe(true);
});
