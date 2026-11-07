// Judge shadow mode + learning loop: every routed decision records the judge's answer; owner answers score it.
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const W = mkdtempSync(join(tmpdir(), "hub-decisions-"));
let judgeReply: any = null;
const sent: string[] = [];
const notifyOpts: any[] = [];
const realRunner = await import("../src/runner");
mock.module("../src/runner", () => ({ ...realRunner, ask: async () => judgeReply }));
const realNotify = await import("../src/notify");
// the module cache is shared across test files: realNotify may already carry an earlier file's stub
// (autonomy.test.ts blanks openDecisionIds), so the fs-reading helper is spelled out here — handleReplies
// needs real open-card ids, or every reply is dropped as "no such card"
mock.module("../src/notify", () => ({ ...realNotify,
  openDecisionIds: () => new Set(core.list(core.P("decisions", "open")).map(core.fileId)),
  pollReplies: async () => [],
  notify: async (t: string, _c: unknown, o: any = {}) => { sent.push(t); notifyOpts.push(o); return ["test"]; } }));

let core: typeof import("../src/core"), dec: typeof import("../src/decisions"), auto: typeof import("../src/autonomy");
beforeAll(async () => {
  process.env.HUB_DATA ||= join(W, "data"); // test/preload.ts normally sets a temp dir already
  process.env.HUB_SYNC = "local";
  core = await import("../src/core");
  if (!core.DATA.startsWith(tmpdir())) throw new Error(`DATA=${core.DATA} is not a temp dir; refusing to touch real data`);
  for (const d of ["decisions/open", "decisions/closed"]) rmSync(core.P(d), { recursive: true, force: true });
  rmSync(core.P("memory", "lessons.md"), { force: true });
  dec = await import("../src/decisions");
  auto = await import("../src/autonomy");
  for (const d of ["decisions/open", "decisions/closed", "tasks/blocked", "tasks/inbox", "memory", "journal", "logs/runs"])
    mkdirSync(join(core.DATA, d), { recursive: true });
});
afterAll(() => { // the data dir is shared with every other test file: leave the clean slate beforeAll took
  for (const d of ["decisions/open", "decisions/closed"]) rmSync(core.P(d), { recursive: true, force: true });
  rmSync(W, { recursive: true, force: true });
});

const cfg = { judge: { enabled: true } } as any; // autonomy level defaults to onboarding → shadow mode
const open = (rec = "A", question = "Merge?") => dec.openDecision({ id: "T-0001", agent: "lead" }, { status: "blocked", summary: "ctx", question, recommendation: rec, options: ["A: merge", "B: wait"] } as any, "h");
const closed = (id: string) => core.readDoc(core.P("decisions", "closed", `${id}.md`)).meta;
const lessons = () => (existsSync(core.P("memory", "lessons.md")) ? readFileSync(core.P("memory", "lessons.md"), "utf8") : "");

test("judge hold is still recorded and scored against the owner", async () => {
  judgeReply = { verdict: "hold", answer: "B: wait", reason: "release gate" };
  const id = open("A");
  await dec.routeDecision(id, cfg, "h");
  const o = core.readDoc(core.P("decisions", "open", `${id}.md`)).meta;
  expect(o.shadow_verdict).toBe("hold");
  expect(o.shadow_answer).toBe("B: wait");
  // the card: the question, the agent's account, its recommendation; never the judge's reason for asking
  expect(sent.at(-1)).toContain("Merge?");
  expect(sent.at(-1)).toContain("建议：*A*");
  expect(sent.at(-1)).not.toContain("release gate");
  dec.closeDecision(id, "B", "owner(chat)");
  expect(closed(id).shadow_agree).toBe("yes");
  // owner chose differently from the agent's recommendation → lesson appended (precedents() lists it too)
  expect(closed(id).overrode_recommendation).toBe("yes");
  expect(lessons()).toContain(`${id} [lead]`);
  expect(core.precedents()).toContain(`${id} [lead] Q: Merge?`);
});

test("shadow decided verdict feeds judgeAccuracy; agreeing with the recommendation adds no lesson", async () => {
  judgeReply = { verdict: "decided", answer: "A", reason: "precedent", cite: "D-0001" };
  const before = lessons();
  const id = open("A");
  await dec.routeDecision(id, cfg, "h");
  expect(existsSync(core.P("decisions", "open", `${id}.md`))).toBe(true); // onboarding: still asks the owner
  dec.closeDecision(id, "A: merge", "owner(cli@h)");
  expect(closed(id).shadow_verdict).toBe("decided");
  expect(closed(id).shadow_agree).toBe("yes");
  expect(lessons()).toBe(before);
  const acc = auto.judgeAccuracy();
  expect(acc.samples).toBe(2);
  expect(acc.would_decide).toBe(1);
  expect(acc.scored).toBe(2); // the held decision is scored too
  expect(acc.agreed).toBe(2);
});

test("judge failure is recorded as error; judge auto-decision keeps its shadow fields and is not self-scored", async () => {
  judgeReply = null;
  const id = open();
  await dec.routeDecision(id, cfg, "h");
  expect(core.readDoc(core.P("decisions", "open", `${id}.md`)).meta.shadow_verdict).toBe("error");
  dec.closeDecision(id, "B", "owner(chat)");
  expect(closed(id).shadow_agree).toBeUndefined();

  judgeReply = { verdict: "decided", answer: "A", reason: "precedent" };
  const id2 = open("A", "Which fix?"); // merge cards are always held (rule D), so a non-merge card
  await dec.routeDecision(id2, { ...cfg, autonomy: { level: "trusted" } }, "h");
  expect(closed(id2).answered_by).toBe("judge");
  expect(closed(id2).shadow_verdict).toBe("decided");
  expect(closed(id2).shadow_agree).toBeUndefined();
});

test("choice() normalises option answers", () => {
  expect(dec.choice("B: wait")).toBe("B");
  expect(dec.choice(" a ")).toBe("A");
  expect(dec.choice("1, 3")).toBe("1,3");
  expect(dec.choice("Approve it")).toBe("approve it");
});

test("decision cards carry structured choices (recommended + gated risk); legacy options still parse", async () => {
  judgeReply = null;
  const id = dec.openDecision({ id: "T-0003", agent: "lead" }, { status: "needs_decision", summary: "ctx",
    question: "现在合并 x #1 吗？", recommendation: "A", options: ["A: merge now", "B: wait"] } as any, "h");
  const meta = core.readDoc(core.P("decisions", "open", `${id}.md`)).meta;
  const parsed = JSON.parse(meta.options_json);
  expect(parsed).toEqual([
    { key: "A", label: "A: merge now", recommended: true, risk: "high" },
    { key: "B", label: "B: wait", risk: "high" }, // the question is a merge card: every option confirms twice
  ]);
  expect(meta.options).toBe("A: merge now | B: wait"); // legacy string stays for older clients
  await dec.routeDecision(id, cfg, "h"); // judge unavailable → held → notified with structured choices
  expect(notifyOpts.at(-1)?.choices).toEqual(parsed);
  expect(notifyOpts.at(-1)?.options).toEqual(["A: merge now", "B: wait"]); // derived, never an independent source
  // legacy fallbacks: no options_json, corrupted JSON, wrong shape, empty array, leading whitespace, no prefix
  expect(dec.parseOptions({ options: "A: approve | B: reject" })).toEqual([{ key: "A", label: "A: approve" }, { key: "B", label: "B: reject" }]);
  const legacy = { options: "A: x | B: y" };
  for (const broken of ["not json", '[{"key":1}]', "[]"]) expect(dec.parseOptions({ ...legacy, options_json: broken })).toEqual([{ key: "A", label: "A: x" }, { key: "B", label: "B: y" }]);
  expect(dec.parseOptions({ options: "  B: wait" }).map((o) => o.key)).toEqual(["B"]);
  expect(dec.parseOptions({ options: "继续等 CI | 直接关掉" }).map((o) => o.key)).toEqual(["", ""]); // free-form labels: empty key, UI falls back to free text
  dec.closeDecision(id, "B", "owner(chat)"); // leave no open card behind
});

test("merge cards are high-risk from the trusted question rule even with verb-less labels", async () => {
  judgeReply = { verdict: "decided", answer: "A", reason: "precedent" };
  const id = dec.openDecision({ id: "T-0004", agent: "reviewer" }, { status: "needs_decision", summary: "ctx",
    question: "现在合并 omamail #457 吗？", recommendation: "A", options: ["A: yes", "B: no"] } as any, "h");
  expect(JSON.parse(core.readDoc(core.P("decisions", "open", `${id}.md`)).meta.options_json)).toEqual([
    { key: "A", label: "A: yes", recommended: true, risk: "high" },
    { key: "B", label: "B: no", risk: "high" },
  ]);
  dec.closeDecision(id, "B", "owner(chat)");
});

test("proposal batches carry structured choices", async () => {
  mkdirSync(join(core.DATA, "tasks", "proposed"), { recursive: true });
  core.writeDoc(core.P("tasks", "proposed", "T-0501.md"), { id: "T-0501", title: "fix CI", agent: "reviewer", source: "routine:x", created: core.now() }, "body");
  core.writeDoc(core.P("tasks", "proposed", "T-0502.md"), { id: "T-0502", title: "update deps", agent: "lead", source: "routine:x", created: core.now() }, "body");
  await auto.proposeBatch({ autonomy: { batch_minutes: 0 } } as any, "h");
  const card = core.list(core.P("decisions", "open")).map((p) => core.readDoc(p)).find((d) => d.meta.kind === "proposals");
  expect(card).toBeTruthy();
  const choices = JSON.parse(card!.meta.options_json);
  expect(choices.map((o: any) => o.key)).toEqual(["1", "2", "all", "none"]);
  expect(notifyOpts.at(-1)?.choices).toEqual(choices);
  auto.resolveProposals(card!.meta.id, "1", "owner(chat)");
  rmSync(core.P("tasks", "inbox", "T-0501.md"), { force: true });
  rmSync(core.P("tasks", "rejected", "T-0502.md"), { force: true });
  rmSync(core.P("decisions", "closed", `${card!.meta.id}.md`), { force: true });
});

test("proposal batches cap at nine items with all/none appended", async () => {
  mkdirSync(join(core.DATA, "tasks", "proposed"), { recursive: true });
  for (let i = 1; i <= 10; i++) {
    const tid = `T-06${String(i).padStart(2, "0")}`;
    core.writeDoc(core.P("tasks", "proposed", `${tid}.md`), { id: tid, title: `t${i}`, agent: "lead", created: core.now() }, "b");
  }
  await auto.proposeBatch({ autonomy: { batch_minutes: 0 } } as any, "h");
  const card = core.list(core.P("decisions", "open")).map((p) => core.readDoc(p)).find((d) => d.meta.kind === "proposals");
  expect(card).toBeTruthy();
  expect(card!.meta.items.split(",")).toHaveLength(9); // slice(0, 9)
  const choices = JSON.parse(card!.meta.options_json);
  expect(choices).toHaveLength(11); // 9 items + all + none
  expect(choices.slice(-2).map((o: any) => o.key)).toEqual(["all", "none"]);
  auto.resolveProposals(card!.meta.id, "none", "owner(chat)");
  for (let i = 1; i <= 9; i++) rmSync(core.P("tasks", "rejected", `T-06${String(i).padStart(2, "0")}.md`), { force: true });
  rmSync(core.P("tasks", "proposed", "T-0610.md"), { force: true });
  rmSync(core.P("decisions", "closed", `${card!.meta.id}.md`), { force: true });
});

test("linkRefs links PR references using the repositories the decision mentions", () => {
  const opts = "A: squash 合并 https://github.com/longbridge/nsh/pull/747 — 发布";
  expect(dec.linkRefs("合并 nsh #747 吗？", undefined, opts)).toBe("合并 [nsh#747](https://github.com/longbridge/nsh/pull/747) 吗？");
  expect(dec.linkRefs("见 PR #747", undefined, opts)).toBe("见 PR [#747](https://github.com/longbridge/nsh/pull/747)");
  expect(dec.linkRefs("改 a/b#3", undefined, "")).toBe("改 [a/b#3](https://github.com/a/b/pull/3)");
  // an unknown repository, an existing link and no repository at all stay as they are
  expect(dec.linkRefs("见 other#3 与 [#9](u)", undefined, opts)).toBe("见 other#3 与 [#9](u)");
  expect(dec.linkRefs("见 #5", undefined, "")).toBe("见 #5");
});

test("ignoring a question closes it without a lesson and hands the call back to the agent", async () => {
  judgeReply = { verdict: "hold", reason: "owner call" };
  const before = lessons();
  const id = open("A");
  core.writeDoc(core.P("tasks", "blocked", "T-0001.md"), { id: "T-0001", title: "t" }, "body");
  expect(dec.ignoreDecision(id, "owner(chat)")).toBe(true);
  expect(closed(id).ignored).toBe("yes");
  expect(closed(id).overrode_recommendation).toBeUndefined();
  expect(lessons()).toBe(before);
  expect(existsSync(core.P("tasks", "blocked", "T-0001.md"))).toBe(false);
  expect(existsSync(core.P("tasks", "rejected", "T-0001.md"))).toBe(false);
  const t = core.readDoc(core.P("tasks", "inbox", "T-0001.md"));
  expect(t.meta.gate_override).toBeUndefined();
  expect(t.body).toContain("NOT a rejection");
  expect(dec.ignoreDecision(id, "owner(chat)")).toBe(false);
});

test("D: the judge never answers a merge card, even when allowed to decide", async () => {
  judgeReply = { verdict: "decided", answer: "A", reason: "precedent", cite: "D-0107" };
  sent.length = 0;
  const id = dec.openDecision({ id: "T-0002", agent: "reviewer" }, { status: "needs_decision", summary: "https://github.com/huacnlee/omamail/pull/457 fixes x",
    question: "现在合并 omamail #457 吗？", recommendation: "A", options: ["A: merge", "B: wait"] } as any, "h");
  await dec.routeDecision(id, { judge: { enabled: true }, autonomy: { level: "trusted" } } as any, "h");
  expect(existsSync(core.P("decisions", "open", `${id}.md`))).toBe(true);
  expect(sent.at(-1)!.split("\n")[0]).toBe("https://github.com/huacnlee/omamail/pull/457 需要你点合并");
});

test("judge decided sends a quiet receipt with the veto button, and a chat veto overrides the closed card", async () => {
  judgeReply = { verdict: "decided", answer: "B", reason: "precedent", cite: "D-0001" };
  sent.length = 0; notifyOpts.length = 0;
  const id = dec.openDecision({ id: "T-0401", agent: "lead" }, { status: "needs_decision", summary: "ctx",
    question: "选哪个方案？", recommendation: "A", options: ["A: fast", "B: safe"] } as any, "h");
  await dec.routeDecision(id, { judge: { enabled: true }, autonomy: { level: "trusted" } } as any, "h");
  expect(closed(id).answered_by).toBe("judge");
  // the receipt is the only follow-up message: quiet (no push), with the veto as its one high-risk button
  expect(sent).toHaveLength(1);
  expect(notifyOpts.at(-1)?.quiet).toBe(true);
  expect(notifyOpts.at(-1)?.kind).toBe("decision");
  expect(notifyOpts.at(-1)?.ref).toBe(id);
  expect(notifyOpts.at(-1)?.choices).toEqual([{ key: "override", label: "否决，重新决定", risk: "high" }]);
  expect(notifyOpts.at(-1)?.from).toBe("judge@h");
  expect(sent.at(-1)).toContain("judge 已代答");
  // the veto rides the reply path even though the card is closed — the already-answered drop must not eat it
  const srv = await import("../src/server");
  const { handleReplies } = await import("../src/cli");
  srv.answerFromChat(id, "override 不安全，用 A", false);
  await handleReplies(cfg, "h");
  expect(closed(id).answered_by).toBe("owner-override(chat)");
  expect(closed(id).overridden_judge).toBe("B");
  expect(readFileSync(core.P("memory", "judge-feedback.md"), "utf8")).toContain(`${id}: Q「选哪个方案？」`);
  const redo = core.list(core.P("tasks", "inbox")).map((p) => core.readDoc(p)).find((d) => d.meta.source === `override:${id}`);
  expect(redo).toBeTruthy();
  const evs = srv.feed(undefined, 500).filter((e) => e.kind === "resolved" && e.ref === id);
  expect(evs.at(-1)?.state).toBe("overridden");
  rmSync(core.P("tasks", "inbox", `${redo!.meta.id}.md`), { force: true }); // shared data dir: leave no redo behind
  rmSync(core.P("memory", "judge-feedback.md"), { force: true });
});

test("snooze keeps the card open with a wake_at; the tick re-presents it when due", async () => {
  judgeReply = { verdict: "hold", reason: "owner call" };
  sent.length = 0; notifyOpts.length = 0;
  const id = open("A");
  await dec.routeDecision(id, cfg, "h"); // held + notified
  expect(dec.snoozeDecision(id, 30, "owner(chat)")).toBe(true); // the chat path ("稍后 30m") lands here from handleReplies
  const f = core.P("decisions", "open", `${id}.md`);
  const wake = core.readDoc(f).meta.wake_at;
  expect(wake).toBeTruthy();
  expect(Date.parse(wake) - Date.now()).toBeGreaterThan(25 * 60_000); // ~30 minutes out
  expect(dec.wakeDue()).not.toContain(id); // not due yet
  expect(existsSync(core.P("decisions", "closed", `${id}.md`))).toBe(false); // snooze is not an answer
  const srv = await import("../src/server");
  const evs = srv.feed(undefined, 500).filter((e) => e.kind === "resolved" && e.ref === id);
  expect(evs.at(-1)?.state).toBe("snoozed");
  // due: the tick re-presents the same card and clears the wake
  const { meta, body } = core.readDoc(f);
  core.writeDoc(f, { ...meta, wake_at: new Date(Date.now() - 1000).toISOString() }, body);
  expect(dec.wakeDue()).toContain(id);
  sent.length = 0;
  await dec.holdNotify(id, cfg, "h");
  expect(core.readDoc(f).meta.wake_at).toBeUndefined();
  expect(sent.at(-1)).toContain("Merge?"); // the original card, re-presented
  dec.closeDecision(id, "B", "owner(chat)"); // leave no open card behind
});

test("resolving a card emits resolved events the app can live-update on", async () => {
  judgeReply = { verdict: "hold", reason: "owner call" };
  const srv = await import("../src/server");
  let id = open("A");
  await dec.routeDecision(id, cfg, "h");
  dec.closeDecision(id, "B", "owner(cli@h)");
  let evs = srv.feed(undefined, 500).filter((e) => e.kind === "resolved" && e.ref === id);
  expect(evs.at(-1)?.state).toBe("answered");
  expect(evs.at(-1)?.by).toBe("owner(cli@h)");
  id = open("A");
  core.writeDoc(core.P("tasks", "blocked", "T-0001.md"), { id: "T-0001", title: "t" }, "body");
  dec.ignoreDecision(id, "owner(chat)");
  evs = srv.feed(undefined, 500).filter((e) => e.kind === "resolved" && e.ref === id);
  expect(evs.at(-1)?.state).toBe("ignored");
  rmSync(core.P("tasks", "inbox", "T-0001.md"), { force: true });
});

test("free text on an open card is arbitrated: mapped closes it; unclear or high-risk keeps it open", async () => {
  const srv = await import("../src/server");
  const { handleReplies } = await import("../src/cli");
  const card = () => dec.openDecision({ id: "T-0402", agent: "lead" }, { status: "needs_decision", summary: "ctx",
    question: "选哪个方案？", recommendation: "A", options: ["A: fast", "B: safe"] } as any, "h");
  // mapped to a safe option: the card closes with the mapped label and a receipt names the mapping
  judgeReply = { key: "B", why: "CI 未绿" };
  sent.length = 0;
  let id = card();
  srv.answerFromChat(id, "先别求快，稳一点", false);
  await handleReplies(cfg, "h");
  expect(closed(id).answer).toBe("B: safe");
  expect(sent.at(-1)).toContain("按 *B* 处理");
  // high-risk mapping: words alone must not unlock it — the card stays open and the owner is asked to confirm
  judgeReply = { key: "A", why: "字面意思" };
  id = dec.openDecision({ id: "T-0403", agent: "reviewer" }, { status: "needs_decision", summary: "fixes x",
    question: "现在合并 x #1 吗？", recommendation: "A", options: ["A: merge", "B: wait"] } as any, "h");
  srv.answerFromChat(id, "直接合了吧", false);
  await handleReplies(cfg, "h");
  expect(existsSync(core.P("decisions", "open", `${id}.md`))).toBe(true);
  expect(sent.at(-1)).toContain("高风险");
  dec.closeDecision(id, "A", "owner(chat)");
  // unclear: the owner is asked again with the options — never guessed
  judgeReply = { key: "unclear", why: "意思不明" };
  id = card();
  srv.answerFromChat(id, "随便弄吧", false);
  await handleReplies(cfg, "h");
  expect(existsSync(core.P("decisions", "open", `${id}.md`))).toBe(true);
  expect(sent.at(-1)).toContain("没听懂");
  dec.closeDecision(id, "B", "owner(chat)");
  // brain unavailable: still a receipt, never silent
  judgeReply = null;
  id = card();
  srv.answerFromChat(id, "看着办", false);
  await handleReplies(cfg, "h");
  expect(existsSync(core.P("decisions", "open", `${id}.md`))).toBe(true);
  expect(sent.at(-1)).toContain("没听懂");
  dec.closeDecision(id, "B", "owner(chat)");
});

test("the same free-text words are arbitrated once per renotify window; new wording re-runs", async () => {
  const srv = await import("../src/server");
  const { handleReplies } = await import("../src/cli");
  judgeReply = { key: "unclear", why: "意思不明" };
  const id = dec.openDecision({ id: "T-0408", agent: "lead" }, { status: "needs_decision", summary: "ctx",
    question: "选哪个方案？", recommendation: "A", options: ["A: fast", "B: safe"] } as any, "h");
  srv.answerFromChat(id, "随便弄吧", false);
  await handleReplies(cfg, "h");
  expect(sent.at(-1)).toContain("没听懂");
  const afterFirst = sent.length;
  // polling channels re-deliver the same channel message every tick: no second brain run, no second notification
  srv.answerFromChat(id, "随便弄吧", false);
  await handleReplies(cfg, "h");
  expect(sent.length).toBe(afterFirst);
  // different words are a new message from the owner, not a re-poll: they get answered
  srv.answerFromChat(id, "我是说先稳住", false);
  await handleReplies(cfg, "h");
  expect(sent.length).toBe(afterFirst + 1);
  expect(sent.at(-1)).toContain("没听懂");
  dec.closeDecision(id, "B", "owner(chat)");
});

test("a brain reply without a key never lands a keyless-option card (never a guess)", async () => {
  const srv = await import("../src/server");
  const { handleReplies } = await import("../src/cli");
  judgeReply = { why: "意思不明" }; // malformed: no key at all
  const id = dec.openDecision({ id: "T-0409", agent: "lead" }, { status: "needs_decision", summary: "ctx",
    question: "选哪个方案？", recommendation: "", options: ["稳一点", "快一点"] } as any, "h");
  srv.answerFromChat(id, "随便弄吧", false);
  await handleReplies(cfg, "h");
  expect(existsSync(core.P("decisions", "open", `${id}.md`))).toBe(true); // an empty key must not match the first keyless option
  expect(sent.at(-1)).toContain("没听懂");
  dec.closeDecision(id, "稳一点", "owner(chat)");
});

test("a fragment that only looks like a high-risk option is refused; the bare key confirms", async () => {
  const srv = await import("../src/server");
  const { handleReplies } = await import("../src/cli");
  judgeReply = { key: "A", why: "字面意思" };
  const id = dec.openDecision({ id: "T-0410", agent: "reviewer" }, { status: "needs_decision", summary: "fixes y",
    question: "现在合并 y #2 吗？", recommendation: "A", options: ["A: merge", "B: wait"] } as any, "h");
  // a fuzzy fragment (not the full label, not a bare key) must not unlock a merge
  srv.answerFromChat(id, "先 merge 再说", false);
  await handleReplies(cfg, "h");
  expect(existsSync(core.P("decisions", "open", `${id}.md`))).toBe(true);
  expect(sent.at(-1)).toContain("高风险");
  // the deliberate typed key is the explicit confirmation and closes the card
  srv.answerFromChat(id, "A", false);
  await handleReplies(cfg, "h");
  expect(closed(id).answer).toBe("A");
});

test("closeDecision records how the answer arrived: via splits into answered_via/channel, answered_ms always", () => {
  const q = { status: "needs_decision", summary: "ctx", question: "选哪个方案？", recommendation: "A",
    options: ["A: fast", "B: safe"] } as any;
  let id = dec.openDecision({ id: "T-0405", agent: "lead" }, { ...q }, "h");
  dec.closeDecision(id, "B: safe", "owner(chat)", "", "button:slack");
  let m = closed(id);
  expect(m.answered_via).toBe("button");
  expect(m.answered_channel).toBe("slack");
  expect(Number(m.answered_ms)).toBeLessThan(10_000); // answered moments after the card was created
  id = dec.openDecision({ id: "T-0406", agent: "lead" }, { ...q }, "h");
  dec.closeDecision(id, "A: fast", "owner(chat)"); // no via (older callers): only the latency is recorded
  m = closed(id);
  expect(m.answered_via).toBeUndefined();
  expect(m.answered_channel).toBeUndefined();
  expect(Number(m.answered_ms)).toBeLessThan(10_000);
});

test("the morning digest fires once after quiet hours end, only when cards wait", async () => {
  const p = (d: Date) => d.toTimeString().slice(0, 5);
  const end = new Date(Date.now() - 10 * 60_000); // quiet ended 10 minutes ago
  const start = new Date(end.getTime() - 6 * 3600_000);
  const cfgQ = { judge: { enabled: true }, idle: { quiet_hours: `${p(start)}-${p(end)}` }, autonomy: { renotify_hours: 3 } } as any;
  judgeReply = { verdict: "hold", reason: "owner call" };
  sent.length = 0;
  rmSync(core.P("decisions", "open"), { recursive: true, force: true }); // earlier tests leave open cards behind
  mkdirSync(core.P("decisions", "open"), { recursive: true });
  rmSync(core.P("logs", "summary-state.json"), { force: true });
  expect(await dec.summarizeOpenCards(cfgQ, "h")).toBe(false); // no cards → nothing
  const id = open("A");
  await dec.routeDecision(id, cfgQ, "h"); // held: an open card waits
  expect(await dec.summarizeOpenCards(cfgQ, "h")).toBe(true);
  expect(sent.at(-1)).toContain("张卡等你");
  expect(sent.at(-1)).toContain(id);
  expect(await dec.summarizeOpenCards(cfgQ, "h")).toBe(false); // inside the renotify window: silent
  // far from the quiet end: no digest even with cards waiting and no fresh summary
  rmSync(core.P("logs", "summary-state.json"), { force: true });
  expect(await dec.summarizeOpenCards({ ...cfgQ, idle: { quiet_hours: "00:00-06:00" } }, "h")).toBe(false);
  expect(await dec.summarizeOpenCards({ judge: { enabled: true } } as any, "h")).toBe(false); // no quiet hours: no trigger
  dec.closeDecision(id, "B", "owner(chat)");
  rmSync(core.P("logs", "summary-state.json"), { force: true }); // shared data dir: leave no state behind
});

test("a reply inside the amend window corrects the answer; outside it is dropped", async () => {
  judgeReply = { verdict: "hold", reason: "owner call" };
  sent.length = 0;
  const srv = await import("../src/server");
  const { handleReplies } = await import("../src/cli");
  const id = open("A");
  core.writeDoc(core.P("tasks", "blocked", "T-0001.md"), { id: "T-0001", title: "t" }, "body");
  dec.closeDecision(id, "A", "owner(chat)"); // moves T-0001 to inbox with the answer
  srv.answerFromChat(id, "其实选 B，等 CI 绿了再合", false);
  await handleReplies(cfg, "h");
  const t = core.readDoc(core.P("tasks", "inbox", "T-0001.md"));
  expect(t.body).toContain(`Owner correction to ${id}`);
  expect(t.body).toContain("其实选 B");
  expect(sent.at(-1)).toContain("已按你的纠正更新");
  // past the window the same reply is a new topic, not a correction: the task stays as it is
  const f = core.P("decisions", "closed", `${id}.md`);
  const { meta, body } = core.readDoc(f);
  core.writeDoc(f, { ...meta, answered: new Date(Date.now() - 10 * 60_000).toISOString() }, body);
  const before = core.readDoc(core.P("tasks", "inbox", "T-0001.md")).body;
  srv.answerFromChat(id, "另外把 README 也改了", false);
  await handleReplies(cfg, "h");
  expect(core.readDoc(core.P("tasks", "inbox", "T-0001.md")).body).toBe(before);
  rmSync(core.P("tasks", "inbox", "T-0001.md"), { force: true });
});
