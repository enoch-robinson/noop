// Hub server: runs inside the primary daemon. Chat API (for the NSH client), built-in web chat (PWA), media.
// Reach it from phone / Mac over Tailscale (`tailscale serve --bg 8787` gives HTTPS on your tailnet). No cloud.
//
// API (Bearer token = [server].token in config.local.toml):
//   GET  /api/feed?since=<iso>            → { events: Event[] }        chat timeline (newest last)
//   GET  /api/stream                      → WebSocket, pushes Event JSON as it happens
//   POST /api/messages {text, reply_to?, attachments?}  → owner message: answers D-/P-/L- ids, otherwise becomes a task for `lead`
//   POST /api/uploads (multipart file)    → { url }   (the owner's images for a message: image/*, ≤ 10 MB)
//   GET  /api/status                      → queue, decisions, hosts, accounts
//   POST /api/fleet/update               → every machine updates to the latest code; the primary redeploys the cloud
//   POST /api/media (multipart file)      → { url }   (workers upload screenshots/recordings here)
//   GET  /media/<file>                    → attachment
//   GET  /api/files/list?prefix=  · GET /api/files/read?path=   → read-only rules & memory (same shape as the Worker)
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ServerWebSocket } from "bun";
import { accountsInfo } from "./accounts";
import { type Cfg, DATA, P, _commitPush, allowedClis, hostName, list, loadConfig, locked, onlineHosts, readDoc, UPDATE_REQUEST } from "./core";
import { cliCommand, startModel } from "./runner";
import { CLIS } from "./clis";
import { mediaHeaders, ownerAttachments, sniffImage, uploadId, uploadProblem } from "../cloud/src/uploads";
import { timingSafeEqual } from "node:crypto";
import { readable, validPath } from "../cloud/src/files";
import { channelDigest, channelsView, parseTaskBody, taskHistory, taskInfo } from "../cloud/src/tools";
import { channels, originChannel, updateChannel } from "./channels";
import { localStore } from "./brain";
import { ensureWebClient } from "./webclient";

/** One tappable option on a decision/proposals/menu card; `options` (plain strings) stays for older clients. */
export type CardOption = { key: string; label: string; consequence?: string; recommended?: boolean; risk?: "high" };

export type Event = {
  id: string; ts: string; from: string; kind: "notice" | "decision" | "menu" | "proposals" | "login" | "owner" | "system" | "resolved";
  text: string; ref?: string; client_id?: string; options?: string[]; attachments?: string[];
  /** Structured card options: buttons and push actions render from these. */
  choices?: CardOption[];
  /** Said inside a task's own conversation: shown on the task page, not in the main channel. */
  thread?: boolean;
  /** Said in a channel (its slug): shown in that channel only, never in the main chat. */
  channel?: string;
  /** resolved events only: how the card ended (answered / ignored / overridden / superseded / snoozed) and by whom. */
  state?: string; by?: string;
  /** owner events only: how the reply arrived ("button:slack" / "text:chat" / "push_action:ntfy" / "card_page:web"),
   *  for the answer-latency and channel metrics. */
  via?: string;
};

export const MEDIA = join(DATA, "..", "media");
const NSH_WEB = join(import.meta.dir, "..", "app", "dist", "web", "noop"); // built NSH web client
const FEED_DIR = join(DATA, "..", "feed"); // primary-local (next to the data repo), append-only JSONL per day
const sockets = new Set<ServerWebSocket<unknown>>();
type Inbound = { id: string; answer: string; source: string; via?: string };
const inbound: Inbound[] = [];
/** A chat message goes to the chat brain (src/brain.ts), which replies and acts through noop's tools. `reply`: the task
 * whose message the owner replied to ("T-0125"), or whose page they wrote on; `answered`: the decision the owner answered
 * moments ago (the message may change that answer); `sentAt`: when the owner sent it (for latency). */
type OwnerTask = (text: string, o: { reply?: string; answered?: string; sentAt?: string; thread?: boolean; channel?: string }) => Promise<void>;
let ownerTask: OwnerTask | null = null;

const today = () => new Date().toLocaleDateString("sv-SE");

let mirror: ((e: Event) => void) | null = null; // cloud bridge: copies primary events to the Cloudflare hub
export const setMirror = (fn: (e: Event) => void) => { mirror = fn; };

export function appendEvent(e: Omit<Event, "id" | "ts"> & Partial<Pick<Event, "id" | "ts">>, opts: { mirror?: boolean } = {}): Event {
  mkdirSync(FEED_DIR, { recursive: true });
  const ev: Event = { id: crypto.randomUUID(), ts: new Date().toISOString(), ...e };
  // results and cards of work started in a channel stay in that channel
  if (!ev.channel && ev.ref) { const c = originChannel(ev.ref); if (c) ev.channel = c; }
  if (opts.mirror !== false) mirror?.(ev);
  appendFileSync(join(FEED_DIR, `${today()}.jsonl`), JSON.stringify(ev) + "\n");
  for (const ws of sockets) ws.send(JSON.stringify(ev));
  return ev;
}

export function feed(since?: string, limit = 300): Event[] {
  if (!existsSync(FEED_DIR)) return [];
  const files = readdirSync(FEED_DIR).sort().slice(-7);
  const evs = files.flatMap((f) => readFileSync(join(FEED_DIR, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Event));
  return evs.filter((e) => !since || e.ts > since).slice(-limit);
}

/** The channel's last few hours as plain lines, oldest first: what a new chat message ("不行", "这个细节记下来") refers to.
 * The message being handled (the owner's last event, `text`) is left out. */
export function recentChat(text = "", opts: { limit?: number; hours?: number; channel?: string } = {}): string[] {
  const since = new Date(Date.now() - (opts.hours ?? 6) * 3600_000).toISOString();
  let evs = feed(since, 2000).filter((e) => e.kind !== "login" && e.text?.trim() && (e.channel ?? "") === (opts.channel ?? "")).slice(-200);
  const last = evs.at(-1);
  if (last?.from === "owner" && last.text.trim() === text.trim()) evs = evs.slice(0, -1);
  return evs.slice(-(opts.limit ?? 12)).map((e) => {
    const who = e.from === "owner" ? "owner" : e.from;
    const t = e.text.length > 700 ? `${e.text.slice(0, 700)}…` : e.text;
    return `[${e.ts.slice(11, 16)}] ${who}${e.ref ? ` (${e.ref})` : ""}: ${t.replace(/\n+/g, " ⏎ ")}`;
  });
}


/** Replies the daemon should process (same shape as Slack/Discord replies). */
export const drainInbound = () => inbound.splice(0);
/** A decision answer from the chat brain: an open card is answered; one answered minutes ago is amended. */
export function answerFromChat(id: string, answer: string, amend: boolean) {
  inbound.push({ id, answer, source: amend ? "chat-amend" : "chat" });
  if (!amend) lastAnswer = { id, at: Date.now() };
}

/** Store a local file as media; returns a server-relative URL. */
export function storeMedia(path: string): string {
  mkdirSync(MEDIA, { recursive: true });
  const name = `${Date.now()}-${basename(path).replace(/[^\w.\-]/g, "_")}`;
  writeFileSync(join(MEDIA, name), readFileSync(path));
  return `/media/${name}`;
}

/** Workers (not primary) upload media to the primary server. */
export async function uploadMedia(path: string, cfg: Cfg): Promise<string | null> {
  const url = cfg.server?.url;
  if (!url) return null;
  const fd = new FormData();
  fd.append("file", Bun.file(path), basename(path));
  const r = await fetch(`${url.replace(/\/$/, "")}/api/media`, { method: "POST", body: fd, headers: { Authorization: `Bearer ${cfg.server?.token}` } }).catch(() => null);
  return r?.ok ? ((await r.json()) as any).url : null;
}

/** Workers forward events to the primary so the chat timeline is complete. */
export async function forwardEvent(e: Omit<Event, "id" | "ts">, cfg: Cfg) {
  const url = cfg.server?.url;
  if (!url) return false;
  const r = await fetch(`${url.replace(/\/$/, "")}/api/events`, {
    method: "POST", body: JSON.stringify(e), headers: { Authorization: `Bearer ${cfg.server?.token}`, "Content-Type": "application/json" },
  }).catch(() => null);
  return !!r?.ok;
}

/** The last journal lines, for each task's timeline. */
function journalLines(): string[] {
  const dir = P("journal");
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort().slice(-2);
  return files.flatMap((f) => readFileSync(`${dir}/${f}`, "utf8").split("\n").filter((l) => l.startsWith("- ")).map((l) => `${f.slice(0, 10)} ${l.slice(2)}`));
}

/** Journal lines' leading marks → a step kind the app draws with its own icon. */
const STEP_KINDS: [string[], string][] = [
  [["💬"], "chat"], [["▶"], "start"], [["✅", "✔"], "done"], [["❌", "💥"], "fail"], [["⏸", "📨"], "decision"],
  [["↻", "♻️", "🔁", "↩️"], "retry"], [["↳"], "followup"], [["🧩"], "delegated"], [["⚖️", "👤"], "judge"], [["✏️"], "edit"],
];

/** What the app shows for a task: its request, state, timeline and results. */
export function taskView(path: string, state: string, log: string[]) {
  const { meta: m, body } = readDoc(path);
  const { request, runs } = parseTaskBody(m.title, body);
  const steps = log.filter((l) => l.includes(` ${m.id} `) || l.endsWith(` ${m.id}`)).slice(-12)
    .map((l) => {
      const x = l.match(/^(\S+) (\d\d:\d\d) `([^`]+)` (.*)$/);
      if (!x) return { text: l };
      const raw = x[4].trim();
      const lead = raw.match(/^[^\p{L}\p{N}\[(`]+/u)?.[0]?.trim() ?? "";
      const kind = STEP_KINDS.find(([marks]) => marks.some((m) => lead.startsWith(m)))?.[1] ?? "note";
      const text = raw.slice(lead.length).replace(new RegExp(`^${m.id}\\b[:：]?\\s*`), "").trim();
      return { day: x[1], time: x[2], host: x[3], kind, text };
    });
  if (state === "waiting" && (m.wake_at || m.wait_kind)) state = "parked"; // waiting on something slow (CI, a release), not on sub-tasks
  // queued, but no online machine can run it (a task that needs Windows while none is up): it waits for one, not for a turn
  const needs = state === "inbox" && m.parked && m.requires ? String(m.requires) : undefined;
  if (needs) state = "nohost";
  return { id: m.id, title: m.title, agent: m.agent, host: m.claimed_by, state, needs, waiting_on: m.waiting_on, wake_at: m.wake_at, started: m.started, created: m.created, cli: m.cli_used, model: m.model,
    finished: m.finished, updated: m.finished ?? m.started ?? m.created, attempt: m.attempt, decision: m.decision, request, runs, steps };
}

type TaskView = ReturnType<typeof taskView>;

const taskStore = () => localStore({ acts: {}, status: () => ({}), feed: () => [] });

/** Per host: what it runs now, what it finished lately, and (for this machine) its AI accounts. */
function hostViews(active: TaskView[], finished: TaskView[]) {
  let cfg: Cfg | null = null;
  try { cfg = loadConfig(); } catch {}
  const me = cfg ? hostName(cfg) : "";
  const ran = (t: TaskView, h: string) => t.host === h || t.runs.some((r) => r.host === h);
  return onlineHosts(cfg ?? {}).map((h) => ({
    ...h,
    os: h.caps.find((c) => c.startsWith("os:"))?.slice(3),
    arch: h.caps.find((c) => c.startsWith("arch:"))?.slice(5),
    clis: h.caps.filter((c) => c.startsWith("cli:")).map((c) => c.slice(4)),
    accounts: cfg && h.host === me ? (() => { try { return accountsInfo(cfg!).map((a) => ({ ...a, model: startModel(a.cli, cliCommand(a.cli, cfg!)) })); } catch { return undefined; } })() : undefined,
    running: active.filter((t) => t.host === h.host).map((t) => ({ id: t.id, title: t.title, agent: t.agent, started: t.started, activity: h.activity?.[t.id] })),
    recent: finished.filter((t) => ran(t, h.host)).slice(0, 8).map((t) => ({ id: t.id, title: t.title, state: t.state, finished: t.finished ?? t.updated })),
  }));
}

export function status() {
  const log = journalLines();
  const count = (f: string) => list(P("tasks", f), /^T-.*\.md$/).length;
  // a running task carries its agent's latest sign of life (from the heartbeat of the machine running it)
  const beats = (() => { try { return onlineHosts(loadConfig()); } catch { return []; } })();
  const active = list(P("tasks", "active"), /^T-.*\.md$/).map((p) => taskView(p, "active", log))
    .map((t) => ({ ...t, activity: beats.find((h) => h.host === t.host)?.activity?.[t.id] }));
  const others = ["done", "failed", "blocked", "waiting", "inbox"].flatMap((f) => list(P("tasks", f), /^T-.*\.md$/).map((p) => taskView(p, f, log)))
    .sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""));
  return {
    tasks: Object.fromEntries(["proposed", "inbox", "active", "waiting", "blocked", "failed", "done"].map((f) => [f, count(f)])),
    active,
    // every open task (queued, waiting on sub-tasks or something slow, blocked) and the newest finished ones; a task copied in two folders mid-sync shows once, as running
    recent: (() => {
      const rest = others.filter((t) => !active.some((a) => a.id === t.id));
      const open = rest.filter((t) => ["inbox", "nohost", "waiting", "parked", "blocked"].includes(t.state));
      return [...open, ...rest.filter((t) => !open.includes(t)).slice(0, 12)].sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""));
    })(),
    decisions: list(P("decisions", "open")).map((p) => { const m = readDoc(p).meta; return { id: m.id, kind: m.kind ?? "decision", question: m.question, held: !!m.held, task: m.task }; }),
    channels_revision: JSON.stringify(channels()),
    hosts: hostViews(active, others.filter((t) => t.state === "done" || t.state === "failed")),
    /** The owner's latest "update every machine" (each host reports its progress on it in `hosts[].update`). */
    update: (() => { try { return { at: String(JSON.parse(readFileSync(UPDATE_REQUEST(), "utf8")).at ?? "") }; } catch { return undefined; } })(),
  };
}

// ---------------------------------------------------------------- settings (UI-adjustable, shared via data repo)
const SETTABLE = ["clis", "autonomy", "routines", "host", "idle", "judge", "resources", "notify_prefs", "commands", "media_days"]; // whitelisted top-level keys

/** What an agent is for, from its profile's first line: "# Name (中文名) — what it does". */
/** Chinese titles and one-liners for the built-in roles (a profile's own Chinese "(标题)" and text still win where present). */
const ROLE_ZH: Record<string, { title: string; about: string }> = {
  apprentice: { title: "学徒", about: "从你自己的 AI 会话里学习你怎么做事、怎么判断、偏好什么" },
  architect: { title: "团队架构师", about: "持续调整这个团队的规则、提示词、记忆和角色，贴合你真实的工作" },
  "chief-of-staff": { title: "幕僚长", about: "团队空闲时给你列出可以直接开干的下一步选项" },
  dispatcher: { title: "分诊调度", about: "扫描所有进来的信号，拆成任务交给对应成员" },
  lead: { title: "负责人", about: "任务的默认负责人，决定一件事需要走多少流程" },
  "ops-watcher": { title: "线上值守", about: "盯线上告警和 CI 健康" },
  "oss-triage": { title: "开源社区", about: "处理你的开源项目里的 issue" },
  "release-manager": { title: "发布", about: "版本号、CHANGELOG、Homebrew 和软件包发布" },
  reporter: { title: "日报 / 周报", about: "根据日志、提交和 GitHub 动态写日报、周报和 OKR 进展" },
  reviewer: { title: "PR 审查", about: "仔细审查并实际验证你项目上的 PR，尤其是别人提的" },
  "rust-maintainer": { title: "Rust / GPUI 维护", about: "维护 nsh、gpui-kit、gpui-fast 等 Rust 项目" },
};
const hasHan = (s?: string) => !!s && /\p{Script=Han}/u.test(s);

export function agentRole(agent: string): { title?: string; about?: string } {
  const p = P("agents", agent, "profile.md");
  const head = existsSync(p) ? (readFileSync(p, "utf8").split("\n").find((l) => l.startsWith("# ")) ?? "") : "";
  const m = head.match(/^#\s+(.+?)\s*(?:\(([^)]+)\))?\s*(?:[—–-]+\s*(.+))?$/);
  const zh = ROLE_ZH[agent];
  const title = m ? (m[2] ?? m[1]).trim() : undefined;
  const about = m?.[3]?.trim();
  return {
    title: hasHan(title) ? title : (zh?.title ?? title),
    about: hasHan(about) ? about : (zh?.about ?? about),
  };
}

/** What each built-in routine does, for the settings page (a routine's own `desc` in config.toml wins). */
const ROUTINE_DESC: Record<string, string> = {
  "triage-inbound": "扫描 GitHub 通知、待你审的 PR、指派给你的 issue 和 CI 失败，拆成任务交给对应成员",
  "uptime-watch": "查看线上可用性告警，按升级规则处理",
  "pr-review": "审查 Core 仓库里还没审过的 PR，每次最多 3 个",
  "own-prs-ci": "让你自己的 PR 保持可合并：解冲突、修 CI、改掉明显的评审意见",
  "nightly-health": "在最新 main 上跑 cargo check / test，发现回归就建任务",
  "macos-check": "在 macOS 上构建并测试 Core 仓库，报告平台相关的失败",
  "daily-report": "根据日志、提交和 GitHub 动态写当天的日报",
  "weekly-report": "按 OKR 起草本周周报，正式提交前先问你",
  "focus-check": "核对你的关注点：哪些继续、哪些已完成、哪些该新增",
  "learn-ceo": "每台机器从本机的 Claude / Codex 会话里学习你的做事方式和判断",
  evolve: "回顾最近 7 天，调整团队的规则、提示词和记忆",
  "evolve-deep": "回顾最近 30 天，重写各成员的设定，提议新角色",
  "release-monday": "周一发布：按 runbook 发 gpui-fast / gpui-kit，每个关口找你确认",
  "release-wednesday": "周三发布 NSH：准备好一切，发布前问你一次",
};
const routineDesc = (r: any) =>
  String(r.desc ?? ROUTINE_DESC[r.name] ?? String(r.prompt ?? "").split(/(?<=[.。])\s/)[0].slice(0, 120)).trim() || undefined;

export function settingsView() {
  const cfg = loadConfig();
  const agents = readdirSync(P("agents"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  // presets for per-agent allowedClis: pin one installed CLI, or the full registry order (= the unset default, claude first)
  const installed = CLIS.map((a) => a.name).filter((c) => Bun.which(c));
  return {
    current: existsSync(P("settings.json")) ? JSON.parse(readFileSync(P("settings.json"), "utf8")) : {},
    effective: {
      agents: agents.map((a) => ({ id: a, ...agentRole(a), clis: allowedClis({ agent: a }, cfg), autonomy: cfg.autonomy?.agents?.[a] ?? cfg.autonomy?.level ?? "onboarding" })),
      autonomy: cfg.autonomy?.level ?? "onboarding",
      routines: (cfg.routine ?? []).map((r: any) => ({ name: r.name, desc: routineDesc(r), every: r.every, agent: r.agent, enabled: r.enabled !== false })),
      max_parallel: cfg.host?.max_parallel ?? null,
      media_days: mediaDays(cfg),
    },
    options: { clis: [...installed.map((c) => [c]), CLIS.map((a) => a.name)], autonomy: ["onboarding", "assisted", "autonomous"] },
  };
}

let settingsHook: ((summary: string) => Promise<void>) | null = null;
export const onSettingsSaved = (fn: (summary: string) => Promise<void>) => { settingsHook = fn; };

export async function saveSettings(patch: Record<string, unknown>) {
  const cur = existsSync(P("settings.json")) ? JSON.parse(readFileSync(P("settings.json"), "utf8")) : {};
  const deep = (a: any, b: any): any => {
    const o = { ...a };
    for (const [k, v] of Object.entries(b ?? {})) o[k] = v && typeof v === "object" && !Array.isArray(v) ? deep(o[k] ?? {}, v) : v;
    return o;
  };
  const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => SETTABLE.includes(k)));
  const next = deep(cur, clean);
  writeFileSync(P("settings.json"), JSON.stringify(next, null, 2) + "\n");
  await settingsHook?.(JSON.stringify(clean));
  return settingsView();
}

const ID = /^\s*([DLP]-[A-Z]?\d{4})\b[\s:：,，\-]*([\s\S]*)$/;

/** Owner said something (local chat or via the cloud inbox): answer an open D-/P-/L- item, or hand it to lead. */
let lastAnswer: { id: string; at: number } | null = null;
let cancelHook: ((tid: string, done?: boolean) => Promise<string>) | null = null;
export const setCancelTask = (fn: (tid: string, done?: boolean) => Promise<string>) => { cancelHook = fn; };
/** The owner cancels a task (queued, waiting, blocked, proposed or running). */
/** done: the owner finished it himself (merged by hand, …): it ends as done, not cancelled. */
export const cancelTask = async (tid: string, done = false) => (cancelHook ? cancelHook(tid, done) : "not available");
let opHook: ((op: any) => Promise<unknown>) | null = null;
export const setApplyOp = (fn: (op: any) => Promise<unknown>) => { opHook = fn; };
/** A write the cloud MCP server handed over (create/amend/cancel a task, remember, …): performed here, where the data lives. */
export const applyOp = async (op: any) => (opHook ? opHook(op) : null);
let updateHook: (() => Promise<number>) | null = null;
export const setUpdateFleet = (fn: () => Promise<number>) => { updateHook = fn; };
/** The owner asks every machine to update to the latest code (the primary also redeploys the Worker and the web app). */
export async function updateFleet(): Promise<string> {
  if (!updateHook) return "not available";
  const n = await updateHook();
  appendEvent({ from: "hub", kind: "system", text: `已通知 ${n} 台机器更新到最新代码：空闲的马上更新，有任务在跑的等跑完再重启；主控机同时重新发布线上。` });
  return "ok";
}
/** How long a reply to a just-answered card counts as a correction of that answer, not a new instruction. */
export const AMEND_MS = 5 * 60_000;

// ---------------------------------------------------------------- the owner's images (attachments of a chat message)
// Downloaded next to the data repo (not into it: the repo syncs through git / the Worker's files API, which is no place
// for screenshots), one directory per message, and named by absolute path in the task so Claude / Codex can open them.
export const ATTACH_DIR = join(DATA, "..", "attachments");
export type FetchAttachment = (path: string) => Promise<Uint8Array | null>;
/** The local server's own media ("/media/<file>" in MEDIA). */
export const localMedia: FetchAttachment = async (p) => {
  const f = join(MEDIA, basename(p));
  return existsSync(f) && statSync(f).isFile() ? new Uint8Array(readFileSync(f)) : null;
};

/** How long images and other media are kept: one of MEDIA_DAYS (settings `media_days`), 7 by default. */
export const MEDIA_DAYS = [7, 14, 30, 90];
export const mediaDays = (cfg: Cfg) => (MEDIA_DAYS.includes(Number(cfg.media_days)) ? Number(cfg.media_days) : 7);

/** Delete media and downloaded attachments older than `days` (by modification time); returns how many entries went. */
export function pruneMedia(days: number, dirs = [MEDIA, ATTACH_DIR], now = Date.now()): number {
  const cutoff = now - days * 86_400_000;
  let n = 0;
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const f = join(dir, name);
      try { if (statSync(f).mtimeMs < cutoff) { rmSync(f, { recursive: true, force: true }); n++; } } catch {}
    }
  }
  return n;
}

/** Download a message's attachments into ATTACH_DIR/<key>/; returns the absolute paths saved (failures are skipped). */
export async function saveAttachments(key: string, paths: string[], fetchOne: FetchAttachment = localMedia, root = ATTACH_DIR): Promise<string[]> {
  const dir = join(root, key.replace(/[^\w.\-]/g, "_"));
  const out: string[] = [];
  for (const p of paths) {
    const bytes = await fetchOne(p).catch(() => null);
    if (!bytes) { console.error(`attachment ${p}: download failed`); continue; }
    mkdirSync(dir, { recursive: true });
    const f = join(dir, basename(p).replace(/[^\w.\-]/g, "_") || `image-${out.length + 1}`);
    writeFileSync(f, bytes);
    out.push(f);
  }
  return out;
}

/** The owner's text with the saved images listed for the agent (a message of images only gets a placeholder text). */
export function withAttachments(text: string, files: string[], missing = 0): string {
  if (!files.length && !missing) return text;
  const lines = files.map((f) => `- ${f}`);
  if (missing) lines.push(`- (${missing} more image(s) could not be downloaded)`);
  return `${text.trim() || "(see the attached images)"}\n\nAttached images from the owner (absolute paths on the primary host; open them to see):\n${lines.join("\n")}`;
}

export async function handleOwnerMessage(
  text: string, reply_to?: string, noAmend = false,
  att: { paths?: string[]; key?: string; fetch?: FetchAttachment; sentAt?: string; thread?: boolean; via?: string; channel?: string } = {},
) {
  if (att.paths?.length) {
    const files = await saveAttachments(att.key ?? crypto.randomUUID(), att.paths, att.fetch);
    text = withAttachments(text, files, att.paths.length - files.length);
  }
  const m = text.match(ID);
  const id = m?.[1] ?? (reply_to && /^[DLP]-[A-Z]?\d{4}$/.test(reply_to) ? reply_to : null);
  // a reply to an agent's message about a task (or a message on its page): it goes to that task, whatever came just before
  const replyTask = !id && reply_to && /^T-\d{4,}$/.test(reply_to) ? reply_to : undefined;
  if (id) {
    inbound.push({ id, answer: (m ? m[2] : text).trim(), source: "chat", via: att.via });
    if (id.startsWith("D-")) lastAnswer = { id, at: Date.now() };
  } else if (ownerTask) {
    // everything else goes to the chat brain: it answers, looks things up, and creates or adjusts work through the tools
    const answered = !noAmend && !replyTask && lastAnswer && Date.now() - lastAnswer.at < AMEND_MS ? lastAnswer.id : undefined;
    await ownerTask(text, { reply: replyTask, answered, sentAt: att.sentAt, thread: !!(att.thread && replyTask), ...(att.channel ? { channel: att.channel } : {}) });
  }
}

export const setOwnerTask = (fn: OwnerTask) => { ownerTask = fn; };

// ---------------------------------------------------------------- read-only rules & memory (mirrors the Worker's /api/files/list|read)
export function listDataFiles(prefix: string, root = DATA) {
  if (prefix && !prefix.endsWith("/")) prefix += "/";
  if (!readable(prefix)) return null;
  const out: { path: string; size: number; updated: string; version: number }[] = [];
  const walk = (rel: string) => {
    let names: string[] = [];
    try { names = readdirSync(join(root, rel)).sort(); } catch { return; }
    for (const n of names) {
      if (n.startsWith(".")) continue;
      const r = rel + n, st = statSync(join(root, r));
      if (st.isDirectory()) walk(r + "/");
      else if (out.length < 2000) out.push({ path: r, size: st.size, updated: st.mtime.toISOString(), version: 0 });
    }
  };
  walk(prefix);
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}
export function readDataFile(path: string, root = DATA) {
  if (!validPath(path) || !readable(path)) return null;
  try {
    const st = statSync(join(root, path));
    if (!st.isFile()) return undefined;
    return { path, content: readFileSync(join(root, path), "utf8"), size: st.size, updated: st.mtime.toISOString(), version: 0 };
  } catch { return undefined; }
}

export function startServer(cfg: Cfg, onOwnerTask: OwnerTask) {
  if (process.env.NODE_ENV !== "test") void ensureWebClient(); // served as soon as it lands
  const s = cfg.server ?? {};
  if (s.enabled === false) return;
  if (!s.token) { console.error("server: set [server].token in config.local.toml to enable the chat API"); return; }
  ownerTask = onOwnerTask;
  const auth = (req: Request) => {
    const h = req.headers.get("authorization") ?? "";
    const q = new URL(req.url).searchParams.get("token");
    const t = h.startsWith("Bearer ") ? h.slice(7) : q ?? "";
    const want = new TextEncoder().encode(String(s.token)), got = new TextEncoder().encode(t);
    return got.length === want.length && timingSafeEqual(got, want);
  };
  const json = (d: unknown, status = 200) => Response.json(d, { status });

  const server = Bun.serve({
    hostname: s.host ?? "0.0.0.0",
    port: s.port ?? 8787,
    async fetch(req, srv) {
      const url = new URL(req.url);
      // The NSH client's web package (from the latest release, or `app/build-web.sh`) when present; else web/index.html.
      if (existsSync(join(NSH_WEB, "index.html")) && !url.pathname.startsWith("/api/") && !url.pathname.startsWith("/media/")) {
        const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
        const f = join(NSH_WEB, rel);
        if (!rel.includes("..") && existsSync(f) && statSync(f).isFile()) return new Response(Bun.file(f));
      }
      if (url.pathname === "/" || url.pathname === "/index.html")
        return new Response(Bun.file(join(import.meta.dir, "..", "web", "index.html")));
      if (url.pathname === "/manifest.webmanifest")
        return new Response(Bun.file(join(import.meta.dir, "..", "web", "manifest.webmanifest")));
      if (!auth(req)) return json({ error: "unauthorized" }, 401);
      if (url.pathname === "/api/stream" && srv.upgrade(req)) return undefined as unknown as Response;
      if (url.pathname.startsWith("/media/")) {
        const f = join(MEDIA, basename(url.pathname));
        if (!existsSync(f)) return json({ error: "not found" }, 404);
        const file = Bun.file(f);
        return new Response(file, { headers: mediaHeaders(file.type, basename(f)) });
      }
      if (url.pathname === "/api/feed") return json({ events: feed(url.searchParams.get("since") ?? undefined) });
      if (url.pathname === "/api/status") return json(status());
      if (url.pathname === "/api/files/list" && req.method === "GET") {
        const files = listDataFiles(url.searchParams.get("prefix") ?? "");
        return files ? json({ files }) : json({ error: "prefix not readable" }, 403);
      }
      if (url.pathname === "/api/files/read" && req.method === "GET") {
        const f = readDataFile(url.searchParams.get("path") ?? "");
        return f ? json(f) : f === null ? json({ error: "path not readable" }, 403) : json({ error: "not found" }, 404);
      }
      if (url.pathname === "/api/settings" && req.method === "GET") return json(settingsView());
      if (url.pathname === "/api/settings" && req.method === "PUT") return json(await saveSettings((await req.json()) as Record<string, unknown>));
      if (url.pathname === "/api/tasks" && req.method === "GET") {
        return json(taskHistory(taskStore(), { query: url.searchParams.get("q") ?? "", offset: Number(url.searchParams.get("offset")), limit: Number(url.searchParams.get("limit")) }));
      }
      if (url.pathname === "/api/tasks/get" && req.method === "GET") {
        const t = taskInfo(taskStore(), url.searchParams.get("id") ?? "");
        if (!t) return json({ error: "not found" }, 404);
        const refs = new Set([t.id, ...t.decisions]);
        return json({ ...t, events: feed("", 2000).filter((e) => e.ref && refs.has(e.ref)) });
      }
      if (url.pathname === "/api/tasks/cancel" && req.method === "POST") {
        const { id, done } = (await req.json().catch(() => ({}))) as { id?: string; done?: boolean };
        if (!id || !/^T-[\w]*\d{4}$/.test(id)) return json({ error: "id required" }, 400);
        return json({ ok: true, result: await cancelTask(id, done === true) });
      }
      if (url.pathname === "/api/channels" && req.method === "GET") return json(channelsView(taskStore()));
      if (url.pathname === "/api/channels/feed" && req.method === "GET") {
        const c = channelsView(taskStore()).channels.find((c) => c.slug === url.searchParams.get("slug"));
        return c ? json({ events: channelDigest(feed("", 5000), c.refs ?? [], c.slug) }) : json({ error: "not found" }, 404);
      }
      if (url.pathname === "/api/channels" && req.method === "POST") {
        const { slug, ...patch } = (await req.json().catch(() => ({}))) as { slug?: string; name?: unknown; goal?: unknown; archived?: unknown };
        const r = await locked(async () => { const r = updateChannel(String(slug ?? ""), patch); if (typeof r !== "string") await _commitPush(`channel ${slug}`); return r; });
        return typeof r === "string" ? json({ error: r }, 404) : json({ ok: true, channel: r });
      }
      if (url.pathname === "/api/fleet/update" && req.method === "POST") return json({ ok: true, result: await updateFleet() });
      if (url.pathname === "/api/media" && req.method === "POST") {
        const f = (await req.formData()).get("file") as File | null;
        if (!f) return json({ error: "file required" }, 400);
        mkdirSync(MEDIA, { recursive: true });
        const name = `${Date.now()}-${f.name.replace(/[^\w.\-]/g, "_")}`;
        await Bun.write(join(MEDIA, name), f);
        return json({ url: `/media/${name}` });
      }
      if (url.pathname === "/api/uploads" && req.method === "POST") { // the owner's images for a message
        const f = (await req.formData().catch(() => null))?.get("file") as File | null;
        if (!f || typeof f === "string") return json({ error: "file required" }, 400);
        const bytes = new Uint8Array(await f.arrayBuffer());
        const type = sniffImage(bytes.subarray(0, 16), f.type);
        const bad = uploadProblem(type, f.size);
        if (bad) return json({ error: bad.error }, bad.status);
        mkdirSync(MEDIA, { recursive: true });
        const name = uploadId(f.name);
        await Bun.write(join(MEDIA, name), bytes);
        return json({ url: `/media/${name}` });
      }
      if (url.pathname === "/api/events" && req.method === "POST") return json(appendEvent(await req.json() as Event));
      if (url.pathname === "/api/messages" && req.method === "POST") {
        const { text = "", reply_to, attachments, thread: inThread, client_id, channel: inChannel } = (await req.json()) as { text?: string; reply_to?: string; attachments?: unknown; thread?: unknown; client_id?: unknown; channel?: unknown };
        const channel = typeof inChannel === "string" && inChannel ? channels().find((c) => c.slug === inChannel)?.slug : undefined;
        if (inChannel !== undefined && inChannel !== "" && !channel) return json({ error: "channel not found" }, 400);
        if (client_id !== undefined && (typeof client_id !== "string" || !/^[\w:-]{1,100}$/.test(client_id)))
          return json({ error: "bad client_id" }, 400);
        if (client_id) {
          const previous = feed("", Infinity).find((e) => e.kind === "owner" && e.client_id === client_id);
          if (previous) return json(previous);
        }
        const files = ownerAttachments(attachments);
        if (files === null) return json({ error: "bad attachments" }, 400);
        if (files.some((p) => !existsSync(join(MEDIA, basename(p))))) return json({ error: "attachment not found" }, 400);
        if (!text.trim() && !files.length) return json({ error: "text required" }, 400);
        const thread = inThread === true && /^T-/.test(reply_to ?? "");
        const ev = appendEvent({ from: "owner", kind: "owner", text, ref: reply_to, via: "text:chat", ...(client_id ? { client_id: client_id as string } : {}), ...(files.length ? { attachments: files } : {}), ...(thread ? { thread } : {}), ...(channel ? { channel } : {}) });
        await handleOwnerMessage(text, reply_to, false, { paths: files, key: ev.id, thread, via: "text:chat", channel: ev.channel });
        return json(ev);
      }
      return json({ error: "not found" }, 404);
    },
    websocket: {
      open(ws) { sockets.add(ws); },
      close(ws) { sockets.delete(ws); },
      message() {},
    },
  });
  console.log(`hub server on http://${server.hostname}:${server.port}  (phone: tailscale serve --bg ${server.port})`);
  return server;
}

export const hostLabel = (cfg: Cfg) => hostName(cfg);
