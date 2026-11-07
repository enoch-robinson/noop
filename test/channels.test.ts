import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { DATA, P, writeDoc } from "../src/core";
import { channelPrompt, channels, createChannel, resolveChannels, updateChannel } from "../src/channels";
import { localStore } from "../src/brain";
import { channelsView, slugify } from "../cloud/src/tools";

const reset = () => { rmSync(P("channels"), { recursive: true, force: true }); rmSync(P("tasks"), { recursive: true, force: true }); rmSync(P("decisions"), { recursive: true, force: true }); };
const store = () => localStore({ acts: {}, status: () => ({}), feed: () => [], root: DATA });

test("slugs: ascii names become kebab-case, CJK-only names get a stable id", () => {
  expect(slugify("NSH i18n")).toBe("nsh-i18n");
  expect(slugify("社区发展")).toBe(slugify("社区发展"));
  expect(slugify("社区发展")).toMatch(/^ch-[a-z0-9]+$/);
});

test("results: existing channels by slug or name, new ones need a goal, archived ones get nothing", () => {
  reset();
  createChannel("Omamail", "omamail PRs and issues");
  createChannel("NSH i18n", "translations");
  updateChannel("nsh-i18n", { archived: true });
  expect(resolveChannels(["omamail", "NSH i18n", "Typo channel", { name: "NSH community", goal: "contributors and showcases" }])).toEqual(["omamail", "nsh-community"]);
  expect(channels().map((c) => c.slug).sort()).toEqual(["nsh-community", "nsh-i18n", "omamail"]);
  expect(resolveChannels("x")).toEqual([]);
  expect(channelPrompt()).toContain("`omamail` Omamail: omamail PRs and issues");
  expect(channelPrompt()).not.toContain("nsh-i18n");
});

test("owner edits: goal and archive; unknown slugs are refused", () => {
  reset();
  createChannel("Omasend", "old goal");
  const r = updateChannel("omasend", { goal: "  new goal ", archived: true });
  expect(typeof r !== "string" && r.goal).toBe("new goal");
  expect(typeof r !== "string" && r.status).toBe("archived");
  expect(updateChannel("nope", { goal: "x" })).toContain("not found");
  expect(updateChannel("../x", { goal: "x" })).toContain("not found");
});

test("view: a channel lists its tasks and their cards newest first, and is stale after 7 quiet days", () => {
  reset();
  createChannel("Omamail", "omamail");
  createChannel("Omasend", "omasend");
  writeDoc(P("tasks", "done", "T-0001.md"), { id: "T-0001", title: "review omamail #1", channels: "omamail,gone", created: "2026-11-07T01:00:00Z", finished: "2026-11-07T02:00:00Z" }, "x");
  writeDoc(P("tasks", "blocked", "T-0002.md"), { id: "T-0002", title: "merge omamail #2?", channels: "omamail", created: "2026-11-07T03:00:00Z" }, "x");
  writeDoc(P("decisions", "open", "D-0001.md"), { id: "D-0001", task: "T-0002", question: "合并 #2 吗？", created: "2026-11-07T04:00:00Z" }, "x");
  writeDoc(P("tasks", "done", "T-0003.md"), { id: "T-0003", title: "unrelated", created: "2026-11-07T05:00:00Z" }, "x");
  const v = channelsView(store(), Date.parse("2026-11-08T00:00:00Z"));
  const om = v.channels.find((c) => c.slug === "omamail")!;
  expect(om.items.map((i) => i.id)).toEqual(["D-0001", "T-0002", "T-0001"]);
  expect(om.stale).toBe(false);
  expect(om.count).toBe(3);
  expect(v.channels.find((c) => c.slug === "omasend")!.stale).toBe(false); // just created
  expect(channelsView(store(), Date.parse("2026-11-20T00:00:00Z")).channels.every((c) => c.stale)).toBe(true);
});
