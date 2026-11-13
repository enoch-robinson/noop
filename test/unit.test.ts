import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { due } from "../src/cli";
import { matches, signature, type Cfg } from "../src/core";
import { parseResult, runAgent } from "../src/runner";

test("routine schedule", () => {
  const t = new Date("2026-11-02T19:05:00"); // Monday
  expect(due("15m", undefined, t)).toBe(true);
  expect(due("15m", new Date(+t - 5 * 60e3).toISOString(), t)).toBe(false);
  expect(due("weekdays 19:00", undefined, t)).toBe(true);
  expect(due("weekdays 19:00", new Date("2026-11-02T19:01:00").toISOString(), t)).toBe(false);
  expect(due("weekly FRI 17:00", undefined, t)).toBe(false);
  expect(due("daily 20:00", undefined, t)).toBe(false);
  expect(due("daily 02:30", undefined, t)).toBe(false); // first run long after slot → wait for next slot
});

test("capability matching", () => {
  const caps = ["os:linux", "host:pc", "gpu"];
  expect(matches({ requires: "os:linux" }, caps)).toBe(true);
  expect(matches({ requires: "os:macos" }, caps)).toBe(false);
  expect(matches({ host: "pc", requires: "gpu" }, caps)).toBe(true);
  expect(matches({ host: "mbp" }, caps)).toBe(false);
});

test("external signature links the Noop name to its site", () => {
  const cfg = { owner: { github: "huacnlee" } } as Cfg;
  expect(signature("lead", "host", cfg)).toBe(
    "🤖 [Noop](https://huacnlee.github.io/noop) (lead) · AI agent acting for @huacnlee",
  );
});

test("result parsing", () => {
  expect(parseResult('blah\n```json\n{"status":"done","summary":"ok"}\n```').status).toBe("done");
  expect(parseResult("no block").status).toBe("failed");
});

test("owner image uploads: images only, 10 MB, attachments are the hub's own media", async () => {
  const { uploadProblem, ownerAttachments, MAX_UPLOAD } = await import("../cloud/src/uploads");
  expect(uploadProblem("image/png", 1000)).toBeNull();
  expect(uploadProblem("image/svg+xml", 1000)?.status).toBe(415);
  expect(uploadProblem("application/pdf", 1000)?.status).toBe(415);
  expect(uploadProblem("image/jpeg", MAX_UPLOAD + 1)?.status).toBe(413);
  expect(ownerAttachments(undefined)).toEqual([]);
  expect(ownerAttachments(["/media/1-a.png"])).toEqual(["/media/1-a.png"]);
  expect(ownerAttachments(["https://evil.example/x.png"])).toBeNull();
  expect(ownerAttachments(["/media/../noop.toml"])).toBeNull();
  expect(ownerAttachments(Array(11).fill("/media/a.png"))).toBeNull();
});

test("owner images are downloaded and named by absolute path in the task text", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { saveAttachments, withAttachments } = await import("../src/server");
  const root = mkdtempSync(join(tmpdir(), "noop-att-"));
  const got: string[] = [];
  const files = await saveAttachments("ev-1", ["/media/1-shot.png", "/media/2-gone.png"], async (p) => {
    got.push(p);
    return p.includes("gone") ? null : new Uint8Array([1, 2, 3]);
  }, root);
  expect(got).toEqual(["/media/1-shot.png", "/media/2-gone.png"]);
  expect(files).toEqual([join(root, "ev-1", "1-shot.png")]);
  expect([...readFileSync(files[0])]).toEqual([1, 2, 3]);
  const text = withAttachments("看这个报错", files, 1);
  expect(text.startsWith("看这个报错\n\nAttached images")).toBe(true);
  expect(text).toContain(`- ${files[0]}`);
  expect(text).toContain("1 more image(s) could not be downloaded");
  expect(withAttachments("", files).split("\n")[0]).toBe("(see the attached images)");
  expect(withAttachments("plain", [])).toBe("plain");
  rmSync(root, { recursive: true, force: true });
});

test("media older than media_days is pruned", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { pruneMedia, mediaDays } = await import("../src/server");
  expect(mediaDays({} as any)).toBe(7);
  expect(mediaDays({ media_days: 30 } as any)).toBe(30);
  expect(mediaDays({ media_days: 5 } as any)).toBe(7);
  const media = mkdtempSync(join(tmpdir(), "noop-media-"));
  const att = mkdtempSync(join(tmpdir(), "noop-att-"));
  const now = Date.now();
  const age = (f: string, days: number) => utimesSync(f, (now - days * 86_400_000) / 1000, (now - days * 86_400_000) / 1000);
  writeFileSync(join(media, "old.png"), "x"); age(join(media, "old.png"), 8);
  writeFileSync(join(media, "new.png"), "x"); age(join(media, "new.png"), 6);
  mkdirSync(join(att, "ev-old")); writeFileSync(join(att, "ev-old", "a.png"), "x"); age(join(att, "ev-old"), 10);
  expect(pruneMedia(7, [media, att, join(media, "missing")], now)).toBe(2);
  expect(existsSync(join(media, "old.png"))).toBe(false);
  expect(existsSync(join(media, "new.png"))).toBe(true);
  expect(existsSync(join(att, "ev-old"))).toBe(false);
  rmSync(media, { recursive: true, force: true }); rmSync(att, { recursive: true, force: true });
});

test("repo language → host requirements (only when the repo is on disk)", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { capOk, repoRequires } = await import("../src/core");
  const rust = mkdtempSync(join(tmpdir(), "noop-rust-"));
  writeFileSync(join(rust, "Cargo.toml"), "[package]\n");
  const js = mkdtempSync(join(tmpdir(), "noop-js-"));
  writeFileSync(join(js, "package.json"), "{}");
  expect(repoRequires(rust)).toEqual(["cli:cargo"]);
  expect(repoRequires("/nonexistent/repo/xyz")).toEqual([]);
  const mac = ["os:macos", "host:mbp", "cli:claude", "cli:node"];
  expect(matches({ repo: rust }, mac)).toBe(false); // the Mac without cargo must not claim a Rust task
  expect(matches({ repo: rust }, [...mac, "cli:cargo"])).toBe(true);
  expect(matches({ repo: js }, mac)).toBe(true); // node is enough for package.json
  expect(matches({ repo: js }, ["os:linux"])).toBe(false);
  expect(capOk("cli:bun|cli:node", ["cli:bun"])).toBe(true);
  expect(capOk("cargo", ["os:linux", "cli:cargo"])).toBe(true); // planner may emit a bare tool name
  expect(capOk("gh", ["cli:gh"])).toBe(true);
  expect(capOk("cli:gh", ["os:linux"])).toBe(false); // still no invented capabilities
  expect(capOk("host:laptop", ["os:linux", "host:vibe-coding"])).toBe(false); // prefix stays exact
  expect(matches({ repo: "/nonexistent/repo/xyz", requires: "cli:cargo" }, mac)).toBe(false); // stored at creation
});

test("quota/auth failover: same CLI's other account, then the other CLI, else nothing", async () => {
  const { failoverAccount } = await import("../src/accounts");
  const all = () => true;
  const a = { cli: "claude", name: "zz-test-a", dir: "" };
  const two = { accounts: [{ cli: "claude", name: "zz-test-a" }, { cli: "claude", name: "zz-test-b" }] } as any;
  expect(failoverAccount(two, a, ["claude"], all)?.name).toBe("zz-test-b");
  const solo = { accounts: [{ cli: "claude", name: "zz-test-a" }, { cli: "codex", name: "zz-test-c" }] } as any;
  expect(failoverAccount(solo, a, ["claude"], all)?.cli).toBe("codex"); // claude-only (owner/hard) work still falls back
  expect(failoverAccount(solo, a, ["claude"], (c) => c === "claude")).toBeNull(); // codex not installed → requeue
  expect(failoverAccount(solo, { cli: "codex", name: "zz-test-c", dir: "" }, ["codex", "claude"], all)?.cli).toBe("claude");
});

test("restart throttle: at most one voluntary restart per hour unless forced", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { restartAllowed } = await import("../src/cli");
  const f = join(mkdtempSync(join(tmpdir(), "noop-rs-")), "last-restart");
  expect(restartAllowed(false, f)).toBe(true); // never restarted
  const t = Date.parse("2026-11-02T17:00:00Z");
  writeFileSync(f, "2026-11-02T16:30:00Z");
  expect(restartAllowed(false, f, t)).toBe(false);
  expect(restartAllowed(true, f, t)).toBe(true);
  expect(restartAllowed(false, f, t + 31 * 60_000)).toBe(true);
});

test("selfUpdate defers while tasks run on this host", async () => {
  const { selfUpdate } = await import("../src/setup");
  expect(await selfUpdate({ busy: 2 })).toBe(false);
});

test("a release whose tests failed here is not installed again until origin moves on", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { updateRejected } = await import("../src/setup");
  const f = join(mkdtempSync(join(tmpdir(), "noop-up-")), "update-rejected");
  expect(updateRejected("1c6ae5a", f)).toBe(false); // nothing refused yet
  writeFileSync(f, "1c6ae5a\n");
  expect(updateRejected("1c6ae5a", f)).toBe(true); // the same bad release is skipped, no reinstall, no medic
  expect(updateRejected("d23c0de", f)).toBe(false); // a newer release is tried again
});

test("taskView shows the original ask, not daemon requeue notes", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { writeDoc } = await import("../src/core");
  const { taskView } = await import("../src/server");
  const dir = mkdtempSync(join(tmpdir(), "noop-tv-"));
  const old = join(dir, "T-1.md"); // legacy body: note appended as a quote, no owner quote
  writeDoc(old, { id: "T-1", title: "Fix build" }, "Fix the Rust build on CI.\n\n> Requeued after daemon restart on pc; check for partial work.\n");
  expect(taskView(old, "inbox", []).request).toBe("Fix the Rust build on CI.");
  const chat = join(dir, "T-2.md");
  writeDoc(chat, { id: "T-2", title: "x", requeue_note: "Requeued after daemon restart on pc; check for partial work." },
    "The owner (CEO) said in chat:\n\n> ship the release\n\nHandle it.\n\n> Attempt 1 failed: boom. Try a different approach.\n");
  expect(taskView(chat, "inbox", []).request).toBe("ship the release");
});

test("uploads: the real image type comes from the bytes", async () => {
  const { sniffImage } = await import("../cloud/src/uploads");
  expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), "application/octet-stream")).toBe("image/jpeg");
  expect(sniffImage(new TextEncoder().encode("\0\0\0\x18ftypheic"), "")).toBe("image/heic");
  expect(sniffImage(new Uint8Array([1, 2, 3]), "image/jpg")).toBe("image/jpeg");
});


test("update the fleet: the owner's request reaches the hook and the feed says how many machines", async () => {
  const { updateFleet, setUpdateFleet, setMirror } = await import("../src/server");
  const seen: string[] = [];
  setMirror((e) => { seen.push(e.text); });
  expect(await updateFleet()).toBe("not available");
  setUpdateFleet(async () => 3);
  expect(await updateFleet()).toBe("ok");
  expect(seen.at(-1)).toContain("已通知 3 台机器");
  setMirror(() => {});
});

test("heartbeat carries the running code version, linked to its commit", async () => {
  const { runningRev } = await import("../src/core");
  const r = runningRev();
  expect(r.rev).toMatch(/^[0-9a-f]{40}$/);
  if (r.rev_url) expect(r.rev_url).toEndWith(`/commit/${r.rev}`);
});

test("recentChat: the channel before an owner message, without the message itself", async () => {
  const { appendEvent, recentChat } = await import("../src/server");
  appendEvent({ from: "Kai", kind: "notice", text: "已补写 gpui-kit v0.9.0 的更新日志", ref: "T-0115" });
  appendEvent({ from: "owner", kind: "owner", text: "不行，得留下贡献者名单" });
  appendEvent({ from: "hub", kind: "system", text: "收到，接着 T-0115 处理（T-0116）", ref: "T-0116" });
  appendEvent({ from: "owner", kind: "owner", text: "这个细节记录下来，以后都这样" });
  const lines = recentChat("这个细节记录下来，以后都这样");
  expect(lines.slice(-3).map((l) => l.slice(8))).toEqual(["Kai (T-0115): 已补写 gpui-kit v0.9.0 的更新日志", "owner: 不行，得留下贡献者名单", "hub (T-0116): 收到，接着 T-0115 处理（T-0116）"]);
  expect(recentChat("x", { limit: 1 }).length).toBe(1);
});

test("pickTask: a task no machine here can run (needs another OS) never holds back the ones behind it", async () => {
  const { pickTask, writeDoc, P } = await import("../src/core");
  const other = process.platform === "win32" ? "os:linux" : "os:windows";
  const at = new Date(Date.now() - 3600_000).toISOString();
  writeDoc(P("tasks", "inbox", "T-9001.md"), { id: "T-9001", title: "needs another OS", agent: "lead", requires: other, priority: "urgent", planned: at, created: at, parked: at }, "x");
  writeDoc(P("tasks", "inbox", "T-9002.md"), { id: "T-9002", title: "runs anywhere", agent: "lead", priority: "normal", planned: at, created: at }, "y");
  const cfg = { clis: { default: ["claude", "codex"] } } as any;
  const picked = pickTask(cfg);
  if (picked === null && !Bun.which("claude") && !Bun.which("codex")) return; // no AI CLI here: nothing is pickable
  expect(picked).toContain("T-9002");
});

test("a reply to an agent's message goes to the brain with that task, never as an amendment of the last decision", async () => {
  const { handleOwnerMessage, setOwnerTask, drainInbound } = await import("../src/server");
  const calls: [string, { reply?: string; answered?: string }][] = [];
  setOwnerTask(async (text, o) => { calls.push([text, { reply: o.reply, answered: o.answered }]); });
  await handleOwnerMessage("D-0001 A"); // just answered a decision: the brain hears it may be amended
  await handleOwnerMessage("为何我看图片不清晰呢", "T-0125"); // a reply names its task: never an amendment
  expect(calls).toEqual([["为何我看图片不清晰呢", { reply: "T-0125", answered: undefined }]]);
  await handleOwnerMessage("等等，选 B");
  expect(calls.at(-1)).toEqual(["等等，选 B", { reply: undefined, answered: "D-0001" }]);
  expect(drainInbound()).toEqual([{ id: "D-0001", answer: "A", source: "chat" }]);
});

test("a result block survives a later turn from a background task notification", async () => {
  const lines = [
    { type: "result", result: "still compiling" },
    { type: "result", result: '```json\n{"status":"done","summary":"tested"}\n```' },
    { type: "result", result: "that notification changes nothing" },
  ].map((l) => JSON.stringify(l)).join("\n");
  const cfg = { clis: { fake: { command: ["sh", "-c", 'printf "%s\\n" "$1"', "stream-json", lines] } } } as unknown as Cfg;
  const log = `${tmpdir()}/noop-run-${process.pid}.log`;
  const res = parseResult(await runAgent("fake", "", tmpdir(), cfg, log));
  rmSync(log, { force: true });
  expect(res).toMatchObject({ status: "done", summary: "tested" });
});

test("an empty completion (no text, no tool call, exit 0) is retried once instead of failing the task", async () => {
  // The provider sometimes answers with nothing at all and the CLI still exits 0; Claude Code's own
  // "no visible output" retry gets nothing either. runAgent must not hand that back as the task's result.
  const dir = mkdtempSync(`${tmpdir()}/noop-empty-`);
  const mark = `${dir}/ran`;
  const block = JSON.stringify({ type: "result", result: '```json\n{"status":"done","summary":"second try"}\n```' });
  // first spawn: no output at all; second one: the normal result line (a marker file carries the state)
  const script = `const fs = require("node:fs");`
    + `if (fs.existsSync(${JSON.stringify(mark)})) process.stdout.write(${JSON.stringify(`${block}\n`)});`
    + `else fs.writeFileSync(${JSON.stringify(mark)}, "");`;
  const cfg = { clis: { fake: { command: [process.execPath, "-e", script, "stream-json"] } } } as unknown as Cfg;
  const log = `${dir}/run.log`;
  try {
    const res = parseResult(await runAgent("fake", "prompt", dir, cfg, log));
    expect(res).toMatchObject({ status: "done", summary: "second try" });
    expect(readFileSync(log, "utf8")).toContain("[retried after an empty response]");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test("a completed tool call with an empty result is not retried", async () => {
  // A stream that already ran a tool and then ended with result:"" must not be replayed: the first run may have
  // posted, committed, or done other work, and a fresh prompt would repeat it.
  const dir = mkdtempSync(`${tmpdir()}/noop-tool-empty-`);
  const counter = `${dir}/n`;
  const lines = [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "echo hi" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "hi" }] } },
    { type: "result", result: "" },
  ].map((l) => JSON.stringify(l)).join("\n");
  const script = `const fs = require("node:fs");`
    + `const p = ${JSON.stringify(counter)};`
    + `fs.writeFileSync(p, String(Number(fs.existsSync(p) ? fs.readFileSync(p, "utf8") : 0) + 1));`
    + `process.stdout.write(${JSON.stringify(`${lines}\n`)});`;
  const cfg = { clis: { fake: { command: [process.execPath, "-e", script, "stream-json"] } } } as unknown as Cfg;
  const log = `${dir}/run.log`;
  try {
    const out = await runAgent("fake", "prompt", dir, cfg, log);
    expect(out.trim()).toBe("");
    expect(Number(readFileSync(counter, "utf8"))).toBe(1);
    expect(readFileSync(log, "utf8")).not.toContain("[retried after an empty response]");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test("visible assistant text with an empty result is not retried", async () => {
  // An empty result currently masks earlier visible assistant text via `resultText ?? assistantText`; that must not
  // trigger a replay either.
  const dir = mkdtempSync(`${tmpdir()}/noop-text-empty-`);
  const counter = `${dir}/n`;
  const lines = [
    { type: "assistant", message: { content: [{ type: "text", text: "I looked around" }] } },
    { type: "result", result: "" },
  ].map((l) => JSON.stringify(l)).join("\n");
  const script = `const fs = require("node:fs");`
    + `const p = ${JSON.stringify(counter)};`
    + `fs.writeFileSync(p, String(Number(fs.existsSync(p) ? fs.readFileSync(p, "utf8") : 0) + 1));`
    + `process.stdout.write(${JSON.stringify(`${lines}\n`)});`;
  const cfg = { clis: { fake: { command: [process.execPath, "-e", script, "stream-json"] } } } as unknown as Cfg;
  const log = `${dir}/run.log`;
  try {
    const out = await runAgent("fake", "prompt", dir, cfg, log);
    expect(out.trim()).toBe("");
    expect(Number(readFileSync(counter, "utf8"))).toBe(1);
    expect(readFileSync(log, "utf8")).not.toContain("[retried after an empty response]");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test("status: a task parked on something slow stays listed however many tasks finished after it", async () => {
  const { status } = await import("../src/server");
  const { P } = await import("../src/core");
  const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const doc = (id: string, extra: string) => `---\nid: ${id}\ntitle: ${id}\nsource: routine:macos-check\n${extra}\n---\n\nbody\n`;
  mkdirSync(P("tasks", "waiting"), { recursive: true });
  mkdirSync(P("tasks", "done"), { recursive: true });
  const files = [P("tasks", "waiting", "T-9900.md")];
  writeFileSync(files[0], doc("T-9900", "started: 2020-01-01T00:00:00Z\nwake_at: 2999-01-01T00:00:00Z"));
  for (let i = 1; i <= 15; i++) {
    const f = P("tasks", "done", `T-99${String(i).padStart(2, "0")}.md`);
    files.push(f);
    writeFileSync(f, doc(`T-99${String(i).padStart(2, "0")}`, "finished: 2999-01-01T00:00:00Z"));
  }
  try {
    expect(status().recent.find((t) => t.id === "T-9900")?.state).toBe("parked");
  } finally {
    for (const f of files) rmSync(f);
  }
});

test("codex can write to project checkouts and scratch, not only its cwd", async () => {
  const { cliCommand, codexWritableDirs } = await import("../src/runner");
  const { mkdtempSync, mkdirSync, symlinkSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = realpathSync(mkdtempSync(join(tmpdir(), "noop-home-")));
  mkdirSync(join(home, "work"));
  mkdirSync(join(home, ".noop", "work"), { recursive: true });
  symlinkSync(join(home, ".noop"), join(home, ".agent-hub"));
  const dirs = codexWritableDirs(home);
  expect(dirs).toContain(join(home, "work"));
  expect(dirs.filter((d) => d === join(home, ".noop", "work")).length).toBe(1); // the symlinked alias collapses
  expect(dirs).not.toContain(join(home, ".cargo")); // missing dirs are left out
  const cmd = cliCommand("codex", {} as any);
  expect(cmd.at(-1)).toBe("-");
  expect(cmd).toContain("--add-dir");
});

test("checkWaits: a waiting task wakes early once its wait_check exit code changes", async () => {
  const { writeDoc, P } = await import("../src/core");
  const { checkWaits } = await import("../src/cli");
  // The check runs in bash, which reads a Windows "C:\..." path as an escape, so keep it POSIX-style.
  const flag = `${tmpdir()}/noop-waitcheck-${process.pid}`.replace(/\\/g, "/");
  rmSync(flag, { force: true });
  const wake = new Date(Date.now() + 3600_000).toISOString();
  writeDoc(P("tasks", "waiting", "T-9101.md"), { id: "T-9101", title: "wait for CI", wake_at: wake, wait_check: `test -f ${flag}` }, "x");
  const t0 = Date.now();
  expect((await checkWaits(t0, 1000)).size).toBe(0); // baseline: still pending
  expect((await checkWaits(t0 + 10, 1000)).size).toBe(0); // throttled
  await Bun.write(flag, "1");
  expect([...(await checkWaits(t0 + 2000, 1000))]).toEqual(["T-9101"]);
  rmSync(flag, { force: true });
});

test("checkWaits: a wait that finished while the daemon was down still wakes after a restart", async () => {
  const { writeDoc, P } = await import("../src/core");
  const { checkWaits } = await import("../src/cli");
  const flag = `${tmpdir()}/noop-waitcheck-r-${process.pid}`.replace(/\\/g, "/");
  rmSync(flag, { force: true });
  const wake = new Date(Date.now() + 3600_000).toISOString();
  const cmd = `test -f ${flag}`;
  // An earlier daemon saw the check pending (exit 1) and recorded that baseline in the task.
  writeDoc(P("tasks", "waiting", "T-9102.md"), { id: "T-9102", title: "wait", wake_at: wake, wait_check: cmd, wait_check_base: `1 ${cmd}` }, "x");
  await Bun.write(flag, "1"); // finished during the restart
  expect([...(await checkWaits(Date.now() + 999_999_999, 1000))]).toContain("T-9102");
  rmSync(flag, { force: true });
});
