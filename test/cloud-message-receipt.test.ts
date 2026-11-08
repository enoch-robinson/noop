import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));
mock.module("cloudflare:email", () => ({ EmailMessage: class {} }));
mock.module("cloudflare:sockets", () => ({ connect: () => { throw new Error("No network in this test"); } }));
// The Worker has its own runtime types; Bun supplies the bindings above.
const workerModule = "../cloud/src/index";
const { Hub } = await import(workerModule);

test("cloud retries return one event and queue one task; identical new messages stay separate", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE events (json TEXT)");
  db.run("CREATE INDEX events_client_id ON events (json_extract(json, '$.client_id')) WHERE json_extract(json, '$.client_id') IS NOT NULL");
  const queued: unknown[] = [];
  const host = {
    sql: { exec: (q: string, ...args: any[]) => ({ toArray: () => db.query(q).all(...args) }) },
    append: (e: any) => { const ev = { ...e, id: crypto.randomUUID() }; db.query("INSERT INTO events VALUES (?)").run(JSON.stringify(ev)); return ev; },
    toInbox: (e: unknown) => queued.push(e),
    hostOnline: () => true,
  };
  const send = (id?: string) => Hub.prototype.ownerMessage.call(host as any, "Same message", undefined, undefined, false, id);
  try {
    const first = send("local:one");
    expect(send("local:one")).toEqual(first);
    expect(queued.length).toBe(1);
    expect(send("local:two").id).not.toBe(first.id);
    expect(send().id).not.toBe(send().id);
    expect(queued.length).toBe(4);
    expect(JSON.stringify(db.query("EXPLAIN QUERY PLAN SELECT json FROM events WHERE json_extract(json, '$.client_id') = ? LIMIT 1").all("local:one"))).toContain("USING INDEX events_client_id");
  } finally { db.close(); }
});

test("cloud channel feeds use indexed channel and reference lookups", async () => {
  const source = await Bun.file(new URL("../cloud/src/index.ts", import.meta.url)).text();
  const index = source.match(/CREATE INDEX IF NOT EXISTS events_channel[^"\n]+/)![0];
  const query = source.match(/SELECT json FROM events WHERE ref IN \(SELECT value[^"\n]+/)![0];
  const db = new Database(":memory:");
  try {
    db.run("CREATE TABLE events (seq INTEGER PRIMARY KEY, ref TEXT, json TEXT)");
    db.run("CREATE INDEX events_ref ON events (ref)");
    db.run(index);
    const insert = db.query("INSERT INTO events VALUES (?, ?, ?)");
    insert.run(1, "T-1", JSON.stringify({ id: "result", ref: "T-1" }));
    insert.run(2, null, JSON.stringify({ id: "talk", channel: "nsh" }));
    insert.run(3, "T-2", JSON.stringify({ id: "other", channel: "mail" }));
    expect(db.query(query).all('["T-1"]', "nsh").map((r: any) => JSON.parse(r.json).id)).toEqual(["talk", "result"]);
    const plan = JSON.stringify(db.query(`EXPLAIN QUERY PLAN ${query}`).all('["T-1"]', "nsh"));
    expect(plan).toContain("USING INDEX events_ref");
    expect(plan).toContain("USING INDEX events_channel");
    expect(plan).not.toContain("SCAN events");
  } finally { db.close(); }
});
