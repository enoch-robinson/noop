import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA, P, writeDoc } from "../src/core";
import { channelPrompt, channels, createChannel, resolveChannels, updateChannel } from "../src/channels";
import { context, localStore } from "../src/brain";
import { channelsView, slugify, writeOp } from "../cloud/src/tools";

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
  // own data root: the shared dir feeds other files' searches (brain.test counts 合并 decisions exactly),
  // and bun test interleaves files, so anything written here is visible to them mid-run
  const root = mkdtempSync(join(tmpdir(), "noop-channels-"));
  try {
    const st = localStore({ acts: {}, status: () => ({}), feed: () => [], root });
    const now = new Date().toISOString();
    writeDoc(join(root, "channels", "omamail.md"), { name: "Omamail", goal: "omamail", status: "active", created: now }, "");
    writeDoc(join(root, "channels", "omasend.md"), { name: "Omasend", goal: "omasend", status: "active", created: now }, "");
    writeDoc(join(root, "tasks", "done", "T-0001.md"), { id: "T-0001", title: "review omamail #1", channels: "omamail,gone", created: "2026-11-07T01:00:00Z", finished: "2026-11-07T02:00:00Z" }, "x");
    writeDoc(join(root, "tasks", "blocked", "T-0002.md"), { id: "T-0002", title: "merge omamail #2?", channels: "omamail", created: "2026-11-07T03:00:00Z" }, "x");
    writeDoc(join(root, "decisions", "open", "D-0001.md"), { id: "D-0001", task: "T-0002", question: "合并 #2 吗？", created: "2026-11-07T04:00:00Z" }, "x");
    writeDoc(join(root, "tasks", "done", "T-0003.md"), { id: "T-0003", title: "unrelated", created: "2026-11-07T05:00:00Z" }, "x");
    const v = channelsView(st, Date.parse("2026-11-08T00:00:00Z"));
    const om = v.channels.find((c) => c.slug === "omamail")!;
    expect(om.items.map((i) => i.id)).toEqual(["D-0001", "T-0002", "T-0001"]);
    expect(om.stale).toBe(false);
    expect(om.count).toBe(3);
    expect(v.channels.find((c) => c.slug === "omasend")!.stale).toBe(false); // just created
    expect(channelsView(st, Date.parse("2026-11-20T00:00:00Z")).channels.every((c) => c.stale)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("channel reports are discoverable and traversal references are excluded", () => {
  reset();
  createChannel("Mail quality", "Mail bugs and reliability");
  writeDoc(P("reports", "mail.md"), {}, "Mail review");
  writeDoc(P("tasks", "done", "T-0900.md"), { id: "T-0900", title: "Mail report", channels: "mail-quality", finished: "2026-11-07T04:00:00Z" }, "Report: reports/mail.md; duplicate reports/mail.md; invalid reports/../config.md");
  const rows = channelsView(store()).channels[0].items;
  expect(rows.filter((i) => i.kind === "report").map((i) => i.id)).toEqual(["reports/mail.md"]);
});


test("the brain sees channel goals and can classify a task at creation", () => {
  reset();
  createChannel("Mail quality", "Mail synchronization and reliability");
  const st = store();
  expect(context(st, { text: "Fix mail synchronization" })).toContain("Mail synchronization and reliability");
  const op = writeOp("create_task", { title: "Fix mail sync", channels: ["mail-quality"] }, st);
  expect(typeof op !== "string" && op.tool === "create_task" && op.channels).toEqual(["mail-quality"]);
});

import { channelDigest as digest2 } from "../cloud/src/tools";
test("channelDigest: the channel's own talk (incl. the team's replies) plus main-chat results about its work; other rooms never", () => {
  const evs = [
    { id: "1", from: "owner", kind: "owner", text: "q", channel: "a" },
    { id: "2", from: "hub", kind: "system", text: "reply", channel: "a" },
    { id: "3", from: "lead@x", kind: "notice", text: "result", ref: "T-0001" },
    { id: "4", from: "owner", kind: "owner", text: "other room", channel: "b", ref: "T-0001" },
    { id: "5", from: "hub", kind: "system", text: "ack", ref: "T-0001" },
  ];
  expect(digest2(evs, ["T-0001"], "a").map((e) => e.id)).toEqual(["1", "2", "3"]);
  expect(digest2(evs, ["T-0001"], "b").map((e) => e.id)).toEqual(["3", "4"]);
});

import { originChannel } from "../src/channels";
test("originChannel: a task started in a channel, and cards about it, route back there", () => {
  reset();
  writeDoc(P("tasks", "done", "T-0901.md"), { id: "T-0901", title: "x", origin_channel: "nsh-i18n" }, "x");
  writeDoc(P("tasks", "inbox", "T-0902.md"), { id: "T-0902", title: "y" }, "y");
  writeDoc(P("decisions", "open", "D-0901.md"), { id: "D-0901", task: "T-0901" }, "q");
  expect(originChannel("T-0901")).toBe("nsh-i18n");
  expect(originChannel("D-0901")).toBe("nsh-i18n");
  expect(originChannel("T-0902")).toBeUndefined();
  expect(originChannel("T-9999")).toBeUndefined();
});

test("brain context: a message said in a channel names the channel and its goal", () => {
  reset();
  const c = context(store(), { text: "进度？", channel: { slug: "nsh-i18n", name: "NSH i18n", goal: "translations" } });
  expect(c).toContain("inside the channel #NSH i18n");
  expect(c).toContain("goal: translations");
});
