// noop: the server's shapes and the pure logic of the timeline (no UI, no I/O), shared by App.tsx and the tests.
import { L } from "./i18n";

export type Kind = "notice" | "decision" | "menu" | "proposals" | "login" | "owner" | "system" | "resolved";

/** Structured card options as the hub sends them (mirrors the server's CardOption). */
export type CardChoice = { key: string; label: string; consequence?: string; recommended?: boolean; risk?: "high" };

export type HubEvent = {
  id: string;
  ts: string;
  from: string;
  kind: Kind;
  text: string;
  ref?: string;
  priority?: string;
  /** Said inside a task's own conversation: on the task page, not in the main channel. */
  thread?: boolean;
  options?: string[];
  choices?: CardChoice[];
  /** A resolved event: how the card ended (answered / ignored / overridden / snoozed / superseded) and by whom. */
  state?: string;
  by?: string;
  attachments?: string[];
};

export type HostInfo = {
  host: string;
  caps: string[];
  seen?: string;
  busy?: number;
  stats?: { loadRatio?: number; load1?: number; cores?: number; memFreePct?: number; diskFreeGB?: number; diskFreePct?: number; [k: string]: unknown };
  os?: string;
  arch?: string;
  clis?: string[];
  accounts?: { cli: string; name: string; state: "ok" | "cooldown" | "login"; until?: string }[];
  running?: { id: string; title: string; agent: string; started?: string; activity?: Activity }[];
  recent?: { id: string; title: string; state?: string; finished?: string }[];
  /** The code the machine runs: its git commit, and that commit on GitHub. */
  rev?: string;
  rev_url?: string;
  /** Its progress on the owner's latest "update every machine". */
  update?: { at: string; ts: string; state: string; detail?: string; from?: string };
};

/** A running agent's latest sign of life, and (Claude) the step it took. */
export type Activity = { at: string; step?: string; steps?: number };

/** "最近：Bash · gh pr checks 814 · 2 分钟前"; quiet for 10+ minutes reads as such (the fleet stops it at 20 and runs it again). */
export function activityLine(a: Activity | undefined, now = Date.now()): { text: string; quiet: boolean } | null {
  if (!a?.at) return null;
  const min = Math.max(0, Math.floor((now - Date.parse(a.at)) / 60_000));
  const when = min < 1 ? L("just now", "刚刚") : L(`${min} min ago`, `${min} 分钟前`);
  if (min >= 10) return { text: L(`Quiet for ${min} min${a.step ? `, last step: ${a.step}` : ""}; after 20 min it is stopped and run again`, `已经 ${min} 分钟没有动静${a.step ? `，最后一步：${a.step}` : ""}；20 分钟没动静会自动中止并接着跑`), quiet: true };
  return { text: a.step ? L(`Latest: ${a.step} · ${when}`, `最近：${a.step} · ${when}`) : L(`Output · ${when}`, `最近有输出 · ${when}`), quiet: false };
}

export type TaskInfo = {
  id: string; title: string; agent: string; host?: string; state?: string;
  /** state "nohost": what the task needs that no online machine has ("os:windows"). */
  needs?: string;
  started?: string; created?: string; finished?: string; updated?: string; attempt?: string; decision?: string; cli?: string; model?: string;
  request?: string;
  /** state "active": its agent's latest sign of life. */
  activity?: Activity;
  runs?: { ts: string; host: string; cli: string; status: string; summary: string }[];
  steps?: { day?: string; time?: string; host?: string; kind?: string; text: string }[];
};

export type Status = {
  tasks: Record<"proposed" | "inbox" | "active" | "blocked" | "failed" | "done", number>;
  active: TaskInfo[];
  recent?: TaskInfo[];
  decisions: { id: string; kind: string; question?: string; held: boolean; task?: string }[];
  hosts: HostInfo[];
  /** The owner's latest "update every machine" request. */
  update?: { at: string };
};

/** An item id the owner answers: decisions, proposals (lists to approve) and logins. */
export const ITEM_ID = /^[DLP]-[A-Z]?\d{4}$/;
const LEADING_ID = /^\s*([DLP]-[A-Z]?\d{4})\b/;

/** Events that ask the owner something, shown as a card with buttons. */
export function isAsk(e: HubEvent): boolean {
  return !!e.ref && ITEM_ID.test(e.ref) && ["decision", "menu", "proposals", "login"].includes(e.kind);
}

/** The one-tap answers of an ask: numbers (and all / none) for menus and proposals, letters for decisions. */
export function choicesOf(e: HubEvent): string[] {
  const o = e.options ?? [];
  if (e.kind === "menu" || e.kind === "proposals") {
    const nums = o.map((x) => (x.match(/^\s*(\d+|all|none)\b/i) ?? [])[1]).filter((x): x is string => !!x);
    const rank = (x: string) => (/^\d+$/.test(x) ? 0 : x.toLowerCase() === "all" ? 1 : 2);
    return [...new Set(nums.map((x) => (/^\d+$/.test(x) ? x : x.toLowerCase())))].sort((a, b) => rank(a) - rank(b));
  }
  return [...new Set(o.map((x) => (x.match(/^\s*([A-Z])\s*[:：.]/) ?? [])[1]).filter((x): x is string => !!x))];
}

/** The option the team recommends ("建议：B" in the text), if any. */
export function recommended(e: HubEvent): string | null {
  const m = (e.text ?? "").match(/建议：\*?([^*\s　]+)/);
  return m ? m[1].split(/[,，]/)[0] : null;
}

export const choiceLabel = (c: string) => (c === "all" ? L("All", "全部") : c === "none" ? L("None", "都不要") : c);

/** The ids the owner has already answered, from the owner's own messages and the hub's resolved events
 *  (cards answered from Slack, Discord, the web card page or ntfy close here too). A snoozed card is NOT closed —
 *  it stays open and its buttons must stay usable until the tick re-presents it or it is answered. */
export function answeredIds(events: HubEvent[]): Set<string> {
  const done = new Set<string>();
  for (const e of events) {
    if (e.kind === "resolved" && e.ref && e.state !== "snoozed") done.add(e.ref);
    if (e.kind !== "owner") continue;
    if (e.ref) done.add(e.ref);
    const m = e.text.match(LEADING_ID);
    if (m) done.add(m[1]);
  }
  return done;
}

/** When a card was resolved — a resolved event, else the owner's own answer message — for the amend window. */
export function resolvedTsOf(events: HubEvent[], ref: string): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === "resolved" && e.ref === ref) return e.ts;
    if (e.kind === "owner" && (e.ref === ref || e.text.match(LEADING_ID)?.[1] === ref)) return e.ts;
  }
  return null;
}

/** How the card ended according to the hub's resolved events ("answered"…), or null while no closure arrived. */
export function resolvedStateOf(events: HubEvent[], ref: string): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === "resolved" && e.ref === ref) return e.state ?? "answered";
  }
  return null;
}

/** The card's option is gated (merge / release / deploy): the app confirms before sending it. */
export const isRisky = (e: HubEvent, key: string) =>
  !!e.choices?.some((o) => o.key.toUpperCase() === key.toUpperCase() && o.risk === "high");

export { answerOf } from "./answers";

export const TAGS = (): Partial<Record<Kind, string>> => ({ decision: L("Decide", "需要决定"), menu: L("Next", "下一步"), proposals: L("Approve", "待批准"), login: L("Login", "登录") });

export const isHub = (from: string) => /^hub/.test(from);
export const displayName = (from: string) => from.replace(/@.*/, "");
export const initials = (from: string) => (from || "?").replace(/@.*/, "").slice(0, 2).toUpperCase();
export const isVideo = (url: string) => /\.(mp4|webm|mov)(\?|$)/i.test(url);

const pad = (n: number) => String(n).padStart(2, "0");
export const dayKey = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export const timeOf = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function dayLabel(key: string, now = new Date()): string {
  if (key === dayKey(now.toISOString())) return L("Today", "今天");
  const y = new Date(now.getTime() - 86400000);
  if (key === dayKey(y.toISOString())) return L("Yesterday", "昨天");
  const [yy, mm, dd] = key.split("-").map(Number);
  const mon = MONTHS[mm - 1];
  return yy === now.getFullYear() ? L(`${mon} ${dd}`, `${mm} 月 ${dd} 日`) : L(`${mon} ${dd}, ${yy}`, `${yy} 年 ${mm} 月 ${dd} 日`);
}

/** The timeline's rows: the events with a separator before each new day. */
export type Row = { key: string; day: string } | { key: string; event: HubEvent };
export function rows(events: HubEvent[]): Row[] {
  const out: Row[] = [];
  let last = "";
  for (const e of events) {
    const d = dayKey(e.ts);
    if (d !== last) out.push({ key: `day:${d}`, day: d });
    last = d;
    out.push({ key: e.id, event: e });
  }
  return out;
}

/** Merge newly fetched or pushed events into the timeline: no duplicates, ordered by time. */
export function merge(events: HubEvent[], incoming: HubEvent[]): HubEvent[] {
  if (!incoming.length) return events;
  const seen = new Set(events.map((e) => e.id));
  const add = incoming.filter((e) => !seen.has(e.id));
  if (!add.length) return events;
  const all = [...events, ...add];
  all.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return all;
}

/** Decisions waiting for the owner (held decisions and proposals). */
export const waiting = (s: Status | null) => (s?.decisions ?? []).filter((d) => d.held || d.kind === "proposals");

export const osOf = (h: HostInfo) => (h.caps.find((c) => c.startsWith("os:")) ?? "").slice(3);
export const loadOf = (h: HostInfo) => Math.max(0, Math.min(100, Math.round((h.stats?.loadRatio ?? 0) * 100)));

export function greeting(hour = new Date().getHours()): string {
  return hour < 6 ? L("Up late", "夜深了") : hour < 12 ? L("Good morning", "早上好") : hour < 18 ? L("Good afternoon", "下午好") : L("Good evening", "晚上好");
}

/** "http://x:8787/" → "http://x:8787"; adds http:// when no scheme is given. */
export function normalizeUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, "");
  if (u && !/^https?:\/\//i.test(u)) u = `http://${u}`;
  return u;
}

/** v=2: the hub also pushes {"$status": …} frames, so a connected client never polls /api/status. */
export const wsUrl = (base: string, token: string) =>
  `${base.replace(/^http/i, "ws")}/api/stream?v=2&token=${encodeURIComponent(token)}`;

export const mediaUrl = (base: string, token: string, path: string) =>
  /^(blob|data):/i.test(path)
    ? path // a local preview of an image not sent yet
    : `${/^https?:/i.test(path) ? path : base + path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;

// ---------------------------------------------------------------- attachments (images the owner sends with a message)

/** An image waiting in the composer (or in a held message): its bytes and a local URL that shows it. */
export type Attachment = { id: string; name: string; type: string; size: number; file: Blob; preview: string };

export const ATTACH_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACH_MAX_COUNT = 10;
const IMAGE_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic", heif: "image/heif", bmp: "image/bmp",
};

/** The image type of a file, from its media type or else its name's extension; null when it is not an image (SVG is not taken). */
export function imageType(type: string | undefined, name: string): string | null {
  if (type && /^image\/[\w.+-]+$/i.test(type) && !/svg/i.test(type)) return type.toLowerCase();
  return IMAGE_EXT[(name.match(/\.(\w+)$/)?.[1] ?? "").toLowerCase()] ?? null;
}

/** Why a file cannot be attached ("" when it can). */
export function attachProblem(type: string | null, size: number, count: number): string {
  if (!type) return L("Only images can be sent", "只能发送图片");
  if (size > ATTACH_MAX_BYTES) return L("Images must be 10 MB or less", "图片不能超过 10 MB");
  if (count >= ATTACH_MAX_COUNT) return L(`Up to ${ATTACH_MAX_COUNT} images at a time`, `一次最多发送 ${ATTACH_MAX_COUNT} 张图片`);
  return "";
}

/** A `file:` URL as a local path ("file:///Users/a/My%20Shot.png" → "/Users/a/My Shot.png"; Windows drive paths too). */
export function filePath(uri: string): string {
  const p = decodeURIComponent(uri.replace(/^file:\/\/[^/]*/i, ""));
  return /^\/[A-Za-z]:\//.test(p) ? p.slice(1) : p;
}

// ---------------------------------------------------------------- team settings (GET / PUT /api/settings)

export type Autonomy = "onboarding" | "assisted" | "autonomous" | (string & {});
export type SettingsView = {
  current: Record<string, unknown>;
  effective: {
    agents: { id: string; title?: string; about?: string; clis: string[]; autonomy: Autonomy }[];
    autonomy: Autonomy;
    routines: { name: string; desc?: string; every: string; agent: string; enabled: boolean }[];
    max_parallel: number | null;
    media_days?: number;
  };
  options: { clis: string[][]; autonomy: string[] };
};

const CLI_LABELS = (): Record<string, string> => ({
  claude: L("Claude only", "仅 Claude"),
  codex: L("Codex only", "仅 Codex"),
  opencode: L("opencode only", "仅 opencode"),
  pi: L("pi only", "仅 pi"),
  omp: L("omp only", "仅 omp"),
  "codex,claude": "Codex → Claude",
  "claude,codex": "Claude → Codex",
});
export const cliKey = (clis: string[]) => clis.join(",");
export const cliLabel = (clis: string[]) => CLI_LABELS()[cliKey(clis)] ?? clis.join(" → ");
const AUTONOMY_LABELS = (): Record<string, string> => ({ onboarding: L("Onboarding", "学习期"), assisted: L("Assisted", "协助"), autonomous: L("Autonomous", "自主") });
export const autonomyLabel = (a: string) => AUTONOMY_LABELS()[a] ?? a;
export const INTERVALS = ["15m", "30m", "1h", "2h", "6h", "1d"];
const DAYS: Record<string, [string, string]> = { MON: ["Mon", "一"], TUE: ["Tue", "二"], WED: ["Wed", "三"], THU: ["Thu", "四"], FRI: ["Fri", "五"], SAT: ["Sat", "六"], SUN: ["Sun", "日"] };
/** A routine's schedule in words: "30m" → 每 30 分钟, "weekly FRI 17:00" → 每周五 17:00. */
export function everyLabel(every: string): string {
  const e = every.trim();
  let m = e.match(/^(\d+)\s*([mhd])$/);
  if (m) return m[1] === "1" ? { m: L("Every minute", "每分钟"), h: L("Hourly", "每小时"), d: L("Daily", "每天") }[m[2]]! : L(`Every ${m[1]} ${{ m: "min", h: "hours", d: "days" }[m[2]]}`, `每 ${m[1]} ${{ m: "分钟", h: "小时", d: "天" }[m[2]]}`);
  if (e === "hourly") return L("Hourly", "每小时");
  if ((m = e.match(/^daily\s+(\d\d?:\d\d)$/))) return L(`Daily ${m[1]}`, `每天 ${m[1]}`);
  if ((m = e.match(/^weekdays\s+(\d\d?:\d\d)$/))) return L(`Weekdays ${m[1]}`, `工作日 ${m[1]}`);
  if ((m = e.match(/^weekly\s+(\w{3})\s+(\d\d?:\d\d)$/i)) && DAYS[m[1].toUpperCase()]) {
    const [en, zh] = DAYS[m[1].toUpperCase()]!;
    return L(`Every ${en} ${m[2]}`, `每周${zh} ${m[2]}`);
  }
  return e;
}
export const intervalsWith = (every: string) => (INTERVALS.includes(every) ? INTERVALS : [...INTERVALS, every]);

/** The PUT bodies the settings screen sends (whitelisted keys of the hub). */
/** How long images are kept, in days: the choices and the one in force (7 by default). */
export const MEDIA_DAYS = [7, 14, 30, 90];
export const mediaDaysOf = (v: SettingsView | null | undefined): number => {
  const d = Number(v?.current?.media_days ?? v?.effective?.media_days);
  return MEDIA_DAYS.includes(d) ? d : 7;
};

export const patches = {
  clis: (agent: string, clis: string[]) => ({ clis: { agents: { [agent]: clis } } }),
  autonomy: (agent: string, level: string) => ({ autonomy: { agents: { [agent]: level } } }),
  routine: (name: string, change: { enabled?: boolean; every?: string }) => ({ routines: { [name]: change } }),
  maxParallel: (n: number) => ({ host: { max_parallel: n } }),
  mediaDays: (days: number) => ({ media_days: days }),
  /** The whole list: an array replaces the saved one. */
  commands: (list: Command[]) => ({ commands: list }),
};

// ---------------------------------------------------------------- commands (typed after "/" in the composer)

/** A command the owner saved: its name, and what it sends to the team. */
export type Command = { name: string; text: string };
/** What a command does: a built-in action of the app, or the owner's saved message. */
export type CommandItem = { id: string; name: string; detail: string; action?: "update-fleet"; text?: string };

export const BUILTIN_COMMANDS = (): CommandItem[] => [
  { id: "builtin:update-fleet", name: L("Update all machines", "更新所有机器"), detail: L("Every machine pulls the latest code and restarts", "所有机器拉取最新代码并重启"), action: "update-fleet" },
];

/** The owner's saved commands, as settings hold them (anything malformed is left out). */
export function savedCommands(view: SettingsView | null): Command[] {
  const list = (view?.current as { commands?: unknown } | undefined)?.commands;
  return Array.isArray(list) ? list.filter((c): c is Command => !!c && typeof c.name === "string" && typeof c.text === "string" && !!c.name.trim()) : [];
}

/** Built-ins first, then the saved ones; filtered by what follows the "/" (name or text contains it). */
export function commandItems(view: SettingsView | null, query = ""): CommandItem[] {
  const all = [...BUILTIN_COMMANDS(), ...savedCommands(view).map((c, i) => ({ id: `saved:${i}`, name: c.name, detail: c.text, text: c.text }))];
  const q = query.trim().toLowerCase();
  return q ? all.filter((c) => c.name.toLowerCase().includes(q) || c.detail.toLowerCase().includes(q)) : all;
}

/** The query of a draft that is a command being typed ("/更新" → "更新"), else null. */
export function slashQuery(draft: string): string | null {
  const m = draft.match(/^\/([^\n]*)$/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------- notifications (PUT /api/settings notify_prefs; the rules are in notify.ts)

const NOTIFY_KIND_IDS = ["decision", "menu", "proposals", "login", "result"] as const;
export type NotifyKind = (typeof NOTIFY_KIND_IDS)[number];
export const NOTIFY_KINDS = (): [NotifyKind, string][] => [
  ["decision", L("Decisions", "决策")],
  ["menu", L("Menus", "菜单")],
  ["proposals", L("Proposals", "待批任务")],
  ["login", L("Login", "登录")],
  ["result", L("Results", "结果通知")],
];
export type QuietHours = { start: string; end: string } | null;
export type NotifyPrefs = { kinds: Record<NotifyKind, boolean>; quiet_hours: QuietHours; tz: string };

export const QUIET_PRESETS = (): { label: string; value: QuietHours }[] => [
  { label: L("Off", "不设"), value: null },
  { label: "22:00–08:00", value: { start: "22:00", end: "08:00" } },
  { label: "23:00–07:00", value: { start: "23:00", end: "07:00" } },
  { label: "00:00–09:00", value: { start: "00:00", end: "09:00" } },
];
export const quietKey = (q: QuietHours) => (q ? `${q.start}-${q.end}` : "off");

/** The saved preferences (every kind on and no quiet hours until the owner changes them). */
export function notifyPrefsOf(view: SettingsView | null, tz: string): NotifyPrefs {
  const saved = (view?.current?.notify_prefs ?? {}) as Partial<NotifyPrefs>;
  const kinds = Object.fromEntries(NOTIFY_KIND_IDS.map((k) => [k, saved.kinds?.[k] ?? true])) as Record<NotifyKind, boolean>;
  return { kinds, quiet_hours: saved.quiet_hours ?? null, tz: saved.tz ?? tz };
}
export const notifyPatch = (prefs: NotifyPrefs) => ({ notify_prefs: prefs });

/** The event to draw "以下为新消息" above: the first one from others after what was last seen. */
export function firstUnread(events: HubEvent[], seenTs: string | null): string | null {
  if (!seenTs) return null;
  const e = events.find((x) => x.ts > seenTs && x.kind !== "owner");
  return e ? e.id : null;
}

// ---------------------------------------------------------------- the team's rules and memory (read-only views)

export type DataFile = { path: string; size: number; updated?: string; version?: number };
export type RuleItem = { path: string; title: string; detail: string };
export type RuleGroup = { key: string; title: string; hint: string; items: RuleItem[] };

/** The prefixes listed, in the order shown. */
export const RULE_PREFIXES = ["policies/", "memory/", "agents/", "decisions/closed/"] as const;

const stem = (p: string) => p.slice(p.lastIndexOf("/") + 1).replace(/\.md$/i, "");

/** The four groups of the 团队规则与记忆 list, from what /api/files/list returned for each prefix. */
export function groupRules(lists: Record<string, DataFile[]>): RuleGroup[] {
  const md = (pre: string) => (lists[pre] ?? []).filter((f) => /\.md$/i.test(f.path));
  const day = (f: DataFile) => (f.updated ?? "").slice(0, 10);
  const plain = (f: DataFile, title = stem(f.path)) => ({ path: f.path, title, detail: day(f) });
  const agents = md("agents/")
    .map((f) => f.path.match(/^agents\/([^/]+)\/(profile|memory)\.md$/i))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ path: m[0], title: `${m[1]} · ${m[2].toLowerCase() === "profile" ? L("Profile", "档案") : L("Memory", "记忆")}`, detail: day(lists["agents/"]!.find((f) => f.path === m[0])!) }));
  return [
    { key: "policies", title: L("Rules", "规则"), hint: L("Rules the whole team follows, including the ones you set for each project.", "全队遵守的规则，包括你为各项目定的规则。"), items: md("policies/").map((f) => plain(f, f.path.slice("policies/".length).replace(/\.md$/i, ""))) },
    { key: "memory", title: L("My preferences", "我的偏好"), hint: L("Your preferences, principles and lessons the team has noted.", "团队记下的你的偏好、原则和教训。"), items: md("memory/").map((f) => plain(f, f.path.slice("memory/".length).replace(/\.md$/i, ""))) },
    { key: "agents", title: "Agents", hint: L("Each member's profile and memory.", "每个成员的档案和记忆。"), items: agents },
    { key: "decisions", title: L("Precedents", "决策先例"), hint: L("Settled decisions; similar questions follow them.", "已经拍板的决策，之后同类问题照此处理。"), items: md("decisions/closed/").map((f) => plain(f)).sort((a, b) => (a.title < b.title ? 1 : -1)) },
  ];
}

/** The markdown body without its YAML front matter. */
export const stripFrontMatter = (s: string) => s.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");

/** A task's hard requirement as words: "os:windows" → "Windows 机器". */
export function needsLabel(needs = ""): string {
  const os: Record<string, string> = { windows: "Windows", linux: "Linux", macos: "Mac", darwin: "Mac", ios: "iOS", android: "Android" };
  const parts = needs.split(",").map((x) => x.trim()).filter(Boolean);
  const o = parts.find((x) => x.startsWith("os:"));
  if (o && parts.length === 1) return L(`${os[o.slice(3)] ?? o.slice(3)} machine`, `${os[o.slice(3)] ?? o.slice(3)} 机器`);
  return L(`A machine with ${parts.join(" + ")}`, `有 ${parts.join(" + ")} 的机器`);
}

/** Not finished and not running now: queued, waiting on sub-tasks or something slow, or waiting for a machine that can run it. */
export const isQueued = (state?: string) => state === "inbox" || state === "waiting" || state === "parked" || state === "nohost";

/** A machine's line under 版本 while (and after) an update runs; `busy` while it is still on the way. */
export type UpdateLine = { text: string; tone: "muted" | "ok" | "bad" | "busy"; busy: boolean };

/** How long a machine may stay silent on an update request before it reads as not responding (old code never reports). */
const UPDATE_SILENT_MS = 3 * 60_000;
/** After this long, a finished update is history: the rows go back to showing only the commit. */
const UPDATE_SHOWN_MS = 30 * 60_000;

export function updateLine(h: HostInfo, request: string | undefined, now = Date.now()): UpdateLine | null {
  if (!request) return null;
  const age = now - Date.parse(request);
  const u = h.update?.at === request ? h.update : undefined;
  if (!u) {
    if (age > UPDATE_SHOWN_MS) return null;
    return age < UPDATE_SILENT_MS
      ? { text: L("Waiting for a reply…", "等待响应…"), tone: "busy", busy: true }
      : { text: L("No reply: it may run an old version that doesn't report progress; update it by hand on that machine once", "没有响应：可能还在运行不会汇报进度的旧版本，需要在这台机器上手动更新一次"), tone: "bad", busy: false };
  }
  const settled = ["done", "current", "failed"].includes(u.state);
  if (settled && now - Date.parse(u.ts) > UPDATE_SHOWN_MS) return null;
  switch (u.state) {
    case "updating": return { text: L("Pulling and testing the new code…", "正在拉取并测试新代码…"), tone: "busy", busy: true };
    case "waiting": return { text: `${u.detail ?? L("Restarting once running tasks finish", "等运行中的任务跑完后重启")}…`, tone: "busy", busy: true };
    case "restarting": return { text: L("Restarting…", "正在重启…"), tone: "busy", busy: true };
    case "deploying": return { text: L("Redeploying…", "正在重新发布线上…"), tone: "busy", busy: true };
    case "done": return { text: L(`Updated to ${u.detail ?? h.rev?.slice(0, 7) ?? "latest"}`, `已更新到 ${u.detail ?? h.rev?.slice(0, 7) ?? "最新"}`), tone: "ok", busy: false };
    case "current": return { text: u.detail ? L(`Up to date · ${u.detail}`, `已是最新 · ${u.detail}`) : L("Up to date", "已是最新"), tone: "ok", busy: false };
    case "failed": return { text: L(`Update failed: ${u.detail ?? "unknown reason"}`, `更新失败：${u.detail ?? "原因未知"}`), tone: "bad", busy: false };
    default: return { text: u.state, tone: "muted", busy: false };
  }
}

/** The fleet's update as one line: "正在更新 · 1/3 完成", or null when nothing is on the way. */
export function updateSummary(s: Status | null | undefined, now = Date.now()): { text: string; busy: boolean } | null {
  const lines = (s?.hosts ?? []).map((h) => updateLine(h, s?.update?.at, now)).filter((l): l is UpdateLine => !!l);
  if (!lines.length) return null;
  const done = lines.filter((l) => l.tone === "ok").length, bad = lines.filter((l) => l.tone === "bad").length;
  const busy = lines.some((l) => l.busy);
  return { text: L(`${busy ? "Updating" : "Update finished"} · ${done}/${lines.length} done${bad ? ` · ${bad} with problems` : ""}`, `${busy ? "正在更新" : "更新结束"} · ${done}/${lines.length} 完成${bad ? ` · ${bad} 台有问题` : ""}`), busy };
}
