// MCP server + OAuth 2.1 (cloud/src/mcp.ts) against a bun:sqlite stand-in for the Hub Durable Object.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { initFilesSchema } from "../cloud/src/files";
import { Mcp, type McpHost, okRedirect, pkceChallenge } from "../cloud/src/mcp";
import { taskHistory, taskInfo } from "../cloud/src/tools";

function sqlOf() {
  const db = new Database(":memory:");
  return {
    exec(q: string, ...b: any[]) {
      let rows: any[] = [];
      for (const part of q.split(";").map((s) => s.trim()).filter(Boolean)) {
        const st = db.query(part);
        if (/^SELECT/i.test(part)) rows = st.all(...b) as any[]; else st.run(...b);
      }
      return { toArray: () => rows };
    },
  };
}

function hub() {
  const sql = sqlOf();
  initFilesSchema(sql);
  sql.exec(`CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, json TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, email TEXT, created INTEGER, last_seen INTEGER, ua TEXT)`);
  const said: { text: string; ref?: string }[] = [];
  const queued: any[] = [];
  let mcp: Mcp;
  const append = (e: any) => {
    const ev = { id: crypto.randomUUID(), ts: new Date().toISOString(), ...e };
    sql.exec("INSERT INTO events (ts, json) VALUES (?, ?)", ev.ts, JSON.stringify(ev));
    mcp.onEvent(ev);
    return ev;
  };
  let rev = 0;
  const file = (path: string, content: string) => sql.exec("INSERT OR REPLACE INTO files (path, content, hash, version, updated, by, deleted, rev) VALUES (?, ?, '', 1, ?, 'x', 0, ?)",
    path, new TextEncoder().encode(content), new Date(Date.now() + rev * 1000).toISOString(), ++rev);
  const host: McpHost = {
    sql, status: () => ({ tasks: { active: 1 }, decisions: [{ id: "D-0099", question: "合并吗？" }], hosts: [{ host: "h1", online: true }], active: [], hub: { online: true } }),
    events: (after, limit) => sql.exec("SELECT seq, json FROM events WHERE seq > ? ORDER BY seq LIMIT ?", after, limit).toArray().map((r) => ({ seq: r.seq, ev: JSON.parse(r.json) })),
    say: (text, ref) => { said.push({ text, ref }); return append({ from: "owner", kind: "owner", text, ref }); },
    enqueue: (op) => { queued.push(op); },
    startCode: async (email) => (email === "owner@example.com" ? { status: 200, body: { ok: true } } : { status: 400, body: { error: "invalid email" } }),
    checkCode: async (email, code) => (code === "123456" ? { email } : { error: "验证码不对" }),
    newSession: async (email) => { const s = crypto.randomUUID().replace(/-/g, ""); sql.exec("INSERT INTO sessions (id, email) VALUES (?, ?)", s, email); return s; },
    dropSession: async () => {},
  };
  mcp = new Mcp(host);
  file("tasks/active/T-0184.md", "---\nid: T-0184\ntitle: noop: MCP server\nagent: lead\nrepo: huacnlee/noop\nclaimed_by: h1\n---\nBuild the MCP server.\n");
  file("tasks/done/T-0100.md", "---\nid: T-0100\ntitle: Fix typo\nagent: lead\n---\ndone\n");
  file("decisions/open/D-0099.md", "---\nid: D-0099\ntask: T-0184\nquestion: 合并吗？\nrecommendation: A\noptions: A: 合并 — 好 | B: 不合并 — 等\n---\n## Context\n需要你决定。\n\n## Options\n- A\n");
  return { sql, mcp, said, queued, append, file };
}

const B = "https://noop.example.com";
const post = (path: string, body: unknown, h: Record<string, string> = {}) =>
  new Request(B + path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...h }, body: JSON.stringify(body) });
const sessions = new WeakMap<Mcp, string>();
const rpc = async (mcp: Mcp, method: string, params: unknown = {}, sid = "", id: number | null = 1): Promise<{ status: number; sid: string; body: any }> => {
  if (!sid && method !== "initialize") { // every request after initialize needs a session
    if (!sessions.has(mcp)) sessions.set(mcp, (await rpc(mcp, "initialize", { protocolVersion: "2025-06-18" })).sid);
    sid = sessions.get(mcp)!;
  }
  const r = await mcp.fetch(post("/mcp", id === null ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params }, sid ? { "mcp-session-id": sid } : {}), "machine");
  const sse = r.headers.get("content-type") === "text/event-stream"; // streamed tools/call: the response is the last message
  const body = r.status === 202 ? null : sse ? (await r.text()).split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6))).find((m) => "id" in m) : await r.json();
  return { status: r.status, sid: r.headers.get("mcp-session-id") ?? "", body };
};
const tool = async (mcp: Mcp, name: string, args: unknown = {}) => {
  const r = await rpc(mcp, "tools/call", { name, arguments: args });
  return { ...r.body.result, data: r.body.result.isError ? null : JSON.parse(r.body.result.content[0].text) };
};

test("unauthenticated /mcp → 401 pointing at the protected-resource metadata", async () => {
  const { mcp } = hub();
  const r = await mcp.fetch(post("/mcp", { jsonrpc: "2.0", id: 1, method: "initialize" }), null);
  expect(r.status).toBe(401);
  expect(r.headers.get("www-authenticate")).toContain(`resource_metadata="${B}/.well-known/oauth-protected-resource"`);
  const pr = (await (await mcp.fetch(new Request(`${B}/.well-known/oauth-protected-resource/mcp`), null)).json()) as any;
  expect(pr).toMatchObject({ resource: `${B}/mcp`, authorization_servers: [B] });
  const as = (await (await mcp.fetch(new Request(`${B}/.well-known/oauth-authorization-server`), null)).json()) as any;
  expect(as).toMatchObject({ issuer: B, registration_endpoint: `${B}/oauth/register`, code_challenge_methods_supported: ["S256"] });
});

test("OAuth: register → sign in with email code → PKCE token → refresh rotates", async () => {
  const { mcp, sql } = hub();
  expect((await mcp.fetch(post("/oauth/register", { redirect_uris: ["https://evil.example.com/cb#x"] }), null)).status).toBe(400);
  const reg = await mcp.fetch(post("/oauth/register", { client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }), null);
  expect(reg.status).toBe(201);
  const client = (await reg.json()) as any;
  const verifier = "v".repeat(50), challenge = await pkceChallenge(verifier);
  const q = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    code_challenge: challenge, code_challenge_method: "S256", state: "st8" });
  const page = await mcp.fetch(new Request(`${B}/oauth/authorize?${q}`), null);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain("Claude");
  expect(html).toContain("claude.ai");
  // wrong redirect_uri is refused on the page itself (never redirected)
  const bad = new URLSearchParams(q); bad.set("redirect_uri", "https://evil.example.com/cb");
  expect((await mcp.fetch(new Request(`${B}/oauth/authorize?${bad}`), null)).status).toBe(400);
  const form = (o: Record<string, string>) => new Request(`${B}/oauth/authorize?${q}`, { method: "POST", body: new URLSearchParams(o) });
  expect(await (await mcp.fetch(form({ step: "send", email: "owner@example.com" }), null)).text()).toContain('name="code"');
  expect(await (await mcp.fetch(form({ step: "verify", email: "owner@example.com", code: "000000" }), null)).text()).toContain("验证码不对");
  const ok = await mcp.fetch(form({ step: "verify", email: "owner@example.com", code: "123456" }), null);
  expect(ok.status).toBe(302);
  const back = new URL(ok.headers.get("location")!);
  expect(back.origin + back.pathname).toBe("https://claude.ai/api/mcp/auth_callback");
  expect(back.searchParams.get("state")).toBe("st8");
  const code = back.searchParams.get("code")!;
  const tok = (b: Record<string, string>) => mcp.fetch(new Request(`${B}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(b) }), null);
  expect((await tok({ grant_type: "authorization_code", code, client_id: client.client_id, code_verifier: "wrong".repeat(10) })).status).toBe(400);
  // the failed attempt burnt the code (single use) — get a fresh one
  const again = new URL((await mcp.fetch(form({ step: "verify", email: "owner@example.com", code: "123456" }), null)).headers.get("location")!).searchParams.get("code")!;
  const t = (await (await tok({ grant_type: "authorization_code", code: again, client_id: client.client_id, code_verifier: verifier, redirect_uri: "https://claude.ai/api/mcp/auth_callback" })).json()) as any;
  expect(t.token_type).toBe("Bearer");
  expect(sql.exec("SELECT email FROM sessions WHERE id = ?", t.access_token).toArray()[0]?.email).toBe("owner@example.com");
  expect((await tok({ grant_type: "authorization_code", code: again, client_id: client.client_id, code_verifier: verifier })).status).toBe(400); // replay
  const t2 = (await (await tok({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: client.client_id })).json()) as any;
  expect(t2.access_token).toBeTruthy();
  expect((await tok({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: client.client_id })).status).toBe(400); // rotated
  // deny goes back with access_denied
  const deny = await mcp.fetch(form({ step: "deny" }), null);
  expect(new URL(deny.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
});

test("initialize, tools/list, resources", async () => {
  const { mcp } = hub();
  const init = await rpc(mcp, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  expect(init.sid).toMatch(/^[0-9a-f]{32}$/);
  expect(init.body.result.protocolVersion).toBe("2025-06-18");
  expect(init.body.result.capabilities.resources.subscribe).toBe(true);
  expect((await rpc(mcp, "notifications/initialized", {}, init.sid, null)).status).toBe(202);
  const names = (await rpc(mcp, "tools/list", {}, init.sid)).body.result.tools.map((t: any) => t.name);
  expect(names).toEqual(["get_status", "list_tasks", "get_task", "list_decisions", "get_feed", "wait_for_events", "list_agents", "list_routines", "read_memory",
    "search_journal", "search", "fetch", "send_message", "create_task", "amend_task", "cancel_task", "set_priority", "reassign_task", "remember", "edit_memory", "answer_decision"]);
  expect(names.some((n: string) => /merge|release|setting/.test(n))).toBe(false);
  const res = (await rpc(mcp, "resources/list")).body.result.resources.map((r: any) => r.uri);
  expect(res).toContain("noop://tasks/T-0184");
  expect(res).not.toContain("noop://tasks/T-0100"); // done tasks aren't listed
  const read = (await rpc(mcp, "resources/read", { uri: "noop://tasks/T-0184" })).body.result.contents[0];
  expect(JSON.parse(read.text).title).toBe("noop: MCP server");
  expect((await rpc(mcp, "nope/x")).body.error.code).toBe(-32601);
});

test("tools: read and owner-level writes", async () => {
  const { mcp, said, queued } = hub();
  expect((await tool(mcp, "get_status")).data.decisions[0].id).toBe("D-0099");
  expect((await tool(mcp, "list_tasks")).data.tasks.map((t: any) => t.id)).toEqual(["T-0184"]);
  expect((await tool(mcp, "list_tasks", { state: "all", query: "typo" })).data.tasks.map((t: any) => t.id)).toEqual(["T-0100"]);
  const t = (await tool(mcp, "get_task", { id: "T-0184" })).data;
  expect(t).toMatchObject({ state: "active", host: "h1", repo: "huacnlee/noop" });
  expect(t.body).toContain("Build the MCP server");
  expect((await tool(mcp, "get_task", { id: "T-9999" })).isError).toBe(true);
  const d = (await tool(mcp, "list_decisions")).data.decisions[0];
  expect(d).toMatchObject({ id: "D-0099", recommendation: "A", options: ["A: 合并 — 好", "B: 不合并 — 等"], context: "需要你决定。" });

  expect((await tool(mcp, "send_message", { text: "  hi team ", reply_to: "T-0184" })).data.ok).toBe(true);
  expect((await tool(mcp, "answer_decision", { id: "D-0099", answer: "A" })).data.ok).toBe(true);
  expect((await tool(mcp, "answer_decision", { id: "D-0001", answer: "A" })).isError).toBe(true); // not open
  // other writes are performed by the primary daemon (which owns the data): queued on the owner→fleet inbox
  expect((await tool(mcp, "create_task", { title: "Add dark mode", details: "Make it balanced.", repo: "huacnlee/noop" })).data.queued).toBe(true);
  expect((await tool(mcp, "cancel_task", { id: "T-0100" })).isError).toBe(true); // finished: not open
  expect(said).toEqual([{ text: "hi team", ref: "T-0184" }, { text: "D-0099 A", ref: "D-0099" }]);
  expect(queued).toEqual([{ tool: "create_task", title: "Add dark mode", details: "Make it balanced.", repo: "huacnlee/noop", agent: undefined, follows: undefined }]);

  const feed = (await tool(mcp, "get_feed")).data;
  expect(feed.events.map((e: any) => e.text)).toContain("D-0099 A");
  const s = (await tool(mcp, "search", { query: "mcp" })).data.results;
  expect(s.map((r: any) => r.id)).toEqual(["T-0184"]);
  expect(s[0].url).toBe(`${B}/?ref=T-0184`);
  const f = (await tool(mcp, "fetch", { id: "D-0099" })).data;
  expect(f).toMatchObject({ id: "D-0099", title: "D-0099 合并吗？", metadata: { state: "open" } });
});

test("wait_for_events returns as soon as an event lands", async () => {
  const { mcp, append } = hub();
  const cursor = (await tool(mcp, "get_feed")).data.cursor;
  const t0 = Date.now();
  const p = tool(mcp, "wait_for_events", { cursor, timeout_seconds: 10 });
  setTimeout(() => append({ from: "lead@h1", kind: "result", text: "T-0184 done", ref: "T-0184" }), 50);
  const r = (await p).data;
  expect(Date.now() - t0).toBeLessThan(3000);
  expect(r.events.map((e: any) => e.text)).toEqual(["T-0184 done"]);
  expect(r.cursor).toBeGreaterThan(cursor);
});

test("SSE stream delivers events as notifications/message and resources/updated for subscriptions", async () => {
  const { mcp, append } = hub();
  const { sid } = await rpc(mcp, "initialize", { protocolVersion: "2025-11-25" });
  await rpc(mcp, "resources/subscribe", { uri: "noop://tasks/T-0184" }, sid);
  await rpc(mcp, "logging/setLevel", { level: "info" }, sid);
  const r = await mcp.fetch(new Request(`${B}/mcp`, { headers: { accept: "text/event-stream", "mcp-session-id": sid } }), "machine");
  expect(r.headers.get("content-type")).toBe("text/event-stream");
  const reader = r.body!.getReader(), dec = new TextDecoder();
  append({ from: "lead@h1", kind: "result", text: "T-0184 PR opened", ref: "T-0184" });
  append({ from: "hub", kind: "system", text: "debug noise" }); // below "info" → no message
  let buf = "";
  while (!(buf.match(/^data: \{/gm)?.length! >= 2)) buf += dec.decode((await reader.read()).value);
  const msgs = buf.split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)));
  expect(msgs[0]).toMatchObject({ method: "notifications/message", params: { level: "info", logger: "noop", data: { text: "T-0184 PR opened" } } });
  expect(msgs[1]).toMatchObject({ method: "notifications/resources/updated", params: { uri: "noop://tasks/T-0184" } });
  expect(msgs.some((m) => m.params?.data?.text === "debug noise")).toBe(false);
  mcp.onChanged(["noop://status", "noop://tasks/T-0184"]);
  buf = "";
  while (!buf.includes("resources/updated")) buf += dec.decode((await reader.read()).value);
  expect(buf).toContain("noop://tasks/T-0184");
  expect(buf).not.toContain("noop://status"); // not subscribed
  for (const s of mcp.streams) s.close();
});

// ---- spec details: sessions, headers, resumability, POST SSE, progress, cancel, list_changed
const get = (mcp: Mcp, sid: string, h: Record<string, string> = {}) =>
  mcp.fetch(new Request(`${B}/mcp`, { headers: { accept: "text/event-stream", "mcp-session-id": sid, ...h } }), "machine");
/** Reads SSE frames until `until(frames)` is true. */
async function frames(r: Response, until: (f: { id?: string; data?: any; retry?: string }[]) => boolean) {
  const reader = r.body!.getReader(), dec = new TextDecoder();
  let buf = "";
  const parse = () => buf.split("\n\n").slice(0, -1).map((blk) => {
    const f: any = {};
    for (const l of blk.split("\n")) {
      if (l.startsWith("id: ")) f.id = l.slice(4);
      if (l.startsWith("retry: ")) f.retry = l.slice(7);
      if (l.startsWith("data: ") && l.length > 6) f.data = JSON.parse(l.slice(6));
    }
    return f;
  });
  while (!until(parse())) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); }
  reader.releaseLock();
  return { all: parse(), cancel: () => r.body!.cancel() };
}

test("sessions: 400 without Mcp-Session-Id, 404 when unknown, expired or deleted; protocol version validated", async () => {
  const { mcp, sql } = hub();
  const call = (h: Record<string, string>) => mcp.fetch(post("/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, h), "machine");
  expect((await call({})).status).toBe(400);
  expect((await call({ "mcp-session-id": "deadbeef" })).status).toBe(404);
  const { sid } = await rpc(mcp, "initialize", { protocolVersion: "2025-06-18" });
  expect((await call({ "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18" })).status).toBe(200);
  expect((await call({ "mcp-session-id": sid, "mcp-protocol-version": "1999-01-01" })).status).toBe(400);
  expect((await get(mcp, "")).status).toBe(400);
  expect((await get(mcp, "nope")).status).toBe(404);
  // batches are only valid for 2025-03-26
  const batch = (s: string) => mcp.fetch(post("/mcp", [{ jsonrpc: "2.0", id: 1, method: "ping" }], { "mcp-session-id": s }), "machine");
  expect((await batch(sid)).status).toBe(400);
  const old = (await rpc(mcp, "initialize", { protocolVersion: "2025-03-26" })).sid;
  expect(((await (await batch(old)).json()) as any)[0].result).toEqual({});
  // idle sessions expire
  sql.exec("UPDATE mcp_sessions SET last = ? WHERE id = ?", Date.now() - 25 * 3600_000, sid);
  expect((await call({ "mcp-session-id": sid })).status).toBe(404);
  // DELETE ends it
  expect((await mcp.fetch(new Request(`${B}/mcp`, { method: "DELETE", headers: { "mcp-session-id": old } }), "machine")).status).toBe(204);
  expect((await call({ "mcp-session-id": old })).status).toBe(404);
});

test("capabilities follow the negotiated version", async () => {
  const { mcp } = hub();
  for (const v of ["2025-11-25", "2025-06-18", "2025-03-26"]) {
    const r = (await rpc(mcp, "initialize", { protocolVersion: v })).body.result;
    expect(r.protocolVersion).toBe(v);
    expect(r.capabilities).toEqual({ tools: { listChanged: false }, resources: { subscribe: true, listChanged: true }, logging: {} });
  }
  expect((await rpc(mcp, "initialize", { protocolVersion: "2024-01-01" })).body.result.protocolVersion).toBe("2025-11-25");
});

test("GET stream: every message has an id, retry hint, priming event (2025-11-25), Last-Event-ID replays only what was missed", async () => {
  const { mcp, append } = hub();
  mcp.keepAliveMs = 30;
  const { sid } = await rpc(mcp, "initialize", { protocolVersion: "2025-11-25" });
  const r1 = await get(mcp, sid);
  const a = await frames(r1, (f) => f.filter((x) => x.data).length >= 1 || (f.length >= 2 && !!append({ from: "lead@h1", kind: "result", text: "one" }) && false));
  expect(a.all[0].retry).toBe("3000");
  expect(a.all[1]).toEqual({ id: "g.0" }); // priming: id + empty data
  const one = a.all.find((x) => x.data)!;
  expect(one.id).toBe("g.1");
  expect(one.data.params.data.text).toBe("one");
  await a.cancel(); // drop the connection
  await new Promise((res) => setTimeout(res, 10));
  append({ from: "lead@h1", kind: "result", text: "two" }); // while disconnected
  append({ from: "lead@h1", kind: "result", text: "three" });
  const b = await frames(await get(mcp, sid, { "last-event-id": "g.1" }), (f) => f.filter((x) => x.data).length >= 2);
  expect(b.all.filter((x) => x.data).map((x) => [x.id, x.data.params.data.text])).toEqual([["g.2", "two"], ["g.3", "three"]]);
  // keep-alive comments flow on idle streams
  const r3 = await get(mcp, sid);
  const reader = r3.body!.getReader();
  let buf = "";
  while (!buf.includes(": ping")) buf += new TextDecoder().decode((await reader.read()).value);
  for (const s of mcp.streams) s.close();
  expect((await get(mcp, sid, { "last-event-id": "garbage" })).status).toBe(400);
});

test("wait_for_events over a POST SSE response: progress with the client's token, then the result", async () => {
  const { mcp, append } = hub();
  mcp.progressEveryMs = 20;
  const { sid } = await rpc(mcp, "initialize", { protocolVersion: "2025-06-18" });
  const cursor = (await rpc(mcp, "tools/call", { name: "get_feed", arguments: {} }, sid)).body.result.structuredContent.cursor;
  const r = await mcp.fetch(post("/mcp", { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "wait_for_events", arguments: { cursor, timeout_seconds: 10 }, _meta: { progressToken: "tok" } } },
    { "mcp-session-id": sid }), "machine");
  expect(r.headers.get("content-type")).toBe("text/event-stream");
  setTimeout(() => append({ from: "lead@h1", kind: "result", text: "landed" }), 80);
  const f = await frames(r, (x) => x.some((y) => y.data?.id === 7));
  const progress = f.all.filter((x) => x.data?.method === "notifications/progress").map((x) => x.data.params);
  expect(progress.length).toBeGreaterThanOrEqual(2);
  expect(progress.every((p) => p.progressToken === "tok" && p.total === 10)).toBe(true);
  expect(progress.map((p) => p.progress)).toEqual([...progress.map((p) => p.progress)].sort((x, y) => x - y));
  const res = f.all.find((x) => x.data?.id === 7)!;
  expect(JSON.parse(res.data.result.content[0].text).events.map((e: any) => e.text)).toEqual(["landed"]);
  // the POST stream is resumable too: replay from its first id returns the rest, ending with the response
  const first = f.all.find((x) => x.data)!.id!;
  const again = await frames(await get(mcp, sid, { "last-event-id": first }), (x) => x.some((y) => y.data?.id === 7));
  expect(again.all.filter((x) => x.data).length).toBe(f.all.filter((x) => x.data).length - 1);
  // without progressToken / SSE accept: plain JSON
  const plain = await mcp.fetch(new Request(`${B}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", "mcp-session-id": sid },
    body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "wait_for_events", arguments: { cursor: 0, timeout_seconds: 1 } } }) }), "machine");
  expect(plain.headers.get("content-type")).toContain("application/json");
});

test("notifications/cancelled aborts wait_for_events and no response is sent", async () => {
  const { mcp } = hub();
  const { sid } = await rpc(mcp, "initialize", { protocolVersion: "2025-11-25" });
  const t0 = Date.now();
  const r = await mcp.fetch(post("/mcp", { jsonrpc: "2.0", id: "w1", method: "tools/call", params: { name: "wait_for_events", arguments: { cursor: 999999, timeout_seconds: 30 }, _meta: { progressToken: 1 } } },
    { "mcp-session-id": sid }), "machine");
  setTimeout(() => rpc(mcp, "notifications/cancelled", { requestId: "w1", reason: "user gave up" }, sid, null), 50);
  const f = await frames(r, () => false); // reads until the server closes the stream
  expect(Date.now() - t0).toBeLessThan(5000);
  expect(f.all.some((x) => x.data?.id === "w1")).toBe(false);
  expect(mcp.inflight.size).toBe(0);
});

test("resources/list_changed when the set of open tasks or decisions changes", async () => {
  const { mcp, file, append } = hub();
  const { sid } = await rpc(mcp, "initialize", { protocolVersion: "2025-06-18" });
  const r = await get(mcp, sid);
  mcp.onChanged(["noop://tasks/T-0184"]); // content change only → no list_changed
  file("tasks/active/T-0201.md", "---\nid: T-0201\ntitle: new\n---\n");
  mcp.onChanged(["noop://tasks/T-0201", "noop://status"]);
  const f = await frames(r, (x) => x.some((y) => y.data?.method === "notifications/resources/list_changed"));
  expect(f.all.filter((x) => x.data?.method === "notifications/resources/list_changed").length).toBe(1);
  expect((await rpc(mcp, "resources/list", {}, sid)).body.result.resources.map((x: any) => x.uri)).toContain("noop://tasks/T-0201");
  expect((await rpc(mcp, "resources/list", {}, sid)).body.result.resources.map((x: any) => x.uri)).toContain("noop://decisions/D-0099");
  expect(JSON.parse((await rpc(mcp, "resources/read", { uri: "noop://decisions/D-0099" }, sid)).body.result.contents[0].text).question).toBe("合并吗？");
  void append;
  for (const s of mcp.streams) s.close();
});

test("redirect URIs: https or loopback only", () => {
  expect(okRedirect("https://chatgpt.com/connector_platform_oauth_redirect")).toBe(true);
  expect(okRedirect("http://localhost:6274/oauth/callback")).toBe(true);
  expect(okRedirect("http://example.com/cb")).toBe(false);
  expect(okRedirect("javascript:alert(1)")).toBe(false);
});

test("task history: every task in pages, newest first, and any one of them on its own", () => {
  const files: Record<string, string> = {};
  const doc = (id: string, extra: string, body = "") => `---\nid: ${id}\ntitle: task ${id}\nagent: lead\n${extra}\n---\n${body}\n`;
  for (let i = 1; i <= 120; i++) { const id = `T-${String(i).padStart(4, "0")}`; files[`tasks/done/${id}.md`] = doc(id, `finished: 2026-10-01T00:${String(i % 60).padStart(2, "0")}:00Z`.replace("00:", `${String(Math.floor(i / 60)).padStart(2, "0")}:`)); }
  files["tasks/active/T-0200.md"] = doc("T-0200", "started: 2026-11-01T00:00:00Z");
  files["tasks/done/T-0200.md"] = doc("T-0200", "finished: 2026-09-01T00:00:00Z"); // mid-sync copy
  files["tasks/rejected/T-0201.md"] = doc("T-0201", "cancelled: 2026-11-02T00:00:00Z");
  files["tasks/rejected/T-0202.md"] = doc("T-0202", "approval: superseded:T-0203");
  files["tasks/done/T-0204.md"] = doc("T-0204", "finished: 2026-08-01T00:00:00Z", "> fix it\n\n## Run 2026-08-01T00:00 · h1 · claude\n**done** — fixed");
  const st = {
    read: (p: string) => (files[p] ? { path: p, text: files[p], updated: "2026-01-01T00:00:00Z" } : null),
    list: (d: string) => Object.keys(files).filter((p) => p.startsWith(d)).map((p) => ({ path: p, text: files[p], updated: "2026-01-01T00:00:00Z" })),
  } as any;
  const first = taskHistory(st, { limit: 50 });
  expect(first.total).toBe(123); // 120 + T-0200 once + cancelled T-0201 + T-0204; the superseded copy stays out
  expect(first.tasks.slice(0, 2).map((t) => [t.id, t.state])).toEqual([["T-0201", "cancelled"], ["T-0200", "active"]]);
  const ids = new Set<string>();
  for (let offset = 0; offset < first.total; offset += 50) for (const t of taskHistory(st, { offset, limit: 50 }).tasks) ids.add(t.id);
  expect(ids.size).toBe(123);
  expect(taskHistory(st, { query: "T-0204" }).tasks.map((t) => t.id)).toEqual(["T-0204"]);
  expect(taskInfo(st, "T-0204")).toMatchObject({ state: "done", request: "fix it", runs: [{ status: "done", summary: "fixed" }] });
  expect(taskInfo(st, "T-9999")).toBeNull();
});

test("task listings patch changed rows instead of re-reading the directory", () => {
  const { sql, mcp, file } = hub();
  for (let i = 0; i < 50; i++) file(`tasks/done/T-1${String(i).padStart(3, "0")}.md`, `---\nid: T-1${i}\ntitle: t${i}\n---\n`);
  const queries: string[] = [];
  const exec = sql.exec.bind(sql);
  sql.exec = (q: string, ...b: any[]) => { queries.push(q); return exec(q, ...b); };
  const store = mcp.store();
  expect(store.list("tasks/").length).toBe(52);
  queries.length = 0;
  file("tasks/active/T-0184.md", "---\nid: T-0184\ntitle: renamed\n---\n");
  sql.exec("DELETE FROM files WHERE path = 'tasks/done/T-0100.md'"); file("tasks/done/T-0100.md", "");
  sql.exec("UPDATE files SET deleted = 1 WHERE path = 'tasks/done/T-0100.md'");
  const rows = store.list("tasks/");
  expect(queries.some((q) => q.includes("path >= ?"))).toBe(false); // no full directory read
  expect(rows.length).toBe(51);
  expect(rows.find((r) => r.path === "tasks/active/T-0184.md")?.text).toContain("renamed");
  expect(rows.map((r) => r.path)).toEqual([...rows.map((r) => r.path)].sort().reverse());
});
