import { expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { P, writeDoc } from "../src/core";
import { usageReport, writeUsageReport } from "../src/usage-report";

const end = Date.parse("2026-11-09T01:00:00Z");
const at = (days: number) => new Date(end - days * 86400e3).toISOString();

test("usage report: this week vs previous week, PRs deduplicated, decisions by who", () => {
  rmSync(P("tasks"), { recursive: true, force: true });
  rmSync(P("decisions"), { recursive: true, force: true });
  const task = (id: string, folder: string, days: number, extra: Record<string, string>, body = "") =>
    writeDoc(P("tasks", folder, `${id}.md`), { id, created: at(days + 0.1), started: at(days + 0.05), finished: at(days), ...extra }, body);
  task("T-1", "done", 1, { source: "owner@chat", agent: "lead", claimed_by: "a", model: "m1", channels: "nsh,noop-app" }, "https://github.com/o/r/pull/1 and https://github.com/o/r/pull/1");
  task("T-2", "failed", 2, { source: "routine:pr-review", agent: "reviewer", claimed_by: "b", model: "m1" }, "https://github.com/o/r/pull/2");
  task("T-3", "done", 9, { source: "owner@chat", agent: "lead" });
  writeDoc(P("decisions", "closed", "D-1.md"), { id: "D-1", answered: at(1), answered_by: "owner(chat)" }, "");
  writeDoc(P("decisions", "closed", "D-2.md"), { id: "D-2", answered: at(3), answered_by: "judge" }, "");
  const r = usageReport(end);
  expect(r.now).toMatchObject({ created: 2, finished: 2, done: 1, failed: 1, fromOwner: 1, fromRoutines: 1, decisions: 2, byOwner: 1, byJudge: 1 });
  expect(r.now.prs.size).toBe(2);
  expect(r.prev.done).toBe(1);
  expect(r.markdown).toContain("| · done | 1 | 1 | ±0% |");
  expect(r.markdown).toContain("| · failed | 1 | 0 | new |");
  expect(r.markdown).toContain("**By channel**: nsh 1 · noop-app 1");
  expect(r.file).toBe("reports/usage/2026-11-09.md");
  writeUsageReport(end);
  expect(existsSync(P(r.file))).toBe(true);
});
