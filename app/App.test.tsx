import { describe, expect, open, test } from "nsh/test";
import { URL as ParsedURL } from "url";

const URL = "http://hub.test:8787";
const STORAGE = { "hub.url": URL, "hub.token": "tok" };
const ts = (min: number) => new Date(Date.now() - (60 - min) * 60000).toISOString();

const events = [
  { id: "e1", ts: ts(1), from: "lead@mac", kind: "notice", text: "开始处理 `T-0007`，*很快*完成" },
  {
    id: "e2", ts: ts(2), from: "hub", kind: "decision", ref: "D-0001",
    text: "要不要升级依赖？建议：B", options: ["A: 不升级", "B: 升级", "C: 先评估"],
  },
  {
    id: "e3", ts: ts(3), from: "hub", kind: "proposals", ref: "P-0002",
    text: "待批准清单", options: ["1 写测试", "2 修文档", "all", "none"],
  },
  { id: "e4", ts: ts(4), from: "owner", kind: "owner", text: "P-0002 1" },
  { id: "e5", ts: ts(5), from: "hub", kind: "system", text: "⚙️ 设置已更新：{\"routines\":{}}" },
  { id: "e6", ts: ts(6), from: "dev@linux-box", kind: "notice", text: "T-0005 修好了，见 https://github.com/acme/app/pull/42" },
];
const status = {
  tasks: { proposed: 1, inbox: 2, active: 1, blocked: 0, failed: 0, done: 9 },
  active: [{ id: "T-0007", title: "截图检查 gallery", agent: "dev", host: "linux-box" }],
  decisions: [{ id: "D-0001", kind: "decision", question: "要不要升级依赖？", held: true }],
  recent: [{ id: "T-0005", title: "修复登录页", agent: "dev", host: "linux-box", state: "done", finished: ts(30), updated: ts(30) }],
  hosts: [{
    host: "linux-box", caps: ["os:linux", "arch:x64", "cli:claude"], seen: ts(59), busy: 1,
    stats: { loadRatio: 0.42, cores: 8, memFreePct: 40, diskFreeGB: 120, diskFreePct: 60 },
    os: "linux", arch: "x64", clis: ["claude"], accounts: [{ cli: "claude", name: "default", state: "ok" }],
    running: [{ id: "T-0007", title: "截图检查 gallery", agent: "dev", started: ts(50) }],
    recent: [{ id: "T-0005", title: "修复登录页", state: "done", finished: ts(30) }],
    rev: "c1cc0851234567890abcdef1234567890abcdef0", rev_url: "https://github.com/acme/noop/commit/c1cc0851234567890abcdef1234567890abcdef0",
  }],
};

const prDecision = {
  id: "e7", ts: ts(7), from: "hub", kind: "decision", ref: "D-H0003",
  text: "合并 nsh #747 吗？按 D-H0002 的反馈改好了，见 `nsh#1` 和 other#3\n\n建议：*A*",
  options: ["A: squash 合并 https://github.com/acme/nsh/pull/747 — 进入发布", "B: 继续修改"],
};

function hub(posts: { text: string; reply_to?: string }[], extra: unknown[] = []) {
  return {
    [`GET ${URL}/api/feed`]: { body: { events: [...events, ...extra] } },
    [`GET ${URL}/api/feed?*`]: { body: { events: [] } },
    [`GET ${URL}/api/status`]: { body: status },
    [`POST ${URL}/api/messages`]: (r: { body?: string | null }) => {
      const m = JSON.parse(r.body!);
      posts.push(m);
      return { body: { id: `o${posts.length}`, ts: new Date().toISOString(), from: "owner", kind: "owner", text: m.text, ref: m.reply_to } };
    },
  };
}

type Auth = { starts: unknown[]; verifies: unknown[]; logouts: number };
function auth(log: Auth, opts: { start?: number; code?: string } = {}) {
  return {
    [`POST ${URL}/api/auth/start`]: (r: { body?: string | null }) => {
      log.starts.push(JSON.parse(r.body!));
      return opts.start ? { status: opts.start, body: { error: opts.start === 429 ? "请求太频繁" : "email not configured" } } : { body: { ok: true } };
    },
    [`POST ${URL}/api/auth/verify`]: (r: { body?: string | null }) => {
      const b = JSON.parse(r.body!);
      log.verifies.push(b);
      return b.code === (opts.code ?? "123456") ? { body: { session: "sess" } } : { status: 401, body: { error: "bad code" } };
    },
    [`POST ${URL}/api/auth/logout`]: () => {
      log.logouts++;
      return { body: { ok: true } };
    },
  };
}
const newLog = (): Auth => ({ starts: [], verifies: [], logouts: 0 });

describe("login", () => {
  test("email, then the 6-digit code logs in and keeps the session", async () => {
    const log = newLog();
    const app = await open("./App.tsx", { network: { ...hub([]), ...auth(log) } });
    await app.waitFor("Sign in to Noop");
    await app.clear("id:url");
    await app.type("id:url", "hub.test:8787/");
    await app.type("id:email", "ceo@example.com");
    await app.press("id:send-code");
    await app.waitFor("id:code");
    expect(log.starts).toEqual([{ email: "ceo@example.com" }]);
    expect(app.shows("text:/Resend \\(\\d+s\\)/")).toBe(true);
    await app.type("id:code", "123456"); // auto-submits on the 6th digit
    await app.waitFor("id:composer");
    expect(log.verifies).toEqual([{ email: "ceo@example.com", code: "123456" }]);
    expect(app.storage()["hub.token"]).toBe("sess");
    expect(app.storage()["hub.url"]).toBe(URL);
    expect(app.storage()["hub.email"]).toBe("ceo@example.com");
  });

  test("served by the hub: no address field; a pasted code with spaces works", async () => {
    const log = newLog();
    const app = await open("./App.tsx", {
      host: { handlers: { page: { origin: URL } } },
      storage: { "hub.email": "ceo@example.com" },
      network: { ...hub([]), ...auth(log) },
    });
    await app.waitFor("Sign in to Noop");
    expect(app.shows("id:url")).toBe(false);
    expect(app.value("id:email")).toBe("ceo@example.com");
    await app.submit("id:email");
    await app.waitFor("id:code");
    await app.paste("id:code", { text: "123 456" });
    await app.waitFor("id:composer");
  });

  test("a wrong code, rate limits and no email configured are explained", async () => {
    const log = newLog();
    const app = await open("./App.tsx", { host: { handlers: { page: { origin: URL } } }, network: { ...hub([]), ...auth(log) } });
    await app.type("id:email", "ceo@example.com");
    await app.press("id:send-code");
    await app.type("id:code", "000000");
    await app.waitFor("text:/code is wrong/");
    expect(app.value("id:code")).toBe("");

    const limited = await open("./App.tsx", { host: { handlers: { page: { origin: URL } } }, network: auth(newLog(), { start: 429 }) });
    await limited.type("id:email", "ceo@example.com");
    await limited.press("id:send-code");
    await limited.waitFor("text:/请求太频繁/");

    const noMail = await open("./App.tsx", { host: { handlers: { page: { origin: URL } } }, network: auth(newLog(), { start: 503 }) });
    await noMail.type("id:email", "ceo@example.com");
    await noMail.press("id:send-code");
    await noMail.waitFor("text:/can’t send email yet/");
  });

  test("an unreachable server is told apart", async () => {
    const app = await open("./App.tsx", { network: {} });
    await app.clear("id:url");
    await app.type("id:url", "nowhere.test:1");
    await app.type("id:email", "ceo@example.com");
    await app.press("id:send-code");
    await app.waitFor("text:/Can’t reach/");
  });

  test("a 401 sends you back to the login", async () => {
    const app = await open("./App.tsx", {
      storage: STORAGE,
      network: { [`GET ${URL}/api/feed`]: { status: 401 }, [`GET ${URL}/api/status`]: { status: 401 } },
    });
    await app.waitFor("Your session expired. Please sign in again.");
    expect(app.storage()["hub.token"]).toBe(undefined);
  });

  test("退出登录 calls logout and forgets the session", async () => {
    const log = newLog();
    const app = await open("./App.tsx", {
      storage: STORAGE, width: 1200, height: 800, platform: "macos",
      network: { ...hub([]), ...auth(log), [`GET ${URL}/api/settings`]: { status: 500 } },
    });
    await app.press("id:user-menu");
    await app.press("id:settings");
    await app.press("id:settings-tab-account");
    await app.press("id:logout");
    await app.waitFor("Sign in to Noop");
    expect(log.logouts).toBe(1);
    expect(app.storage()["hub.token"]).toBe(undefined);
  });
  for (const platform of ["ios", "android"] as const) {
    test(`the mobile account menu on ${platform} switches appearance and language`, async () => {
      const app = await open("./App.tsx", { storage: STORAGE, network: hub([]), width: platform === "android" ? 1200 : 390, height: 844, platform });
      if (platform === "ios") await app.press("label:Menu");
      await app.press("id:user-menu");
      await app.press("id:theme-dark");
      expect(app.storage()["hub.theme"]).toBe("dark");
      await app.press("id:menu-language");
      await app.press("id:menu-lang-zh");
      expect(app.storage()["hub.lang"]).toBe("zh");
      await app.waitUntil(() => !app.shows("id:menu-lang-zh"));
      await app.press("id:user-menu");
      await app.press("id:settings");
      await app.waitFor(platform === "ios" ? "id:logout" : "id:settings-tab-account");
    });
  }
  test("the sidebar user menu switches appearance and language and opens settings", async () => {
    const app = await open("./App.tsx", { storage: STORAGE, network: hub([]), width: 1200, height: 800, platform: "macos" });
    await app.press("id:user-menu");
    await app.press("id:theme-dark");
    expect(app.storage()["hub.theme"]).toBe("dark");
    await app.press("id:menu-language");
    await app.press("id:menu-lang-zh");
    expect(app.storage()["hub.lang"]).toBe("zh");
    await app.waitFor("主会话");
    await app.waitFor("唐僧");
    expect(app.shows("Tripitaka")).toBe(false);
    await app.press("id:user-menu");
    await app.press("id:settings");
    await app.waitFor("id:settings-tab-account");
  });
});

describe("channel", () => {
  test("virtualized timeline recycles messages and jumps to an off-screen decision", async () => {
    const many = Array.from({ length: 90 }, (_, i) => ({
      id: `long-${i}`, ts: ts(10 + i / 100), from: "agent", kind: "notice", text: `Long timeline message ${i}`,
    }));
    const app = await open("./App.tsx", { storage: STORAGE, width: 390, height: 800, platform: "ios", network: hub([], many) });
    await app.waitFor("Long timeline message 89");
    expect(app.shows("Long timeline message 0")).toBe(false);
    await app.scroll("id:timeline", -20000);
    await app.waitFor("Long timeline message 0");
    expect(app.shows("Long timeline message 89")).toBe(false);
    await app.scroll("id:timeline", 20000);
    await app.waitFor("Long timeline message 89");
    expect(app.shows("Long timeline message 0")).toBe(false);
  });
  test("the channel shows the newest 200 messages; older ones load on request", async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ id: `page-${i}`, ts: ts(i / 5), from: "agent", kind: "notice", text: `Paged message ${i}` }));
    const app = await open("./App.tsx", { storage: STORAGE, width: 390, height: 800, platform: "ios", network: hub([], many) });
    await app.waitFor("Paged message 249");
    const toTop = async (seen: string) => { for (let i = 0; i < 100 && !app.shows(seen); i++) await app.scroll("id:timeline", -2000).catch(() => {}); };
    await toTop("id:timeline-more");
    expect(app.shows("id:timeline-more")).toBe(true);
    expect(app.shows("Paged message 0")).toBe(false);
    await app.press("id:timeline-more");
    await toTop("Paged message 0");
    expect(app.shows("Paged message 0")).toBe(true);
  });
  for (const platform of ["ios", "macos", "android"] as const) test(`a new message leaves a timeline scrolled up where it is; at the end it follows (${platform})`, async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ id: `tail-${i}`, ts: ts(10 + i / 100), from: "agent", kind: "notice", text: `Tail message ${i}` }));
    const later: unknown[] = [];
    const arrive = (text: string) => later.push({ id: text, ts: new Date().toISOString(), from: "agent", kind: "notice", text });
    const app = await open("./App.tsx", {
      storage: STORAGE, width: 390, height: 800, platform,
      network: { ...hub([], many), [`GET ${URL}/api/feed?*`]: () => ({ body: { events: later.splice(0) } }) },
    });
    await app.waitUntil(() => app.texts().some((text) => text.startsWith("Tail message")));
    if (app.shows("label:Jump to latest")) await app.press("label:Jump to latest");
    await app.waitFor("Tail message 249");
    await app.wait(300); // Let initial list measurements and the initial scroll settle.
    expect(app.shows("label:Jump to latest")).toBe(false);

    // Just off the end, closer than a message: it stays put and counts what came below.
    await app.scroll("id:timeline", platform === "ios" ? -40 : -240);
    await app.waitFor("Jump to latest");
    arrive("Below the fold");
    await app.waitFor("1 new messages", { timeout: 10000 });
    await app.wait(300); // following would reach the end, and the end clears the count
    expect(app.shows("1 new messages")).toBe(true);

    // Further up, what is on screen does not change.
    await app.scroll("id:timeline", -1500);
    const onScreen = () => app.texts().filter((t) => t.startsWith("Tail message"));
    const before = onScreen();
    expect(before.length).toBeGreaterThan(0);
    arrive("Further below");
    await app.waitFor("2 new messages", { timeout: 10000 });
    await app.wait(300);
    // Rows mounted around the viewport come and go; none from nearer the end may appear.
    expect(onScreen().filter((t) => !before.includes(t))).toEqual([]);

    // Back at the end, new messages show by themselves.
    await app.press("label:Jump to latest");
    await app.waitFor("Further below");
    await app.waitUntil(() => !app.shows("label:Jump to latest"));
    arrive("Followed");
    await app.waitFor("Followed", { timeout: 10000 });
    expect(app.shows("label:Jump to latest")).toBe(false);
  });

  test("a new message preserves existing content", async () => {
    const url = "http://hub.test:8787";
    let arrival = false;
    const old = { id: "old", ts: "2026-11-07T01:00:00Z", from: "lead", kind: "notice", text: "Existing message stays in place" };
    const next = { id: "next", ts: "2026-11-07T02:00:00Z", from: "lead", kind: "notice", text: "New message enters smoothly" };
    const app = await open("./App.tsx", {
      width: 600, height: 800,
      storage: { "hub.url": url, "hub.token": "tok" },
      network: {
        [`GET ${url}/api/feed`]: { body: { events: [old] } },
        [`GET ${url}/api/feed?*`]: () => ({ body: { events: arrival ? [next] : [] } }),
        [`GET ${url}/api/status`]: { body: { tasks: {}, active: [], decisions: [], recent: [], hosts: [] } },
      },
    });
    await app.waitFor(old.text);
    arrival = true;
    await app.waitFor(next.text, { timeout: 10000 });
    await app.wait(300);
    expect(app.shows(old.text)).toBe(true);
  });

  test("proposal selection survives a recycled timeline cell", async () => {
    const proposal = { id: "proposal-long", ts: ts(8), from: "hub", kind: "proposals", ref: "P-0900", text: "请选择\n1. 保存选择" };
    const many = Array.from({ length: 90 }, (_, i) => ({ id: `recycle-${i}`, ts: ts(10 + i / 100), from: "agent", kind: "notice", text: `Recycled message ${i}` }));
    const app = await open("./App.tsx", { storage: STORAGE, width: 390, height: 800, platform: "ios", network: hub([], [proposal, ...many]) });
    await app.waitFor("Recycled message 89");
    await app.scroll("id:timeline", -20000);
    await app.waitFor("id:proposal-P-0900-1");
    await app.press("id:proposal-P-0900-1");
    await app.waitFor("Approve selected (1)");
    await app.scroll("id:timeline", 20000);
    await app.waitFor("Recycled message 89");
    await app.scroll("id:timeline", -20000);
    await app.waitFor("Approve selected (1)");
  });

  test("a message's avatar sits in the name's row on a phone, and in its own column when wide", async () => {
    const app = await open("./App.tsx", { storage: STORAGE, network: hub([]), width: 390, height: 800, platform: "ios" });
    await app.waitFor("text:/修好了/");
    expect(app.shows("id:avatar-inline-e6")).toBe(true);
    expect(app.shows("id:avatar-column-e6")).toBe(false);
    await app.setViewport(1200, 800);
    await app.waitFor("id:avatar-column-e6");
    expect(app.shows("id:avatar-inline-e6")).toBe(false);
  });

  test("shows the timeline, cards and sidebar", async () => {
    const app = await open("./App.tsx", { storage: STORAGE, network: hub([]), width: 1200, height: 800, platform: "macos" });
    await app.waitFor("要不要升级依赖？建议：B");
    expect(app.shows("Today")).toBe(true);
    expect(app.shows("Decide")).toBe(true);
    expect(app.shows("id:opt-D-0001-B")).toBe(true);
    expect(app.shows("All")).toBe(true);
    expect(app.shows("None")).toBe(true);
    expect(app.shows("↳ P-0002") || app.shows("P-0002")).toBe(true);
    // sidebar
    expect(app.shows("text:/设置已更新/")).toBe(false);
    await app.waitFor("截图检查 gallery");
    expect(app.shows("Needs your decision")).toBe(true);
    expect(app.shows("text:/linux-box/")).toBe(true);
    expect(app.shows("text:/Queued 2/")).toBe(true);
  });

  test("a task id is a chip that opens the task; a GitHub PR link is a plain link named repo#n", async () => {
    const app = await open("./App.tsx", { storage: STORAGE, network: hub([]), width: 1200, height: 800, platform: "macos" });
    await app.waitFor("text:app#42");
    expect(app.shows("id:gh-chip-app-42")).toBe(false);
    expect(app.shows("text:/github\\.com\\/acme\\/app/")).toBe(false);
    await app.press("text:app#42");
    expect(app.openedUrls()).toEqual(["https://github.com/acme/app/pull/42"]);
    await app.press("id:task-chip-T-0005");
    await app.waitFor("Task T-0005");
  });

  test("a task page is its conversation: what was said about it, and a box that adds to it", async () => {
    const posts: { text: string; reply_to?: string }[] = [];
    const said = [
      { id: "e10", ts: ts(10), from: "owner", kind: "owner", ref: "T-0005", text: "登录页在手机上也看一下" },
      { id: "e11", ts: ts(11), from: "dev@linux-box", kind: "notice", ref: "T-0005", text: "手机上也正常，截图附上" },
      { id: "e12", ts: ts(12), from: "hub", kind: "system", ref: "T-0005", text: "收到，已补充到 T-0005" },
    ];
    const app = await open("./App.tsx", { storage: STORAGE, network: hub(posts, said), width: 1200, height: 800, platform: "macos" });
    await app.press("id:task-chip-T-0005 >> nth=0");
    await app.waitFor("id:task-talk");
    expect(app.shows("text:登录页在手机上也看一下")).toBe(true);
    expect(app.shows("text:手机上也正常，截图附上")).toBe(true);
    await app.type("id:task-composer", "再看下 iPad");
    await app.press("id:task-send");
    expect(app.value("id:task-composer")).toBe(""); // reads as sent before the hub answers
    expect(app.shows("Sending…")).toBe(false);
    await app.waitUntil(() => posts.length === 1);
    expect(posts[0]).toEqual({ text: "再看下 iPad", reply_to: "T-0005", thread: true });
    await app.waitUntil(() => app.value("id:task-composer") === "");
    await app.waitFor("text:再看下 iPad");
  });

  test("a task's conversation stays on its page: the main channel skips it, old messages load, and its cards can be answered there", async () => {
    const posts: { text: string; reply_to?: string }[] = [];
    const said = [
      { id: "e20", ts: ts(20), from: "owner", kind: "owner", ref: "T-0005", thread: true, text: "只在任务里说的话" },
      { id: "e21", ts: ts(21), from: "hub", kind: "system", ref: "T-0005", thread: true, text: "任务里的回复" },
      { id: "e22", ts: ts(22), from: "dev@linux-box", kind: "notice", ref: "T-0005", text: "主要结果在主会话" },
    ];
    const net = {
      ...hub(posts, said),
      [`GET ${URL}/api/tasks/get?*`]: { body: { id: "T-0005", title: "t", agent: "lead", state: "done", decisions: ["D-0701"], events: [
        { id: "e1", ts: ts(1), from: "dev@linux-box", kind: "notice", ref: "T-0005", text: "很久以前的对话" },
        { id: "e2", ts: ts(2), from: "dev@linux-box", kind: "decision", ref: "D-0701", text: "要合并吗？", options: ["A: 合并", "B: 等"] },
      ] } },
    };
    const app = await open("./App.tsx", { storage: STORAGE, network: net, width: 1200, height: 800, platform: "macos" });
    await app.waitFor("text:主要结果在主会话");
    expect(app.shows("text:只在任务里说的话")).toBe(false);
    expect(app.shows("text:任务里的回复")).toBe(false);
    await app.press("id:task-chip-T-0005 >> nth=0");
    await app.waitFor("text:很久以前的对话");
    expect(app.shows("text:只在任务里说的话")).toBe(true);
    expect(app.shows("text:任务里的回复")).toBe(true);
    await app.press("text:/A: 合并/");
    await app.waitUntil(() => posts.length === 1);
    expect(posts[0]).toEqual({ text: "D-0701 A", reply_to: "D-0701", thread: true });
  });

    test("a decision's PR references are links, host-lettered ids are chips, option buttons shorten PR links", async () => {
    const app = await open("./App.tsx", { storage: STORAGE, network: hub([], [prDecision]), width: 1200, height: 800, platform: "macos" });
    await app.waitFor("text:/D-H0002/");
    expect(app.shows("id:gh-chip-nsh-747")).toBe(false);
    expect(app.shows("text:/A: squash 合并 nsh#747 — 进入发布/")).toBe(true);
    expect(app.shows("text:/github\\.com\\/acme\\/nsh/")).toBe(false);
    await app.press("text:nsh #747");
    expect(app.openedUrls()).toEqual(["https://github.com/acme/nsh/issues/747"]);
    // repositories no link names stay text
    expect(app.shows("text:/other#3/")).toBe(true);
    // the recommendation marks its option instead of a line of its own
    expect(app.shows("text:/建议：\\*?A/")).toBe(false);
    expect(app.shows("text:Recommended")).toBe(true);
  });

  test("a bare #746 links to the repository its thread names", async () => {
    const thread = [
      prDecision,
      { id: "e10", ts: ts(10), from: "owner", kind: "owner", ref: "T-0129", text: "Review NSH#746, 754 770" },
      { id: "e11", ts: ts(11), from: "lead@linux-box", kind: "notice", ref: "T-0129", text: "都审完了。可以合并：#746（重跑 CI）、#770（要等 `#763` 先合）。" },
    ];
    const app = await open("./App.tsx", { storage: STORAGE, network: hub([], thread), width: 1200, height: 800, platform: "macos" });
    await app.waitFor("text:#770");
    await app.press("text:#770");
    await app.press("text:NSH#746");
    expect(app.openedUrls()).toEqual(["https://github.com/acme/nsh/issues/770", "https://github.com/acme/nsh/issues/746"]);
  });

  test("an answer quotes the card it replies to; pressing the quote goes back to the card", async () => {
    const reply = { id: "e9", ts: ts(9), from: "owner", kind: "owner", ref: "D-0001", text: "B，但先跑一遍测试" };
    const app = await open("./App.tsx", { storage: STORAGE, network: hub([], [reply]), width: 1200, height: 800, platform: "macos" });
    await app.waitFor("id:reply-to-D-0001");
    expect(app.shows("text:要不要升级依赖？建议：B >> nth=1")).toBe(true);
    await app.press("id:reply-to-D-0001");
  });

  test("answers a decision with one tap", async () => {
    const posts: { text: string; reply_to?: string }[] = [];
    const app = await open("./App.tsx", { storage: STORAGE, network: hub(posts), width: 1200, height: 800, platform: "macos" });
    await app.waitFor("id:opt-D-0001-B");
    await app.press("id:opt-D-0001-B");
    await app.waitUntil(() => posts.length === 1);
    expect(posts[0]).toEqual({ text: "D-0001 B" });
    // the sidebar drops it at once, before the hub's status catches up
    expect(app.shows("text:要不要升级依赖？")).toBe(true);
    await app.waitUntil(() => !app.shows("text:要不要升级依赖？"));
  });

  test("replies to an agent's message: the reply names its task and quotes it", async () => {
    const posts: { text: string; reply_to?: string }[] = [];
    const kai = { id: "e9", ts: ts(9), from: "Kai@lb", kind: "notice", ref: "T-0125", text: "\n  \t nsh #812   主要修的是文字排版\n细节在 PR 里" };
    const app = await open("./App.tsx", { storage: STORAGE, network: hub(posts, [kai]), width: 1200, height: 800, platform: "macos" });
    await app.waitFor("id:reply-e9");
    expect(app.shows("id:reply-e1")).toBe(false); // a message with no task can't be replied to
    await app.hover("text:/主要修的是文字排版/");
    await app.press("id:reply-e9");
    await app.waitFor("id:reply-chip");
    expect(app.shows("id:reply-chip >> text:nsh #812 主要修的是文字排版")).toBe(true);
    expect(app.shows("text:/^Reply to Tripitaka:/")).toBe(false);
    await app.type("id:composer", "为何我看图片不清晰呢");
    await app.press("id:send");
    await app.waitUntil(() => posts.length === 1, { timeout: 10_000 });
    expect(posts[0]).toEqual({ text: "为何我看图片不清晰呢", reply_to: "T-0125" });
    expect(app.shows("id:reply-chip")).toBe(false);
    await app.waitFor("id:reply-to-T-0125");
    expect(app.shows("text:/Tripitaka: nsh #812 +主要修的是文字排版/")).toBe(true);
  });

  test("a question can be ignored from its card or from the sidebar", async () => {
    const posts: { text: string; reply_to?: string }[] = [];
    const app = await open("./App.tsx", { storage: STORAGE, network: hub(posts, [prDecision]), width: 1200, height: 800, platform: "macos" });
    await app.waitFor("id:ignore-D-H0003");
    await app.press("id:ignore-D-H0003");
    await app.waitUntil(() => posts.length === 1);
    expect(posts[0]).toEqual({ text: "D-H0003 忽略" });
    await app.waitFor("text:/^Ignored$/");
    await app.rightClick("text:要不要升级依赖？ >> nth=0");
    await app.press("id:side-ignore-D-0001");
    await app.waitUntil(() => posts.length === 2);
    expect(posts[1]).toEqual({ text: "D-0001 忽略" });
    await app.waitUntil(() => !app.shows("id:ignore-D-0001"));
  });

  test("the sidebar's right-click menu cancels a stuck task or marks it done", async () => {
    const cancels: unknown[] = [];
    const withTask = { ...status, decisions: [{ ...status.decisions[0], task: "T-0003" }] };
    const app = await open("./App.tsx", {
      storage: STORAGE, width: 1200, height: 800, platform: "macos",
      network: { ...hub([]), [`GET ${URL}/api/status`]: { body: withTask }, [`POST ${URL}/api/tasks/cancel`]: (r: { body?: string | null }) => { cancels.push(JSON.parse(r.body!)); return { body: { ok: true } }; } },
    });
    await app.waitFor("text:要不要升级依赖？ >> nth=0");
    app.onDialog((d) => (d.title === "Cancel T-0003?" ? "Cancel task" : null));
    await app.rightClick("text:要不要升级依赖？ >> nth=0");
    await app.press("id:side-cancel-T-0003");
    await app.waitUntil(() => cancels.length === 1);
    expect(cancels[0]).toEqual({ id: "T-0003" });
    app.onDialog((d) => (d.title === "Mark T-0007 as done?" ? "Mark as done" : null));
    await app.rightClick("text:截图检查 gallery >> nth=0");
    await app.press("id:side-done-T-0007");
    await app.waitUntil(() => cancels.length === 2);
    expect(cancels[1]).toEqual({ id: "T-0007", done: true });
  });

  test("Other instructions replies to the item from the composer", async () => {
    const posts: { text: string; reply_to?: string }[] = [];
    const app = await open("./App.tsx", { storage: STORAGE, network: hub(posts), width: 1200, height: 800, platform: "macos" });
    await app.waitFor("id:opt-D-0001-B");
    await app.press("id:other-D-0001");
    await app.waitFor("id:reply-chip >> text:要不要升级依赖？建议：B");
    await app.type("id:composer", "先等一周");
    await app.keyboard.press("mod+enter");
    await app.waitUntil(() => posts.length === 1);
    expect(posts[0]).toEqual({ text: "先等一周", reply_to: "D-0001" });
    expect(app.value("id:composer")).toBe("");
  });

  test("a message's quick actions copy its text and reply to its task", async () => {
    const posts: { text: string; reply_to?: string }[] = [];
    const done = { id: "e8", ts: ts(8), from: "lead@mac", kind: "notice", ref: "T-0009", text: "T-0009 已完成，PR 已开" };
    const app = await open("./App.tsx", { storage: STORAGE, network: hub(posts, [done]), width: 1200, height: 800, platform: "macos" });
    await app.waitFor("id:copy-e8");
    await app.hover("text:/已完成，PR 已开/");
    await app.press("id:copy-e8");
    await app.waitUntil(() => app.clipboard() === "T-0009 已完成，PR 已开");
    await app.waitFor("label:Copied");
    // an open question answers through its card, so it has no reply action
    expect(app.shows("id:reply-e2")).toBe(false);
    await app.press("id:reply-e8");
    await app.waitFor("id:reply-chip >> text:T-0009 已完成，PR 已开");
    await app.type("id:composer", "再加个截图");
    await app.keyboard.press("mod+enter");
    await app.waitUntil(() => posts.length === 1);
    expect(posts[0]).toEqual({ text: "再加个截图", reply_to: "T-0009" });
  });

  test("a machine in the sidebar opens its page, and its tasks open theirs", async () => {
    const app = await open("./App.tsx", { storage: STORAGE, network: hub([]), width: 1200, height: 800, platform: "macos" });
    await app.waitFor("Channel");
    await app.press("label:Load 42% · Disk 120 GB free · 1 running");
    await app.waitFor("Machine linux-box");
    await app.waitFor("Running");
    await app.waitFor("60% used");
    await app.waitFor("修复登录页");
    await app.press("label:T-0005 修复登录页");
    await app.waitFor("Task T-0005");
  });

  test("all tasks: older ones load page by page, and any of them opens", async () => {
    const row = (i: number) => ({ id: `T-${1000 + i}`, title: `旧任务 ${i}`, agent: "lead", state: "done", updated: ts(1) });
    const app = await open("./App.tsx", {
      storage: STORAGE, width: 1200, height: 800, platform: "macos",
      network: {
        ...hub([]),
        [`GET ${URL}/api/tasks?*`]: (r: { url: string }) => {
          const u = new ParsedURL(r.url), offset = Number(u.searchParams.get("offset"));
          if (u.searchParams.get("q")) return { body: { tasks: [row(70)], total: 1 } };
          return { body: { tasks: Array.from({ length: offset ? 20 : 50 }, (_, i) => row(i + offset)), total: 70 } };
        },
        [`GET ${URL}/api/tasks/get?*`]: { body: { ...row(1), request: "很久以前的请求", runs: [{ ts: ts(1), host: "h", cli: "claude", status: "done", summary: "早就做完了" }] } },
      },
    });
    await app.waitFor("Channel");
    await app.press("label:All tasks");
    await app.waitFor("旧任务 0");
    await app.waitFor("Load more (20 left)");
    await app.press("id:task-more");
    await app.waitFor("旧任务 69");
    await app.press("label:T-1001 旧任务 1");
    await app.waitFor("很久以前的请求");
    await app.waitFor("早就做完了");
  });

  test("channels: the sidebar lists them with unread counts; a channel shows its goal, items, edit and archive", async () => {
    const posts: unknown[] = [];
    const fresh = ts(5);
    const chans = [
      { slug: "omamail", name: "Omamail", goal: "omamail 的 PR 与 issue", status: "active", created: ts(-900), last_activity: fresh, stale: false, count: 2,
        items: [{ id: "T-0700", kind: "task", title: "omamail #460 审查", state: "done", updated: fresh }, { id: "D-0700", kind: "decision", title: "合并 omamail #460 吗？", state: "closed", updated: ts(30), task: "T-0700" }] },
      { slug: "omasend", name: "Omasend", goal: "omasend", status: "active", created: ts(-20000), last_activity: ts(-20000), stale: true, count: 0, items: [] },
    ];
    const app = await open("./App.tsx", {
      storage: { ...STORAGE, "noop.channels.since": ts(-10000) }, width: 1200, height: 800, platform: "macos",
      network: {
        ...hub([]),
        [`GET ${URL}/api/channels`]: { body: { channels: chans } },
        [`POST ${URL}/api/channels`]: (r: { body?: string | null }) => { posts.push(JSON.parse(r.body!)); return { body: { ok: true } }; },
      },
    });
    await app.waitFor("id:side-channel-omamail");
    await app.waitFor("id:side-channel-unread-omamail");
    await app.waitFor("Quiet 7d");
    await app.press("id:side-channel-omamail");
    await app.waitFor("omamail 的 PR 与 issue");
    await app.waitFor("omamail #460 审查");
    await app.waitFor("合并 omamail #460 吗？");
    await app.waitUntil(() => !app.shows("id:side-channel-unread-omamail"));
    await app.press("id:channel-edit-goal");
    await app.type("id:channel-goal-input", "，以及发布");
    await app.press("id:channel-save-goal");
    await app.waitFor("omamail 的 PR 与 issue，以及发布");
    await app.press("id:channel-archive");
    await app.waitFor("id:channel-archived");
    expect(posts).toEqual([{ slug: "omamail", goal: "omamail 的 PR 与 issue，以及发布" }, { slug: "omamail", archived: true }]);
  });

  test("a dropped connection stays quiet until reconnecting keeps failing", async () => {
    const app = await open("./App.tsx", { storage: STORAGE, network: hub([]) });
    await app.waitFor("id:composer");
    expect(app.shows("text:/Lost connection/")).toBe(false);
    await app.waitUntil(() => app.shows("text:/Lost connection/"), { timeout: 30_000 });
  });

  test("a task no online machine can run says which machine it waits for", async () => {
    const nohost = { id: "T-0097", title: "在 Windows 上实测拖入文件", agent: "reviewer", state: "nohost", needs: "os:windows", created: ts(40), updated: ts(40) };
    const app = await open("./App.tsx", {
      storage: STORAGE, width: 1200, height: 800, platform: "macos",
      network: { ...hub([]), [`GET ${URL}/api/status`]: { body: { ...status, recent: [nohost, ...status.recent] } } },
    });
    await app.waitFor("Waiting for Windows machine");
    await app.press("label:T-0097 · Waiting for a machine");
    await app.waitFor("id:task-nohost");
    expect(app.shows("id:cancel-task")).toBe(true);
    expect(app.shows("id:finish-task")).toBe(true);
  });

  test("a routine run waiting on something slow stays in the list, and can be cancelled", async () => {
    const parked = { id: "T-0236", title: "macos-check · 2026-11-04 10:00", agent: "rust-maintainer", state: "parked", started: ts(40), updated: ts(40) };
    const app = await open("./App.tsx", {
      storage: STORAGE, width: 1200, height: 800, platform: "macos",
      network: { ...hub([]), [`GET ${URL}/api/status`]: { body: { ...status, recent: [parked, ...status.recent] } } },
    });
    await app.waitFor("Waiting");
    await app.press("label:T-0236 · Waiting on external result");
    await app.waitFor("id:cancel-task");
  });

  test("machines show the code they run, and settings updates them all after a confirm", async () => {
    let updates = 0;
    const app = await open("./App.tsx", {
      storage: STORAGE, width: 1200, height: 800, platform: "macos",
      network: { ...hub([]), [`GET ${URL}/api/settings`]: { status: 500 }, [`POST ${URL}/api/fleet/update`]: () => { updates++; return { body: { ok: true } }; } },
    });
    await app.press("label:Load 42% · Disk 120 GB free · 1 running");
    await app.waitFor("id:rev-linux-box");
    expect(app.shows("c1cc085")).toBe(true);
    await app.press("id:user-menu");
    await app.press("id:settings");
    await app.press("id:settings-tab-version");
    await app.waitFor("id:version-linux-box");
    app.onDialog((d) => (d.title === "Update all machines?" ? "Cancel" : null));
    await app.press("id:update-fleet");
    await app.waitUntil(() => app.dialogs().length === 1);
    expect(updates).toBe(0);
    app.onDialog((d) => (d.title === "Update all machines?" ? "Update" : null));
    await app.press("id:update-fleet");
    await app.waitUntil(() => updates === 1);
  });

  test("while an update runs, each machine shows its progress and the button waits", async () => {
    const at = new Date(Date.now() - 60_000).toISOString();
    const mk = (state: string, detail?: string) => ({ at, ts: new Date().toISOString(), state, detail });
    const hosts = [
      { ...status.hosts[0], update: mk("waiting", "等 1 个任务跑完后重启") },
      { ...status.hosts[0], host: "mac-mini", update: mk("done", "abc1234") },
      { ...status.hosts[0], host: "old-box", update: undefined },
      { ...status.hosts[0], host: "win-box", update: mk("failed", "有本地改动或测试没通过，仍在运行旧代码") },
    ];
    const app = await open("./App.tsx", {
      storage: STORAGE, width: 1200, height: 800, platform: "macos",
      network: { ...hub([]), [`GET ${URL}/api/settings`]: { status: 500 }, [`GET ${URL}/api/status`]: { body: { ...status, hosts, update: { at } } } },
    });
    await app.press("id:user-menu");
    await app.press("id:settings");
    await app.press("id:settings-tab-version");
    await app.waitFor("等 1 个任务跑完后重启…");
    expect(app.shows("Updated to abc1234")).toBe(true);
    expect(app.shows("Waiting for a reply…")).toBe(true);
    expect(app.shows("Update failed: 有本地改动或测试没通过，仍在运行旧代码")).toBe(true);
    expect(app.shows("Updating · 1/4 done · 1 with problems")).toBe(true);
    expect(app.shows("Updating…")).toBe(true);
  });

  test("sends a task with the button, and the drawer opens on phones", async () => {
    const posts: { text: string; reply_to?: string }[] = [];
    const app = await open("./App.tsx", { storage: STORAGE, network: hub(posts) });
    await app.waitFor("id:composer");
    await app.press("label:Menu");
    await app.waitFor("Needs your decision");
    await app.press("label:Close menu");
    await app.waitUntil(() => !app.shows("Needs your decision"));
    await app.type("id:composer", "截图检查\n两个平台");
    await app.press("id:send");
    await app.waitUntil(() => posts.length === 1);
    expect(posts[0]).toEqual({ text: "截图检查\n两个平台" });
  });
});

describe("images", () => {
  const desk = { storage: STORAGE, width: 1200, height: 800, platform: "linux" as const };
  const here = (f: string) => decodeURIComponent(new (globalThis as any).URL(`./${f}`, import.meta.url).pathname);
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89, 0, 0, 0, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0, 1, 0, 0, 5, 0, 1, 0x0d, 0x0a, 0x2d, 0xb4, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  function withUploads(posts: { text: string; reply_to?: string; attachments?: string[] }[], uploads: string[]) {
    return {
      ...hub(posts),
      [`POST ${URL}/api/uploads`]: () => {
        uploads.push(`/media/shot-${uploads.length + 1}.png`);
        return { body: { url: uploads[uploads.length - 1] } };
      },
    };
  }

  test("a picked image shows as a thumbnail, can be removed, and is sent with the text", async () => {
    const posts: { text: string; attachments?: string[] }[] = [];
    const uploads: string[] = [];
    const app = await open("./App.tsx", { ...desk, network: withUploads(posts, uploads) });
    await app.waitFor("id:composer");
    app.onPick(() => [{ name: "a.png", type: "image/png", data: PNG }, { name: "b.png", type: "image/png", data: PNG }]);
    await app.press("id:attach");
    await app.waitUntil(() => app.count("id:attachment") === 2);
    await app.press("label:Remove b.png");
    expect(app.count("id:attachment")).toBe(1);
    await app.type("id:composer", "看这个报错");
    await app.press("id:send");
    expect(app.count("id:attachment")).toBe(0);
    expect(app.shows("id:owner-images")).toBe(true); // the held bubble shows the image
    await app.waitUntil(() => posts.length === 1, { timeout: 8000 });
    expect(uploads.length).toBe(1);
    expect(posts[0]).toEqual({ text: "看这个报错", attachments: ["/media/shot-1.png"] });
  });

  test("undo brings the image back to the composer; nothing is uploaded", async () => {
    const posts: { text: string }[] = [];
    const uploads: string[] = [];
    const app = await open("./App.tsx", { ...desk, network: withUploads(posts, uploads) });
    await app.waitFor("id:composer");
    app.onPick(() => [{ name: "a.png", type: "image/png", data: PNG }]);
    await app.press("id:attach");
    await app.waitFor("id:attachment");
    await app.press("id:send"); // an image alone can be sent
    await app.keyboard.press("mod+z");
    expect(app.count("id:attachment")).toBe(1);
    await app.wait(6000);
    expect(uploads.length).toBe(0);
    expect(posts.length).toBe(0);
  });

  test("a pasted screenshot attaches; a non-image is refused", async () => {
    const posts: { text: string; attachments?: string[] }[] = [];
    const uploads: string[] = [];
    const app = await open("./App.tsx", { ...desk, network: withUploads(posts, uploads) });
    await app.waitFor("id:composer");
    await app.paste("id:composer", { files: [here("icon.png")] });
    await app.waitFor("id:attachment");
    await app.paste("id:composer", { files: [here("hub.ts")] });
    await app.waitFor("id:attach-note");
    expect(app.shows("Only images can be sent")).toBe(true);
    expect(app.count("id:attachment")).toBe(1);
    await app.submit("id:composer");
    await app.waitUntil(() => posts.length === 1, { timeout: 8000 });
    expect(posts[0]).toEqual({ text: "", attachments: ["/media/shot-1.png"] });
  });

  test("an image file dropped on the composer attaches", async () => {
    const app = await open("./App.tsx", { ...desk, network: withUploads([], []) });
    await app.waitFor("id:composer");
    await app.dropFiles("id:composer-area", [`file://${here("icon.png")}`]);
    await app.waitFor("id:attachment");
    expect(app.count("id:attachment")).toBe(1);
  });
});

describe("keyboard", () => {
  const desk = { storage: STORAGE, width: 1200, height: 800, platform: "macos" as const };

  test("a sent message looks sent right away; only a failure shows, and retry sends at once", async () => {
    let fail = true;
    const posts: { text: string }[] = [];
    const ok = hub(posts);
    const network = { ...ok, [`POST ${URL}/api/messages`]: (r: { body?: string | null }) =>
      fail ? { status: 500, body: {} } : (ok as any)[`POST ${URL}/api/messages`](r) };
    const app = await open("./App.tsx", { ...desk, network });
    await app.waitFor("id:composer");
    await app.type("id:composer", "看一下日志");
    await app.submit("id:composer");
    await app.waitFor("text:看一下日志");
    expect(app.shows("即将发送")).toBe(false);
    expect(app.shows("Sending…")).toBe(false);
    await app.waitFor("text:Couldn’t send", { timeout: 8000 });
    fail = false;
    await app.press("label:Retry sending");
    await app.waitUntil(() => posts.length === 1, { timeout: 1000 }); // no second undo window
    await app.waitUntil(() => !app.shows("Couldn’t send"));
  });

  test("a just-sent message can be recalled by its button: the words return and nothing is posted", async () => {
    const posts: { text: string }[] = [];
    const app = await open("./App.tsx", { ...desk, network: hub(posts) });
    await app.waitFor("id:composer");
    await app.type("id:composer", "发错了");
    await app.submit("id:composer");
    await app.waitFor("text:发错了");
    expect(app.shows("即将发送")).toBe(false);
    await app.press("id:recall-send");
    await app.waitUntil(() => app.value("id:composer") === "发错了");
    await app.wait(6000);
    expect(posts.length).toBe(0);
  });

  test("the recall button goes away once the message has left", async () => {
    const posts: { text: string }[] = [];
    const app = await open("./App.tsx", { ...desk, network: hub(posts) });
    await app.waitFor("id:composer");
    await app.type("id:composer", "看一下");
    await app.submit("id:composer");
    await app.waitFor("id:recall-send");
    await app.waitUntil(() => posts.length === 1, { timeout: 8000 });
    await app.waitUntil(() => !app.shows("id:recall-send"));
  });

  test("a delivered message shows a check that goes away on its own", async () => {
    const posts: { text: string }[] = [];
    const app = await open("./App.tsx", { ...desk, network: hub(posts) });
    await app.waitFor("id:composer");
    await app.type("id:composer", "送达了吗");
    await app.submit("id:composer");
    expect(app.shows("id:sent-check")).toBe(false);
    await app.waitFor("id:sent-check", { timeout: 8000 });
    await app.waitUntil(() => !app.shows("id:sent-check"), { timeout: 4000 });
  });

  test("Enter sends from the composer", async () => {
    const posts: { text: string; reply_to?: string }[] = [];
    const app = await open("./App.tsx", { ...desk, network: hub(posts) });
    await app.waitFor("id:composer");
    await app.type("id:composer", "看一下日志");
    await app.submit("id:composer");
    await app.waitUntil(() => posts.length === 1, { timeout: 8000 }); // sent after the 5 s undo window
    expect(posts[0]).toEqual({ text: "看一下日志" });
    expect(app.value("id:composer")).toBe("");
  });

  test("number keys answer the pending decision; r replies to it", async () => {
    const posts: { text: string; reply_to?: string }[] = [];
    const app = await open("./App.tsx", { ...desk, network: hub(posts) });
    await app.waitFor("id:opt-D-0001-B");
    // P-0002 is answered (e4), so D-0001 is the pending one.
    await app.keyboard.press("2");
    await app.waitUntil(() => posts.length === 1);
    expect(posts[0]).toEqual({ text: "D-0001 B" });
  });

  test("Alt+number answers while the cursor is in the composer", async () => {
    const posts: { text: string; reply_to?: string }[] = [];
    const app = await open("./App.tsx", { ...desk, network: hub(posts) });
    await app.waitFor("id:opt-D-0001-B");
    await app.type("id:composer", "");
    await app.keyboard.press("alt+2");
    await app.waitUntil(() => posts.length === 1, { timeout: 8000 });
    expect(posts[0]).toEqual({ text: "D-0001 B" });
  });

  test("r replies, Escape cancels the reply, ? shows the shortcuts", async () => {
    const app = await open("./App.tsx", { ...desk, network: hub([]) });
    await app.waitFor("id:opt-D-0001-B");
    await app.keyboard.press("r");
    await app.waitFor("id:reply-chip >> text:要不要升级依赖？建议：B");
    await app.keyboard.press("escape");
    expect(app.shows("id:reply-chip")).toBe(false);
    await app.keyboard.press("escape");
    await app.keyboard.press("shift+/");
    await app.waitFor("Keyboard shortcuts");
    await app.keyboard.press("escape");
    expect(app.shows("Keyboard shortcuts")).toBe(false);
  });

  test("mod+, opens team settings", async () => {
    const app = await open("./App.tsx", { ...desk, network: { ...hub([]), [`GET ${URL}/api/settings`]: { status: 500 } } });
    await app.waitFor("id:composer");
    await app.keyboard.press("mod+,");
    await app.waitFor("Team settings");
    // Escape pops back to the channel, one page at a time.
    await app.keyboard.press("escape");
    await app.waitUntil(() => !app.shows("Team settings"));
    expect(app.shows("Channel")).toBe(true);
  });
});

describe("team settings", () => {
  test("changes an agent's models, a routine and max parallel", async () => {
    const puts: unknown[] = [];
    let view = {
      current: {},
      effective: {
        agents: [{ id: "reporter", clis: ["codex", "claude"], autonomy: "onboarding" }],
        autonomy: "onboarding",
        routines: [{ name: "triage-inbound", desc: "扫描收件箱", every: "30m", agent: "lead", enabled: true }],
        max_parallel: 4,
      },
      options: { clis: [["claude"], ["codex", "claude"], ["claude", "codex"], ["codex"]], autonomy: ["onboarding", "assisted", "autonomous"] },
    };
    const app = await open("./App.tsx", {
      storage: STORAGE,
      width: 1200,
      height: 800,
      platform: "macos",
      network: {
        ...hub([]),
        [`GET ${URL}/api/settings`]: () => ({ body: view }),
        [`PUT ${URL}/api/settings`]: (r: { body?: string | null }) => {
          const p = JSON.parse(r.body!);
          puts.push(p);
          if (p.clis) view = { ...view, effective: { ...view.effective, agents: [{ ...view.effective.agents[0], clis: p.clis.agents.reporter }] } };
          if (p.host) view = { ...view, effective: { ...view.effective, max_parallel: p.host.max_parallel } };
          return { body: view };
        },
      },
    });
    await app.press("id:user-menu");
    await app.press("id:settings");
    await app.press("id:settings-tab-members");
    await app.waitFor("id:cli-reporter");
    await app.press("id:cli-reporter");
    await app.press("id:cli-reporter-claude");
    await app.waitUntil(() => puts.length === 1);
    await app.press("id:autonomy-reporter");
    await app.press("id:autonomy-reporter-assisted");
    await app.press("id:settings-tab-routines");
    await app.waitFor("text:扫描收件箱");
    await app.waitFor("text:Every 30 min");
    await app.press("id:routine-triage-inbound");
    await app.press("id:every-triage-inbound");
    await app.press("id:every-triage-inbound-1h");
    await app.press("id:settings-tab-parallel");
    await app.press("id:parallel-inc");
    await app.waitUntil(() => puts.length === 5);
    expect(puts).toEqual([
      { clis: { agents: { reporter: ["claude"] } } },
      { autonomy: { agents: { reporter: "assisted" } } },
      { routines: { "triage-inbound": { enabled: false } } },
      { routines: { "triage-inbound": { every: "1h" } } },
      { host: { max_parallel: 5 } },
    ]);
    await app.waitFor("text:5");
    await app.press("label:Back to Channel");
    await app.waitFor("id:composer");
  });

  test("picks how long images are kept", async () => {
    const puts: unknown[] = [];
    let view = { current: {} as Record<string, unknown>, effective: { agents: [], autonomy: "onboarding", routines: [], max_parallel: 2 }, options: { clis: [], autonomy: [] } };
    const app = await open("./App.tsx", {
      storage: STORAGE,
      width: 1200,
      height: 800,
      platform: "macos",
      network: {
        ...hub([]),
        [`GET ${URL}/api/settings`]: () => ({ body: view }),
        [`PUT ${URL}/api/settings`]: (r: { body?: string | null }) => {
          const p = JSON.parse(r.body!);
          puts.push(p);
          view = { ...view, current: { ...view.current, ...p } };
          return { body: view };
        },
      },
    });
    await app.press("id:user-menu");
    await app.press("id:settings");
    await app.press("id:settings-tab-storage");
    await app.waitFor("id:media-days-90");
    await app.press("id:media-days-30");
    await app.waitUntil(() => puts.length === 1);
    expect(puts).toEqual([{ media_days: 30 }]);
    expect(app.shows("text:14 days")).toBe(true);
  });
});

describe("notifications", () => {
  type Info = { supported: boolean; ios: boolean; standalone: boolean; permission: string; subscribed: boolean; endpoint: string | null; device: string };
  const device = (over: Partial<Info> = {}): Info => ({
    supported: true, ios: false, standalone: false, permission: "default", subscribed: false, endpoint: null, device: "Android · Chrome", ...over,
  });
  /** The browser host.js wraps (Notification, PushManager, the service worker), played by the test. */
  function browser(info: Info, permission = "granted") {
    let state = { ...info };
    return {
      page: { origin: URL },
      pushState: () => state,
      pushEnable: () => {
        state = { ...state, permission, subscribed: permission === "granted", endpoint: "https://push.test/e1" };
        return { permission, subscription: permission === "granted" ? { endpoint: "https://push.test/e1", keys: { p256dh: "k", auth: "a" } } : null, device: state.device };
      },
      pushDisable: () => {
        state = { ...state, subscribed: false };
        return { endpoint: "https://push.test/e1" };
      },
      setSession: {},
      setBadge: {},
      clearNotifications: {},
      vibrate: {},
    };
  }
  function server(log: { subs: unknown[]; unsubs: unknown[]; tests: number; puts: unknown[] }) {
    return {
      ...hub([]),
      [`GET ${URL}/api/push/vapid`]: { body: { publicKey: "BPublicKey" } },
      [`POST ${URL}/api/push/subscribe`]: (r: { body?: string | null }) => (log.subs.push(JSON.parse(r.body!)), { body: { ok: true } }),
      [`POST ${URL}/api/push/unsubscribe`]: (r: { body?: string | null }) => (log.unsubs.push(JSON.parse(r.body!)), { body: { ok: true } }),
      [`POST ${URL}/api/push/test`]: () => (log.tests++, { body: { ok: true } }),
      [`GET ${URL}/api/settings`]: { body: { current: {}, effective: { agents: [], autonomy: "assisted", routines: [], max_parallel: 2 }, options: { clis: [], autonomy: [] } } },
      [`PUT ${URL}/api/settings`]: (r: { body?: string | null }) => {
        const p = JSON.parse(r.body!);
        log.puts.push(p);
        return { body: { current: p, effective: { agents: [], autonomy: "assisted", routines: [], max_parallel: 2 }, options: { clis: [], autonomy: [] } } };
      },
    };
  }
  const newLog = () => ({ subs: [] as unknown[], unsubs: [] as unknown[], tests: 0, puts: [] as unknown[] });

  test("enable on this device, send a test, turn a kind off, set quiet hours", async () => {
    const log = newLog();
    const app = await open("./App.tsx", { storage: STORAGE, host: { handlers: browser(device()) }, network: server(log) });
    await app.press("id:settings-top");
    await app.press("id:settings-notify");
    await app.waitFor("id:push-enable");
    expect(app.texts()).toContain("Off");
    await app.press("id:push-enable");
    await app.waitUntil(() => log.subs.length === 1);
    expect(log.subs[0]).toEqual({ subscription: { endpoint: "https://push.test/e1", keys: { p256dh: "k", auth: "a" } }, device_label: "Android · Chrome" });
    await app.waitFor("id:push-test");
    await app.press("id:push-test");
    await app.waitUntil(() => log.tests === 1);
    await app.waitFor("id:settings-toast >> text:/Test notification sent/");
    expect(app.shows("id:push-note")).toBe(false);
    await app.press("id:notify-result");
    await app.waitUntil(() => log.puts.length === 1);
    const p = log.puts[0] as { notify_prefs: { kinds: Record<string, boolean>; quiet_hours: unknown; tz: string } };
    expect(p.notify_prefs.kinds).toEqual({ decision: true, menu: true, proposals: true, login: true, result: false });
    expect(p.notify_prefs.quiet_hours).toBe(null);
    await app.press("id:quiet-22:00-08:00");
    await app.waitUntil(() => log.puts.length === 2);
    expect((log.puts[1] as typeof p).notify_prefs).toMatchObject({ quiet_hours: { start: "22:00", end: "08:00" }, kinds: { result: false } });
    await app.press("id:push-disable");
    await app.waitUntil(() => log.unsubs.length === 1);
    expect(log.unsubs[0]).toEqual({ endpoint: "https://push.test/e1" });
  });

  test("a refused permission is explained", async () => {
    const app = await open("./App.tsx", { storage: STORAGE, host: { handlers: browser(device(), "denied") }, network: server(newLog()) });
    await app.press("id:settings-top");
    await app.press("id:settings-notify");
    await app.press("id:push-enable");
    await app.waitFor("text:/Notifications are blocked/");
  });

  test("iPhone in Safari: notification setup is in settings", async () => {
    const app = await open("./App.tsx", {
      storage: STORAGE,
      host: { handlers: browser(device({ supported: false, ios: true, permission: "unsupported", device: "iPhone · Safari" })) },
      network: server(newLog()),
    });
    await app.waitFor("id:composer");
    expect(app.shows("id:notify-banner")).toBe(false);
    await app.press("id:settings-top");
    await app.press("id:settings-notify");
    await app.waitFor("text:/Add to Home Screen/");
    expect(app.enabled("id:push-enable")).toBe(false);
  });

  test("notification setup enables from settings", async () => {
    const log = newLog();
    const app = await open("./App.tsx", { storage: STORAGE, host: { handlers: browser(device()) }, network: server(log) });
    await app.waitFor("id:composer");
    expect(app.shows("id:notify-banner")).toBe(false);
    await app.press("id:settings-top");
    await app.press("id:settings-notify");
    await app.press("id:push-enable");
    await app.waitUntil(() => log.subs.length === 1);
  });

  test("badge, unread divider, and a notification opening an event", async () => {
    const app = await open("./App.tsx", {
      storage: { ...STORAGE, "hub.lastSeen": events[0].ts, "hub.notifyAsked": "1" },
      host: { handlers: browser(device()) },
      network: server(newLog()),
      width: 1200, height: 800, platform: "macos",
    });
    await app.waitFor("New messages");
    await app.waitUntil(() => app.host.calls().some((c) => c.name === "setBadge" && (c.data as { count: number }).count === 1));
    expect(app.host.calls().some((c) => c.name === "setSession" && (c.data as { session: string }).session === "tok")).toBe(true);
    await app.host.send("open", { ref: "D-0001" });
    await app.waitUntil(() => app.host.calls().some((c) => c.name === "clearNotifications" && (c.data as { ref: string }).ref === "D-0001"));
  });

  test("the unread divider skips an event the channel hides", async () => {
    const app = await open("./App.tsx", {
      storage: { ...STORAGE, "hub.lastSeen": events[3].ts, "hub.notifyAsked": "1" },
      network: hub([]),
      width: 1200, height: 800, platform: "macos",
    });
    await app.waitFor("New messages");
  });

  test("logging out turns this device's notifications off", async () => {
    const log = newLog();
    const app = await open("./App.tsx", {
      storage: { ...STORAGE, "hub.notifyAsked": "1" },
      host: { handlers: browser(device({ subscribed: true, permission: "granted", endpoint: "https://push.test/e1" })) },
      network: { ...server(log), [`POST ${URL}/api/auth/logout`]: { body: { ok: true } } },
    });
    await app.press("id:settings-top");
    app.onDialog((d) => (d.title === "Sign out?" ? "Sign out" : null));
    await app.press("id:logout");
    await app.waitFor("Sign in to Noop");
    expect(app.dialogs()[0].title).toBe("Sign out?");
    expect(log.unsubs).toEqual([{ endpoint: "https://push.test/e1" }]);
  });
});

describe("voice input", () => {
  test("the microphone dictates into the composer until pressed again; nothing is sent", async () => {
    const posts: { text: string; reply_to?: string }[] = [];
    const app = await open("./App.tsx", { storage: STORAGE, network: hub(posts), width: 1200, height: 800, platform: "macos" });
    await app.waitFor("label:Voice input");
    await app.type("id:composer", "提醒我：");
    await app.press("label:Voice input");
    await app.waitUntil(() => app.speechRequests().length === 1);
    expect(app.speechRequests()[0].lang).toBe("zh-CN");
    await app.waitFor("label:Stop voice input");
    expect(app.shows("text:Listening…")).toBe(true);

    // interim results replace each other; the words land after what was typed
    await app.hear("明天");
    expect(app.value("id:composer")).toBe("提醒我：明天");
    await app.hear("明天上午开会");
    expect(app.value("id:composer")).toBe("提醒我：明天上午开会");

    await app.press("label:Stop voice input");
    await app.waitFor("label:Voice input");
    expect(app.value("id:composer")).toBe("提醒我：明天上午开会");
    expect(app.shows("id:dictating")).toBe(false);
    expect(posts).toEqual([]);
  });

  test("sending while listening stops it; a refused microphone is explained", async () => {
    const app = await open("./App.tsx", { storage: STORAGE, network: hub([]), width: 1200, height: 800, platform: "macos" });
    await app.press("label:Voice input");
    await app.hear("看一下日志");
    expect(app.value("id:composer")).toBe("看一下日志");
    await app.press("id:send");
    await app.waitFor("label:Voice input");
    expect(app.value("id:composer")).toBe("");

    await app.press("label:Voice input");
    await app.endSpeech("not-allowed");
    await app.waitFor("id:attach-note");
    expect(app.shows("text:/No microphone or speech recognition permission/")).toBe(true);
    expect(app.shows("label:Stop voice input")).toBe(false);
  });

  test("on a phone, listening shows a red stop button where the mic was; stopping keeps the words", async () => {
    const posts: { text: string; reply_to?: string }[] = [];
    const app = await open("./App.tsx", { storage: STORAGE, network: hub(posts), width: 390, height: 844, platform: "ios" });
    await app.waitFor("label:Voice input");
    await app.press("label:Voice input");
    await app.waitFor("label:Stop voice input");
    expect(app.shows("id:dictate")).toBe(true);
    expect(app.shows("label:Voice input")).toBe(false);
    await app.hear("部署一下");
    await app.press("label:Stop voice input");
    await app.waitFor("label:Voice input");
    expect(app.value("id:composer")).toBe("部署一下");
    expect(posts).toEqual([]);
  });
});

test("clicking outside the macOS composer collapses an empty draft", async () => {
  const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: 1100, height: 760, platform: "macos", network: hub([]) });
  await app.waitFor("id:composer");
  expect(app.count("id:attach")).toBe(1);
  expect(app.shows("id:send")).toBe(false);
  await app.keyboard.press("mod+k");
  await app.waitFor("id:send");
  expect(app.count("id:attach")).toBe(1);
  await app.press("id:attach");
  expect(app.picks().length).toBe(1);
  await app.press("label:Channel");
  await app.waitUntil(() => !app.shows("id:send"));
  expect(app.count("id:attach")).toBe(1);
  await app.press("id:attach");
  expect(app.picks().length).toBe(2);
});

describe("phones", () => {
  const view = () => ({
    current: {},
    effective: {
      agents: [{ id: "reporter", clis: ["codex", "claude"], autonomy: "onboarding" }],
      autonomy: "onboarding",
      routines: [{ name: "triage-inbound", every: "30m", agent: "lead", enabled: true }],
      max_parallel: 4,
    },
    options: { clis: [["claude"], ["codex", "claude"], ["claude", "codex"], ["codex"]], autonomy: ["onboarding", "assisted", "autonomous"] },
  });
  function settingsServer(puts: unknown[]) {
    let v = view();
    return {
      ...hub([]),
      [`GET ${URL}/api/settings`]: () => ({ body: v }),
      [`PUT ${URL}/api/settings`]: (r: { body?: string | null }) => {
        const p = JSON.parse(r.body!);
        puts.push(p);
        if (p.clis) v = { ...v, effective: { ...v.effective, agents: [{ ...v.effective.agents[0], clis: p.clis.agents.reporter }] } };
        if (p.routines) v = { ...v, effective: { ...v.effective, routines: [{ ...v.effective.routines[0], ...p.routines["triage-inbound"] }] } };
        return { body: v };
      },
    };
  }

  for (const platform of ["ios", "android", "macos"] as const) {
    test(`${platform}: settings success uses a dismissible toast without an inline note`, async () => {
      const desktop = platform === "macos";
      const app = await open("./App.tsx", {
        storage: { ...STORAGE, "hub.notifyAsked": "1" },
        width: desktop ? 1100 : 390, height: 844, platform, network: settingsServer([]),
      });
      await app.waitFor("id:composer");
      if (desktop) await app.keyboard.press("mod+,");
      else await app.press("id:settings-top");
      if (desktop) {
        await app.waitFor("id:settings-tab-members");
        await app.press("id:settings-tab-members");
        await app.waitFor("id:cli-reporter");
        await app.press("id:cli-reporter");
      } else {
        await app.press("id:member-reporter");
      }
      await app.press("id:cli-reporter-claude");
      await app.waitFor("id:settings-toast");
      expect(app.shows("id:settings-toast >> text:Saved")).toBe(true);
      expect(app.shows("id:settings-note")).toBe(false);
      await app.waitUntil(() => !app.shows("id:settings-toast"));
      if (desktop) await app.press("id:cli-reporter");
      await app.press("id:cli-reporter-codex");
      await app.waitFor("id:settings-toast");
      if (desktop) await app.keyboard.press("Escape");
      await app.waitUntil(() => !app.shows("id:settings-toast"));
    });
  }

  test("phone settings checks a model immediately while saving", async () => {
    const app = await open("./App.tsx", {
      storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: 390, height: 844, platform: "ios",
      network: { ...settingsServer([]), [`PUT ${URL}/api/settings`]: { body: view(), delay: 5000 } },
    });
    await app.waitFor("id:composer");
    await app.press("id:settings-top");
    await app.waitFor("id:member-reporter");
    await app.press("id:member-reporter");
    await app.waitFor("id:phone-member");
    await app.press("id:cli-reporter-claude");
    expect(app.shows("id:choice-check-cli-reporter-claude")).toBe(true);
    expect(app.shows("id:settings-note")).toBe(false);
  });

  test("phone model keeps the accepted selection when effective settings are stale", async () => {
    const stale = { ...view(), current: { clis: { agents: { reporter: ["claude"] } } } };
    const app = await open("./App.tsx", {
      storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: 390, height: 844, platform: "ios",
      network: { ...settingsServer([]), [`PUT ${URL}/api/settings`]: { body: stale } },
    });
    await app.waitFor("id:composer");
    await app.press("id:settings-top");
    await app.waitFor("id:member-reporter");
    await app.press("id:member-reporter");
    await app.waitFor("id:phone-member");
    await app.press("id:cli-reporter-claude");
    await app.wait(200);
    expect(app.shows("id:choice-check-cli-reporter-claude")).toBe(true);
  });

  test("phone settings shows an error when saving fails", async () => {
    const app = await open("./App.tsx", {
      storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: 390, height: 844, platform: "ios",
      network: { ...settingsServer([]), [`PUT ${URL}/api/settings`]: { status: 500, body: "error" } },
    });
    await app.waitFor("id:composer");
    await app.press("id:settings-top");
    await app.waitFor("id:member-reporter");
    await app.press("id:member-reporter");
    await app.waitFor("id:phone-member");
    await app.press("id:cli-reporter-claude");
    await app.waitFor("id:settings-note");
    expect(app.shows("id:settings-note")).toBe(true);
    expect(app.shows("id:choice-check-cli-reporter-claude")).toBe(false);
  });

  test("iOS settings allows logout", async () => {
    const log = newLog();
    const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: 390, height: 844, platform: "ios", network: { ...settingsServer([]), ...auth(log) } });
    await app.waitFor("id:composer");
    await app.press("id:settings-top");
    await app.waitFor("id:phone-settings");
    app.onDialog((d) => d.title === "Sign out?" ? "Sign out" : null);
    await app.press("id:logout");
    await app.waitFor("Sign in to Noop");
    expect(log.logouts).toBe(1);
  });

  for (const platform of ["ios", "android"] as const) {
    test(`${platform}: settings is a grouped list whose rows push pages; back returns to the channel`, async () => {
      const puts: unknown[] = [];
      const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: 390, height: 844, platform, network: settingsServer(puts) });
      await app.waitFor("id:composer");
      await app.press("id:settings-top");
      await app.waitFor("id:phone-settings");
      for (const t of ["Notifications", "Members", "Routines", "Parallelism", "Account", "Sign out"]) expect(app.shows(`id:phone-settings >> text:${t}`)).toBe(true);
      // A member pushes its page: models and autonomy as radio rows.
      await app.press("id:member-reporter");
      await app.waitFor("id:phone-member");
      await app.press("id:cli-reporter-claude");
      await app.waitUntil(() => puts.length === 1);
      await app.press("id:autonomy-reporter-assisted");
      await app.waitUntil(() => puts.length === 2);
      await app.back();
      await app.waitUntil(() => !app.shows("id:phone-member"));
      // A routine: a real switch and the interval.
      await app.press("id:routine-row-triage-inbound");
      await app.waitFor("id:phone-routine");
      await app.press("id:routine-triage-inbound");
      await app.press("id:every-triage-inbound-1h");
      await app.waitUntil(() => puts.length === 4);
      expect(puts).toEqual([
        { clis: { agents: { reporter: ["claude"] } } },
        { autonomy: { agents: { reporter: "assisted" } } },
        { routines: { "triage-inbound": { enabled: false } } },
        { routines: { "triage-inbound": { every: "1h" } } },
      ]);
      await app.back();
      await app.back();
      await app.waitUntil(() => !app.shows("id:phone-settings"));
      expect(app.shows("id:composer")).toBe(true);
    });
  }

  test("a horizontal swipe opens the phone sidebar", async () => {
    const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: 390, height: 844, platform: "ios", network: settingsServer([]) });
    await app.waitFor("id:composer");
    await app.drag("id:channel-swipe", { x: 0, y: -100 });
    expect(app.shows("id:drawer")).toBe(false);
    await app.drag("id:channel-swipe", { x: -100, y: 0 });
    expect(app.shows("id:drawer")).toBe(false);
    await app.drag("id:channel-swipe", { x: 100, y: 0 });
    await app.waitFor("id:drawer");
    await app.drag("id:drawer", { x: -100, y: 0 });
    await app.waitUntil(() => !app.shows("id:drawer"));
  });

  test("the sidebar opens from the left; a machine opens its page and back returns to the channel", async () => {
    const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: 390, height: 844, platform: "ios", network: hub([]) });
    await app.waitFor("id:composer");
    expect(app.shows("Needs your decision")).toBe(false);
    await app.press("label:Menu");
    await app.waitFor("Needs your decision");
    await app.press("label:Load 42% · Disk 120 GB free · 1 running");
    await app.waitFor("60% used");
    await app.waitUntil(() => !app.shows("Needs your decision"));
    await app.back();
    await app.waitUntil(() => !app.shows("60% used"));
    expect(app.shows("id:composer")).toBe(true);
  });

  test("a phone browser draws its own header with a back button", async () => {
    const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: 390, height: 844, platform: "web", network: settingsServer([]) });
    await app.waitFor("id:composer");
    await app.press("id:settings-top");
    await app.waitFor("id:phone-settings");
    await app.press("label:Back to Channel");
    await app.waitUntil(() => !app.shows("id:phone-settings"));
    expect(app.shows("id:composer")).toBe(true);
  });
});

describe("rules and memory", () => {
  const enc = encodeURIComponent;
  const day = "2026-10-30T08:00:00.000Z";
  const files: Record<string, unknown[]> = {
    "policies/": [{ path: "policies/fleet.md", size: 10, updated: day }, { path: "policies/projects/app.md", size: 10, updated: day }],
    "memory/": [{ path: "memory/owner.md", size: 10, updated: day }],
    "agents/": [{ path: "agents/dev/profile.md", size: 1, updated: day }, { path: "agents/dev/memory.md", size: 1, updated: day }, { path: "agents/dev/notes.txt", size: 1, updated: day }],
    "decisions/closed/": [],
  };
  const docs: Record<string, string> = {
    "policies/fleet.md": "---\nid: fleet\n---\n# 全队规则\n\n- 先写测试再改代码",
    "agents/dev/profile.md": "# dev 的档案\n\n负责前端",
  };
  function rulesServer(reads: string[]) {
    const routes: Record<string, any> = { ...hub([]) };
    for (const [pre, list] of Object.entries(files)) routes[`GET ${URL}/api/files/list?prefix=${enc(pre)}`] = { body: { files: list } };
    for (const [p, content] of Object.entries(docs)) {
      routes[`GET ${URL}/api/files/read?path=${enc(p)}`] = () => {
        reads.push(p);
        return { body: { path: p, content, size: content.length, updated: day, version: 1 } };
      };
    }
    return routes;
  }

  test("desktop: the sidebar opens the grouped list; an item renders its markdown", async () => {
    const reads: string[] = [];
    const app = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network: rulesServer(reads) });
    await app.waitFor("id:composer");
    await app.press("label:Memory");
    await app.waitFor("id:rules-policies");
    for (const t of ["Rules", "My preferences", "Agents", "Precedents", "fleet", "projects/app", "owner", "dev · Profile", "dev · Memory", "Nothing yet"]) expect(app.shows(`id:rules >> text:${t}`)).toBe(true);
    expect(app.shows("text:notes")).toBe(false);
    await app.press("id:rule-policies/fleet.md");
    await app.waitFor("全队规则");
    expect(app.shows("text:先写测试再改代码")).toBe(true);
    expect(app.shows("text:id: fleet")).toBe(false);
    expect(reads).toEqual(["policies/fleet.md"]);
    await app.press("label:Back to Memory");
    await app.waitFor("id:rules");
  });

  test("phone: settings opens the list; an agent's profile pushes a page; back walks down", async () => {
    const reads: string[] = [];
    const view = { current: {}, effective: { agents: [], autonomy: "onboarding", routines: [], max_parallel: 2 }, options: { clis: [], autonomy: [] } };
    const app = await open("./App.tsx", {
      storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: 390, height: 844, platform: "ios",
      network: { ...rulesServer(reads), [`GET ${URL}/api/settings`]: { body: view } },
    });
    await app.waitFor("id:composer");
    await app.press("id:settings-top");
    await app.waitFor("id:phone-settings");
    await app.press("id:settings-rules");
    await app.waitFor("id:rules-agents");
    await app.press("id:rule-agents/dev/profile.md");
    await app.waitFor("负责前端");
    await app.back();
    await app.waitUntil(() => !app.shows("id:rule-doc"));
    expect(app.shows("id:rules")).toBe(true);
    await app.back();
    await app.waitFor("id:phone-settings");
  });
});

describe("commands", () => {
  const view = (commands: unknown[]) => ({
    current: { commands },
    effective: { agents: [], autonomy: "onboarding", routines: [], max_parallel: 2 },
    options: { clis: [], autonomy: [] },
  });
  function server(posts: { text: string; reply_to?: string }[], puts: unknown[], updates: { n: number }) {
    let v = view([{ name: "日报", text: "把今天各项目的进展整理成日报发给我" }]);
    return {
      ...hub(posts),
      [`GET ${URL}/api/settings`]: () => ({ body: v }),
      [`PUT ${URL}/api/settings`]: (r: { body?: string | null }) => {
        const p = JSON.parse(r.body!);
        puts.push(p);
        v = { ...v, current: { ...v.current, ...p } };
        return { body: v };
      },
      [`POST ${URL}/api/fleet/update`]: () => { updates.n++; return { body: { ok: true } }; },
    };
  }

  test("/ lists the commands; Return runs the first match: a saved one sends its text, the built-in updates the fleet", async () => {
    const posts: { text: string; reply_to?: string }[] = [], puts: unknown[] = [], updates = { n: 0 };
    const app = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network: server(posts, puts, updates) });
    await app.waitFor("id:composer");
    await app.type("id:composer", "/");
    await app.waitFor("id:command-builtin:update-fleet");
    await app.waitFor("id:command-saved:0");
    await app.type("id:composer", "日报");
    await app.waitUntil(() => !app.shows("id:command-builtin:update-fleet"));
    await app.keyboard.press("mod+enter");
    await app.waitUntil(() => posts.length === 1);
    expect(posts[0]).toEqual({ text: "把今天各项目的进展整理成日报发给我" });
    expect(app.value("id:composer")).toBe("");
    expect(app.shows("id:commands")).toBe(false);

    app.onDialog((d) => (d.title === "Update all machines?" ? "Update" : null));
    await app.type("id:composer", "/Update");
    await app.press("id:command-builtin:update-fleet");
    await app.waitUntil(() => updates.n === 1);
    expect(posts.length).toBe(1);
  });

  test("the / list takes the keyboard: Down picks the next, Return runs it, Escape closes", async () => {
    const posts: { text: string; reply_to?: string }[] = [], puts: unknown[] = [], updates = { n: 0 };
    const app = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network: server(posts, puts, updates) });
    await app.waitFor("id:composer");
    await app.type("id:composer", "/");
    await app.waitFor("id:command-saved:0");
    await app.keyboard.press("escape");
    await app.waitUntil(() => !app.shows("id:commands"));
    expect(app.value("id:composer")).toBe("");
    await app.type("id:composer", "/");
    await app.waitFor("id:command-saved:0");
    await app.keyboard.press("down");
    await app.keyboard.press("mod+enter");
    await app.waitUntil(() => posts.length === 1);
    expect(posts[0]).toEqual({ text: "把今天各项目的进展整理成日报发给我" });
    expect(updates.n).toBe(0);
  });

  test("settings adds, edits and deletes saved commands in an editor", async () => {
    const posts: { text: string; reply_to?: string }[] = [], puts: unknown[] = [], updates = { n: 0 };
    const app = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network: server(posts, puts, updates) });
    await app.press("id:user-menu");
    await app.press("id:settings");
    await app.press("id:settings-tab-commands");
    await app.waitFor("id:command-row-日报");
    // new: a name taken by another command is refused
    await app.press("id:command-new");
    await app.waitFor("id:command-editor");
    await app.type("id:command-name", "/日报");
    await app.type("id:command-text", "整理本周进展\n按项目分段");
    await app.press("id:command-save");
    await app.waitFor("id:command-note");
    expect(puts.length).toBe(0);
    await app.clear("id:command-name");
    await app.type("id:command-name", "周报");
    await app.press("id:command-save");
    await app.waitUntil(() => puts.length === 1);
    expect(puts[0]).toEqual({ commands: [{ name: "日报", text: "把今天各项目的进展整理成日报发给我" }, { name: "周报", text: "整理本周进展\n按项目分段" }] });
    await app.waitUntil(() => !app.shows("id:command-editor"));
    // edit: renaming keeps its place
    await app.press("id:command-row-日报");
    expect(app.value("id:command-name")).toBe("日报");
    await app.clear("id:command-name");
    await app.type("id:command-name", "今日");
    await app.press("id:command-save");
    await app.waitUntil(() => puts.length === 2);
    expect(puts[1]).toEqual({ commands: [{ name: "今日", text: "把今天各项目的进展整理成日报发给我" }, { name: "周报", text: "整理本周进展\n按项目分段" }] });
    // delete
    await app.waitFor("id:command-row-周报");
    await app.press("id:command-row-周报");
    await app.press("id:command-delete");
    await app.waitUntil(() => puts.length === 3);
    expect(puts[2]).toEqual({ commands: [{ name: "今日", text: "把今天各项目的进展整理成日报发给我" }] });
  });
});
