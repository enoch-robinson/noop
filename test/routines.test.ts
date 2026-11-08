// runRoutines must keep the fleet alive no matter what a single routine throws (2026-11-08: the learn
// routine crashed on a session file, the whole tick died before the claim loop, and the queue starved
// overnight). One throwing routine: 💥 in the journal, the others still fire, routine-state.json is
// still persisted so schedules don't rewind into a re-fire storm.
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const sessions = await import("../src/sessions");
mock.module("../src/sessions", () => ({ ...sessions, collect: () => { throw new Error("boom session db"); } }));
const core = await import("../src/core");
const cli = await import("../src/cli");
const { P } = core;
if (!core.DATA.startsWith(tmpdir())) throw new Error(`refusing to run: DATA=${core.DATA} is not a temp dir`);

afterAll(() => rmSync(core.DATA, { recursive: true, force: true }));
beforeEach(() => rmSync(core.DATA, { recursive: true, force: true }));

const journalText = () => existsSync(P("journal")) ? require("node:fs").readdirSync(P("journal")).map((f: string) => readFileSync(P("journal", f), "utf8")).join("\n") : "";
const cfg = {
  fleet: {}, routine: [
    { name: "learn-ceo", kind: "learn", every: "1m" },
    { name: "uptime-watch", readonly: true, every: "1m", agent: "ops-watcher", priority: "high", prompt: "check" },
    { name: "triage-inbound", every: "1m", agent: "dispatcher", prompt: "scan" },
  ],
};

test("one throwing routine is isolated; the rest fire and the schedule state still persists", () => {
  mkdirSync(P("journal"), { recursive: true });
  cli.runRoutines(cfg as never, "pc", true);
  const log = journalText();
  expect(log).toContain("💥 routine `learn-ceo` failed");
  expect(log).toContain("routine `uptime-watch` → T-");
  expect(log).toContain("routine `triage-inbound` → T-");
  // every fired routine's timestamp was persisted: the next tick must not re-fire them
  const state = JSON.parse(readFileSync(P("logs", "routine-state.json"), "utf8"));
  expect(Object.keys(state)).toEqual(expect.arrayContaining(["learn-ceo", "uptime-watch", "triage-inbound"]));
});

test("a second run right after does not re-fire (state was persisted even though learn threw)", () => {
  mkdirSync(P("journal"), { recursive: true });
  cli.runRoutines(cfg as never, "pc", true);
  const lines = journalText().match(/routine `(uptime-watch|triage-inbound)` → T-/g)?.length ?? 0;
  cli.runRoutines(cfg as never, "pc", true);
  expect((journalText().match(/routine `(uptime-watch|triage-inbound)` → T-/g) ?? []).length).toBe(lines);
});
