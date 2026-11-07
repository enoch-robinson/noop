// Approval batches, routine dedupe, read-only routines, id minting: run against a throwaway data dir.
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";

const sent: string[] = [];
const realNotify = await import("../src/notify");
mock.module("../src/notify", () => ({ ...realNotify, openDecisionIds: () => new Set<string>(), pollReplies: async () => [], notify: async (t: string) => { sent.push(t); return []; } }));
const core = await import("../src/core");
const A = await import("../src/autonomy");
const { P, readDoc, writeDoc, nextId, setIdTag, idTagFor } = core;
// test/preload.ts points DATA at a temp dir; refuse to run against anything else (e.g. a live ~/.agent-hub)
if (!core.DATA.startsWith(tmpdir())) throw new Error(`refusing to run: DATA=${core.DATA} is not a temp dir`);

afterAll(() => rmSync(core.DATA, { recursive: true, force: true }));
beforeEach(() => { rmSync(core.DATA, { recursive: true, force: true }); mkdirSync(P("journal"), { recursive: true }); sent.length = 0; setIdTag(""); });

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const task = (state: string, id: string, source: string, created = ago(60)) =>
  writeDoc(P("tasks", state, `${id}.md`), { id, title: `t ${id}`, agent: "lead", source, created }, "body");
const files = (...p: string[]) => existsSync(P(...p)) ? readdirSync(P(...p)).sort() : [];
const cfg = { autonomy: { level: "onboarding" }, routine: [{ name: "uptime-watch", readonly: true }, { name: "pr-review" }] };

test("open batch with stale tasks is closed and rebuilt (no deadlock)", async () => {
  task("proposed", "T-0001", "routine:pr-review");
  task("proposed", "T-0002", "routine:pr-review");
  await A.proposeBatch(cfg, "pc");
  expect(files("decisions", "open")).toEqual(["P-0001.md"]);
  expect(sent[0]).toContain("请确认");
  expect(sent[0]).not.toMatch(/Which|fleet/);

  // unchanged → nothing happens
  await A.proposeBatch(cfg, "pc");
  expect(sent.length).toBe(1);

  // T-0001 moved away, T-0003 is new; but the batch was just sent → throttled
  rmSync(P("tasks", "proposed", "T-0001.md"));
  task("proposed", "T-0003", "followup:T-0002");
  await A.proposeBatch(cfg, "pc");
  expect(files("decisions", "open")).toEqual(["P-0001.md"]);

  // hours later → closed and replaced by a fresh batch
  const f = P("decisions", "open", "P-0001.md");
  const { meta, body } = readDoc(f);
  writeDoc(f, { ...meta, created: ago(300), notified: ago(300) }, body);
  await A.proposeBatch(cfg, "pc");
  expect(files("decisions", "closed")).toEqual(["P-0001.md"]);
  expect(files("decisions", "open")).toEqual(["P-0002.md"]);
  expect(readDoc(P("decisions", "open", "P-0002.md")).meta.items).toBe("T-0002,T-0003");
  expect(sent.length).toBe(2);
});

test("open batch whose tasks are all gone is closed right away", async () => {
  writeDoc(P("decisions", "open", "P-0001.md"), { id: "P-0001", kind: "proposals", created: ago(1), items: "T-0009" }, "x");
  task("proposed", "T-0010", "routine:pr-review", ago(1));
  await A.proposeBatch(cfg, "pc");
  expect(files("decisions", "closed")).toEqual(["P-0001.md"]);
  expect(files("decisions", "open")).toEqual(["P-0002.md"]);
});

test("routine dedupe: newer run supersedes proposed copy, queued copy blocks", () => {
  task("proposed", "T-0001", "routine:pr-review");
  task("proposed", "T-0002", "routine:other");
  expect(A.routineQueued("pr-review")).toBe("");
  task("proposed", "T-0003", "routine:pr-review");
  expect(A.supersedeProposed("pr-review", "T-0003")).toEqual(["T-0001"]);
  expect(files("tasks", "proposed")).toEqual(["T-0002.md", "T-0003.md"]);
  expect(readFileSync(P("tasks", "rejected", "T-0001.md"), "utf8")).toContain("superseded by T-0003");

  task("active", "T-0004", "approved:routine:pr-review");
  expect(A.routineQueued("pr-review")).toBe("T-0004");
  expect(A.routineQueued("other")).toBe("");
});

test("routine dedupe: a long-parked copy stops blocking, a fresh one still does", () => {
  const park = (dir: string, id: string, hours: number) =>
    writeDoc(P("tasks", dir, `${id}.md`), { id, source: "routine:parked", created: new Date(Date.now() - hours * 3600_000).toISOString() }, "");
  park("waiting", "T-0101", 7);
  park("blocked", "T-0102", 7);
  expect(A.routineQueued("parked")).toBe("");
  park("active", "T-0103", 7);
  expect(A.routineQueued("parked")).toBe("T-0103");
  unlinkSync(P("tasks", "active", "T-0103.md"));
  park("waiting", "T-0104", 1);
  expect(A.routineQueued("parked")).toBe("T-0104");
});

test("read-only routines skip approval at onboarding; others and followups stay gated", () => {
  expect(A.needsApproval(cfg, "routine:uptime-watch")).toBe(false);
  expect(A.needsApproval(cfg, "routine:pr-review")).toBe(true);
  expect(A.needsApproval(cfg, "followup:T-0001")).toBe(true);
  expect(A.needsApproval({ ...cfg, autonomy: { level: "onboarding", auto_routines: ["pr-review"] } }, "routine:pr-review")).toBe(false);
  expect(A.needsApproval(cfg, "routine:daily-report")).toBe(false); // housekeeping unchanged
});

test("ids: non-primary hosts are tagged, primary skips ids taken in any state", () => {
  expect(idTagFor({ fleet: { primary: "pc" } }, "pc")).toBe("");
  expect(idTagFor({ fleet: { primary: "pc" } }, "mac")).toBe("M");
  expect(idTagFor({ fleet: { primary: "pc" }, host: { id_tag: "x" } }, "mac")).toBe("X");

  task("inbox", "T-0068", "owner");
  expect(nextId("T", P("tasks"))).toBe("T-0069");
  setIdTag("M");
  task("done", "T-M0003", "owner");
  expect(nextId("T", P("tasks"))).toBe("T-M0004");
  expect(nextId("D", P("decisions"))).toBe("D-M0001");
});

test("primary: named in the config, else only while no other host has a heartbeat", () => {
  rmSync(P("fleet", "hosts"), { recursive: true, force: true });
  expect(core.isPrimary({ fleet: { primary: "pc" } }, "mac")).toBe(false);
  expect(core.isPrimary({}, "mac")).toBe(true); // alone: a fresh first machine
  core.heartbeat({ host: { name: "pc" } }, 0);
  expect(core.isPrimary({}, "mac")).toBe(false); // another host is here: a worker, never a second primary
  expect(idTagFor({}, "mac")).toBe("M");
  expect(core.isPrimary({}, "pc")).toBe(true); // its own heartbeat does not count
  expect(core.isPrimary({ fleet: { primary: "mac" } }, "mac")).toBe(true);
});

test("per-machine routine (scheduler each): copies on other machines neither block nor get superseded", () => {
  const t = (dir: string, id: string, host: string) => writeDoc(P("tasks", dir, `${id}.md`), { id, host, source: "routine:security-check", created: new Date().toISOString() }, "");
  t("active", "T-0201", "mac");
  t("proposed", "T-0202", "mac");
  expect(A.routineQueued("security-check", "linux")).toBe("");
  expect(A.routineQueued("security-check", "mac")).toBe("T-0201");
  t("proposed", "T-0203", "linux");
  expect(A.supersedeProposed("security-check", "T-0203", "linux")).toEqual([]);
  expect(existsSync(P("tasks", "proposed", "T-0202.md"))).toBe(true);
});

test("built-in routines: every config has security-check (read-only, each machine); config.toml can replace it", async () => {
  const { writeFileSync } = await import("node:fs");
  mkdirSync(P(), { recursive: true });
  writeFileSync(P("config.toml"), "");
  let r = core.loadConfig().routine.find((x: any) => x.name === "security-check");
  expect(r).toMatchObject({ builtin: true, readonly: true, scheduler: "each", every: "weekly MON 09:00" });
  expect(A.needsApproval(core.loadConfig(), "routine:security-check")).toBe(false);
  writeFileSync(P("config.toml"), '[[routine]]\nname = "security-check"\nevery = "daily 08:00"\nagent = "lead"\nprompt = "x"\n');
  r = core.loadConfig().routine.filter((x: any) => x.name === "security-check");
  expect(r).toHaveLength(1);
  expect(r[0].every).toBe("daily 08:00");
  expect(r[0].builtin).toBeUndefined();
  rmSync(P("config.toml"));
});
