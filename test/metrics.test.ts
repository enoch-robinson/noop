// Reply metrics: answer latency + how the owner answers (channel/via); old-format closed cards are skipped from
// latency tallies, never a crash.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const W = mkdtempSync(join(tmpdir(), "hub-metrics-"));
let core: typeof import("../src/core"), metrics: typeof import("../src/metrics");
beforeAll(async () => {
  process.env.HUB_DATA ||= join(W, "data"); // test/preload.ts normally sets a temp dir already
  process.env.HUB_SYNC = "local";
  core = await import("../src/core");
  if (!core.DATA.startsWith(tmpdir())) throw new Error(`DATA=${core.DATA} is not a temp dir; refusing to touch real data`);
  for (const d of ["decisions/closed", "tasks/done", "tasks/rejected", "fleet"])
    mkdirSync(join(core.DATA, d), { recursive: true });
  metrics = await import("../src/metrics");
});
afterAll(() => { // the data dir is shared with every other test file: leave the clean slate beforeAll took
  for (const d of ["decisions/closed", "tasks/done", "tasks/rejected"]) rmSync(core.P(d), { recursive: true, force: true });
  rmSync(W, { recursive: true, force: true });
});

const card = (id: string, meta: Record<string, string>) =>
  core.writeDoc(core.P("decisions", "closed", `${id}.md`), { agent: "lead", ...meta }, "");

test("reply latency buckets and channel tallies: old-format cards are skipped from latency, not errors", () => {
  const now = new Date().toISOString();
  card("D-0501", { question: "q", answer: "B: safe", recommendation: "A", answered_by: "owner(chat)",
    answered: now, answered_ms: "120000", answered_via: "button", answered_channel: "slack" }); // 2m
  card("D-0502", { question: "q", answer: "A: fast", answered_by: "owner(slack)", answered: now,
    answered_ms: "7200000", answered_via: "text", answered_channel: "discord" }); // 2h
  card("D-0503", { question: "q", answer: "B: safe", answered_by: "owner(chat)", answered: now, answered_ms: "180000" }); // 3m, no via
  card("D-0504", { question: "q", answer: "B", answered_by: "judge", answered: now, answered_ms: "60000",
    answered_via: "button", answered_channel: "web" }); // judge answers are not owner replies
  card("D-0505", { question: "q", answer: "B: safe", answered_by: "owner(chat)", answered: now }); // old format: no answered_ms/via
  const d = metrics.computeMetrics().decisions;
  expect(d.total).toBe(5);
  expect(d.by_owner).toBe(4);
  expect(d.by_judge).toBe(1);
  expect(d.reply_latency).toEqual({ sampled: 3, median_minutes: 3, buckets: { under_5m: 2, under_1h: 0, under_1d: 1, older: 0 } });
  expect(d.by_channel).toEqual({ slack: 1, discord: 1, unknown: 2 });
  expect(d.by_via).toEqual({ button: 1, text: 1, unknown: 2 });
});

test("even sample count: the median is the mean of the two middle values", () => {
  rmSync(core.P("decisions", "closed"), { recursive: true, force: true }); // the previous test leaves its cards behind
  mkdirSync(core.P("decisions", "closed"), { recursive: true });
  const now = new Date().toISOString();
  card("D-0601", { question: "q", answer: "B", answered_by: "owner(chat)", answered: now,
    answered_ms: "120000", answered_via: "text", answered_channel: "slack" }); // 2m
  card("D-0602", { question: "q", answer: "A", answered_by: "owner(chat)", answered: now,
    answered_ms: "240000", answered_via: "text", answered_channel: "slack" }); // 4m
  const d = metrics.computeMetrics().decisions;
  expect(d.reply_latency.sampled).toBe(2);
  expect(d.reply_latency.median_minutes).toBe(3); // (2m + 4m) / 2
});
