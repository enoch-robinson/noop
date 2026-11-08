// noop chat client: one TSX app for the web (served by the hub), macOS, Linux and phones.
// Design: the NSH gallery's (~/work/nsh/examples/gallery): its theme tokens (theme.json is the
// gallery's), its shared UI layer (nsh-gallery-ui: palette, icons, tooltips, scroll bars), its
// sidebar + toolbar layout; sized up for reading a chat all day (16 pt text, 40 pt controls).
import { L, lang, LANG_KEY, LANGS } from "./i18n";

/** A sender's name in the current language (agents localized, others without the @host). */
const displayName = (from: string): string => agentDisplayName(from, lang() === "zh");
import {
  cleanup,
  createAnimatedValue,
  createMotion,
  colorScheme,
  computed,
  effect,
  host,
  Image,
  keymap,
  lifecycle,
  locale,
  LayoutAnimation,
  List,
  type ListRef,
  mount,
  platform,
  reduceMotion,
  safeArea,
  Scroll,
  type Signal,
  setColorScheme,
  signal,
  Storage,
  Text,
  untracked,
  Video,
  View,
  windowSize, token, openUrl, keyboardFrame, Picker, Speech, Clipboard, Notifications } from "nsh";
import fs from "fs/promises";
import type { InputRef, JSX, SpeechSession, ViewStyle } from "nsh";
import { AlertDialog, Button, ContextMenu, Dialog, Menu, MenuItem, MenuSeparator, Submenu, Input, NavPage, NavStack, NumberInput, Radio, RadioGroup, Scrollbar, TextView, createNavStack, type MarkdownExtension, type TextViewBlock, type TextViewCustomNode, type TextViewInline, type TextViewRef } from "nsh/base";
import { isAvailable as hasWindow, titleBar, currentWindow } from "nsh/desktop";
import { checkForPackage, checkForUpdate, downloadPackage, downloadUpdate, installAndRestart, restartToPackage, runningPackage } from "nsh/updater";
// shellInfo through the namespace: runtimes older than it lack the export, and a missing named import would fail to link
import * as nshUpdater from "nsh/updater";
import { CLIENT_VERSION } from "./version";
import { createSettingsToast, SettingsToast } from "./settings-toast";
import { agentDisplayName, avatarOf } from "./avatars";
import { CheckMark } from "./ui/icons";
import { type Channel, channelDigest, sortChannels } from "./channels";
import { isRead, markRead, unreadEvents, toggleMessageRead, type MessageReadState as ReadState } from "./read";
import { appendQuote } from "./quote";
import { setupTray, type TrayChat } from "./tray";
import { createTimelineWindow } from "./timeline";
import { CHECK_EVERY_MS, createUpdates, shellLine, type ShellInfo, type UpdateState } from "./update";
import {
  alpha,
  colors,
  Toggle,
  focusRing,
  hovered,
  Icon,
  type IconName,
  isDark,
  radius,
  scrollbarTheme,
  Spinner,
  tints,
  Tip,
} from "./ui";
import {
  answeredIds,
  answerOf,
  choiceLabel,
  choicesOf,
  dayLabel,
  dayKey,
  greeting,
  type HubEvent,
  initials,
  isAsk,
  isHub,
  isVideo,
  loadOf,
  mediaUrl,
  merge,
  normalizeUrl,
  osOf,
  recommended,
  isRisky,
  resolvedStateOf,
  resolvedTsOf,
  type Attachment,
  attachProblem,
  filePath,
  imageType,
  rows,
  type Status,
  TAGS,
  timeOf,
  waiting,
  wsUrl,
  autonomyLabel,
  cliKey,
  cliLabel,
  intervalsWith,
  activityLine,
  everyLabel,
  patches,
  MEDIA_DAYS,
  mediaDaysOf,
  type SettingsView,
  NOTIFY_KINDS,
  type NotifyKind,
  type NotifyPrefs,
  notifyPrefsOf,
  notifyPatch,
  QUIET_PRESETS,
  quietKey,
  firstUnread,
  type Row,
  type DataFile,
  type RuleGroup,
  RULE_PREFIXES,
  groupRules,
  stripFrontMatter,
  type HostInfo,
  type Command,
  type CommandItem,
  commandItems,
  savedCommands,
  BUILTIN_COMMANDS,
  slashQuery,
  needsLabel,
  updateLine,
  updateSummary,
  type UpdateLine,
  isQueued,
  type TaskInfo,
} from "./hub";
import { notificationFor, type NotifyRules } from "./notify";
// Email sign-in code length (cloud/src/index.ts CODE_LEN): letters and digits, case-insensitive.
const CODE_LEN = 8;

type Config = { url: string; token: string };
/** `token` holds the login session (sent as `Bearer`, and `?token=` on the WebSocket and media URLs). */
const KEYS = { url: "hub.url", token: "hub.token", email: "hub.email", theme: "hub.theme", seen: "hub.lastSeen", notifyOff: "hub.notifyOff", draft: "hub.draft" };
const touch = !(platform.idiom === "desktop" || platform.idiom === "mac");
/** iOS and Android draw the pages' headers (title, back, swipe back); the desktops and the web show the app's. */
const systemHeader = platform.os === "ios" || platform.os === "android";
const MONO = "monospace";

/** Sizes: the gallery's proportions, a step larger (the owner reads this all day). */
const size = {
  text: 17,
  line: 26,
  small: 15,
  tiny: 13,
  control: touch ? 44 : 38,
  row: touch ? 44 : 34,
  bar: touch ? 56 : 52,
  sidebar: 288,
  column: 880,
};

// ---------------------------------------------------------------- settings & connection

type Page = { origin?: string; theme?: string | null; ref?: string | null };

/** A function of the page's host (host.js on the web: push, badge, ...); null where there is none or it failed. */
async function hostCall<T>(name: string, args?: Record<string, unknown>): Promise<T | null> {
  try {
    if (!host.available()) return null;
    return ((await host.call(name, args ?? {})) ?? null) as T | null;
  } catch {
    return null;
  }
}

/** Where the app was served from on the web (nsh.json `web.host`); nothing elsewhere. */
async function pageInfo(): Promise<Page> {
  try {
    if (!host.available()) return {};
    return ((await host.call("page")) ?? {}) as Page;
  } catch {
    return {};
  }
}

type Boot = { config: Config | null; suggested: string; served: boolean; email: string; ref: string | null };

async function loadConfig(): Promise<Boot> {
  const page = await pageInfo();
  if (page.theme === "light" || page.theme === "dark") setColorScheme(page.theme);
  else {
    const saved = await Storage.getItem(KEYS.theme);
    if (saved === "light" || saved === "dark") setColorScheme(saved);
  }
  const saved = await Storage.getItem(LANG_KEY);
  if (saved === "en" || saved === "zh") lang.set(saved);
  let url = (await Storage.getItem(KEYS.url)) ?? "";
  const token = (await Storage.getItem(KEYS.token)) ?? "";
  if (!url && page.origin) url = page.origin;
  const suggested = url || page.origin || "";
  const email = (await Storage.getItem(KEYS.email)) ?? "";
  return { config: url && token ? { url: normalizeUrl(url), token } : null, suggested, served: !!page.origin, email, ref: page.ref ?? null };
}

type Conn = "connecting" | "live" | "offline" | "unauthorized" | "blocked";
/** The Worker's IP allow-list (HUB_ALLOW_IPS) turned this device away; `ip` is its address as the Worker saw it. */
const ipBlocked = (status: number, data: unknown): string | null =>
  status === 403 && (data as { error?: unknown })?.error === "ip_blocked" ? String((data as { ip?: unknown }).ip ?? "?") : null;

/** Failed reconnects in a row before the owner hears about it; anything shorter recovers silently. */
const OFFLINE_AFTER = 5;

function createHub(cfg: Config) {
  const events = signal<HubEvent[]>([]);
  const status = signal<Status | null>(null);
  const conn = signal<Conn>("connecting");
  const blockedIp = signal("");
  const loaded = signal(false);
  const headers = { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" };
  let disposed = false;
  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;

  const last = () => {
    const evs = untracked(events);
    return evs.length ? evs[evs.length - 1].ts : "";
  };

  async function loadFeed() {
    const since = last();
    try {
      const r = await fetch(`${cfg.url}/api/feed${since ? `?since=${encodeURIComponent(since)}` : ""}`, { headers });
      if (r.status === 401) return conn.set("unauthorized");
      const body = (await r.json()) as { events: HubEvent[] };
      const ip = ipBlocked(r.status, body);
      if (ip) { blockedIp.set(ip); return conn.set("blocked"); } // retried with the socket: the device may change networks
      if (untracked(conn) === "blocked") conn.set("connecting");
      events.update((evs) => merge(evs, body.events));
    } catch {
      /* the socket's retries decide when this counts as offline */
    } finally {
      loaded.set(true);
    }
  }

  async function loadStatus() {
    try {
      const r = await fetch(`${cfg.url}/api/status`, { headers });
      if (r.ok) status.set((await r.json()) as Status);
    } catch {
      /* the feed reports the connection */
    }
  }

  function stream() {
    if (disposed || untracked(conn) === "unauthorized") return;
    const ws = new WebSocket(wsUrl(cfg.url, cfg.token));
    socket = ws;
    ws.onopen = () => {
      failures = 0;
      conn.set("live");
      loadStatus(); // whatever changed while disconnected; from here on the hub pushes it
    };
    ws.onmessage = (m: { data: unknown }) => {
      try {
        const d = JSON.parse(String(m.data)) as HubEvent & { $status?: Status };
        if (d.$status) status.set(d.$status);
        else events.update((evs) => merge(evs, [d]));
      } catch {
        /* not JSON */
      }
    };
    ws.onclose = () => {
      if (disposed) return;
      if (++failures >= OFFLINE_AFTER && untracked(conn) !== "unauthorized" && untracked(conn) !== "blocked") conn.set("offline");
      retry = setTimeout(async () => {
        await loadFeed();
        stream();
      }, 3000);
    };
  }

  /** Uploads one image the owner attaches; resolves with its media path ("/media/…"). */
  async function upload(a: Attachment): Promise<string> {
    const fd = new FormData();
    fd.append("file", a.file, a.name);
    const r = await fetch(`${cfg.url}/api/uploads`, { method: "POST", headers: { Authorization: headers.Authorization }, body: fd });
    if (r.status === 401) conn.set("unauthorized");
    if (!r.ok) throw new Error(L(`Image upload failed (${r.status})`, `图片上传失败（${r.status}）`));
    return ((await r.json()) as { url: string }).url;
  }

  async function send(text: string, replyTo: string | null, files: Attachment[] = [], thread = false, clientId?: string, channel?: string) {
    const attachments: string[] = [];
    for (const f of files) attachments.push(await upload(f));
    const r = await fetch(`${cfg.url}/api/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text, ...(clientId ? { client_id: clientId } : {}), ...(replyTo ? { reply_to: replyTo } : {}), ...(attachments.length ? { attachments } : {}), ...(thread ? { thread } : {}), ...(channel ? { channel } : {}) }),
    });
    if (r.status === 401) conn.set("unauthorized");
    if (!r.ok) throw new Error(L(`Send failed (${r.status})`, `发送失败（${r.status}）`));
    const ev = (await r.json()) as HubEvent;
    if (ev?.id) events.update((evs) => merge(evs, [ev]));
    return ev?.id;
  }

  async function settings(patch?: Record<string, unknown>): Promise<SettingsView> {
    const r = await fetch(`${cfg.url}/api/settings`, patch ? { method: "PUT", headers, body: JSON.stringify(patch) } : { headers });
    if (r.status === 401) conn.set("unauthorized");
    if (!r.ok) throw new Error(L(`Couldn’t ${patch ? "save" : "load"} settings (${r.status})`, `设置${patch ? "保存" : "读取"}失败（${r.status}）`));
    return (await r.json()) as SettingsView;
  }

  /** A JSON call of the hub's API: never throws (status 0 when unreachable); a 401 ends the session. */
  async function api(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
    try {
      const r = await fetch(`${cfg.url}${path}`, method === "GET" ? { headers } : { method, headers, body: JSON.stringify(body ?? {}) });
      if (r.status === 401) conn.set("unauthorized");
      let data: Record<string, unknown> = {};
      try {
        data = ((await r.json()) ?? {}) as Record<string, unknown>;
      } catch {
        /* no body */
      }
      return { ok: r.ok, status: r.status, data };
    } catch {
      return { ok: false, status: 0, data: {} };
    }
  }

  async function logout() {
    try {
      await fetch(`${cfg.url}/api/auth/logout`, { method: "POST", headers });
    } catch {
      /* forgotten locally either way */
    }
  }

  loadFeed().then(stream);
  loadStatus();
  // the socket pushes the dashboard; only without it does the app poll, and slowly (Cloudflare free plan)
  const timer = setInterval(() => untracked(conn) !== "live" && loadStatus(), 120_000);
  const dispose = () => {
    disposed = true;
    clearInterval(timer);
    clearTimeout(retry);
    socket?.close();
  };
  return { events, status, conn, blockedIp, loaded, send, settings, api, logout, dispose, cfg };
}
type Hub = ReturnType<typeof createHub>;

function pickLang(id: string) {
  if (id !== "en" && id !== "zh") return;
  lang.set(id);
  Storage.setItem(LANG_KEY, id);
}

/** English or Chinese; the app speaks English until the owner picks. */
function LangChoices() {
  return (
    <Choices
      label={L("Language", "语言")}
      choices={LANGS.map((l) => ({ id: l.id, label: l.label, testID: `lang-${l.id}` }))}
      selected={lang()}
      onPick={pickLang}
    />
  );
}

function toggleTheme() {
  const next = colorScheme() === "dark" ? "light" : "dark";
  setColorScheme(next);
  Storage.setItem(KEYS.theme, next);
}

// ---------------------------------------------------------------- small pieces (the gallery's idioms)

/** A key as a small badge: `1`, `Enter`, `⌘K`. */
function Kbd(props: { k: string; on?: string }) {
  return (
    <View
      style={{
        minWidth: 22,
        height: 22,
        paddingHorizontal: 6,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 5,
        borderWidth: 1,
        borderColor: props.on ? alpha(props.on, 0.35) : colors.border,
        backgroundColor: props.on ? "transparent" : colors.raised,
      }}
    >
      <Text style={{ fontSize: 12.5, fontWeight: "500", color: props.on ?? colors.muted, fontVariant: ["tabular-nums"] }}>{props.k}</Text>
    </View>
  );
}

/** A quiet icon button of the toolbars and the sidebar (the gallery's ToolButton, at 36 pt). */
function ToolButton(props: { icon: IconName; label: string; shortcut?: string; on?: boolean; onPress: () => void; testID?: string; noTooltip?: boolean; compact?: boolean }) {
  return (
    <View
      onPress={props.onPress}
      role="button"
      testID={props.testID}
      accessibilityLabel={props.label}
      accessibilityState={props.on === undefined ? undefined : { selected: props.on }}
      tooltip={props.noTooltip ? undefined : <Tip label={props.label} shortcut={props.shortcut} />}
      hoverStyle={hovered()}
      activeStyle={{ backgroundColor: alpha(colors.text, 0.09) }}
      focusStyle={focusRing()}
      style={{ width: touch ? 44 : 32, height: touch ? 44 : 32, alignItems: "center", justifyContent: "center", borderRadius: radius.control, borderCurve: "continuous", borderWidth: 1, borderColor: "transparent" }}
    >
      <Icon name={props.icon} size={18} tint={props.on ? colors.accent : colors.muted} />
    </View>
  );
}

type BtnKind = "primary" | "secondary" | "ghost" | "dashed" | "danger";

/** Shared edge for controls and grouped settings surfaces. */
const surfaceEdge = () => colors.line;

/** A labelled button: the gallery's raised / accent-filled look, 38 pt (44 on touch). */
function Btn(props: {
  label: string;
  kind?: BtnKind;
  icon?: IconName;
  kbd?: string;
  note?: string;
  busy?: boolean;
  disabled?: boolean;
  /** the option the owner picked: a check and an accent edge, not dimmed */
  checked?: boolean;
  onPress: () => void;
  testID?: string;
  accessibilityLabel?: string;
  grow?: boolean;
}) {
  const kind = () => props.kind ?? "secondary";
  const fg = () => (kind() === "primary" ? colors.onAccent : kind() === "danger" ? colors.danger : kind() === "dashed" || kind() === "ghost" ? colors.muted : colors.text);
  const look = (): ViewStyle =>
    kind() === "primary"
      ? { backgroundColor: colors.accentFill, borderColor: "transparent" }
      : kind() === "danger"
        ? { backgroundColor: tints.danger, borderColor: alpha(colors.danger, 0.3) }
        : kind() === "ghost"
          ? { backgroundColor: "transparent", borderColor: "transparent" }
          : kind() === "dashed"
            ? { backgroundColor: "transparent", borderColor: colors.fieldBorder, borderStyle: "dashed" }
            : { backgroundColor: colors.surface, borderColor: surfaceEdge() };
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={{ disabled: !!props.disabled, ...(props.checked ? { checked: true } : {}) }}
      onPress={() => !props.disabled && !props.busy && props.onPress()}
      hoverStyle={props.disabled ? undefined : kind() === "primary" ? { opacity: 0.92 } : hovered()}
      activeStyle={props.disabled ? undefined : kind() === "primary" ? { opacity: 0.85 } : { backgroundColor: alpha(colors.text, 0.09) }}
      focusStyle={focusRing()}
      style={{
        minHeight: size.control,
        maxWidth: "100%",
        flexShrink: 1,
        flexGrow: props.grow ? 1 : 0,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        paddingHorizontal: 14,
        paddingVertical: 6,
        borderRadius: radius.control,
        borderCurve: "continuous",
        borderWidth: props.checked ? 1.5 : 0.5,
        opacity: props.disabled && !props.checked ? 0.45 : 1,
        transitionProperty: "background-color, border-color, opacity",
        transitionDuration: 120,
        ...look(),
        ...(props.checked ? { backgroundColor: tints.accent, borderColor: colors.accentFill, cursor: "default" } : props.disabled ? { cursor: "default" } : {}),
      }}
    >
      <If when={props.checked}>
        <Icon name="check" size={16} tint={colors.accentFill} />
      </If>
      <If when={props.kbd}>
        <Kbd k={props.kbd!} on={kind() === "primary" ? colors.onAccent : undefined} />
      </If>
      <If when={props.busy}>
        <Spinner size={14} tint={fg()} />
      </If>
      <If when={!props.busy && props.icon}>
        <Icon name={props.icon!} size={16} tint={fg()} />
      </If>
      <Text style={{ flexShrink: 1, textAlign: "center", fontSize: 15, lineHeight: 21, fontWeight: kind() === "primary" ? "600" : "500", color: fg() }}>{props.label}</Text>
      <If when={props.note}>
        <Text style={{ fontSize: size.tiny, color: kind() === "primary" ? alpha(colors.onAccent, 0.7) : colors.faint }}>{props.note}</Text>
      </If>
    </View>
  );
}

/**
 * A floating surface, for the composer and the sidebar: Apple's Liquid Glass where it is drawn (iOS 26, macOS 26), a
 * blur elsewhere. Linux and Android before 12 draw no backdrop, so they stay opaque there, or what is behind would show
 * through the text on it.
 */
const glass = (tint: string, cornerRadius: number): ViewStyle => ({
  borderRadius: cornerRadius,
  borderCurve: "continuous",
  borderWidth: 1,
  borderColor: alpha(colors.text, 0.1),
  boxShadow: "0 8px 28px rgba(0,0,0,0.1)",
  ...(platform.os === "linux" || (platform.os === "android" && Number(platform.version) < 31)
    ? { backgroundColor: tint }
    : { backgroundColor: alpha(tint, 0.55), glassEffect: "regular" as const, backdropFilter: "blur(20px)" }),
});

/** The floating surface of a message composer, which the conversation scrolls under. */
const composerGlass = (active = false): ViewStyle => ({
  ...glass(colors.field, 24),
  ...(platform.os === "ios" ? { backgroundColor: alpha(colors.field, 0.25) } : {}),
  boxShadow: "0 4px 16px rgba(0,0,0,0.06)",
  borderWidth: platform.os === "ios" || platform.os === "macos" ? 0 : 1,
  borderColor: alpha(colors.text, active ? 0.22 : 0.1),
  transitionProperty: "border-color",
  transitionDuration: 120,
});

/** Links use a quiet, underlined accent shared by the app's themes. */
const linkColor = () => token("link");

/** The icon-only send button of a message composer: a circle, the same size and icon scale as the voice button beside it. */
function SendButton(props: { disabled: boolean; onPress: () => void; testID: string }) {
  return (
    <View
      testID={props.testID}
      role="button"
      accessibilityLabel={L("Send", "发送")}
      accessibilityState={{ disabled: props.disabled }}
      onPress={() => !props.disabled && props.onPress()}
      tooltip={touch ? undefined : <Tip label={L("Send", "发送")} shortcut="Enter" />}
      hoverStyle={props.disabled ? undefined : { opacity: 0.9 }}
      style={{
        width: touch ? 44 : 36,
        height: touch ? 44 : 36,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: touch ? 22 : 18,
      }}
    >
      <View style={{ width: touch ? 32 : 28, height: touch ? 32 : 28, borderRadius: touch ? 16 : 14, alignItems: "center", justifyContent: "center", backgroundColor: colors.accentFill }}>
        <Icon name="arrow-up" size={touch ? 18 : 16} tint={colors.onAccent} />
      </View>
    </View>
  );
}

function Dot(props: { tone: "on" | "run" | "queue" | "wait" | "off" | "bad" }) {
  const color = () => ({ on: colors.up, run: colors.up, queue: colors.info, wait: colors.warn, off: colors.faint, bad: colors.danger })[props.tone];
  return <View style={{ width: 8, height: 8, borderRadius: 4, flexShrink: 0, backgroundColor: color() }} />;
}

/** A tag in the gallery's Badge style: a tone's tint behind its color. */
function Badge(props: { label: string; tone?: "accent" | "warn" | "info" | "neutral" | "danger" }) {
  const tone = props.tone ?? "neutral";
  const fg = () => (tone === "neutral" ? colors.muted : tone === "accent" ? colors.accent : colors[tone]);
  const bg = () => (tone === "neutral" ? colors.raised : tints[tone]);
  return (
    <View style={{ height: 22, paddingHorizontal: 8, justifyContent: "center", borderRadius: 6, backgroundColor: bg() }}>
      <Text style={{ fontSize: 12.5, fontWeight: "600", color: fg() }}>{props.label}</Text>
    </View>
  );
}

/** The app's mark: a dark square with a live dot (the hub). */
function Mark(props: { size?: number }) {
  const s = props.size ?? 24;
  return (
    <View style={{ width: s, height: s, borderRadius: s * 0.28, backgroundColor: colors.text, alignItems: "center", justifyContent: "center" }}>
      <View style={{ width: s * 0.38, height: s * 0.38, borderRadius: s, backgroundColor: colors.surface }} />
    </View>
  );
}

/** Opens a task's page from a T-0000 in any text (set by the channel). */
let taskLink: (id: string) => void = () => {};

/** A task's state from the hub's status (set by the channel), for the chips' dots. */
let taskState: (id: string) => string | undefined = () => undefined;

/** The app's syntax in messages (`extensions`, `pattern`): task ids and decision / proposal ids, shown by `renderCustom`. */
const EXTENSIONS: MarkdownExtension[] = [
  // ids minted on a non-primary host carry its letter (T-M0001, D-H0002)
  { name: "task", pattern: "\\bT-[A-Z]?\\d{4}\\b" },
  { name: "item", pattern: "\\b[DP]-[A-Z]?\\d{4}\\b" },
];
const GH = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)\/?$/;

/** A bare GitHub PR or issue link reads as "nsh#747": still a plain link, not a chip (GFM autolinks bare URLs). */
function ghInlines(inlines: TextViewInline[]): TextViewInline[] {
  return inlines.map((i): TextViewInline => {
    if (i.type === "link") {
      const m = i.url.match(GH);
      const bare = i.content.length === 1 && i.content[0].type === "text" && i.content[0].text.replace(/\/$/, "") === i.url.replace(/\/$/, "");
      return m && bare ? { ...i, content: [{ type: "text", text: `${m[2]}#${m[4]}` }] } : i;
    }
    return "content" in i && Array.isArray(i.content) ? ({ ...i, content: ghInlines(i.content) } as TextViewInline) : i;
  });
}
function ghBlocks(blocks: TextViewBlock[]): TextViewBlock[] {
  return blocks.map((b): TextViewBlock => {
    const x = { ...b } as Record<string, unknown>;
    if (Array.isArray(x.content)) x.content = ghInlines(x.content as TextViewInline[]);
    if (Array.isArray(x.children)) x.children = ghBlocks(x.children as TextViewBlock[]);
    if (Array.isArray(x.items)) x.items = (x.items as { children: TextViewBlock[] }[]).map((it) => ({ ...it, children: ghBlocks(it.children) }));
    return x as TextViewBlock;
  });
}

/** Repositories the channel has linked so far, by name ("nsh" → "longbridge/nsh"; set by the channel). */
let knownRepos: () => Map<string, string> = () => new Map();

/** Every repository a GitHub link in `text` names, by lower-cased name. */
function reposIn(text: string, into = new Map<string, string>()): Map<string, string> {
  for (const m of text.matchAll(/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/\d+/g)) into.set(m[2].toLowerCase(), `${m[1]}/${m[2]}`);
  return into;
}

const REF = /(^|[^\w\/\[#&])(?:([A-Za-z][\w.-]*)( ?))?#(\d+)\b/g;

/**
 * A "#746" is a GitHub PR or issue: "nsh #747" / "NSH#747" links to that repository when the channel has linked it
 * before; a bare "#747" to the one repository the message, or what it is about (`context`: a card's options, the
 * thread it belongs to), names. Code spans are left alone.
 */
function linkRepoRefs(text: string, context = ""): string {
  const known = reposIn(`${text}\n${context}`, new Map(knownRepos()));
  if (!known.size) return text;
  // the repositories in play: linked ones, and "name#N" naming a known one
  const named = new Set<string>([...reposIn(`${text}\n${context}`).values()]);
  for (const m of `${text}\n${context}`.matchAll(REF)) {
    const slug = m[2] && known.get(m[2].toLowerCase());
    if (slug) named.add(slug);
  }
  const only = named.size === 1 ? [...named][0] : null;
  const url = (slug: string, n: string) => `https://github.com/${slug}/issues/${n}`;
  return text.split(/(`[^`\n]*`)/).map((part, i) => (i % 2 ? part : part.replace(
    REF,
    (all, pre: string, name: string | undefined, sp: string, n: string) => {
      const slug = name && known.get(name.toLowerCase());
      if (slug) return `${pre}[${name}${sp}#${n}](${url(slug, n)})`;
      if (!only || (name && !sp && !/^(pr|issue)s?$/i.test(name))) return all;
      return `${pre}${name ? name + sp : ""}[#${n}](${url(only, n)})`;
    },
  ))).join("");
}

/** Hub text keeps its line breaks: single newlines become hard breaks, outside code fences. */
function hubMarkdown(text: string): string {
  return text
    .split(/(^```[\s\S]*?^```)/m)
    .map((part, i) => (i % 2 ? part : part
      // single newlines are hard breaks, except around list items (a "\\" there shows up literally)
      .replace(/([^\n])\n(?!\n|\s*(?:[-*+]|\d+[.)])\s)/g, (m0, c, off, all) => /^\s*(?:[-*+]|\d+[.)])\s/.test(all.slice(all.lastIndexOf("\n", off) + 1, off + 1)) ? `${c}\n` : `${c}\\\n`)
      // Bare URLs stop at CJK / full-width punctuation and spaces ("pull/1：让" links pull/1 only).
      .replace(/(?<![(<\[`])\bhttps?:\/\/[^\s<>()\[\]`\u3000-\u303f\uff00-\uffef\u2018-\u201f\u4e00-\u9fff]+[^\s<>()\[\]`.,;:!?'"\u3000-\u303f\uff00-\uffef\u2018-\u201f\u4e00-\u9fff]/g, "<$&>")))
    .join("");
}

/** Texts inside a pressable chip: a pointer, not the I-beam selectable texts force (per view on Linux). */
const chipText = { cursor: "pointer", userSelect: "none" } as const;
/** A message's first line, without markdown marks, for a one-line quote. */
const firstLine = (t: string) => (t.split("\n").find((l) => l.trim()) ?? "").replace(/^\s*(#+|>)\s*/, "").replace(/[*_`]/g, "").trim().slice(0, 80);
const chipFrame: ViewStyle = {
  cursor: "pointer", verticalAlign: "middle", flexDirection: "row", alignItems: "center", gap: 5, marginHorizontal: 2, height: 20,
  borderWidth: 1, borderColor: colors.border, backgroundColor: alpha(colors.text, 0.05),
};
const chipHover: ViewStyle = { borderColor: colors.fieldBorder, backgroundColor: alpha(colors.text, 0.09) };

function Custom(props: { node: TextViewCustomNode; small: boolean }) {
  const n = props.node;
  const fs = props.small ? 12 : 13;
  if (n.name === "task") {
    const st = () => STATE_OF()[taskState(n.text!) ?? ""];
    return (
      <View role="link" testID={`task-chip-${n.text}`} accessibilityLabel={L(`Task ${n.text}`, `任务 ${n.text}`)} onPress={() => taskLink(n.text!)}
        hoverStyle={chipHover} style={{ ...chipFrame, paddingHorizontal: 7, borderRadius: 999 }}>
        <If when={st()}>
          <View style={{ cursor: "pointer", width: 6, height: 6, borderRadius: 3, backgroundColor: st()?.[1] ?? colors.muted }} />
        </If>
        <Text style={{ ...chipText, fontFamily: MONO, fontSize: fs, lineHeight: 16, color: colors.text }}>{n.text}</Text>
      </View>
    );
  }
  return (
    <View style={{ verticalAlign: "middle", height: 20, justifyContent: "center", marginHorizontal: 2, paddingHorizontal: 6, borderRadius: 5, backgroundColor: alpha(colors.text, 0.06) }}>
      <Text style={{ fontFamily: MONO, fontSize: fs, lineHeight: 16, color: colors.muted }}>{n.text}</Text>
    </View>
  );
}

// Invalidates pending Markdown reads when another selection or composer action wins.
let selectionGeneration = 0;

/** Selectable message Markdown; selection previews are owned by the composer. */
function Rich(props: { text: string; muted?: boolean; quiet?: boolean; context?: string; onQuote?: (markdown: string) => void }) {
  let documentRef: TextViewRef | undefined;
  let selectionVersion = 0;
  const captureSelection = async ({ text }: { text: string }) => {
    if (!props.onQuote || !text.trim()) return;
    const version = ++selectionVersion;
    const generation = ++selectionGeneration;
    // Publish immediately so a selection in another message replaces the preview.
    props.onQuote(text);
    try {
      const markdown = await documentRef?.selectedText({ format: "markdown" });
      if (version === selectionVersion && generation === selectionGeneration && markdown?.trim()) props.onQuote(markdown.trim());
    } catch { /* The plain-text selection remains available. */ }
  };
  cleanup(() => { selectionVersion++; });
  effect(() => { props.text; selectionVersion++; });
  const small = !!(props.muted || props.quiet);
  const fontSize = props.quiet ? 14 : props.muted ? size.small : size.text;
  const lineHeight = small ? 21 : size.line;
  const doc = () => {
    const d = TextView.parse(hubMarkdown(linkRepoRefs(props.text, props.context)), { math: false, html: false }, EXTENSIONS);
    return { ...d, blocks: ghBlocks(d.blocks) };
  };
  return (
    <View style={{ gap: 6 }}>
      <TextView
        ref={(ref) => { documentRef = ref; }}
        onSelectionChange={captureSelection}
        document={doc()}
        selectable
        onLinkPress={({ url }) => { if (/^(https?|mailto):/i.test(url)) void openUrl(url).catch(() => {}); }}
        renderCustom={(node) => <Custom node={node} small={small} />}
        styles={{
          root: { gap: 8, fontSize, lineHeight, color: small ? colors.muted : colors.text },
          code: { fontFamily: MONO, fontSize: small ? 13 : 14.5, color: colors.text, backgroundColor: alpha(colors.text, 0.07) },
          emphasis: { fontStyle: "normal", fontWeight: "600" },
          link: { color: linkColor(), textDecorationColor: token("link-underline") },
        }}
      />
    </View>
  );
}

/** Selection actions belong to the floating composer, outside the scrolling messages. */
function QuotePreview(props: { text: string; onQuote: () => void; onCancel: () => void }) {
  return <If when={props.text}>
    <View testID="quote-preview" style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 8, paddingVertical: 4, ...composerGlass(), borderRadius: radius.inset }}>
      <Button testID="quote-selection" accessibilityLabel={L("Quote selection", "引用片段")} onPress={() => { selectionGeneration++; props.onQuote(); }}
        style={{ flex: 1, minWidth: 0, minHeight: touch ? 44 : 32, justifyContent: "center", borderRadius: radius.control }} hoverStyle={hovered()} focusStyle={focusRing()}>
        <Text style={{ numberOfLines: 1, fontSize: size.small, color: colors.text }}>{props.text.replace(/\s+/g, " ").trim()}</Text>
      </Button>
      <Button testID="cancel-quote" accessibilityLabel={L("Cancel quote", "取消引用片段")} onPress={() => { selectionGeneration++; props.onCancel(); }}
        style={{ width: touch ? 44 : 32, height: touch ? 44 : 32, alignItems: "center", justifyContent: "center", borderRadius: radius.control }} hoverStyle={hovered()} focusStyle={focusRing()}>
        <Icon name="close" size={14} tint={colors.muted} />
      </Button>
    </View>
  </If>;
}

/** Puts an image (by URL) on the system clipboard as an image, not as its link. */
async function copyImage(src: string): Promise<void> {
  try {
    const r = await fetch(src);
    if (!r.ok) return;
    const bytes = new Uint8Array(await r.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const type = r.headers.get("content-type")?.split(";")[0] || "image/png";
    await Clipboard.writeImage(`data:${type};base64,${btoa(bin)}`);
  } catch {
    // nothing to show: the menu has closed and the clipboard keeps what it had
  }
}

function Media(props: { hub: Hub; path: string }) {
  const src = mediaUrl(props.hub.cfg.url, props.hub.cfg.token, props.path);
  const ratio = signal(16 / 10);
  const zoomed = signal(false);
  const frame: ViewStyle = { borderRadius: radius.inset, backgroundColor: colors.inset };
  if (isVideo(props.path)) return <Video src={src} controls paused style={{ ...frame, borderWidth: 1, borderColor: colors.border, width: "100%", maxWidth: 480, aspectRatio: 16 / 9 }} />;
  // a thumbnail that keeps the timeline readable; press it to see the full image
  const THUMB = 240;
  const size = () => (ratio() >= 1 ? { width: THUMB, height: THUMB / ratio() } : { width: THUMB * ratio(), height: THUMB });
  const gone = signal(false); // past the media retention (or otherwise unavailable)
  return (
    <If
      when={!gone()}
      else={
        <View testID="media-gone" style={{ ...frame, width: THUMB, height: 72, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ fontSize: 13.5, color: colors.faint }}>{L("Image expired", "图片已过期")}</Text>
        </View>
      }
    >
      {/* right-click (long press on touch) copies the image itself */}
      <ContextMenu
        margin={8}
        popupStyle={{ minWidth: 140, padding: 4, borderRadius: radius.control, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface }}
        trigger={
          <View accessibilityLabel={L("View full size", "查看大图")} onPress={() => zoomed.set(true)} style={{ cursor: "pointer" }}>
            <Image
              src={src}
              onLoad={({ size }) => size.width && size.height && ratio.set(size.width / size.height)}
              onError={() => gone.set(true)}
              style={{ ...frame, ...size(), objectFit: "cover" }}
            />
          </View>
        }
      >
        <MenuItem
          testID="copy-image"
          onSelect={() => void copyImage(src)}
          hoverStyle={hovered()}
          style={{ height: 32, justifyContent: "center", paddingHorizontal: 10, borderRadius: 6 }}
        >
          <Text style={{ fontSize: 14, color: colors.text }}>{L("Copy image", "复制图片")}</Text>
        </MenuItem>
      </ContextMenu>
      <Dialog
        open={zoomed()}
        animation="fade"
        onOpenChange={({ open }) => !open && zoomed.set(false)}
        backdropClass="bg-scrim"
        style={{ flex: 1, padding: 24, pointerEvents: "box-none" }}
      >
        <View accessibilityLabel={L("Close image", "关闭大图")} onPress={() => zoomed.set(false)} style={{ flex: 1, alignItems: "center", justifyContent: "center", cursor: "zoom-out" }}>
          <Image src={src} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
        </View>
      </Dialog>
    </If>
  );
}

// ---------------------------------------------------------------- timeline

/** Messages the hub just confirmed: a quiet check beside their timestamp fades away. */
const justSent = signal<Set<string>>(new Set());
const SENT_CHECK_MS = 1600;
function markSent(id: string | undefined) {
  if (!id) return;
  justSent.update((s) => new Set(s).add(id));
  setTimeout(() => justSent.update((s) => { const n = new Set(s); n.delete(id); return n; }), SENT_CHECK_MS);
}

/** Delivery feedback shares the timestamp’s visual weight, without a badge or bounce. */
function SentCheck() {
  const still = reduceMotion();
  const fade = createAnimatedValue(still ? 1 : 0);
  if (!still) fade.timing(1, { duration: 150, easing: "easeOut" });
  const t = setTimeout(() => fade.timing(0, { duration: still ? 0 : 300, easing: "easeOut" }), SENT_CHECK_MS - 320);
  cleanup(() => clearTimeout(t));
  return (
    <View
      testID="sent-check"
      accessibilityLabel={L("Sent", "已发送")}
      style={{ width: 14, height: 16, alignItems: "center", justifyContent: "center", opacity: fade }}
    >
      <CheckMark size={14} weight={1.8} tint={colors.muted} />
    </View>
  );
}

/** A message the owner sent that the hub has not confirmed yet: it reads as sent unless delivery fails. */
type Outgoing = { id: string; ts: string; text: string; ref: string | null; files: Attachment[]; state: "held" | "sending" | "failed"; channel?: string };

/** Each agent's own color and mark, the same everywhere it appears (stable by its id). */
const MARKS = ["★", "◆", "▲", "●", "✦", "☾", "✿", "♪"];
/** From this window width on, the app lays out for a desktop or tablet rather than a phone. */
const WIDE = 860;

function persona(from: string): { tint: string; mark: string } {
  const id = from.split("@")[0].toLowerCase();
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { tint: token(`agent-${(h % 8) + 1}` as "agent-1"), mark: MARKS[(h >>> 3) % MARKS.length] };
}

function Avatar(props: { from: string; small?: boolean; testID?: string }) {
  const hubbed = isHub(props.from);
  const p = persona(props.from);
  const box = props.small ? 22 : 36;
  return (
    <View
      testID={props.testID}
      accessibilityLabel={displayName(props.from)}
      style={{
        width: box,
        height: box,
        borderRadius: box / 2,
        flexShrink: 0,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: hubbed ? colors.raised : alpha(p.tint, 0.16),
      }}
    >
      <If when={hubbed} else={
        <If when={avatarOf(props.from) !== null} else={<>
          <Text style={{ fontSize: props.small ? 12 : 16, fontWeight: "700", color: p.tint }}>{displayName(props.from).slice(0, 1).toUpperCase()}</Text>
          <If when={!props.small}>
            <View style={{ position: "absolute", right: -3, bottom: -3, width: 17, height: 17, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: colors.background }}>
              <Text style={{ fontSize: 10, lineHeight: 12, color: p.tint }}>{p.mark}</Text>
            </View>
          </If>
        </>}>
          <Image src={avatarOf(props.from) ?? ""} style={{ width: box, height: box, borderRadius: box / 2 }} />
        </If>
      }>
        <View style={{ width: props.small ? 8 : 12, height: props.small ? 8 : 12, borderRadius: 6, backgroundColor: colors.muted }} />
      </If>
    </View>
  );
}

/** The label of an option button: the option's own text when the hub gives one ("B: 升级"). */
function optionText(e: HubEvent, c: string): string {
  if (c === "all" || c === "none") return choiceLabel(c);
  const full = (e.options ?? []).find((o) => new RegExp(`^\\s*${c}\\s*([:：.、)]|\\s)`).test(o));
  // a button can't hold a link: a GitHub PR / issue URL reads as "nsh#747"
  return full ? full.trim().replace(/https:\/\/github\.com\/[\w.-]+\/([\w.-]+)\/(?:pull|issues)\/(\d+)\/?/g, "$1#$2") : choiceLabel(c);
}

type Proposal = { n: string; title: string; agent: string; note: string };
/** The items of an approval batch, from either message format ("1. [agent] title (source)" or "1. 标题（agent）"). */
function proposalsOf(text: string): Proposal[] {
  const out: Proposal[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\\\s*$/, "").replace(/\*\*/g, "").trim();
    const m = line.match(/^(\d+)[.、]\s*(.+)$/);
    if (!m) continue;
    let rest = m[2], agent = "", note = "";
    const a = rest.match(/^\[([\w-]+)\]\s*/);
    if (a) { agent = a[1]; rest = rest.slice(a[0].length); }
    const src = rest.match(/\s*[(（]((?:routine|followup|approved)[^)）]*)[)）]\s*$/);
    if (src) {
      rest = rest.slice(0, src.index);
      const [kind, ref] = src[1].split(":");
      note = kind === "routine" ? L("Routines", "例行任务") : kind === "followup" && ref ? L(`Follow-up to ${ref}`, `接着 ${ref}`) : "";
    }
    const who = rest.match(/\s*[(（]([\w-]+)[)）]\s*$/);
    if (!agent && who) { agent = who[1]; rest = rest.slice(0, who.index); }
    rest = rest.replace(/\s*·\s*\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}\s*$/, "").trim();
    out.push({ n: m[1], title: rest, agent, note });
  }
  return out;
}

/** An approval batch as a checklist: tick what may start, then approve. */
function ProposalList(props: { event: HubEvent; selection: Map<string, Signal<Set<string>>>; done: boolean; onAnswer: (ref: string, choice: string) => void; onReply: (ref: string) => void }) {
  const e = props.event;
  const items = proposalsOf(e.text);
  let picked = props.selection.get(e.id);
  if (!picked) { picked = signal<Set<string>>(new Set()); props.selection.set(e.id, picked); }
  const selection = picked;
  const toggle = (n: string) => selection.update((s) => { const x = new Set(s); x.has(n) ? x.delete(n) : x.add(n); return x; });
  const answer = (c: string) => props.onAnswer(e.ref!, c);
  return (
    <>
      <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 6 }}>
        <Text style={{ fontSize: size.small, color: colors.muted }}>{L(`The team wants to do ${items.length} things. Check the ones to start:`, `团队想做这 ${items.length} 件事，勾选同意开始的：`)}</Text>
      </View>
      <View style={{ paddingHorizontal: 8, paddingBottom: 8 }}>
        <Each of={items}>
          {(it) => {
            const on = () => selection().has(it().n);
            return (
              <View
                role="checkbox"
                accessibilityState={{ checked: on() }}
                accessibilityLabel={it().title}
                testID={`proposal-${e.ref}-${it().n}`}
                onPress={props.done ? undefined : () => toggle(it().n)}
                hoverStyle={props.done ? undefined : { backgroundColor: alpha(colors.text, 0.04) }}
                style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 8, paddingVertical: 8, borderRadius: 8, cursor: props.done ? "default" : "pointer" }}
              >
                <View style={{ width: 20, height: 20, borderRadius: 6, borderWidth: on() ? 0 : 1.5, borderColor: colors.fieldBorder, backgroundColor: on() ? colors.accentFill : "transparent", alignItems: "center", justifyContent: "center" }}>
                  <If when={on()}><Icon name="check" size={14} tint={colors.onAccent} /></If>
                </View>
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <Text style={{ numberOfLines: 2, fontSize: size.text, lineHeight: 22, color: colors.text, cursor: "pointer" }}>{it().title}</Text>
                  <Text style={{ fontSize: size.tiny, color: colors.faint, cursor: "pointer" }}>{[it().agent && displayName(it().agent), it().note].filter(Boolean).join(" · ")}</Text>
                </View>
              </View>
            );
          }}
        </Each>
      </View>
      <If when={!props.done}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingTop: 2, paddingBottom: 16 }}>
          <Btn testID={`approve-${e.ref}`} label={selection().size ? L(`Approve selected (${selection().size})`, `批准所选（${selection().size}）`) : L("Approve selected", "批准所选")} kind="primary" disabled={!selection().size}
            onPress={() => answer([...selection()].sort((a, b) => +a - +b).join(","))} />
          <Btn testID={`opt-${e.ref}-all`} label={L("Approve all", "全部批准")} kind="secondary" onPress={() => answer("all")} />
          <Btn testID={`opt-${e.ref}-none`} label={L("None", "都不要")} kind="ghost" onPress={() => answer("none")} />
          <View style={{ flex: 1 }} />
          <Btn testID={`other-${e.ref}`} label={L("Other instructions…", "其他指示…")} kind="dashed" onPress={() => props.onReply(e.ref!)} />
        </View>
      </If>
    </>
  );
}

/** An answer to a card, as plain words: "P-0002 6,7,8" → "批准 6、7、8". */
/** The answer that sets a question aside (the hub's decisions.IGNORE). */
const IGNORE = "忽略";

/** How long a sent answer can still be edited (mirrors AMEND_MS in src/server.ts; the hub is the real gate). */
const AMEND_MS = 5 * 60_000;

function answerText(t: string): string {
  const [, ref, rest] = t.match(/^([DLP]-[A-Z]?\d{4}) (.+)$/) ?? [, "", t];
  const a = rest.trim();
  if (ref.startsWith("P-")) {
    if (/^(all|全部)$/i.test(a)) return L("Approve all", "全部批准");
    if (/^(none|都不要)$/i.test(a)) return L("None", "都不要");
    if (/^\d+(\s*[,，]\s*\d+)*$/.test(a)) { const items = a.split(/\s*[,，]\s*/); return L(`Approve ${items.join(", ")}`, `批准 ${items.join("、")}`); }
  }
  return a === IGNORE ? L("Ignored", "忽略") : L(`Chose ${a}`, `选 ${a}`);
}

/** The first line of a card's text, as plain words: what an answer replies to. */
function askLine(text: string): string {
  return (text.split("\n").find((l) => l.trim()) ?? "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*`_]/g, "").replace(/\\$/, "").trim();
}

/** A message's quick actions under it (like ChatGPT's): copy its text, reply to what it is about. Shown on hover
 * on a desktop, always on a phone (no hover there). */
function MsgActions(props: { text: string; show: () => boolean; onReply?: () => void; align?: "flex-start" | "flex-end"; id: string; unread?: () => boolean; onToggleRead?: () => void }) {
  const copied = signal(false);
  let t: ReturnType<typeof setTimeout> | undefined;
  cleanup(() => clearTimeout(t));
  const copy = () => {
    void Clipboard.writeText(props.text.trim()).then(() => {
      copied.set(true);
      clearTimeout(t);
      t = setTimeout(() => copied.set(false), 1500);
    }, () => {});
  };
  const btn = () => ({ width: touch ? 44 : 32, height: touch ? 44 : 32, borderRadius: radius.control, borderCurve: "continuous" as const, alignItems: "center" as const, justifyContent: "center" as const, cursor: "pointer" as const });
  return (
    <View style={{ flexDirection: "row", alignSelf: props.align ?? "flex-start", gap: 2, height: touch ? 44 : 32, marginLeft: props.align === "flex-end" ? 0 : -6, opacity: props.show() || copied() ? 1 : 0, transitionProperty: "opacity", transitionDuration: 120 }}>
      <View role="button" testID={`copy-${props.id}`} accessibilityLabel={copied() ? L("Copied", "已复制") : L("Copy", "复制")} onPress={copy} hoverStyle={hovered()} style={btn()}>
        <Icon name={copied() ? "check" : "copy"} size={18} tint={colors.muted} />
      </View>
      <If when={props.onReply}>
        <View role="button" testID={`reply-${props.id}`} accessibilityLabel={L("Reply", "回复")} onPress={() => props.onReply?.()} hoverStyle={hovered()} style={btn()}>
          <Icon name="reply" size={18} tint={colors.muted} />
        </View>
      </If>
      <If when={props.onToggleRead}>
        <View role="button" testID={`toggle-read-${props.id}`} accessibilityLabel={props.unread?.() ? L("Mark as read", "标为已读") : L("Mark as unread", "标为未读")} onPress={() => props.onToggleRead?.()} hoverStyle={hovered()} style={{ ...btn(), width: undefined, paddingHorizontal: 8 }}>
          <Text style={{ fontSize: size.tiny, fontWeight: "600", color: colors.muted }}>{props.unread?.() ? L("Mark read", "标为已读") : L("Mark unread", "标为未读")}</Text>
        </View>
      </If>
    </View>
  );
}

function OwnerBubble(props: { hub: Hub; event: HubEvent; out?: Outgoing; onRetry?: () => void; onRecall?: () => void; onRef?: (ref: string) => void }) {
  const e = props.event;
  // an answer sent from the sidebar or a card ("D-0015 忽略") names its card in the text, not in `ref`
  const ref = e.ref ?? e.text.match(/^([DLP]-[A-Z]?\d{4}) \S/)?.[1];
  const over = signal(false);
  // a reply to an agent's message about a task quotes that message (the last one about it before this)
  const said = () => [...props.hub.events()].reverse().find((x) => x.ref === ref && x.ts <= e.ts && x.kind !== "owner" && !isHub(x.from));
  const asked = () => (ref ? askLine(props.hub.events().find((x) => x.ref === ref && isAsk(x))?.text ?? "") || (props.hub.status()?.decisions.find((d) => d.id === ref)?.question ?? "")
    || (/^T-/.test(ref) && said() ? `${displayName(said()!.from)}${L(": ", "：")}${firstLine(said()!.text)}` : "") : "");
  // "选 A" alone says little: the option's own words go under it, without the "A:" it already shows
  const chosen = () => {
    const card = ref && props.hub.events().find((x) => x.ref === ref && isAsk(x));
    const a = e.text.match(/^[DLP]-[A-Z]?\d{4} (\S+)$/)?.[1];
    if (!card || !a || !(card.options ?? []).length) return "";
    const t = optionText(card, a);
    return t === choiceLabel(a) ? "" : t.replace(new RegExp(`^\\s*${a}\\s*[:：.、)]?\\s*`, "i"), "");
  };
  return (
    <View style={{ flexDirection: "row", justifyContent: "flex-end", paddingVertical: 8 }} onMouseEnter={() => over.set(true)} onMouseLeave={() => over.set(false)}>
      <View style={{ maxWidth: "82%", alignItems: "flex-end", gap: 4 }}>
        {/* what this answers, quoted above the bubble (press: back to the card) */}
        <If when={ref}>
          <View
            role="link"
            testID={`reply-to-${ref}`}
            onPress={() => props.onRef?.(ref!)}
            hoverStyle={{ opacity: 1 }}
            style={{ cursor: "pointer", opacity: 0.85, flexDirection: "row", alignItems: "center", gap: 6, maxWidth: "100%", paddingLeft: 8, paddingRight: 4, borderLeftWidth: 2, borderLeftColor: colors.fieldBorder }}
          >
            <Text style={{ ...chipText, fontFamily: MONO, fontSize: 12, color: colors.muted }}>{ref}</Text>
            <If when={asked()}>
              <Text style={{ ...chipText, flexShrink: 1, numberOfLines: 1, fontSize: 13, color: colors.faint }}>{asked()}</Text>
            </If>
          </View>
        </If>
        <If when={e.attachments?.length}>
          <View testID="owner-images" style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", alignItems: "flex-end", gap: 6, opacity: props.out ? 0.65 : 1 }}>
            <Each of={e.attachments ?? []}>{(a) => <Media hub={props.hub} path={a()} />}</Each>
          </View>
        </If>
        <If when={e.text.trim() || e.ref}>
        <View
          style={{
            paddingHorizontal: 16,
            paddingVertical: 11,
            borderRadius: 18,
            borderBottomRightRadius: 6,
            backgroundColor: tints.accent,
            gap: 4,
          }}
        >
          {/^[DLP]-[A-Z]?\d{4} \S/.test(e.text) && !e.text.includes("\n")
            ? <>
                <Text style={{ fontSize: size.text, lineHeight: size.line, fontWeight: "600", color: colors.text, userSelect: "text" }}>{answerText(e.text)}</Text>
                <If when={chosen()}>
                  <Text testID={`answer-option-${ref}`} style={{ fontSize: size.small, lineHeight: 20, color: colors.muted, userSelect: "text" }}>{chosen()}</Text>
                </If>
              </>
            : <Rich text={e.text} />}
        </View>
        </If>
        <If
          when={props.out?.state === "failed"}
          else={
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <If when={e.text.trim()}>
                <MsgActions id={e.id} text={/^[DLP]-[A-Z]?\d{4} \S/.test(e.text) && !e.text.includes("\n") ? answerText(e.text) : e.text} show={() => touch || over()} align="flex-end" />
              </If>
              {/* only while it can still be taken back; the row keeps its height when this goes */}
              <If when={props.out?.state === "held"}>
                <View role="button" testID="recall-send" accessibilityLabel={L("Undo", "撤回")} onPress={() => props.onRecall?.()} hoverStyle={hovered()} style={{ height: 28, paddingHorizontal: 6, borderRadius: 6, justifyContent: "center", cursor: "pointer" }}>
                  <Text style={{ fontSize: size.tiny, fontWeight: "600", color: colors.muted }}>{L("Undo", "撤回")}</Text>
                </View>
              </If>
              {/* Reserve the mark’s space so delivery feedback never moves the footer. */}
              <View style={{ width: 14, height: 16 }}>
                <If when={justSent().has(e.id)}><SentCheck /></If>
              </View>
              <Text style={{ fontSize: size.tiny, color: colors.faint }}>{timeOf(e.ts)}</Text>
            </View>
          }
        >
          <View role="button" onPress={props.onRetry} accessibilityLabel={L("Retry sending", "重试发送")} style={{ flexDirection: "row", gap: 6 }}>
            <Text style={{ fontSize: size.tiny, color: colors.danger }}>{L("Couldn’t send", "发送失败")}</Text>
            <Text style={{ fontSize: size.tiny, fontWeight: "600", color: colors.danger }}>{L("Retry", "重试")}</Text>
          </View>
        </If>
      </View>
    </View>
  );
}

function Message(props: {
  hub: Hub;
  event: HubEvent;
  answered: () => Set<string>;
  /** The pending ask the keyboard acts on. */
  target: () => string | null;
  onAnswer: (ref: string, choice: string) => void;
  onReply: (ref: string, note?: string) => void;
  onQuote?: (markdown: string, ref?: string) => void;
  selection?: Map<string, Signal<Set<string>>>;
  /** Unread on this device; the dot by the name and the action under the message. */
  unread?: () => boolean;
  onToggleRead?: () => void;
}) {
  const e = props.event;
  const selection = props.selection ?? new Map<string, Signal<Set<string>>>();
  const ask = isAsk(e);
  // an agent's message about a task can be replied to: the reply goes to that task
  const replyable = !ask && !isHub(e.from) && !!e.ref && /^T-\d{4,}$/.test(e.ref);
  const over = signal(false);
  const tag = TAGS()[e.kind];
  // what the message is about, for its bare "#746": the card's options, the task's title, the thread it belongs to
  const about = () => {
    if (!e.ref) return (e.options ?? []).join("\n");
    const s = props.hub.status();
    const task = [...(s?.active ?? []), ...(s?.recent ?? [])].find((t) => t.id === e.ref);
    return [...(e.options ?? []), task?.title ?? "", ...props.hub.events().filter((x) => x.ref === e.ref && x.id !== e.id).map((x) => x.text)].join("\n");
  };
  const body = (
    <View style={{ gap: 10 }}>
      <Rich text={ask ? e.text.replace(/\n*^建议：.*$/m, "").trimEnd() : e.text} muted={e.kind === "system" && isHub(e.from)} context={about()} onQuote={props.onQuote ? (markdown) => props.onQuote?.(markdown, e.ref) : undefined} />
      <If when={e.attachments?.length}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", gap: 10 }}>
          <Each of={e.attachments ?? []}>{(a) => <Media hub={props.hub} path={a()} />}</Each>
        </View>
      </If>
    </View>
  );
  const done = () => !!e.ref && props.answered().has(e.ref);
  const picked = () => (e.ref && done() ? answerOf(props.hub.events(), e.ref) : null);
  /** The card was answered and the amend window is open: the reply box edits the answer (the hub requeues the task). */
  const amendable = () => {
    if (!done() || !e.ref) return false;
    const st = resolvedStateOf(props.hub.events(), e.ref);
    if (st && st !== "answered") return false; // ignored / snoozed cards have no answer to amend
    const t = resolvedTsOf(props.hub.events(), e.ref);
    return !!t && Date.now() - Date.parse(t) < AMEND_MS;
  };
  /** A gated option (merge / release / deploy) confirms first: the tap is an instruction, not a missed scroll. */
  const answerCard = (ref: string, c: string) => {
    if (!isRisky(e, c)) return props.onAnswer(ref, c);
    void AlertDialog.show({
      title: L(`Confirm ${ref}: ${optionText(e, c)}?`, `确认 ${ref}：${optionText(e, c)}？`),
      description: L("This is hard to undo (merge, release, deploy) and the team acts on it right away.", "这类操作不易回退（合并、发布、部署），团队会立刻执行。"),
      actions: [{ id: "back", label: L("Back", "再想想"), role: "cancel" }, { id: "go", label: L("Confirm", "确认执行") }],
    }).then((r) => r.action === "go" && props.onAnswer(ref, c));
  };
  const targeted = () => ask && !done() && props.target() === e.ref;
  const rec = recommended(e);
  // a phone has no width to spare: the avatar sits in the name's row, and the message takes the whole column
  const wide = () => windowSize().width >= WIDE;
  // the hub's own receipts ("✅ D-0012 已答") are lines in the log, not conversation
  if (isHub(e.from) && !ask && !e.attachments?.length && (e.kind === "system" || e.kind === "resolved"))
    return (
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, paddingVertical: 4, paddingLeft: wide() ? 50 : 0 }}>
        <Text style={{ fontSize: size.tiny, color: colors.faint, fontVariant: ["tabular-nums"] }}>{timeOf(e.ts)}</Text>
        <View selectable style={{ flex: 1, minWidth: 0 }}><Rich text={e.text} quiet /></View>
      </View>
    );
  return (
    <View style={{ flexDirection: "row", gap: 14, paddingVertical: 10 }} onMouseEnter={() => over.set(true)} onMouseLeave={() => over.set(false)}>
      <If when={wide()}><View style={{ position: "relative", alignSelf: "flex-start" }}><Avatar testID={`avatar-column-${e.id}`} from={e.from} /><If when={props.unread?.()}><View testID={`unread-dot-${e.id}`} accessibilityLabel={L("Unread", "未读")} style={{ position: "absolute", top: -2, right: -2, width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderColor: colors.background, backgroundColor: colors.info }} /></If></View></If>
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 22 }}>
          <If when={!wide()}><View style={{ position: "relative" }}><Avatar testID={`avatar-inline-${e.id}`} from={e.from} small /><If when={props.unread?.()}><View testID={`unread-dot-${e.id}`} accessibilityLabel={L("Unread", "未读")} style={{ position: "absolute", top: -2, right: -2, width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderColor: colors.background, backgroundColor: colors.info }} /></If></View></If>
          <Text style={{ fontSize: 15, fontWeight: "600", color: colors.text }}>{displayName(e.from)}</Text>
          <Text style={{ fontSize: size.tiny, color: colors.faint, fontVariant: ["tabular-nums"] }}>{timeOf(e.ts)}</Text>
          {tag && !ask ? <Badge label={tag} /> : null}
        </View>
        {ask ? (
          <View
            style={{
              marginTop: 6,
              borderRadius: radius.card,
              backgroundColor: colors.surface,
              opacity: 1,
              overflow: "hidden",
              transitionProperty: "opacity",
              transitionDuration: 160,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingTop: 12 }}>
              <Badge label={tag ?? L("Needs you", "需要你")} tone={done() ? "neutral" : "warn"} />
              <Text style={{ fontFamily: MONO, fontSize: 13, color: colors.muted }}>{e.ref}</Text>
              <View style={{ flex: 1 }} />
              <If when={done()}>
                <View testID={`replied-${e.ref}`} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                  <Icon name="check" size={14} tint={colors.up} />
                  <Text style={{ fontSize: 13, color: colors.up }}>{L("Replied", "已回复")}</Text>
                </View>
              </If>
            </View>
            {e.kind === "proposals" && proposalsOf(e.text).length ? (
              <ProposalList event={e} selection={selection} done={done()} onAnswer={props.onAnswer} onReply={props.onReply} />
            ) : (
            <>
            <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 14 }}>{body}</View>
            {/* one option per line: options are sentences, side by side they read as a jumble */}
            <View style={{ alignItems: "flex-start", gap: 8, paddingHorizontal: 16, paddingTop: 2, paddingBottom: 16 }}>
              <Each of={choicesOf(e).slice(0, 12)}>
                {(c, i) => (
                  <Btn
                    testID={`opt-${e.ref}-${c()}`}
                    label={optionText(e, c())}
                    kind="secondary"
                    note={rec === c() ? L("Recommended", "推荐") : undefined}
                    disabled={done()}
                    checked={done() && picked()?.toUpperCase() === c().toUpperCase()}
                    onPress={() => answerCard(e.ref!, c())}
                  />
                )}
              </Each>
              {/* answered: the card is a record, not a second chance to send; a free-text answer shows as it was sent */}
              <If when={done() && picked() && !choicesOf(e).some((c) => c.toUpperCase() === picked()!.toUpperCase())}>
                <Text testID={`answer-${e.ref}`} style={{ fontSize: size.small, color: colors.muted }}>{L(`Your reply: ${answerText(`${e.ref} ${picked()}`)}`, `你的回复：${answerText(`${e.ref} ${picked()}`)}`)}</Text>
              </If>
              <If when={!done()}>
                <Btn testID={`other-${e.ref}`} label={L("Other instructions…", "其他指示…")} kind="dashed" onPress={() => props.onReply(e.ref!)} />
              </If>
              <If when={e.ref!.startsWith("D-") && !done()}>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  <Btn testID={`snooze-${e.ref}`} label={L("Later", "稍后")} kind="dashed" onPress={() => props.onAnswer(e.ref!, "稍后")} />
                  <Btn testID={`ignore-${e.ref}`} label={L("Ignore", "忽略")} kind="dashed" note={L("not a rejection", "不算拒绝")}
                    accessibilityLabel={L("Ignore — the agent decides and continues; this is not a rejection", "忽略——agent 自行决定并继续，不算拒绝")}
                    onPress={() => props.onAnswer(e.ref!, IGNORE)} />
                </View>
              </If>
              <If when={amendable()}>
                <Btn testID={`amend-${e.ref}`} label={L("Change answer", "修改")} kind="dashed" onPress={() => props.onReply(e.ref!)} />
              </If>
            </View>
            </>
            )}
          </View>
        ) : (
          body
        )}
        <If when={e.text.trim()}>
          <MsgActions id={e.id} text={e.text} show={() => touch || over() || !!props.unread?.()} unread={props.unread} onToggleRead={props.onToggleRead} onReply={e.ref && !(ask && !done()) ? () => props.onReply(e.ref!, replyable ? firstLine(e.text) : undefined) : undefined} />
        </If>
      </View>
    </View>
  );
}

/** A task's state as the sidebar's dot: only what needs attention gets a color. */
const TONE: Record<string, "on" | "run" | "queue" | "wait" | "off" | "bad"> = { active: "run", blocked: "wait", failed: "bad", done: "off", inbox: "queue", waiting: "wait", nohost: "wait", parked: "wait" };

/** A task's state: its label, color and mark. */
const STATE_OF = (): Record<string, [string, string, string]> => ({
  active: [L("In progress", "进行中"), colors.up, "●"], inbox: [L("Queued", "排队中"), colors.info, "○"], waiting: [L("Waiting on subtasks", "等子任务"), colors.warn, "○"], nohost: [L("Waiting for a machine", "等机器"), colors.warn, "○"], parked: [L("Waiting on external result", "等外部结果"), colors.warn, "○"],
  blocked: [L("Needs your decision", "等你决定"), colors.warn, "!"], failed: [L("Failed", "失败"), colors.danger, "✕"], done: [L("Done", "完成"), colors.faint, "✓"], cancelled: [L("Cancelled", "已取消"), colors.faint, "✕"],
});

/** A progress step's icon and color. */
const STEP_OF = (): Record<string, [IconName, string]> => ({
  chat: ["chat", colors.muted], start: ["play", colors.info], done: ["check", colors.up], fail: ["close", colors.danger],
  decision: ["pause", colors.warn], retry: ["replace", colors.muted], followup: ["plus", colors.muted],
  delegated: ["layers", colors.info], judge: ["sliders", colors.muted], edit: ["document", colors.muted],
});

/** "11-02 16:34", or "16:34" today. */
function clock(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  const today = new Date().toDateString() === d.toDateString();
  return `${today ? "" : `${p(d.getMonth() + 1)}-${p(d.getDate())} `}${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** "3 分钟" since an ISO time (to now, or to `end`). */
function since(iso?: string, end?: string): string {
  if (!iso) return "";
  const m = Math.max(0, Math.round(((end ? Date.parse(end) : Date.now()) - Date.parse(iso)) / 60000));
  return m < 1 ? L("just now", "刚刚") : m < 60 ? L(`${m} min`, `${m} 分钟`) : m < 1440 ? L(`${Math.floor(m / 60)} h`, `${Math.floor(m / 60)} 小时`) : L(`${Math.floor(m / 1440)} d`, `${Math.floor(m / 1440)} 天`);
}

const HISTORY_PAGE = 50;

/** One event read record, shared by all views on this device. The old chat watermark migrates once. */
function createMessageReads(hub: Hub) {
  const state = signal<ReadState>({ through: "", ids: [], marked: [] });
  const loaded = signal(false);
  const key = `hub.read:${hub.cfg.url}`;
  let saving = Promise.resolve();
  Promise.all([Storage.getItem(key), Storage.getItem(KEYS.seen), Storage.getItem("hub.markedUnread")]).then(([raw, old, marked]) => {
    let next: ReadState = { through: old ?? "", ids: [], marked: [] };
    try { const marks = JSON.parse(marked ?? "[]"); if (Array.isArray(marks)) next.marked = marks.filter((v: unknown) => typeof v === "string"); } catch {}
    try { const j = JSON.parse(raw ?? "null"); if (j && typeof j.through === "string" && Array.isArray(j.ids)) next = { through: j.through, ids: j.ids.filter((id: unknown) => typeof id === "string"), marked: Array.isArray(j.marked) ? j.marked.filter((v: unknown) => typeof v === "string") : next.marked }; } catch {}
    state.set(next); loaded.set(true);
  });
  const persist = (next: ReadState) => { state.set(next); saving = saving.then(async () => { await Storage.setItem(key, JSON.stringify(next)); await Storage.setItem("hub.markedUnread", JSON.stringify(next.marked ?? [])); }).catch(() => {}); };
  const read = (events: HubEvent[], explicit = false) => {
    if (!untracked(loaded)) return;
    const old = untracked(state);
    const marks = explicit ? (old.marked ?? []).filter((id) => !events.some((e) => e.id === id)) : old.marked;
    const base = marks?.length !== old.marked?.length ? { ...old, marked: marks } : old;
    const next = markRead(base, events);
    if (next !== old) persist(next);
  };
  const unread = computed(() => loaded() ? unreadEvents(hub.events(), state()) : []);
  // the main chat's own: what was said inside a channel is counted on that channel only
  const main = computed(() => unread().filter((e) => !e.channel));
  return { loaded, state, read, unread, main,
    ref: (id: string) => read(untracked(hub.events).filter((e) => e.ref === id), true),
    toggle: (e: HubEvent) => persist(toggleMessageRead(untracked(state), e)),
    all: () => persist({ through: untracked(hub.events).reduce((ts, e) => e.ts > ts ? e.ts : ts, untracked(state).through), ids: [], marked: [] }),
  };
}
type MessageReads = ReturnType<typeof createMessageReads>;

/** Channel snapshots refresh from pushed task/channel revisions, never on a timer. */
function createChannels(hub: Hub, reads: MessageReads) {
  const list = signal<Channel[]>([]);
  let generation = 0;
  const load = async () => {
    const mine = ++generation;
    const r = await hub.api("GET", "/api/channels").catch(() => null);
    if (mine === generation && r?.ok && Array.isArray(r.data.channels)) list.set(sortChannels(r.data.channels as Channel[]));
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let revision = "";
  effect(() => {
    const st = hub.status();
    const next = JSON.stringify([st?.channels_revision, st?.tasks, st?.decisions, st?.recent?.map((t) => [t.id, t.updated])]);
    if (next === revision) return;
    revision = next;
    clearTimeout(timer); timer = setTimeout(() => void load(), 150);
  });
  cleanup(() => { clearTimeout(timer); generation++; });
  return {
    list, load, reads,
    unread: (c: Channel) => {
      const refs = new Set(c.refs ?? c.items.filter((i) => i.kind !== "report").map((i) => i.id));
      return reads.unread().filter((e) => (e.channel ? e.channel === c.slug : !!e.ref && refs.has(e.ref))).length;
    },
    async save(slug: string, patch: { name?: string; goal?: string; archived?: boolean }) {
      generation++;
      const r = await hub.api("POST", "/api/channels", { slug, ...patch });
      if (r.ok) list.set(sortChannels(untracked(list).map((c) => (c.slug === slug ? { ...c, ...(patch.name ? { name: patch.name } : {}), ...(patch.goal !== undefined ? { goal: patch.goal } : {}), ...(patch.archived !== undefined ? { status: patch.archived ? "archived" : "active" } : {}) } : c))));
      return r.ok;
    },
  };
}
type Channels = ReturnType<typeof createChannels>;

/** One channel: its goal (editable), archive, and the tasks and cards that belong to it, newest first. */
/** A channel's head above its conversation: name and purpose together, actions out of the way. The conversation itself is the main chat's. */
function ChannelHeader(props: { channels: Channels; slug: string }) {
  const ch = () => props.channels.list().find((c) => c.slug === props.slug);
  const editing = signal(false);
  const goal = signal("");
  const name = signal("");
  const busy = signal(false);
  const saveGoal = async () => {
    busy.set(true);
    const n = untracked(name).trim(), g = untracked(goal).trim(), c = ch()!;
    const patch = { ...(n && n !== c.name ? { name: n } : {}), ...(g !== c.goal ? { goal: g } : {}) };
    if (!Object.keys(patch).length || (await props.channels.save(props.slug, patch))) editing.set(false);
    busy.set(false);
  };
  return (
    <View testID="channel-page" style={{ paddingTop: 8, paddingBottom: 12 }}>
        <If when={ch()} else={<Text style={{ fontSize: 14, color: colors.faint }}>{L("Loading…", "读取中…")}</Text>}>
          {/* header: a channel reads like a room, name and purpose together, actions out of the way */}
          <View testID="channel-header" style={{ flexDirection: "row", alignItems: "flex-start", gap: 14, paddingBottom: 8 }}>
            <View style={{ width: 44, height: 44, borderRadius: radius.card, alignItems: "center", justifyContent: "center", backgroundColor: alpha(colors.accent, 0.12) }}>
              <Text style={{ fontSize: 22, fontWeight: "700", color: colors.accent }}>#</Text>
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={{ flexShrink: 1, fontSize: 20, fontWeight: "700", color: colors.text, numberOfLines: 1 }}>{ch()!.name}</Text>
                <If when={ch()!.status === "archived"}><View testID="channel-archived"><Badge label={L("Archived", "已归档")} tone="warn" /></View></If>
                <If when={ch()!.status === "active" && ch()!.stale}><View testID="channel-stale"><Badge label={L("Quiet 7 days", "7 天无动静")} /></View></If>
              </View>
              <If when={editing()} else={
                <Text testID="channel-goal" style={{ fontSize: 14.5, lineHeight: 21, color: ch()!.goal ? colors.muted : colors.faint, userSelect: "text" }}>{ch()!.goal || L("No goal yet", "还没有目标")}</Text>
              }>
                <View style={{ gap: 8, paddingTop: 4 }}>
                  <Input
                    testID="channel-name-input"
                    value={name()}
                    onChange={({ value }) => name.set(value)}
                    onSubmit={() => void saveGoal()}
                    placeholder={L("Channel name", "Channel 名称")}
                    class="placeholder:text-faint"
                    style={{ height: 38, paddingHorizontal: 12, fontSize: 15, fontWeight: "600", color: colors.text, borderRadius: radius.control, borderWidth: 1, borderColor: colors.fieldBorder, backgroundColor: colors.surface }}
                  />
                  <Input
                    testID="channel-goal-input"
                    value={goal()}
                    onChange={({ value }) => goal.set(value)}
                    onSubmit={() => void saveGoal()}
                    placeholder={L("What this channel is for: the team assigns work by it", "这个 channel 是做什么的，团队按它归类工作")}
                    class="placeholder:text-faint"
                    style={{ height: 38, paddingHorizontal: 12, fontSize: 15, color: colors.text, borderRadius: radius.control, borderWidth: 1, borderColor: colors.fieldBorder, backgroundColor: colors.surface }}
                  />
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <Btn testID="channel-save-goal" kind="primary" label={L("Save", "保存")} disabled={busy()} onPress={() => void saveGoal()} />
                    <Btn testID="channel-cancel-goal" kind="ghost" label={L("Cancel", "取消")} onPress={() => editing.set(false)} />
                  </View>
                </View>
              </If>
            </View>
            <View style={{ flexDirection: "row", gap: 4 }}>
              <If when={!editing()}>
                <Btn testID="channel-edit-goal" kind="ghost" label={L("Edit", "编辑")} onPress={() => { name.set(ch()!.name); goal.set(ch()!.goal); editing.set(true); }} />
              </If>
              <Btn testID="channel-archive" kind="ghost" label={ch()!.status === "archived" ? L("Unarchive", "取消归档") : L("Archive", "归档")}
                onPress={() => void props.channels.save(props.slug, { archived: ch()!.status !== "archived" })} />
            </View>
          </View>
        </If>
    </View>
  );
}

/** 全部任务: every task the team has, newest first, a page at a time. */
function TaskHistory(props: { hub: Hub; wide: boolean; onTask: (id: string) => void }) {
  const tasks = signal<TaskInfo[]>([]);
  const total = signal<number | null>(null);
  const error = signal("");
  const loading = signal(false);
  const query = signal("");
  let asked = 0; // the newest request; an older answer that lands late is dropped
  async function load(reset: boolean) {
    const mine = ++asked;
    loading.set(true);
    const offset = reset ? 0 : untracked(tasks).length;
    const r = await props.hub.api("GET", `/api/tasks?limit=${HISTORY_PAGE}&offset=${offset}&q=${encodeURIComponent(untracked(query).trim())}`);
    if (mine !== asked) return;
    loading.set(false);
    if (!r.ok) { error.set(r.status ? L(`Couldn’t load (${r.status})`, `读取失败（${r.status}）`) : L("Can’t reach the server", "连不上服务器")); return; }
    error.set("");
    const page = (r.data.tasks as TaskInfo[] | undefined) ?? [];
    tasks.set(reset ? page : [...untracked(tasks), ...page]);
    total.set(Number(r.data.total ?? 0));
  }
  void load(true);
  return (
    <Scroll testID="task-history" style={{ flex: 1 }}>
      <View style={{ width: "100%", maxWidth: size.column, alignSelf: "center", gap: 12, paddingHorizontal: props.wide ? 32 : 16, paddingVertical: 20 }}>
        {/* searched on the button or Enter, not on every keystroke: each search reads every task on the server */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Input
            testID="task-search"
            value={query()}
            onChange={({ value }) => query.set(value)}
            onSubmit={() => void load(true)}
            placeholder={L("Search by ID, title or member", "搜索编号、标题或成员")}
            class="placeholder:text-faint"
            style={{ flex: 1, height: 38, paddingHorizontal: 12, fontSize: 15, color: colors.text, borderRadius: radius.control, borderWidth: 1, borderColor: colors.fieldBorder, backgroundColor: colors.surface }}
          />
          <Btn testID="task-search-button" label={L("Search", "搜索")} kind="secondary" disabled={loading()} onPress={() => void load(true)} />
        </View>
        <If when={error()}><Text style={{ fontSize: 14, color: colors.danger }}>{error()}</Text></If>
        <If when={total() === 0 && !loading()}><Text style={{ fontSize: 14, color: colors.faint }}>{L("No matching tasks", "没有符合的任务")}</Text></If>
        <View>
          <Each of={tasks()} key={(t) => t.id}>
            {(t) => (
              <View
                role="button"
                accessibilityLabel={`${t().id} ${t().title}`}
                onPress={() => props.onTask(t().id)}
                hoverStyle={hovered()}
                style={{ minHeight: size.row, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 10, marginHorizontal: -10, borderRadius: 7 }}
              >
                <Dot tone={TONE[t().state ?? ""] ?? "off"} />
                <Text style={{ fontFamily: MONO, fontSize: 12.5, color: colors.faint }}>{t().id}</Text>
                <Text style={{ flex: 1, fontSize: 14.5, color: colors.text, numberOfLines: 1 }}>{t().title}</Text>
                <Text style={{ fontSize: 12.5, color: colors.faint, fontVariant: ["tabular-nums"] }}>{`${STATE_OF()[t().state ?? ""]?.[0] ?? ""} · ${clock(t().updated ?? "")}`}</Text>
              </View>
            )}
          </Each>
        </View>
        <If when={total() !== null && tasks().length < total()!}>
          <View style={{ alignSelf: "flex-start" }}>
            <Btn testID="task-more" label={loading() ? L("Loading…", "读取中…") : L(`Load more (${total()! - tasks().length} left)`, `加载更多（还有 ${total()! - tasks().length} 个）`)} kind="secondary" disabled={loading()} onPress={() => void load(false)} />
          </View>
        </If>
      </View>
    </Scroll>
  );
}

function TaskDetail(props: { hub: Hub; id: string; wide: boolean }) {
  // a task past the status snapshot's newest few is read on its own
  const older = signal<(TaskInfo & { decisions?: string[]; events?: HubEvent[] }) | null>(null);
  const missing = signal(false);
  const t = () => {
    const s = props.hub.status();
    return [...(s?.active ?? []), ...(s?.recent ?? [])].find((x) => x.id === props.id) ?? older() ?? undefined;
  };
  // always read: the page shows the task's whole conversation, and the app only holds the newest events
  void props.hub.api("GET", `/api/tasks/get?id=${encodeURIComponent(props.id)}`).then((r) => {
    if (r.ok) older.set(r.data as TaskInfo); else missing.set(true);
  });
  const section = (title: string) => (
    <Text role="header" style={{ fontSize: 13, fontWeight: "600", color: colors.muted, marginTop: 24, marginBottom: 8 }}>{title}</Text>
  );
  const cancellable = () => ["active", "inbox", "nohost", "waiting", "parked", "blocked", "proposed"].includes(t()?.state ?? "");
  const cancelling = signal(false);
  async function cancel() {
    if (!(await confirmEndTask(props.id, false, t()?.state === "active"))) return;
    cancelling.set(true);
    try { await props.hub.api("POST", "/api/tasks/cancel", { id: props.id }); }
    catch { cancelling.set(false); }
  }
  // the owner already finished it himself (merged by hand, …): end it as done, not cancelled
  async function finish() {
    if (!(await confirmEndTask(props.id, true, t()?.state === "active"))) return;
    cancelling.set(true);
    try { await props.hub.api("POST", "/api/tasks/cancel", { id: props.id, done: true }); }
    catch { cancelling.set(false); }
  }
  // the task is its own conversation: what the owner and the team said about it, and a box to keep talking
  const saying = signal<HubEvent[]>([]);
  const talk = computed(() => {
    const refs = new Set([props.id, ...(older()?.decisions ?? []), ...(t()?.decision ? [t()!.decision!] : [])]);
    return merge(merge(older()?.events ?? [], props.hub.events()), saying()).filter((e) => !!e.ref && refs.has(e.ref) && (e.thread || !(isHub(e.from) && e.kind === "system")));
  });
  const settled = computed(() => answeredIds(talk()));
  const text = signal("");
  const taskExcerpt = signal("");
  let taskComposer: InputRef | undefined;
  const quote = (markdown: string) => {
    taskExcerpt.set("");
    text.update((draft) => appendQuote(draft, markdown));
    taskComposer?.focus();
    taskComposer?.setSelection(text().length);
  };
  const note = signal("");
  const hint = signal("");
  let said = 0;
  async function say() {
    const v = text().trim();
    if (!v) return;
    selectionGeneration++;
    taskExcerpt.set("");
    // reads as sent at once; only a failure brings the words back to the box, with the reason
    const id = `local:${++said}`;
    saying.update((l) => [...l, { id, ts: new Date().toISOString(), from: "owner", kind: "owner", ref: props.id, thread: true, text: v }]);
    text.set("");
    note.set("");
    try {
      await props.hub.send(v, props.id, [], true);
    } catch (e) {
      text.update((now) => (now.trim() ? `${v}\n${now}` : v));
      note.set(String((e as Error)?.message ?? e));
    }
    saying.update((l) => l.filter((x) => x.id !== id));
  }
  const composerHeight = signal(0);
  return (
    <View style={{ flex: 1 }}>
    <Scroll style={{ flex: 1 }}>
      <View style={{ width: "100%", maxWidth: size.column, alignSelf: "center", paddingHorizontal: props.wide ? 32 : 16, paddingTop: 24, paddingBottom: composerHeight() + 24 }}>
        <If when={t()} else={<Text style={{ fontSize: 15, color: colors.muted }}>{missing() ? L(`Can’t find ${props.id}.`, `找不到 ${props.id}。`) : L("Loading…", "读取中…")}</Text>}>
          <View style={{ gap: 8 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Badge label={t()!.state === "nohost" ? L(`Waiting for ${needsLabel(t()!.needs)}`, `等 ${needsLabel(t()!.needs)}`) : STATE_OF()[t()!.state ?? ""]?.[0] ?? t()!.state ?? ""} tone={t()!.state === "failed" ? "danger" : t()!.state === "blocked" ? "warn" : "neutral"} />
              <Text style={{ fontFamily: MONO, fontSize: 13, color: colors.muted }}>{t()!.id}</Text>
              <View style={{ flex: 1 }} />
              <If when={cancellable() && !cancelling()}>
                <Btn testID="finish-task" label={L("Done", "完成")} kind="ghost" icon="check" onPress={() => void finish()} />
                <Btn testID="cancel-task" label={L("Cancel task", "取消任务")} kind="ghost" icon="close" onPress={() => void cancel()} />
              </If>
              <If when={cancelling()}>
                <Text style={{ fontSize: 13, color: colors.muted }}>{L("Working…", "处理中…")}</Text>
              </If>
            </View>
            <Text style={{ userSelect: "text", fontSize: 20, fontWeight: "600", color: colors.text }}>{t()!.title}</Text>
            <Text style={{ fontSize: 14, color: colors.muted }}>
              {[displayName(t()!.agent), t()!.host, t()!.activity?.model ?? t()!.model ?? t()!.cli,
                t()!.started ? L(`Started ${clock(t()!.started!)}`, `${clock(t()!.started!)} 开始`) : "",
                t()!.state === "active" ? L(`Running for ${since(t()!.started)}`, `已运行 ${since(t()!.started)}`) : t()!.finished ? L(`Took ${since(t()!.started, t()!.finished)}`, `用时 ${since(t()!.started, t()!.finished)}`) : "",
                Number(t()!.attempt ?? 1) > 1 ? L(`Attempt ${t()!.attempt}`, `第 ${t()!.attempt} 次`) : ""].filter(Boolean).join(" · ")}
            </Text>
          </View>
          <If when={t()!.state === "active" ? activityLine(t()!.activity) : null}>
            {(a) => (
              <Text testID="task-activity" style={{ marginTop: 10, fontSize: 13.5, lineHeight: 19, color: a().quiet ? colors.warn : colors.muted }}>{a().text}</Text>
            )}
          </If>
          <If when={t()!.state === "nohost"}>
            <View testID="task-nohost" style={{ marginTop: 16, paddingHorizontal: 14, paddingVertical: 11, borderRadius: radius.inset, backgroundColor: tints.warn }}>
              <Text style={{ fontSize: 14, lineHeight: 21, color: colors.text }}>
                {L(`No ${needsLabel(t()!.needs)} is online, and other idle machines can’t take it. It starts automatically once one comes online; cancel it if you no longer need it.`, `现在没有在线的 ${needsLabel(t()!.needs)}，其他机器闲着也接不了它。有 ${needsLabel(t()!.needs)} 上线后会自动开始；用不上的话可以取消。`)}
              </Text>
            </View>
          </If>
          <If when={t()!.request}>
            {section(L("Request", "请求"))}
            <View selectable><Rich text={t()!.request ?? ""} context={t()!.title} /></View>
          </If>
          <If when={talk().length}>
            {section(L("Conversation", "对话"))}
            <View testID="task-talk" style={{ gap: 14 }}>
              <Each of={talk()} key={(e) => e.id}>
                {(e) => isAsk(e()) ? (
                  <Message hub={props.hub} event={e()} answered={settled} target={() => null}
                    onAnswer={(ref, choice) => void props.hub.send(`${ref} ${choice}`, ref, [], true).catch((err) => note.set(String((err as Error)?.message ?? err)))}
                    onQuote={(markdown) => taskExcerpt.set(markdown)}
                    onReply={() => hint.set(L("Write your instructions in the box below; they’ll be sent as the answer to this card.", "在下面的输入框写你的指示，会作为这张卡片的回答。"))} />
                ) : (
                  <View style={{ gap: 3 }}>
                    <Text style={{ fontSize: 13, color: colors.faint }}>
                      <Text style={{ fontWeight: "600", color: e().from === "owner" ? colors.accent : colors.muted }}>{e().from === "owner" ? L("You", "你") : displayName(e().from)}</Text>
                      {`  ${timeOf(e().ts)}`}
                    </Text>
                    <Rich text={e().text} onQuote={e().from !== "owner" ? (markdown) => taskExcerpt.set(markdown) : undefined} />
                    <If when={e().attachments?.length}>
                      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", gap: 8 }}>
                        <Each of={e().attachments ?? []}>{(a) => <Media hub={props.hub} path={a()} />}</Each>
                      </View>
                    </If>
                  </View>
                )}
              </Each>
            </View>
          </If>
          <If when={t()!.runs?.length}>
            {section(L("Result", "结果"))}
            <View style={{ gap: 12 }}>
              <Each of={[...(t()!.runs ?? [])].reverse()}>
                {(r) => (
                  <View style={{ gap: 4 }}>
                    <Text style={{ fontSize: 13, color: colors.faint, fontVariant: ["tabular-nums"] }}>{`${r().ts.slice(5, 16).replace("T", " ")} · ${r().host} · ${r().status}`}</Text>
                    <Rich text={r().summary} context={`${t()!.title}\n${t()!.request ?? ""}`} />
                  </View>
                )}
              </Each>
            </View>
          </If>
          <If when={t()!.steps?.length}>
            {section(L("Progress", "进度"))}
            <View selectable style={{ gap: 6 }}>
              <Each of={t()!.steps ?? []}>
                {(st) => (
                  <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
                    <Text style={{ width: 44, fontSize: 13.5, lineHeight: 21, color: colors.faint, fontVariant: ["tabular-nums"] }}>{st().time ?? ""}</Text>
                    <View style={{ width: 12, height: 21, alignItems: "center", justifyContent: "center" }}>
                      <Dot tone={st().kind === "done" ? "off" : st().kind === "fail" ? "bad" : st().kind === "decision" ? "wait" : "off"} />
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}><Rich text={st().text.replace(new RegExp(`^${t()!.id}\\b\\s*(→\\s*)?[:：]?\\s*`), "")} muted context={t()!.title} /></View>
                  </View>
                )}
              </Each>
            </View>
          </If>
        </If>
      </View>
    </Scroll>
    <If when={t()}>
      <View
        onLayout={({ bounds }) => composerHeight.set(bounds.size.height)}
        style={{ position: "absolute", bottom: 0, width: "100%", maxWidth: size.column, alignSelf: "center", gap: 6, paddingHorizontal: props.wide ? 32 : 10, paddingTop: 4, paddingBottom: 12, pointerEvents: "box-none" }}
      >
        <QuotePreview text={taskExcerpt()} onQuote={() => quote(taskExcerpt())} onCancel={() => taskExcerpt.set("")} />
        <If when={note()}>
          <Text style={{ fontSize: 13, color: colors.danger }}>{note()}</Text>
        </If>
        <If when={hint() && !note()}>
          <Text style={{ fontSize: 13, color: colors.muted }}>{hint()}</Text>
        </If>
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8, paddingLeft: 16, paddingRight: 8, paddingVertical: 8, ...composerGlass() }}>
          <Input
            testID="task-composer"
            ref={(ref) => { taskComposer = ref; }}
            multiline
            value={text()}
            onChange={({ value }) => text.set(value)}
            submitBehavior={touch ? "newline" : "submit"}
            onSubmit={() => void say()}
            placeholder={L(`Continue in ${props.id}…`, `在 ${props.id} 里继续说…`)}
            class="placeholder:text-faint"
            style={{ flex: 1, minHeight: 36, maxHeight: 160, paddingVertical: 8, fontSize: 15, lineHeight: 21, color: colors.text, borderWidth: 0, backgroundColor: "transparent" }}
          />
          <SendButton testID="task-send" disabled={!text().trim()} onPress={() => void say()} />
        </View>
      </View>
    </If>
    </View>
  );
}

/** A short horizontal meter: how full something is, 0..100. */
function Meter(props: { pct: number; tone?: "up" | "warn" | "danger" }) {
  const fill = () => ({ up: colors.up, warn: colors.warn, danger: colors.danger })[props.tone ?? "up"];
  return (
    <View style={{ height: 6, borderRadius: 3, backgroundColor: colors.raised, overflow: "hidden" }}>
      <View style={{ width: `${Math.max(0, Math.min(100, props.pct))}%`, height: 6, borderRadius: 3, backgroundColor: fill() }} />
    </View>
  );
}

const ACCOUNT_STATE = (): Record<string, [string, "neutral" | "warn" | "danger"]> => ({ ok: [L("Available", "可用"), "neutral"], cooldown: [L("Cooling down", "冷却中"), "warn"], login: [L("Sign-in needed", "需要登录"), "danger"] });

const ago = (iso?: string) => { const s = since(iso); return s === L("just now", "刚刚") || !s ? s : L(`${s} ago`, `${s}前`); };

function MachineDetail(props: { hub: Hub; host: string; wide: boolean; onTask: (id: string) => void }) {
  const h = () => props.hub.status()?.hosts.find((x) => x.host === props.host);
  const section = (title: string) => (
    <Text role="header" style={{ fontSize: 13, fontWeight: "600", color: colors.muted, marginTop: 24, marginBottom: 8 }}>{title}</Text>
  );
  const stat = (label: string, value: string, pct: number, tone: "up" | "warn" | "danger") => (
    <View style={{ flex: 1, minWidth: 140, gap: 6, padding: 12, borderRadius: radius.control, borderWidth: 1, borderColor: colors.line }}>
      <Text style={{ fontSize: 13, color: colors.muted }}>{label}</Text>
      <Text style={{ fontSize: 17, fontWeight: "600", color: colors.text, fontVariant: ["tabular-nums"] }}>{value}</Text>
      <Meter pct={pct} tone={tone} />
    </View>
  );
  const load = () => loadOf(h()!);
  const memUsed = () => 100 - (h()!.stats?.memFreePct ?? 100);
  const diskUsed = () => 100 - (h()!.stats?.diskFreePct ?? 100);
  const toneOf = (pct: number): "up" | "warn" | "danger" => (pct >= 90 ? "danger" : pct >= 70 ? "warn" : "up");
  const row = (id: string, title: string, right: string, mark?: JSX.Element) => (
    <View
      role="button"
      accessibilityLabel={`${id} ${title}`}
      onPress={() => props.onTask(id)}
      hoverStyle={hovered()}
      style={{ minHeight: size.row, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 10, marginHorizontal: -10, borderRadius: 7 }}
    >
      {mark}
      <Text style={{ fontFamily: MONO, fontSize: 12.5, color: colors.faint }}>{id}</Text>
      <Text style={{ flex: 1, fontSize: 14.5, color: colors.text, numberOfLines: 1 }}>{title}</Text>
      <Text style={{ fontSize: 12.5, color: colors.faint, fontVariant: ["tabular-nums"] }}>{right}</Text>
    </View>
  );
  return (
    <Scroll style={{ flex: 1 }}>
      <View style={{ width: "100%", maxWidth: size.column, alignSelf: "center", paddingHorizontal: props.wide ? 32 : 16, paddingVertical: 24 }}>
        <If when={h()} else={<Text style={{ fontSize: 15, color: colors.muted }}>{L(`${props.host} is offline.`, `${props.host} 现在不在线。`)}</Text>}>
          <View style={{ gap: 8 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Dot tone="on" />
              <Text style={{ userSelect: "text", fontSize: 20, fontWeight: "600", color: colors.text }}>{h()!.host}</Text>
            </View>
            <Text style={{ fontSize: 14, color: colors.muted }}>
              {[L("Online", "在线"), [h()!.os ?? osOf(h()!), h()!.arch].filter(Boolean).join(" "), h()!.seen ? L(`Seen ${ago(h()!.seen)}`, `心跳 ${ago(h()!.seen)}`) : "", L(`${h()!.busy ?? 0} running`, `${h()!.busy ?? 0} 个运行中`)].filter(Boolean).join(" · ")}
            </Text>
            <If when={h()!.rev}>
              <RevLink host={h()!} />
            </If>
          </View>
          {section(L("Resources", "资源"))}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {stat(L("Load", "负载"), `${load()}%${h()!.stats?.cores ? L(` · ${h()!.stats!.cores} cores`, ` · ${h()!.stats!.cores} 核`) : ""}`, load(), toneOf(load()))}
            {stat(L("Memory", "内存"), h()!.stats?.memFreePct != null ? L(`${memUsed()}% used`, `已用 ${memUsed()}%`) : L("Unknown", "未知"), memUsed(), toneOf(memUsed()))}
            {stat(L("Disk", "磁盘"), L(`${h()!.stats?.diskFreeGB ?? "?"} GB free`, `剩余 ${h()!.stats?.diskFreeGB ?? "?"} GB`), diskUsed(), toneOf(diskUsed()))}
          </View>
          <If when={h()!.clis?.length || h()!.accounts?.length}>
            {section(L("Tools & accounts", "工具与账号"))}
            <View style={{ gap: 8 }}>
              <If when={h()!.clis?.length}>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  <Each of={h()!.clis ?? []}>{(c) => <Badge label={c()} />}</Each>
                </View>
              </If>
              <Each of={h()!.accounts ?? []}>
                {(a) => (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                    <Text style={{ flex: 1, fontSize: 14.5, color: colors.text }}>{[a().cli, a().name, a().model].filter(Boolean).join(" · ")}</Text>
                    <Badge label={`${ACCOUNT_STATE()[a().state]?.[0] ?? a().state}${a().until ? L(` until ${a().until!.slice(11, 16)}`, ` 至 ${a().until!.slice(11, 16)}`) : ""}`} tone={ACCOUNT_STATE()[a().state]?.[1] ?? "neutral"} />
                  </View>
                )}
              </Each>
            </View>
          </If>
          {section(L("Running", "运行中"))}
          <If when={h()!.running?.length} else={<Text style={{ fontSize: 14, color: colors.faint }}>{L("Idle", "空闲")}</Text>}>
            <View>
              <Each of={h()!.running ?? []} key={(t) => t.id}>
                {(t) => row(t().id, t().title, [displayName(t().agent), t().activity?.model, since(t().started), activityLine(t().activity)?.text].filter(Boolean).join(" · "), <Dot tone="run" />)}
              </Each>
            </View>
          </If>
          {section(L("Recent", "最近"))}
          <If when={h()!.recent?.length} else={<Text style={{ fontSize: 14, color: colors.faint }}>{L("No finished tasks yet", "还没有完成的任务")}</Text>}>
            <View>
              <Each of={h()!.recent ?? []} key={(t) => t.id}>
                {(t) => row(t().id, t().title, t().finished ? ago(t().finished) : "",
                  <Text style={{ width: 14, fontSize: 13, color: STATE_OF()[t().state ?? ""]?.[1] ?? colors.faint }}>{STATE_OF()[t().state ?? ""]?.[2] ?? "·"}</Text>)}
              </Each>
            </View>
          </If>
        </If>
      </View>
    </Scroll>
  );
}

// ---------------------------------------------------------------- sidebar

function SideHeading(props: { title: string; count?: number | string; accent?: boolean }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingTop: 18, paddingBottom: 6 }}>
      <Text style={{ flex: 1, fontSize: 12, fontWeight: "600", color: colors.muted, letterSpacing: 0.4 }}>{props.title}</Text>
      <If when={props.count}>
        <If when={props.accent} else={<Text style={{ fontSize: 12.5, color: colors.faint, fontVariant: ["tabular-nums"] }}>{String(props.count)}</Text>}>
          <View style={{ minWidth: 20, height: 20, paddingHorizontal: 6, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: colors.accentFill }}>
            <Text style={{ fontSize: 12, fontWeight: "600", color: colors.onAccent }}>{String(props.count)}</Text>
          </View>
        </If>
      </If>
    </View>
  );
}

function SideEmpty(props: { text: string }) {
  return <Text style={{ fontSize: 13.5, color: colors.faint, paddingHorizontal: 20, paddingVertical: 6 }}>{props.text}</Text>;
}

/** A sidebar row: the gallery's SidebarRow, at 34 pt (44 on touch). */
function SideRow(props: { onPress?: () => void; selected?: boolean; title?: string; children: JSX.Element }) {
  return (
    <View
      onPress={props.onPress}
      role={props.onPress ? "button" : undefined}
      accessibilityLabel={props.title}
      tooltip={props.title && !props.onPress ? <Tip label={props.title} placement="right" /> : undefined}
      hoverStyle={props.onPress && !props.selected ? hovered() : undefined}
      style={{
        minHeight: size.row,
        minWidth: 0,
        overflow: "hidden",
        marginHorizontal: 10,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingHorizontal: 10,
        borderRadius: radius.control,
        borderCurve: "continuous",
        backgroundColor: props.selected ? alpha(colors.text, 0.08) : "transparent",
      }}
    >
      {props.children}
    </View>
  );
}

/** Ask before ending a task: cancel it, or mark it done when the owner finished it himself. */
async function confirmEndTask(id: string, done: boolean, running: boolean): Promise<boolean> {
  const r = done
    ? await AlertDialog.show({
      title: L(`Mark ${id} as done?`, `把 ${id} 标记为完成？`),
      description: running ? L("The running agent will be stopped and the task marked done.", "正在运行的 agent 会被停下，任务记为完成。") : L("The task will be marked done and won’t run again.", "任务记为完成，不再执行。"),
      actions: [
        { id: "keep", label: L("Back", "返回"), role: "cancel" },
        { id: "end", label: L("Mark as done", "标记完成") },
      ],
    })
    : await AlertDialog.show({
      title: L(`Cancel ${id}?`, `取消 ${id}？`),
      description: running ? L("The running agent will be stopped. Changes it already made stay in the repository.", "正在运行的 agent 会被停下，已经做了的改动保留在仓库里。") : L("This task won’t run again.", "这个任务不会再执行。"),
      actions: [
        { id: "keep", label: L("Keep", "不取消"), role: "cancel" },
        { id: "end", label: L("Cancel task", "取消任务"), role: "destructive" },
      ],
    });
  return r.action === "end";
}

/** How far the wide layout's floating sidebar sits from the window's edges. */
const sidebarInset = 8;

function Sidebar(props: {
  hub: Hub;
  target: () => string | null;
  onPick: (ref: string) => void;
  /** Set a question aside: it leaves 待你决定 and is not asked again. */
  onIgnore: (ref: string) => void;
  task: () => string | null;
  onTask: (id: string) => void;
  machine: () => string | null;
  onMachine: (host: string) => void;
  onSettings: () => void;
  rules: () => boolean;
  onRules: () => void;
  tasks: () => boolean;
  onTasks: () => void;
  channels: Channels;
  channel: () => string | null;
  onChannel: (slug: string) => void;
  onHelp: () => void;
  onClose?: () => void;
  chrome?: boolean;
  onCollapse?: () => void;
  home: () => boolean;
  onHome: () => void;
  /** Unread messages in the channel on this device, and reading them all. */
  unread: () => number;
  onReadAll: () => void;
  onRestart: () => void;
}) {
  /** Archived channels stay folded under one row; the open one stays in place so the selection doesn't vanish. */
  const showArchived = signal(false);
  const archivedChannels = () => props.channels.list().filter((c) => c.status === "archived" && c.slug !== props.channel());
  const s = () => props.hub.status();
  // the hub closes a decision on its next tick: one the channel already shows answered leaves the list now
  const waits = computed(() => { const done = answeredIds(props.hub.events()); return waiting(s()).filter((d) => !done.has(d.id)); });
  // the sidebar's right-click menu: end a task that can't go on without opening it
  const endTask = async (id: string, done: boolean) => {
    const running = (s()?.active ?? []).some((a) => a.id === id);
    if (await confirmEndTask(id, done, running)) await props.hub.api("POST", "/api/tasks/cancel", done ? { id, done: true } : { id }).catch(() => {});
  };
  const menuStyle = () => ({ minWidth: 160, padding: 4, borderRadius: radius.control, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface });
  const itemStyle = { height: 32, justifyContent: "center" as const, paddingHorizontal: 10, borderRadius: 6 };
  const taskItems = (id: string) => [
    <MenuItem testID={`side-done-${id}`} onSelect={() => void endTask(id, true)} hoverStyle={hovered()} style={itemStyle}>
      <Text style={{ fontSize: 14, color: colors.text }}>{L("Mark as done", "标记完成")}</Text>
    </MenuItem>,
    <MenuItem testID={`side-cancel-${id}`} onSelect={() => void endTask(id, false)} hoverStyle={hovered()} style={itemStyle}>
      <Text style={{ fontSize: 14, color: colors.danger }}>{L("Cancel task", "取消任务")}</Text>
    </MenuItem>,
  ];
  const queue = () => {
    const q = s()?.tasks;
    return [
      [L("To approve", "待批准"), q?.proposed],
      [L("Queued", "排队"), q?.inbox],
      [L("Blocked", "阻塞"), q?.blocked],
      [L("Failed", "失败"), q?.failed],
      [L("Done", "完成"), q?.done],
    ] as const;
  };
  const rowText = () => ({ flex: 1, minWidth: 0, fontSize: 14.5, color: colors.text, numberOfLines: 1 }) as const;
  return (
    <View style={{ flex: 1, minWidth: 0 }}>
      <View
        desktop={{ windowDrag: true }}
        // the floating panel starts below the window's top: its row stays centered on the title bar, level with the window controls
        style={{ height: props.chrome ? size.bar - sidebarInset : size.bar, paddingBottom: props.chrome ? sidebarInset : 0, flexDirection: "row", alignItems: "center", gap: 10, paddingLeft: (props.chrome && hasWindow ? Math.max(0, titleBar().left - sidebarInset) : 0) + 18, paddingRight: 10 }}
      >
        <Text style={{ flex: 1, fontSize: 16, fontWeight: "600", color: colors.text }}>Noop</Text>
        <If when={props.onClose}>
          <ToolButton icon="close" label={L("Close menu", "收起菜单")} onPress={() => props.onClose?.()} />
        </If>
        <If when={props.onCollapse}>
          <ToolButton icon="sidebar" label={L("Hide sidebar", "隐藏侧栏")} noTooltip compact onPress={() => props.onCollapse?.()} />
        </If>
      </View>
      <Scroll testID="sidebar-scroll" style={{ flex: 1, minWidth: 0 }}>
        {/* Keep intrinsic text widths from expanding the scrollable content. */}
        <View style={{ width: "100%", minWidth: 0, overflow: "hidden", paddingBottom: 16, gap: 1 }}>
          <View style={{ paddingTop: 8 }}>
            <ContextMenu margin={8} popupStyle={menuStyle()} trigger={
            <SideRow onPress={props.onHome} selected={props.home()} title={L("Channel", "主会话")}>
              <Icon name="chat" size={17} tint={props.home() ? colors.text : colors.muted} />
              <Text style={{ ...rowText(), fontWeight: "600" }}>{L("Channel", "主会话")}</Text>
              <If when={waits().length && !props.unread()}>
                <Text style={{ fontSize: 12.5, color: colors.faint, fontVariant: ["tabular-nums"] }}>{L(`${waits().length} to decide`, `${waits().length} 待决定`)}</Text>
              </If>
              <If when={props.unread()}>
                <View testID="channel-unread" accessibilityLabel={L(`${props.unread()} unread`, `${props.unread()} 条未读`)} style={{ minWidth: 20, height: 20, paddingHorizontal: 6, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: colors.accentFill }}>
                  <Text style={{ fontSize: 12, fontWeight: "600", color: colors.onAccent, fontVariant: ["tabular-nums"] }}>{props.unread() > 99 ? "99+" : String(props.unread())}</Text>
                </View>
              </If>
            </SideRow>
            }>
              <MenuItem testID="read-all" disabled={!props.unread()} onSelect={props.onReadAll} hoverStyle={hovered()} style={{ height: touch ? 44 : 32, justifyContent: "center", paddingHorizontal: 10, borderRadius: 6 }}>
                <Text style={{ fontSize: 14, color: props.unread() ? colors.text : colors.faint }}>{L("Mark all as read", "全部标为已读")}</Text>
              </MenuItem>
            </ContextMenu>
            <SideRow onPress={props.onRules} selected={props.rules()} title={L("Memory", "记忆")}>
              <Icon name="scroll" size={17} tint={props.rules() ? colors.text : colors.muted} />
              <Text style={rowText()}>{L("Memory", "记忆")}</Text>
            </SideRow>
          </View>
          <SideHeading title={L("Needs your decision", "待你决定")} count={waits().length || undefined} accent />
          <Each of={waits()} key={(d) => d.id}>
            {(d) => (
              <ContextMenu
                margin={8}
                popupStyle={{ minWidth: 160, padding: 4, borderRadius: radius.control, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface }}
                trigger={
                  <SideRow onPress={() => props.onPick(d().id)} title={d().id}>
                    <Dot tone="wait" />
                    <Text style={rowText()}>{d().question || d().id}</Text>
                    <Text style={{ fontFamily: MONO, fontSize: 12, color: colors.faint }}>{d().id}</Text>
                  </SideRow>
                }
              >
                <MenuItem
                  testID={`side-ignore-${d().id}`}
                  onSelect={() => props.onIgnore(d().id)}
                  hoverStyle={hovered()}
                  style={{ height: 32, justifyContent: "center", paddingHorizontal: 10, borderRadius: 6 }}
                >
                  <Text style={{ fontSize: 14, color: colors.text }}>{L("Ignore, you decide", "忽略，你来定")}</Text>
                </MenuItem>
                {d().task ? taskItems(d().task!) : null}
              </ContextMenu>
            )}
          </Each>
          <If when={!waits().length}>
            <SideEmpty text={L("Nothing to do. The team is on it.", "没有待办，团队在自己推进")} />
          </If>

          <SideHeading title={L("In progress", "进行中")} count={s()?.active.length || undefined} />
          <Each of={s()?.active ?? []} key={(a) => a.id}>
            {(a) => (
              <ContextMenu margin={8} popupStyle={menuStyle()} trigger={
                <SideRow onPress={() => props.onTask(a().id)} selected={props.task() === a().id} title={`${a().id} · ${a().agent}${a().host ? ` @ ${a().host}` : ""}`}>
                  <Dot tone="run" />
                  <Text style={rowText()}>{a().title}</Text>
                  <Text style={{ fontSize: 12.5, color: colors.faint, fontVariant: ["tabular-nums"] }}>{since(a().started)}</Text>
                </SideRow>
              }>
                {taskItems(a().id)}
              </ContextMenu>
            )}
          </Each>
          <If when={!s()?.active.length}>
            <SideEmpty text={L("Idle", "空闲")} />
          </If>

          <If when={(s()?.recent ?? []).filter((t) => !(s()?.active ?? []).some((a) => a.id === t.id) && isQueued(t.state)).length}>
            <SideHeading title={L("Queued", "排队")} count={(s()?.recent ?? []).filter((t) => !(s()?.active ?? []).some((a) => a.id === t.id) && isQueued(t.state)).length} />
            <Each of={(s()?.recent ?? []).filter((t) => !(s()?.active ?? []).some((a) => a.id === t.id) && isQueued(t.state))} key={(a) => a.id}>
              {(a) => (
                <ContextMenu margin={8} popupStyle={menuStyle()} trigger={
                <SideRow onPress={() => props.onTask(a().id)} selected={props.task() === a().id} title={`${a().id} · ${STATE_OF()[a().state ?? ""]?.[0] ?? ""}`}>
                  <Dot tone={TONE[a().state ?? ""] ?? "off"} />
                  <Text style={{ ...rowText(), color: colors.muted }}>{a().title}</Text>
                  <Text style={{ maxWidth: "50%", minWidth: 0, flexShrink: 1, numberOfLines: 1, fontSize: 12.5, color: colors.faint, fontVariant: ["tabular-nums"] }}>{a().state === "waiting" ? L("Waiting on subtasks", "等子任务") : a().state === "parked" ? L("Waiting", "等待") : a().state === "nohost" ? L(`Waiting for ${needsLabel((a() as { needs?: string }).needs)}`, `等 ${needsLabel((a() as { needs?: string }).needs)}`) : L("Queued", "排队中")}</Text>
                </SideRow>
                }>
                  {taskItems(a().id)}
                </ContextMenu>
              )}
            </Each>
          </If>
          <If when={(s()?.recent ?? []).filter((t) => !(s()?.active ?? []).some((a) => a.id === t.id) && !isQueued(t.state)).slice(0, 6).length}>
            <SideHeading title={L("Recent", "最近")} />
            <Each of={(s()?.recent ?? []).filter((t) => !(s()?.active ?? []).some((a) => a.id === t.id) && !isQueued(t.state)).slice(0, 6)} key={(a) => a.id}>
              {(a) => (
                <SideRow onPress={() => props.onTask(a().id)} selected={props.task() === a().id} title={`${a().id} · ${STATE_OF()[a().state ?? ""]?.[0] ?? ""}`}>
                  <Dot tone={TONE[a().state ?? ""] ?? "off"} />
                  <Text style={{ ...rowText(), color: colors.muted }}>{a().title}</Text>
                  <Text style={{ fontSize: 12.5, color: colors.faint, fontVariant: ["tabular-nums"] }}>{since(a().updated)}</Text>
                </SideRow>
              )}
            </Each>
          </If>

          <If when={props.channels.list().length}>
            <SideHeading title={L("Channels", "Channels")} count={props.channels.list().reduce((n, c) => n + props.channels.unread(c), 0) || undefined} accent />
            <Each of={props.channels.list().filter((c) => c.status !== "archived" || c.slug === props.channel())} key={(c) => c.slug}>
              {(c) => (
                <SideRow onPress={() => props.onChannel(c().slug)} selected={props.channel() === c().slug} title={c().goal || c().name}>
                  <Text style={{ width: 17, textAlign: "right", fontSize: 15, color: colors.faint }}>#</Text>
                  <Text testID={`side-channel-${c().slug}`} style={{ ...rowText(), color: c().status === "archived" || c().stale ? colors.faint : props.channels.unread(c()) ? colors.text : colors.muted, fontWeight: props.channels.unread(c()) ? "600" : "400" }}>{c().name}</Text>
                  <If when={props.channels.unread(c())} else={
                    <If when={c().status !== "archived" && c().stale}>
                      <Text style={{ fontSize: 12.5, color: colors.faint }}>{L("Quiet 7d", "7 天无动静")}</Text>
                    </If>
                  }>
                    <Text testID={`side-channel-unread-${c().slug}`} style={{ fontSize: 12.5, fontWeight: "600", color: colors.accent, fontVariant: ["tabular-nums"] }}>{String(props.channels.unread(c()))}</Text>
                  </If>
                </SideRow>
              )}
            </Each>
            <If when={archivedChannels().length}>
              <SideRow onPress={() => showArchived.set(!showArchived())} title={L("Archived channels", "已归档的 Channel")}>
                <View style={{ width: 17, alignItems: "flex-end" }}><Icon name={showArchived() ? "chevron-down" : "chevron"} size={12} tint={colors.faint} /></View>
                <Text testID="side-channels-archived" style={{ ...rowText(), color: colors.faint }}>{L("Archived", "已归档")}</Text>
                <Text style={{ fontSize: 12.5, color: colors.faint, fontVariant: ["tabular-nums"] }}>{String(archivedChannels().length)}</Text>
              </SideRow>
              <If when={showArchived()}>
                <Each of={archivedChannels()} key={(c) => c.slug}>
              {(c) => (
                <SideRow onPress={() => props.onChannel(c().slug)} selected={props.channel() === c().slug} title={c().goal || c().name}>
                  <Text style={{ width: 17, textAlign: "right", fontSize: 15, color: colors.faint }}>#</Text>
                  <Text testID={`side-channel-${c().slug}`} style={{ ...rowText(), color: c().status === "archived" || c().stale ? colors.faint : props.channels.unread(c()) ? colors.text : colors.muted, fontWeight: props.channels.unread(c()) ? "600" : "400" }}>{c().name}</Text>
                  <If when={props.channels.unread(c())} else={
                    <If when={c().status !== "archived" && c().stale}>
                      <Text style={{ fontSize: 12.5, color: colors.faint }}>{L("Quiet 7d", "7 天无动静")}</Text>
                    </If>
                  }>
                    <Text testID={`side-channel-unread-${c().slug}`} style={{ fontSize: 12.5, fontWeight: "600", color: colors.accent, fontVariant: ["tabular-nums"] }}>{String(props.channels.unread(c()))}</Text>
                  </If>
                </SideRow>
              )}
                </Each>
              </If>
            </If>
          </If>

          <SideRow onPress={props.onTasks} selected={props.tasks()} title={L("All tasks", "全部任务")}>
            <Icon name="layers" size={17} tint={colors.muted} />
            <Text style={{ ...rowText(), color: colors.muted }}>{L("All tasks", "全部任务")}</Text>
          </SideRow>

          <SideHeading title={L("Machines", "机器")} count={s()?.hosts.length || undefined} />
          <Each of={s()?.hosts ?? []} key={(h) => h.host}>
            {(h) => (
              <SideRow onPress={() => props.onMachine(h().host)} selected={props.machine() === h().host} title={L(`Load ${loadOf(h())}% · Disk ${h().stats?.diskFreeGB ?? "?"} GB free · ${h().busy ?? 0} running`, `负载 ${loadOf(h())}% · 磁盘 ${h().stats?.diskFreeGB ?? "?"}GB · ${h().busy ?? 0} 个运行中`)}>
                <Dot tone="on" />
                <Text style={rowText()}>{h().host}</Text>
                <If when={(h().busy ?? 0) > 0}>
                  <Text style={{ fontSize: 13, color: colors.muted, fontVariant: ["tabular-nums"] }}>{L(`${h().busy} running`, `${h().busy} 运行中`)}</Text>
                </If>
              </SideRow>
            )}
          </Each>
          <If when={!s()?.hosts.length}>
            <SideEmpty text={L("No machines online", "没有在线机器")} />
          </If>

          <If when={queue().some((q) => q[1] && q[0] !== L("Done", "完成") && q[0] !== L("To approve", "待批准"))}>
            <Text style={{ fontSize: 13, color: colors.faint, paddingHorizontal: 20, paddingTop: 18, fontVariant: ["tabular-nums"] }}>
              {queue().filter((q) => q[1] && q[0] !== L("Done", "完成") && q[0] !== L("To approve", "待批准")).map((q) => `${q[0]} ${q[1]}`).join(" · ")}
            </Text>
          </If>
        </View>
      </Scroll>
      <UpdateRow onRestart={props.onRestart} />
      <View
        style={{
          minHeight: 56,
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          paddingHorizontal: 10,
          paddingBottom: touch ? safeArea().bottom : 0,
        }}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <UserMenu hub={props.hub} onSettings={props.onSettings} reads={props.channels.reads} />
        </View>
      </View>
    </View>
  );
}

/** A fixed colour per initial, so the same account always gets the same avatar colour. */
function initialColor(ch: string): string {
  const c = ch.toUpperCase().charCodeAt(0);
  const index = c >= 65 && c <= 90 ? (c - 65) % 10 + 1 : 10;
  return token(`avatar-${index}` as "avatar-1");
}

/** The sidebar account, opening the user menu (settings, appearance, language). */
function UserMenu(props: { hub: Hub; onSettings: () => void; reads: MessageReads }) {
  /** The signed-in account: its email, shown as the local part; the server address stays out of the UI. */
  const email = signal("");
  void Storage.getItem(KEYS.email).then((e) => email.set(e ?? ""));
  const account = () => email().split("@")[0] ?? "";
  // A pointer gets a compact popup at the trigger; a finger gets the sheet at the bottom with rows it can hit.
  const touch = platform.os === "ios" || platform.os === "android";
  const m = touch
    ? { row: 52, padX: 16, gap: 12, icon: 20, label: 16, value: 14, avatar: 48, name: 20, mail: 14, seg: 44, segH: 44, sepX: 12 }
    : { row: 30, padX: 8, gap: 10, icon: 15, label: 13.5, value: 13, avatar: 30, name: 13.5, mail: 12, seg: 28, segH: 22, sepX: 8 };
  const surface = (): ViewStyle => touch
    // Opaque on a phone: the sheet sits over the sidebar's own rows, which would show through glass.
    ? { backgroundColor: colors.raised, borderRadius: 24, borderCurve: "continuous", boxShadow: "0 10px 40px rgba(0,0,0,0.18)",
        left: 12, right: 12, bottom: Math.max(12, safeArea().bottom), padding: 12 }
    // No minWidth here: the language submenu takes this same style and should fit its rows; the menu gets its width from its header.
    : { ...glass(colors.surface, 12), padding: 5 };
  const row = (): ViewStyle => ({ flexDirection: "row", alignItems: "center", gap: m.gap, ...(touch ? { minHeight: m.row, paddingVertical: 12 } : { height: m.row }), paddingHorizontal: m.padX, borderRadius: touch ? 12 : 7, borderCurve: "continuous" });
  const label = (text: string) => <Text style={{ flex: 1, minWidth: 0, fontSize: m.label, color: colors.text, ...(touch ? {} : { numberOfLines: 1 }) }}>{text}</Text>;
  const lead = (name: IconName) => <Icon name={name} size={m.icon} tint={colors.muted} />;
  const sep = () => <MenuSeparator style={{ height: 1, marginVertical: touch ? 6 : 4, marginHorizontal: m.sepX, backgroundColor: alpha(colors.text, 0.07) }} />;
  const initial = () => (account().slice(0, 1) || "?").toUpperCase();
  const avatar = (box: number) => (
    <View style={{ width: box, height: box, borderRadius: box / 2, flexShrink: 0, alignItems: "center", justifyContent: "center", backgroundColor: initialColor(initial()) }}>
      <Text style={{ fontSize: Math.round(box * 0.44), fontWeight: "600", color: token("avatar-foreground") }}>{initial()}</Text>
    </View>
  );
  /** One of the two appearances, as a segment whose raised thumb marks the current one. */
  const appearance = (dark: boolean, title: string, icon: IconName) => (
    <MenuItem testID={dark ? "theme-dark" : "theme-light"} accessibilityLabel={title}
      role="menuitemradio" checked={isDark() === dark} closeOnSelect={false}
      onSelect={() => { if (isDark() !== dark) toggleTheme(); }}
      activeStyle={hovered()}
      style={{ ...(touch ? { flex: 1, minHeight: m.segH, flexDirection: "row", gap: 8, padding: 8 } : { width: m.seg, height: m.segH }), alignItems: "center", justifyContent: "center", borderRadius: touch ? 8 : 6, borderCurve: "continuous",
        ...(isDark() === dark ? { backgroundColor: colors.field, boxShadow: "0 1px 2px rgba(0,0,0,0.14)" } : {}) }}>
      <Icon name={icon} size={touch ? 20 : 14} tint={isDark() === dark ? colors.text : colors.muted} />
      <If when={touch}><Text style={{ fontSize: 16, color: isDark() === dark ? colors.text : colors.muted }}>{title}</Text></If>
    </MenuItem>
  );
  const radio = (text: string, on: () => boolean, pick: () => void, testID: string) => (
    <MenuItem testID={testID} role="menuitemradio" checked={on()} onSelect={() => !on() && pick()} hoverStyle={hovered()} activeStyle={hovered()} style={{ ...row(), ...(touch ? { backgroundColor: colors.surface, marginTop: 4 } : { minWidth: 136 }) }}>
      {label(text)}
      <View style={{ width: m.icon }}>
        <If when={on()}>
          <Icon name="check" size={m.icon - 2} tint={colors.text} />
        </If>
      </View>
    </MenuItem>
  );
  return (
    <Menu
      align="start"
      offset={6}
      margin={8}
      popupStyle={surface()}
      backdropClass="bg-scrim"
      trigger={
        <View
          role="button"
          testID="user-menu"
          accessibilityLabel={L("Account menu", "用户菜单")}
          hoverStyle={hovered()}
          style={{ width: "100%", flexDirection: "row", alignItems: "center", gap: 8, minHeight: touch ? 44 : 40, paddingLeft: 8, paddingRight: 10, borderRadius: radius.control, borderCurve: "continuous" }}
        >
          {avatar(24)}
          <Text testID="user-account" style={{ flex: 1, fontSize: 13, fontWeight: "600", color: colors.text, numberOfLines: 1 }}>{account() || L("Account", "账户")}</Text>
          <Icon name="chevron-up" size={12} tint={colors.faint} />
        </View>
      }
    >
      <View style={{ ...(touch ? {} : { minWidth: 254 }), flexDirection: "row", alignItems: "center", gap: touch ? 12 : 10, paddingHorizontal: m.padX, paddingTop: touch ? 12 : 6, paddingBottom: touch ? 24 : 7 }}>
        {avatar(m.avatar)}
        <View style={{ flex: 1, minWidth: 0, gap: touch ? 4 : 1 }}>
          <Text style={{ fontSize: m.name, fontWeight: "600", color: colors.text, numberOfLines: 1 }}>{account() || L("Account", "账户")}</Text>
          <If when={email()}>
            <Text style={{ fontSize: m.mail, color: colors.muted, numberOfLines: 1 }}>{email()}</Text>
          </If>
        </View>
      </View>
      <If when={!touch}>{sep()}</If>
      <View style={touch ? { backgroundColor: colors.surface, borderRadius: 12, borderCurve: "continuous" } : {}}>
        <MenuItem testID="mark-all-read" disabled={!props.reads.main().length} onSelect={props.reads.all} hoverStyle={hovered()} activeStyle={hovered()} disabledStyle={{ opacity: 0.4 }} style={row()}>
          {lead("check")}{label(L("Mark all as read", "全部已读"))}
        </MenuItem>
        <MenuItem testID="settings" onSelect={props.onSettings} hoverStyle={hovered()} activeStyle={hovered()} style={row()}>
          {lead("settings")}
          {label(L("Settings…", "设置…"))}
          <If when={touch} else={<Text style={{ fontSize: 12, color: colors.faint }}>{keymap.label("mod+,")}</Text>}><Icon name="chevron" size={14} tint={colors.faint} /></If>
        </MenuItem>
        <Submenu offset={4}
          trigger={<View testID="menu-language" hoverStyle={hovered()} activeStyle={hovered()} style={row()}>
            {lead("globe")}
            {label(L("Language", "语言"))}
            <Text style={{ fontSize: m.value, color: colors.muted }}>{LANGS.find((l) => l.id === lang())?.label ?? "English"}</Text>
            <Icon name="chevron" size={touch ? 14 : 12} tint={colors.faint} />
          </View>}
          back={<View testID="menu-language-back" activeStyle={hovered()} style={row()}><Icon name="back" size={m.icon} tint={colors.muted} />{label(L("Back", "返回"))}</View>}>
          <Each of={LANGS}>{(l) => radio(l().label, () => lang() === l().id, () => pickLang(l().id), `menu-lang-${l().id}`)}</Each>
        </Submenu>
      </View>
      <View style={touch ? { gap: 8, paddingTop: 16, paddingHorizontal: 4 } : { ...row(), height: 34 }}>
        <If when={!touch}>{lead(isDark() ? "moon" : "sun")}</If>
        <Text style={{ ...(touch ? { paddingHorizontal: 12 } : { flex: 1 }), fontSize: touch ? 14 : m.label, color: touch ? colors.muted : colors.text }}>{L("Appearance", "外观")}</Text>
        <View style={{ flexDirection: "row", gap: touch ? 4 : 2, padding: touch ? 4 : 2, borderRadius: touch ? 12 : 8, borderCurve: "continuous", backgroundColor: alpha(colors.text, 0.07) }}>
          {appearance(false, L("Light", "浅色"), "sun")}
          {appearance(true, L("Dark", "深色"), "moon")}
        </View>
      </View>
    </Menu>
  );
}

// ---------------------------------------------------------------- app updates

const appUpdate = signal<UpdateState>({ kind: "none" });
const updates = createUpdates(
  {
    check: checkForUpdate, download: () => downloadUpdate(), install: installAndRestart,
    // OTA: a signed package of the app's code. Phones cannot restart an app, so there it runs from the next launch.
    packages: { check: checkForPackage, download: () => downloadPackage(), restart: platform.os === "ios" || platform.os === "android" ? null : restartToPackage, running: runningPackage },
  },
  (state) => appUpdate.set(state),
);
/** The first check waits for the app to settle; nsh/updater answers null where apps do not update (the web, a dev run). */
function watchUpdates() {
  const first = setTimeout(() => void updates.check(), 5000);
  const timer = setInterval(() => void updates.check(), CHECK_EVERY_MS);
  cleanup(() => { clearTimeout(first); clearInterval(timer); });
}

/** Above the sidebar's footer, only when there is something to press. */
function UpdateRow(props: { onRestart: () => void }) {
  const state = () => appUpdate();
  const version = () => { const u = state(); return u.kind === "none" ? "" : u.version; };
  const label = () => {
    const u = state();
    if (u.kind === "link") return L(`Download ${u.version}`, `下载新版本 ${u.version}`);
    if (u.kind === "installing") return L("Updating…", "正在更新…");
    if (u.kind === "failed") return L("Update failed. Click to retry.", "更新失败，点此重试");
    return L(`Restart to update to ${version()}`, `重启以更新到 ${version()}`);
  };
  const press = () => {
    const u = state();
    if (u.kind === "link") void openUrl(u.url).catch(() => {});
    else if (u.kind !== "installing") props.onRestart();
  };
  return (
    <If when={state().kind !== "none" && state().kind !== "staged"}>
      <View
        role="button"
        testID="app-update"
        accessibilityLabel={label()}
        onPress={press}
        class="active:bg-raised"
        style={{ minHeight: touch ? 44 : 36, justifyContent: "center", gap: 2, paddingHorizontal: 18, paddingVertical: 6, borderTopWidth: 1, borderTopColor: alpha(colors.text, 0.08) }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <If when={state().kind === "installing"}>
            <Spinner size={12} tint={colors.muted} />
          </If>
          <Text style={{ flexShrink: 1, fontSize: 13.5, color: state().kind === "installing" ? colors.muted : colors.info, numberOfLines: 1 }}>{label()}</Text>
        </View>
        <If when={state().kind === "failed"}>
          <Text style={{ fontSize: 12, lineHeight: 16, color: colors.muted, numberOfLines: 2 }}>{(state() as { message?: string }).message}</Text>
        </If>
      </View>
    </If>
  );
}

// ---------------------------------------------------------------- team settings

function Chip(props: { label: string; on: boolean; onPress: () => void; testID?: string; accessibilityLabel?: string }) {
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={{ selected: props.on }}
      onPress={props.onPress}
      hoverStyle={props.on ? undefined : hovered()}
      focusStyle={focusRing()}
      style={{
        minHeight: touch ? 40 : 34,
        minWidth: 34,
        justifyContent: "center",
        alignItems: "center",
        paddingHorizontal: 12,
        borderRadius: radius.control,
        borderCurve: "continuous",
        borderWidth: 0.5,
        borderColor: props.on ? alpha(colors.text, 0.2) : surfaceEdge(),
        backgroundColor: props.on ? tints.accent : colors.surface,
        transitionProperty: "background-color, border-color",
        transitionDuration: 120,
      }}
    >
      <Text style={{ textAlign: "center", fontSize: 14, fontWeight: props.on ? "600" : "400", color: props.on ? colors.accent : colors.text }}>{props.label}</Text>
    </View>
  );
}

/** A shared stepper for the per-machine parallel limit. */
function ParallelInput(props: { value: number; onChange: (value: number) => void }) {
  return <NumberInput
    testID="parallel" accessibilityLabel={L("Tasks each machine runs at once", "每台机器同时运行的任务数")} value={props.value} min={1} max={32}
    onChange={({ value }) => { if (value != null && value >= 1 && value <= 32 && value !== props.value) props.onChange(value); }}
    style={{ flexDirection: "row", alignItems: "center", height: touch ? 44 : 36, borderRadius: radius.control, borderCurve: "continuous", backgroundColor: colors.raised }}
    inputStyle={{ width: 40, textAlign: "center", fontSize: 16, fontWeight: "600", color: colors.text, fontVariant: ["tabular-nums"] }}
    decrementButtonClass="active:opacity-50 disabled:opacity-30" incrementButtonClass="active:opacity-50 disabled:opacity-30"
    decrementButtonStyle={{ width: touch ? 44 : 36, height: touch ? 44 : 36, alignItems: "center", justifyContent: "center" }}
    incrementButtonStyle={{ width: touch ? 44 : 36, height: touch ? 44 : 36, alignItems: "center", justifyContent: "center" }}
    decrementButton={<View testID="parallel-dec"><Icon name="minus" size={16} tint={colors.text} /></View>}
    incrementButton={<View testID="parallel-inc"><Icon name="plus" size={16} tint={colors.text} /></View>}
  />;
}

/** A settings section: the gallery's Card (a title above one flat surface). */
const AUTONOMY_DETAIL = (): Record<string, string> => ({
  onboarding: L("Asks you about most things and learns from your answers", "大多数事先问你，从你的回答里学习"),
  assisted: L("Handles routine work, asks you about important things", "常规的事自己做，重要的先问你"),
  autonomous: L("Decides on its own, asks only about high-risk things", "自己拿主意，只有高风险的事才问你"),
});
const cliDetail = (c: string[]) => {
  const name = (x: string) => cliLabel([x]).replace(/^(仅|only)\s*/i, "");
  if (c.length === 1) return L(`Only ${name(c[0]!)}`, `只用 ${name(c[0]!)}`);
  const rest = c.slice(1).map(name).join(" → ");
  return L(`${name(c[0]!)} first, then ${rest} on failure or when out of quota`, `先用 ${name(c[0]!)}，失败或额度用尽时依次换 ${rest}`);
};

type DropdownOption = { id: string; label: string; detail?: string; testID?: string };

/** A labelled value that opens a menu of its choices (each with a line saying what it means). */
function Dropdown(props: { label: string; value: string; options: DropdownOption[]; selected: string; onPick: (id: string) => void; testID?: string }) {
  return (
    <Menu
      align="end"
      offset={6}
      margin={8}
      popupStyle={{ minWidth: 260, maxWidth: 340, padding: 4, borderRadius: radius.control, borderCurve: "continuous", borderWidth: 0.5, borderColor: surfaceEdge(), backgroundColor: colors.surface }}
      trigger={
        <View
          role="button"
          testID={props.testID}
          accessibilityLabel={`${props.label}${L(": ", "：")}${props.value}`}
          hoverStyle={hovered()}
          style={{ flexDirection: "row", alignItems: "center", gap: 6, height: 34, paddingLeft: 11, paddingRight: 9, borderRadius: radius.control, borderCurve: "continuous", borderWidth: 0.5, borderColor: surfaceEdge(), backgroundColor: colors.surface }}
        >
          <Text style={{ fontSize: 13, color: colors.faint }}>{props.label}</Text>
          <Text style={{ fontSize: 14, fontWeight: "500", color: colors.text }}>{props.value}</Text>
          <Icon name="chevron-down" size={12} tint={colors.muted} />
        </View>
      }
    >
      <Each of={props.options}>
        {(o) => (
          <MenuItem
            testID={o().testID}
            role="menuitemradio"
            checked={o().id === props.selected}
            onSelect={() => o().id !== props.selected && props.onPick(o().id)}
            hoverStyle={hovered()}
            style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, paddingVertical: 7, paddingHorizontal: 10, borderRadius: 6 }}
          >
            <View style={{ width: 14, paddingTop: 3 }}>
              <If when={o().id === props.selected}>
                <Icon name="check" size={13} tint={colors.text} />
              </If>
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontSize: 14, fontWeight: "500", color: colors.text }}>{o().label}</Text>
              <If when={o().detail}>
                <Text style={{ fontSize: 12.5, lineHeight: 17, color: colors.muted }}>{o().detail}</Text>
              </If>
            </View>
          </MenuItem>
        )}
      </Each>
    </Menu>
  );
}

function Group(props: { title: string; hint?: string; children: JSX.Element }) {
  return (
    <View style={{ gap: 8 }}>
      <View style={{ gap: 3, paddingHorizontal: 2 }}>
        <Text style={{ fontSize: 15, fontWeight: "600", color: colors.text }}>{props.title}</Text>
        {props.hint ? <Text style={{ fontSize: 13.5, lineHeight: 20, color: colors.muted }}>{props.hint}</Text> : null}
      </View>
      <View style={{ borderRadius: radius.card, borderCurve: "continuous", borderWidth: 0.5, borderColor: surfaceEdge(), overflow: "hidden" }}>{props.children}</View>
    </View>
  );
}

// ---------------------------------------------------------------- notifications (Web Push through host.js; the system's in an installed app)

/** In an installed app (no page host) NSH shows the system's notifications; they appear while the app runs. */
const systemNotifications = () => !host.available();
/** The notifications this run showed, by id, to take them back. Ones without an event to open start with `noop:`. */
const showing = new Set<string>();
const closeNotification = (id: string) => {
  if (!showing.delete(id)) return;
  Notifications.close(id).catch(() => {});
};
function clearNotification(ref: string) {
  if (systemNotifications()) closeNotification(ref);
  else hostCall("clearNotifications", { ref });
}
function setBadge(count: number) {
  if (systemNotifications()) Notifications.setBadge(count).catch(() => {}); // iOS refuses it before the permission
  else hostCall("setBadge", { count });
}
const DEVICES: Record<string, string> = { macos: "Mac", ios: "iPhone", android: "Android", windows: "Windows", linux: "Linux" };

type PushInfo = { supported: boolean; ios: boolean; standalone: boolean; permission: string; subscribed: boolean; endpoint: string | null; device: string };

async function systemInfo(): Promise<PushInfo | null> {
  try {
    const permission = await Notifications.permission();
    if (permission === "unavailable") return null;
    const off = !!(await Storage.getItem(KEYS.notifyOff));
    return { supported: true, ios: false, standalone: true, permission, subscribed: permission === "granted" && !off, endpoint: null, device: DEVICES[platform.os] ?? L("This device", "本设备") };
  } catch {
    return null;
  }
}

/** This device's push state and the steps that change it (the permission prompt needs the press that calls `enable`). */
function createPush(hub: Hub, success: (message: string) => void) {
  const info = signal<PushInfo | null>(null);
  const busy = signal(false);
  const note = signal<string | null>(null);
  const refresh = async () => info.set(systemNotifications() ? await systemInfo() : await hostCall<PushInfo>("pushState"));
  refresh();

  async function run(work: () => Promise<string>) {
    busy.set(true);
    note.set(null);
    try {
      success(await work());
    } catch (e) {
      note.set(e instanceof Error ? e.message : String(e));
    } finally {
      busy.set(false);
      await refresh();
    }
  }
  const enable = () =>
    run(async () => {
      if (systemNotifications()) {
        const permission = await Notifications.requestPermission();
        if (permission === "denied") throw new Error(L("Notifications are blocked. Allow Noop in System Settings, then come back and turn them on.", "通知被拦截了：请在系统设置里允许 Noop 发通知，再回来开启"));
        if (permission !== "granted") throw new Error(L("Notifications aren’t on", "没有开启通知"));
        await Storage.removeItem(KEYS.notifyOff);
        return L("On. Decisions that need you appear as system notifications.", "已开启：需要你决定的事会发到系统通知");
      }
      // Ask the browser first, while the press still counts as the user's gesture.
      const v = hub.api("GET", "/api/push/vapid");
      const key = (await v).data.publicKey;
      if (typeof key !== "string" || !key) throw new Error(L("The server hasn’t set up push yet, so it can’t be turned on", "服务器还没有配置推送，暂时无法开启"));
      const r = await hostCall<{ permission: string; subscription: unknown; device?: string }>("pushEnable", { publicKey: key });
      if (!r) throw new Error(L("Web push isn’t supported here", "这个环境不支持网页推送"));
      if (r.permission === "denied") throw new Error(L("Notifications are blocked. Allow Noop in your browser or system settings, then come back and turn them on.", "通知被拦截了：请在浏览器或系统设置里允许 Noop 发通知，再回来开启"));
      if (r.permission !== "granted" || !r.subscription) throw new Error(L("Notifications aren’t on", "没有开启通知"));
      const s = await hub.api("POST", "/api/push/subscribe", { subscription: r.subscription, device_label: r.device ?? untracked(info)?.device ?? L("Device", "设备") });
      if (!s.ok) throw new Error(L(`Subscription failed (${s.status || "can’t reach the server"})`, `订阅失败（${s.status || "连不上服务器"}）`));
      return L("On. Decisions that need you are pushed to this device.", "已开启：需要你决定的事会推送到这台设备");
    });
  const disable = () =>
    run(async () => {
      if (systemNotifications()) {
        await Storage.setItem(KEYS.notifyOff, "1");
        for (const id of [...showing]) closeNotification(id);
        return L("Notifications are off on this device", "已关闭这台设备的通知");
      }
      const r = await hostCall<{ endpoint: string | null }>("pushDisable");
      if (r?.endpoint) await hub.api("POST", "/api/push/unsubscribe", { endpoint: r.endpoint });
      return L("Notifications are off on this device", "已关闭这台设备的通知");
    });
  const test = () =>
    run(async () => {
      if (systemNotifications()) {
        showing.add("noop:test");
        if (!(await Notifications.show({ id: "noop:test", title: "Noop", body: L("Test notification: system notifications are working.", "测试通知：系统通知已开通。"), silent: true }))) throw new Error(L("The system didn’t accept the notification", "系统没有接收这条通知"));
        return L("Test notification sent", "测试通知已发出");
      }
      const r = await hub.api("POST", "/api/push/test");
      if (!r.ok) throw new Error(L(`Couldn’t send the test notification (${r.status || "can’t reach the server"})`, `测试通知发送失败（${r.status || "连不上服务器"}）`));
      return L("Test notification sent. It should arrive in a few seconds.", "测试通知已发出，几秒内会到");
    });
  /** iOS shows web push only to an app added to the home screen. */
  const needsHomeScreen = () => !!info()?.ios && !info()?.standalone;
  const canAsk = () => !!info()?.supported && !needsHomeScreen();
  return { info, busy, note, refresh, enable, disable, test, needsHomeScreen, canAsk };
}
type Push = ReturnType<typeof createPush>;

function Steps(props: { steps: string[] }) {
  return (
    <View style={{ gap: 8 }}>
      <Each of={props.steps}>
        {(s, i) => (
          <View style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
            <View style={{ width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: tints.accent }}>
              <Text style={{ fontSize: 12.5, fontWeight: "700", color: colors.accent }}>{String(i() + 1)}</Text>
            </View>
            <Text style={{ flex: 1, fontSize: 15, lineHeight: 22, color: colors.text }}>{s()}</Text>
          </View>
        )}
      </Each>
    </View>
  );
}

function NotifySettings(props: { push: Push; view: SettingsView | null; save: (patch: Record<string, unknown>) => void; wide: boolean }) {
  const push = props.push;
  const { prefs, setPrefs, state } = notifyModel(push, () => props.view, props.save);
  const row = (): ViewStyle => ({ gap: 12, paddingHorizontal: 16, paddingVertical: 14, borderTopWidth: 0.5, borderTopColor: surfaceEdge() });
  return (
    <Group title={L("Notifications", "通知")} hint={systemNotifications() ? L("While Noop is running, decisions that need you appear as system notifications. Click one to jump to it.", "Noop 运行时，需要你拍板的事会发系统通知，点开直接到这一条。") : L("Decisions that need you are pushed to your phone. You can pick an option right from the notification.", "需要你拍板的事推送到手机；通知上可以直接选择选项。")}>
      <View style={{ gap: 12, paddingHorizontal: 16, paddingVertical: 14 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Dot tone={push.info()?.subscribed ? "on" : push.info()?.permission === "denied" ? "bad" : "off"} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ fontSize: 15.5, fontWeight: "600", color: colors.text }}>{push.info()?.device ?? L("This device", "本设备")}</Text>
            <Text testID="push-state" style={{ fontSize: 13.5, color: colors.muted }}>{state()}</Text>
          </View>
        </View>
        <If when={push.needsHomeScreen()}>
          <View style={{ gap: 10, padding: 14, borderRadius: radius.inset, backgroundColor: colors.inset, borderWidth: 1, borderColor: colors.line }}>
            <Text style={{ fontSize: 15, fontWeight: "600", color: colors.text }}>{L("Turn on notifications on iPhone", "在 iPhone 上开启通知")}</Text>
            <Steps steps={[L("In Safari, tap the Share button at the bottom", "在 Safari 里点底部的「分享」按钮"), L("Choose “Add to Home Screen”, then tap “Add”", "选「添加到主屏幕」，再点「添加」"), L("Open Noop from the Home Screen, sign in, and tap “Turn on notifications” here", "从主屏幕打开 Noop，登录后回到这里点「开启通知」")]} />
          </View>
        </If>
        <If when={push.info()?.permission === "denied" && !push.needsHomeScreen()}>
          <Text style={{ fontSize: 14, lineHeight: 21, color: colors.muted }}>{systemNotifications() ? L("Allow Noop in System Settings → Notifications, then come back and turn them on.", "在系统设置 → 通知里允许 Noop，再回来开启。") : L("Allow Noop in the browser’s site settings (or System Settings → Notifications), then reload and turn them on.", "在浏览器的网站设置（或系统设置 → 通知）里允许 Noop，然后刷新页面再开启。")}</Text>
        </If>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <If
            when={push.info()?.subscribed}
            else={<Btn testID="push-enable" label={L("Turn on notifications", "开启通知")} icon="bell" kind="primary" busy={push.busy()} disabled={!push.canAsk()} onPress={push.enable} />}
          >
            <Btn testID="push-test" label={L("Send test notification", "发送测试通知")} icon="bell" busy={push.busy()} onPress={push.test} />
            <Btn testID="push-disable" label={L("Turn off on this device", "关闭本设备通知")} kind="ghost" onPress={push.disable} />
          </If>
        </View>
        <If when={push.note()}>
          <Text testID="push-note" style={{ fontSize: 14, lineHeight: 20, color: colors.danger }}>{push.note()}</Text>
        </If>
      </View>
      <If when={props.view}>
        <View style={row()}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: colors.muted }}>{L("What to push", "推送哪些")}</Text>
          <Each of={NOTIFY_KINDS()}>
            {(k) => (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 36 }}>
                <Text style={{ flex: 1, fontSize: 15.5, color: colors.text }}>{k()[1]}</Text>
                <Toggle
                  testID={`notify-${k()[0]}`}
                  label={k()[1]}
                  value={prefs().kinds[k()[0]]}
                  onChange={(on) => setPrefs({ kinds: { ...prefs().kinds, [k()[0]]: on } })}
                />
              </View>
            )}
          </Each>
        </View>
        <View style={row()}>
          <View style={{ gap: 2 }}>
            <Text style={{ fontSize: 14, fontWeight: "600", color: colors.muted }}>{L("Quiet hours", "免打扰时段")}</Text>
            <Text style={{ fontSize: 13, color: colors.faint }}>{L(`Recorded but not pushed during these hours (time zone ${prefs().tz})`, `这段时间只记下，不推送（时区 ${prefs().tz}）`)}</Text>
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            <Each of={QUIET_PRESETS()}>
              {(q) => (
                <Chip
                  testID={`quiet-${quietKey(q().value)}`}
                  label={q().label}
                  on={quietKey(q().value) === quietKey(prefs().quiet_hours)}
                  onPress={() => setPrefs({ quiet_hours: q().value })}
                />
              )}
            </Each>
          </View>
        </View>
      </If>
    </Group>
  );
}

/** The team's settings, shared by the settings page and the pages it pushes on phones. */
function createSettings(hub: Hub) {
  const view = signal<SettingsView | null>(null);
  const error = signal("");
  const toast = createSettingsToast();
  const saving = signal(0);
  let writes = Promise.resolve();
  let revision = 0;
  let confirmed: SettingsView | null = null;
  const pending: { patch: Record<string, unknown> }[] = [];
  function merge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
    const result = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      const previous = result[key];
      result[key] = value && typeof value === "object" && !Array.isArray(value)
        ? merge(previous && typeof previous === "object" && !Array.isArray(previous) ? previous as Record<string, unknown> : {}, value as Record<string, unknown>)
        : value;
    }
    return result;
  }
  function displayed(v: SettingsView): SettingsView {
    const current = v.current as { clis?: { agents?: Record<string, string[]> }; autonomy?: { agents?: Record<string, string> }; routines?: Record<string, { enabled?: boolean; every?: string }>; host?: { max_parallel?: number } };
    return { ...v, effective: { ...v.effective,
      agents: v.effective.agents.map((a) => ({ ...a, clis: current.clis?.agents?.[a.id] ?? a.clis, autonomy: current.autonomy?.agents?.[a.id] ?? a.autonomy })),
      routines: v.effective.routines.map((r) => ({ ...r, ...current.routines?.[r.name] })),
      max_parallel: current.host?.max_parallel ?? v.effective.max_parallel,
    } };
  }
  function refresh() {
    if (!confirmed) return;
    const current = pending.reduce((state, item) => merge(state, item.patch), confirmed.current);
    view.set(displayed({ ...confirmed, current }));
  }
  const load = () => {
    error.set("");
    const started = revision;
    hub.settings().then((v) => { if (started === revision && !saving()) { confirmed = v; refresh(); } }, (e) => { if (started === revision && !saving()) error.set(String(e?.message ?? e)); });
  };
  async function save(patch: Record<string, unknown>) {
    revision++;
    error.set("");
    toast.dismiss();
    saving.update((n) => n + 1);
    const item = { patch };
    pending.push(item);
    refresh();
    try {
      const request = writes.then(() => hub.settings(patch));
      writes = request.then(() => {}, () => {});
      confirmed = await request;
    } catch (e) {
      error.set(e instanceof Error ? e.message : String(e));
    } finally {
      pending.splice(pending.indexOf(item), 1);
      refresh();
      saving.update((n) => n - 1);
      if (!saving() && !error()) {
        toast.show(L("Saved", "已保存"));
      }
    }
  }
  // the command being added in 常用指令 (kept here: the settings page may be laid out again while typing)
  /** The command editor: `editing` is undefined when closed, "" for a new command, else the name being edited. */
  const commandDraft = { name: signal(""), text: signal(""), editing: signal<string | undefined>(undefined), note: signal("") };
  /** The section the wide settings page shows (its sidebar picks it). */
  const tab = signal<SettingsTab>("notify");
  return { view, error, toast, saving, load, save, commandDraft, tab };
}
type Settings = ReturnType<typeof createSettings>;

/** The sections of the wide settings page, in its sidebar's order. */
const SETTINGS_TABS = () => [
  ["notify", L("Notifications", "通知"), "bell"],
  ["members", L("Members", "成员"), "chat"],
  ["routines", L("Routines", "例行任务"), "play"],
  ["parallel", L("Parallelism", "并行"), "layers"],
  ["commands", L("Commands", "常用指令"), "terminal"],
  ["storage", L("Storage", "存储"), "photos"],
  ["version", L("Version", "版本"), "github"],
  ["rules", L("Rules & memory", "规则与记忆"), "scroll"],
  ["account", L("Account", "账号与连接"), "lock"],
] as const;
type SettingsTab = ReturnType<typeof SETTINGS_TABS>[number][0];

/** The wide (desktop, tablet, wide browser) settings page. */
function TeamSettings(props: { hub: Hub; push: Push; settings: Settings; wide: boolean; onRules: () => void; onConnection: () => void; onDisconnect: () => void }) {
  const { view, error, save } = props.settings;
  props.settings.load();
  const eff = () => view()?.effective;
  const row = (): ViewStyle => ({ gap: 12, paddingHorizontal: 16, paddingVertical: 14, borderTopWidth: 0.5, borderTopColor: surfaceEdge() });
  const chips: ViewStyle = { flexDirection: "row", flexWrap: "wrap", gap: 6 };

  const tab = props.settings.tab;
  const on = (k: SettingsTab) => tab() === k;
  return (
    <View style={{ flex: 1, flexDirection: "row" }}>
      <View testID="settings-nav" role="tablist" style={{ width: 208, gap: 2, paddingHorizontal: 10, paddingVertical: 20, borderRightWidth: 0.5, borderRightColor: surfaceEdge() }}>
        <Each of={[...SETTINGS_TABS()]}>
          {(x) => (
            <View
              role="tab"
              testID={`settings-tab-${x()[0]}`}
              accessibilityLabel={x()[1]}
              accessibilityState={{ selected: on(x()[0]) }}
              onPress={() => tab.set(x()[0])}
              hoverStyle={on(x()[0]) ? undefined : hovered()}
              style={{ flexDirection: "row", alignItems: "center", gap: 10, height: 36, paddingHorizontal: 10, borderRadius: 8, backgroundColor: on(x()[0]) ? colors.raised : undefined }}
            >
              <Icon name={x()[2]} size={16} tint={on(x()[0]) ? colors.text : colors.muted} />
              <Text style={{ fontSize: 14.5, fontWeight: on(x()[0]) ? "600" : "400", color: on(x()[0]) ? colors.text : colors.muted }}>{x()[1]}</Text>
            </View>
          )}
        </Each>
      </View>
    <Scroll style={{ flex: 1 }}>
      <View style={{ width: "100%", maxWidth: size.column, alignSelf: "center", gap: 28, paddingHorizontal: props.wide ? 32 : 16, paddingTop: props.wide ? 28 : 18, paddingBottom: 48 }}>
        <If when={error()}>
          <Text testID="settings-note" style={{ alignSelf: "flex-end", fontSize: 13.5, color: error() ? colors.danger : colors.up }}>{error()}</Text>
        </If>
        <If when={on("notify")}>
          <NotifySettings push={props.push} view={view()} save={save} wide={props.wide} />
        </If>
        <If when={on("members") || on("routines") || on("parallel")}>
        <If when={eff()} else={<Text style={{ fontSize: 14, color: colors.faint }}>{error() ? "" : L("Loading…", "读取中…")}</Text>}>
          {(e) => (
            <View style={{ gap: 28 }}>
              <If when={on("members")}>
              <Group title={L("Members", "成员")} hint={L("Each role on the team. The model decides who does the work; autonomy decides how big a decision needs your input first.", "团队里的每个角色。模型决定由谁来干活，自主程度决定多大的事要先问你。")}>
                <Each of={e().agents} key={(a) => a.id}>
                  {(a, i) => (
                    <View testID={`member-${a().id}`} style={{ flexDirection: props.wide ? "row" : "column", alignItems: props.wide ? "center" : "stretch", gap: 12, paddingHorizontal: 16, paddingVertical: 14, borderTopWidth: i() === 0 ? 0 : 0.5, borderTopColor: surfaceEdge() }}>
                      <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 12 }}>
                        <Avatar from={a().id} />
                        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
                            <Text style={{ fontSize: 15.5, fontWeight: "600", color: colors.text, numberOfLines: 1 }}>{displayName(a().id)}</Text>
                            <If when={displayName(a().id) !== a().id}>
                              <Text style={{ fontFamily: MONO, fontSize: 12.5, color: colors.faint, numberOfLines: 1 }}>{a().id}</Text>
                            </If>
                          </View>
                          <If when={a().about}>
                            <Text testID={`member-about-${a().id}`} style={{ fontSize: 13.5, lineHeight: 19, color: colors.muted, numberOfLines: 2 }}>{a().about}</Text>
                          </If>
                        </View>
                      </View>
                      <View style={{ flexDirection: "row", gap: 8, paddingLeft: props.wide ? 0 : 52 }}>
                        <Dropdown
                          testID={`cli-${a().id}`}
                          label={L("Model", "模型")}
                          value={cliLabel(a().clis)}
                          options={view()!.options.clis.map((c) => ({ id: cliKey(c), label: cliLabel(c), detail: cliDetail(c), testID: `cli-${a().id}-${cliKey(c)}` }))}
                          selected={cliKey(a().clis)}
                          onPick={(k) => { const c = view()!.options.clis.find((x) => cliKey(x) === k); if (c) save(patches.clis(a().id, c)); }}
                        />
                        <Dropdown
                          testID={`autonomy-${a().id}`}
                          label={L("Autonomy", "自主程度")}
                          value={autonomyLabel(a().autonomy)}
                          options={view()!.options.autonomy.map((l) => ({ id: l, label: autonomyLabel(l), detail: AUTONOMY_DETAIL()[l], testID: `autonomy-${a().id}-${l}` }))}
                          selected={a().autonomy}
                          onPick={(l) => save(patches.autonomy(a().id, l))}
                        />
                      </View>
                    </View>
                  )}
                </Each>
              </Group>
              </If>

              <If when={on("routines")}>
              <Group title={L("Routines", "例行任务")} hint={L("Rules that create tasks on a schedule: on/off and when they run", "定时生成任务的规则：开关和运行时间")}>
                <Each of={e().routines} key={(r) => r.name}>
                  {(r, i) => (
                    <View style={{ ...row(), flexDirection: "row", alignItems: "center", gap: 12, borderTopWidth: i() === 0 ? 0 : 0.5 }}>
                      <View style={{ flex: 1, gap: 3 }}>
                        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
                          <Text style={{ fontSize: 15.5, fontWeight: "500", color: r().enabled ? colors.text : colors.faint }}>{r().name}</Text>
                          <If when={r().agent}>
                            <Text style={{ fontSize: 12.5, color: colors.faint }}>{e().agents.find((a) => a.id === r().agent)?.title ?? r().agent}</Text>
                          </If>
                        </View>
                        <If when={r().desc}>
                          <Text testID={`routine-desc-${r().name}`} style={{ fontSize: 13, lineHeight: 18, color: colors.muted }}>{r().desc}</Text>
                        </If>
                      </View>
                      <Dropdown
                        testID={`every-${r().name}`}
                        label={L("Runs", "运行")}
                        value={everyLabel(r().every)}
                        options={intervalsWith(r().every).map((iv) => ({ id: iv, label: everyLabel(iv), testID: `every-${r().name}-${iv}` }))}
                        selected={r().every}
                        onPick={(iv) => save(patches.routine(r().name, { every: iv }))}
                      />
                      <Toggle
                        testID={`routine-${r().name}`}
                        label={r().name}
                        value={r().enabled}
                        onChange={(on) => save(patches.routine(r().name, { enabled: on }))}
                      />
                    </View>
                  )}
                </Each>
              </Group>
              </If>

              <If when={on("parallel")}>
              <Group title={L("Parallelism", "并行")}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 14 }}>
                  <Text style={{ flex: 1, fontSize: 15.5, color: colors.text }}>{L("Tasks each machine runs at once", "每台机器同时运行的任务数")}</Text>
                  <ParallelInput value={e().max_parallel ?? 2} onChange={(value) => save(patches.maxParallel(value))} />
                </View>
              </Group>
              </If>
            </View>
          )}
        </If>
        </If>
        <If when={on("commands")}>
        <Group title={L("Commands", "常用指令")} hint={L("Type / in the message box to use one. Built-in commands perform an action; ones you add send a message to the team.", "在输入框里输入 / 选用。内置指令执行操作，你添加的指令把一段话发给团队。")}>
          <CommandRows settings={props.settings} />
        </Group>
        </If>
        <If when={on("storage")}>
        <Group title={L("Image retention", "图片保留")} hint={MEDIA_HINT()}>
          <MediaDaysChoices settings={props.settings} />
        </Group>
        </If>
        <If when={on("version")}>
        <Group title={L("Version", "版本")} hint={L("The code each machine runs. Updating makes every machine pull the latest code, and the primary also redeploys the server.", "每台机器运行的代码。更新会让所有机器拉取最新代码，主控机同时重新发布线上。")}>
          <VersionRows hub={props.hub} />
        </Group>
        </If>
        <If when={on("rules")}>
        <Group title={L("Memory", "记忆")} hint={L("The rules the team works by, your preferences, member profiles and past decisions. Read-only.", "团队做事依据的规则、你的偏好、成员档案和决策先例。只读。")}>
          <SetRow first label={L("View rules & memory", "查看规则与记忆")} chevron onPress={props.onRules} testID="settings-rules" />
        </Group>
        </If>
        <If when={on("account")}>
        <Group title={L("Language", "语言")}>
          <LangChoices />
        </Group>
        <Group title={L("Account", "账号与连接")} hint={L("You stay signed in on this device and reconnect automatically next time.", "登录状态保存在这台设备上，下次打开自动连接。")}>
          <View style={{ flexDirection: props.wide ? "row" : "column", alignItems: props.wide ? "center" : "stretch", gap: 10, paddingHorizontal: 16, paddingVertical: 14 }}>
            <View style={{ flex: props.wide ? 1 : undefined, flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Dot tone={props.hub.conn() === "live" ? "on" : props.hub.conn() === "unauthorized" || props.hub.conn() === "blocked" ? "bad" : "wait"} />
              <Text style={{ flex: 1, fontSize: 15, color: colors.text, numberOfLines: 1 }}>{props.hub.cfg.url}</Text>
            </View>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Btn label={L("Sign out", "退出登录")} kind="danger" onPress={props.onDisconnect} testID="logout" />
            </View>
          </View>
        </Group>
        </If>
      </View>
    </Scroll>
    </View>
  );
}

// ---------------------------------------------------------------- settings on phones (iOS / Android Settings)

/** What the notification settings show and change, for both layouts. */
function notifyModel(push: Push, view: () => SettingsView | null, save: (patch: Record<string, unknown>) => void) {
  const tz = "Asia/Singapore";
  const prefs = () => notifyPrefsOf(view(), tz);
  const setPrefs = (change: Partial<NotifyPrefs>) => save(notifyPatch({ ...prefs(), ...change }));
  const state = () => {
    const i = push.info();
    if (!i) return systemNotifications() ? L("System notifications aren’t available here (open the hub’s web page in a phone browser to get push)", "这个环境还不能发系统通知（可以在手机浏览器打开 hub 的网页接收推送）") : L("Web push isn’t supported here (open the hub’s web page in a phone browser)", "这个环境不支持网页推送（请用手机浏览器打开 hub 的网页）");
    if (push.needsHomeScreen()) return L("On iPhone, add Noop to the Home Screen first", "iPhone 需要先把 Noop 添加到主屏幕");
    if (!i.supported) return L("This browser doesn’t support web push", "这个浏览器不支持网页推送");
    if (i.permission === "denied") return systemNotifications() ? L("Blocked by the system", "通知被系统拦截了") : L("Blocked by the browser", "通知被浏览器拦截了");
    return i.subscribed ? L("On", "已开启") : L("Off", "未开启");
  };
  /** The short form for a row's value. */
  const short = () => {
    const i = push.info();
    if (!i || !i.supported || push.needsHomeScreen()) return L("Unavailable", "不可用");
    if (i.permission === "denied") return L("Blocked", "已拦截");
    return i.subscribed ? L("On", "已开启") : L("Off", "未开启");
  };
  return { prefs, setPrefs, state, short };
}

/** A grouped, inset section: a muted title above, rows on one rounded surface, a hint below. */
function Section(props: { title?: string; hint?: string; testID?: string; children: JSX.Element }) {
  return (
    <View testID={props.testID} style={{ gap: 7 }}>
      <If when={props.title}>
        <Text style={{ paddingHorizontal: 32, fontSize: 13, color: colors.muted }}>{props.title}</Text>
      </If>
      <View style={{ marginHorizontal: 16, borderRadius: radius.card, borderCurve: "continuous", borderWidth: 0.5, borderColor: surfaceEdge(), overflow: "hidden", backgroundColor: colors.surface }}>{props.children}</View>
      <If when={props.hint}>
        <Text style={{ paddingHorizontal: 32, fontSize: 13, lineHeight: 18, color: colors.faint }}>{props.hint}</Text>
      </If>
    </View>
  );
}

/** The hairline above every row of a section but its first, inset to the text. */
function Hairline(props: { inset?: number }) {
  return <View style={{ position: "absolute", top: 0, left: props.inset ?? 16, right: 0, height: 0.5, backgroundColor: surfaceEdge() }} />;
}

/** A row of a section, at least 48 pt tall: a label (and a line under it), then a value, a control or a chevron. */
/** The code a machine runs: the short commit, a link to it on GitHub. */
function RevLink(props: { host: HostInfo }) {
  const short = () => (props.host.rev ?? "").slice(0, 7);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <Text style={{ fontSize: 14, color: colors.muted }}>{L("Version", "版本")}</Text>
      <Text
        role={props.host.rev_url ? "link" : undefined}
        testID={`rev-${props.host.host}`}
        accessibilityLabel={L(`Version ${short()}`, `版本 ${short()}`)}
        onPress={props.host.rev_url ? () => void openUrl(props.host.rev_url!).catch(() => {}) : undefined}
        style={{ fontFamily: MONO, fontSize: 13, color: props.host.rev_url ? linkColor() : colors.muted }}
      >
        {short()}
      </Text>
    </View>
  );
}

/** Ask every machine to update to the latest code; the primary also redeploys the web app and the Worker. */
async function updateAllMachines(hub: Hub) {
  const r = await AlertDialog.show({
    title: L("Update all machines?", "更新所有机器？"),
    description: L("Each machine pulls the latest code and restarts. Idle machines update now; busy ones restart when their tasks finish. The primary also redeploys the server.", "每台机器拉取最新代码后重启：空闲的马上更新，有任务在跑的等跑完再重启。主控机同时重新发布线上。"),
    actions: [
      { id: "cancel", label: L("Cancel", "取消"), role: "cancel" },
      { id: "update", label: L("Update", "更新") },
    ],
  });
  if (r.action === "update") await hub.api("POST", "/api/fleet/update").catch(() => {});
}

/** One row per online machine with the commit it runs, then the button that updates them all. */
/** The commands typed after "/" in the composer: the built-ins, the saved ones (deletable), and a form to add one. */
function CommandRows(props: { settings: Settings }) {
  const { view, save } = props.settings;
  const saved = () => savedCommands(view());
  const { name, text, editing, note } = props.settings.commandDraft;
  const open = (c?: Command) => {
    name.set(c?.name ?? ""); text.set(c?.text ?? ""); note.set("");
    editing.set(c?.name ?? "");
  };
  return (
    <>
      <SetRow
        first
        label={L("/Update all machines", "/更新所有机器")}
        detail={L("Make every machine pull the latest code and restart", "让所有机器拉取最新代码并重启")}
        testID="command-row-builtin"
        trailing={<Text style={{ fontSize: 12, color: colors.faint, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, backgroundColor: colors.raised }}>{L("Built-in", "内置")}</Text>}
      />
      <Each of={saved()} key={(c) => c.name}>
        {(c) => (
          <View
            role="button"
            testID={`command-row-${c().name}`}
            accessibilityLabel={L(`Edit command ${c().name}`, `编辑指令 ${c().name}`)}
            onPress={() => open(c())}
            hoverStyle={hovered()}
            class="active:bg-raised"
          >
            <Hairline />
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingLeft: 16, paddingRight: 14, paddingVertical: 11 }}>
              <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                <Text style={{ fontSize: 15.5, fontWeight: "500", color: colors.text, numberOfLines: 1 }}>/{c().name}</Text>
                <Text style={{ fontSize: 13.5, lineHeight: 19, color: colors.muted, numberOfLines: 2 }}>{c().text}</Text>
              </View>
              <Icon name="chevron" size={14} tint={colors.faint} />
            </View>
          </View>
        )}
      </Each>
      <SetRow label={L("New command", "新建指令")} tone="accent" leading={<Icon name="plus" size={16} tint={colors.info} />} onPress={() => open()} testID="command-new" />
      <CommandEditor settings={props.settings} />
    </>
  );
}

/** New / edit / delete one saved command, in a dialog: a name and the words it sends (several lines welcome). */
function CommandEditor(props: { settings: Settings }) {
  const { view, save } = props.settings;
  const { name, text, editing, note } = props.settings.commandDraft;
  const isNew = () => editing() === "";
  const close = () => editing.set(undefined);
  const others = () => savedCommands(view()).filter((c) => c.name !== editing());
  const clean = () => name().trim().replace(/^\//, "").replace(/\s+/g, "-");
  const ok = () => !!clean() && !!text().trim();
  const submit = async () => {
    const n = clean(), t = text().trim();
    if (!n) return note.set(L("Give the command a name", "给指令起个名字"));
    if (!t) return note.set(L("Write what this command sends to the team", "写下这条指令要发给团队的话"));
    if (BUILTIN_COMMANDS().some((b) => b.name === n)) return note.set(L(`“${n}” is a built-in command`, `「${n}」是内置指令的名字`));
    if (others().some((c) => c.name === n)) return note.set(L(`“/${n}” already exists`, `已经有一条「/${n}」`));
    const list = savedCommands(view());
    const i = list.findIndex((c) => c.name === editing());
    const next = i < 0 ? [...list, { name: n, text: t }] : list.map((c, j) => (j === i ? { name: n, text: t } : c));
    close();
    await save({ commands: next });
  };
  const remove = async () => {
    const n = editing();
    close();
    await save({ commands: savedCommands(view()).filter((c) => c.name !== n) });
  };
  const focused = signal(false);
  return (
    <Dialog
      testID="command-editor"
      open={editing() !== undefined}
      animation="fade"
      onOpenChange={({ open }) => !open && close()}
      backdropClass="bg-scrim"
      style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 16, pointerEvents: "box-none" }}
    >
      <View style={{ width: "100%", maxWidth: 560, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, overflow: "hidden" }}>
        <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: 20, paddingRight: 10, height: 56, borderBottomWidth: 0.5, borderBottomColor: surfaceEdge() }}>
          <Text style={{ flex: 1, fontSize: 17, fontWeight: "600", color: colors.text }}>{isNew() ? L("New command", "新建指令") : L("Edit command", "编辑指令")}</Text>
          <ToolButton icon="close" label={L("Close", "关闭")} shortcut="Esc" onPress={close} />
        </View>
        <View style={{ gap: 16, padding: 20 }}>
          <Field label={L("Name", "名称")} value={name()} onChange={(v) => { name.set(v); note.set(""); }} placeholder={L("e.g. daily-report", "例如：日报")} testID="command-name" autoFocus={isNew()} hint={clean() ? L(`Type /${clean()} in the message box to use it`, `在输入框里输入 /${clean()} 选用`) : L("Type / and the name in the message box to use it", "在输入框里输入 / 加名称选用")} />
          <View style={{ gap: 7 }}>
            <Text style={{ fontSize: 14, fontWeight: "600", color: colors.text }}>{L("Message to the team", "发给团队的话")}</Text>
            <Input
              testID="command-text"
              multiline
              value={text()}
              onChange={({ value }) => { text.set(value); note.set(""); }}
              onFocus={() => focused.set(true)}
              onBlur={() => focused.set(false)}
              placeholder={L("e.g. Summarize today’s progress on each project as a daily report,\none section per project, conclusion first.", "例如：把今天各项目的进展整理成日报发给我，\n按项目分段，每段先说结论。")}
              class="placeholder:text-faint"
              style={{
                height: 140,
                paddingHorizontal: 14,
                paddingVertical: 10,
                borderRadius: radius.control,
                borderWidth: 1,
                borderColor: focused() ? colors.accent : colors.fieldBorder,
                backgroundColor: colors.field,
                fontSize: 15.5,
                lineHeight: 23,
                color: colors.text,
                ...(focused() ? { outlineStyle: "solid", outlineWidth: 3, outlineColor: alpha(colors.accent, 0.12) } : {}),
              }}
            />
          </View>
          <If when={note()}>
            <Text testID="command-note" style={{ fontSize: 13.5, color: colors.danger }}>{note()}</Text>
          </If>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 20, paddingBottom: 20 }}>
          <If when={!isNew()}>
            <Btn label={L("Delete", "删除")} kind="danger" icon="trash" onPress={() => void remove()} testID="command-delete" />
          </If>
          <View style={{ flex: 1 }} />
          <Btn label={L("Cancel", "取消")} kind="ghost" onPress={close} testID="command-cancel" />
          <Btn label={isNew() ? L("Add", "添加") : L("Save", "保存")} kind="primary" disabled={!ok()} onPress={() => void submit()} testID="command-save" />
        </View>
      </View>
    </Dialog>
  );
}

function VersionRows(props: { hub: Hub }) {
  const hosts = () => props.hub.status()?.hosts ?? [];
  // the lines age (waiting → not responding, finished → hidden): re-read the clock every few seconds
  const clock = signal(Date.now());
  const timer = setInterval(() => clock.set(Date.now()), 5000);
  cleanup(() => clearInterval(timer));
  const request = () => props.hub.status()?.update?.at;
  const summary = () => updateSummary(props.hub.status(), clock());
  const toneColor = (t: UpdateLine["tone"]) => (t === "ok" ? colors.up : t === "bad" ? colors.danger : colors.muted);
  // This app's own code: the release it was built for, or the OTA package it runs (nsh/updater).
  const ota = runningPackage();
  const client = ota ? L(`${ota.version} · OTA build ${ota.build}`, `${ota.version} · OTA 构建 ${ota.build}`) : CLIENT_VERSION;
  // The installed app around that code (on iOS its CFBundleShortVersionString / CFBundleVersion) and its NSH runtime.
  const info = (nshUpdater as { shellInfo?: () => ShellInfo }).shellInfo?.();
  const shell = shellLine(info, platform.os);
  const shellText = shell?.text === "no-packages" ? L(`${info!.version ?? "?"} (${info!.build ?? "?"}) takes no over-the-air updates: install the app again`, `${info!.version ?? "?"}（${info!.build ?? "?"}）收不到自动更新：请重新安装 App`)
    : shell?.text;
  return (
    <>
      <SetRow first label={L("This app", "本机客户端")} value={client} testID="version-client" />
      <If when={shell}>
        <SetRow label={L("App shell", "外壳")} value={shell?.tone === "ok" ? shellText : undefined} detail={shell?.tone === "bad" ? shellText : undefined} tone={shell?.tone === "bad" ? "danger" : undefined} testID="version-shell" />
      </If>
      <Each of={hosts()} key={(h) => h.host}>
        {(h) => {
          const line = () => updateLine(h(), request(), clock());
          return (
            <SetRow
              label={h().host}
              value={h().rev?.slice(0, 7) ?? L("Unknown", "未知")}
              chevron={!!h().rev_url}
              onPress={h().rev_url ? () => void openUrl(h().rev_url!).catch(() => {}) : undefined}
              testID={`version-${h().host}`}
              below={
                <If when={line()}>
                  <View testID={`update-${h().host}`} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <If when={line()!.busy}>
                      <Spinner size={12} tint={colors.muted} />
                    </If>
                    <Text style={{ flexShrink: 1, fontSize: 13, lineHeight: 18, color: toneColor(line()!.tone) }}>{line()!.text}</Text>
                  </View>
                </If>
              }
            />
          );
        }}
      </Each>
      <SetRow
        first={!hosts().length}
        label={summary()?.busy ? L("Updating…", "正在更新…") : L("Update all machines", "更新所有机器")}
        detail={summary()?.text}
        tone="accent"
        disabled={!!summary()?.busy}
        onPress={() => void updateAllMachines(props.hub)}
        testID="update-fleet"
      />
    </>
  );
}

function SetRow(props: {
  label: string;
  detail?: string;
  value?: string;
  first?: boolean;
  chevron?: boolean;
  tone?: "danger" | "accent";
  leading?: JSX.Element;
  trailing?: JSX.Element;
  /** Under the label and detail (a progress line). */
  below?: JSX.Element;
  inset?: number;
  disabled?: boolean;
  onPress?: () => void;
  testID?: string;
}) {
  const press = () => (props.disabled ? undefined : props.onPress);
  return (
    <View
      role={props.onPress ? "button" : undefined}
      testID={props.testID}
      accessibilityLabel={props.onPress ? [props.label, props.value].filter(Boolean).join("，") : undefined}
      accessibilityState={props.onPress ? { disabled: !!props.disabled } : undefined}
      onPress={press()}
      class={props.onPress && !props.disabled ? "active:bg-raised" : undefined}
      style={{ minHeight: 48, flexDirection: "row", alignItems: "center", gap: 12, paddingLeft: 16, paddingRight: 14, paddingVertical: 10 }}
    >
      <If when={!props.first}>
        <Hairline inset={props.inset} />
      </If>
      {props.leading}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text
          style={{
            fontSize: 16,
            textAlign: props.tone === "danger" && !props.trailing && !props.chevron ? "center" : "left",
            color: props.disabled ? colors.faint : props.tone === "danger" ? colors.danger : props.tone === "accent" ? colors.info : colors.text,
            numberOfLines: 1,
          }}
        >
          {props.label}
        </Text>
        <If when={props.detail}>
          <Text style={{ fontSize: 13, lineHeight: 18, color: colors.muted }}>{props.detail}</Text>
        </If>
        {props.below}
      </View>
      <If when={props.value}>
        <Text style={{ flexShrink: 1, fontSize: 16, color: colors.muted, numberOfLines: 1 }}>{props.value}</Text>
      </If>
      {props.trailing}
      <If when={props.chevron}>
        <Icon name="chevron" size={14} tint={colors.faint} />
      </If>
    </View>
  );
}

const MEDIA_HINT = () => L("How long screenshots and images in the chat are kept. They’re deleted when they expire.", "聊天里的截图和图片保存多久，过期后自动删除。");

/** How long images are kept: 7, 14, 30 or 90 days. */
function MediaDaysChoices(props: { settings: Settings }) {
  const { view, save } = props.settings;
  return (
    <Choices
      label={L("Image retention", "图片保留")}
      choices={MEDIA_DAYS.map((d) => ({ id: String(d), label: L(`${d} days`, `${d} 天`), testID: `media-days-${d}` }))}
      selected={view() ? String(mediaDaysOf(view())) : null}
      onPick={(id) => save(patches.mediaDays(Number(id)))}
    />
  );
}

type Choice = { id: string; label: string; detail?: string; testID: string };

/** Pick one of a few: a radio set of rows, the chosen one checked. */
function Choices(props: { label: string; choices: Choice[]; selected: string | null; onPick: (id: string) => void }) {
  return (
    <RadioGroup>
      <Each of={props.choices} key={(c) => c.id}>
        {(c, i) => (
          <Radio
            testID={c().testID}
            checked={c().id === props.selected}
            onChange={() => props.onPick(c().id)}
            accessibilityLabel={c().label}
            class="active:bg-raised"
            style={{ minHeight: 48, flexDirection: "row", alignItems: "center", gap: 12, paddingLeft: 16, paddingRight: 16, paddingVertical: 10 }}
          >
            <If when={i() > 0}>
              <Hairline />
            </If>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontSize: 16, color: colors.text }}>{c().label}</Text>
              <If when={c().detail}>
                <Text style={{ fontSize: 13, color: colors.muted }}>{c().detail}</Text>
              </If>
            </View>
            <View style={{ width: 20, alignItems: "center" }}>
              <If when={c().id === props.selected}>
                <View testID={`choice-check-${c().testID}`}><Icon name="check" size={17} tint={colors.info} /></View>
              </If>
            </View>
          </Radio>
        )}
      </Each>
    </RadioGroup>
  );
}

/** A page of sections on the grouped background. */
function Grouped(props: { testID?: string; settings?: Settings; children: JSX.Element }) {
  return (
    <View style={{ flex: 1, backgroundColor: platform.os === "ios" ? (isDark() ? "#1c1c1e" : "#f2f2f2") : colors.background }}>
      <If when={props.settings}><SaveNote settings={props.settings!} /></If>
      <Scroll testID={props.testID} style={{ flex: 1 }}>
        <View style={{ width: "100%", maxWidth: 640, alignSelf: "center", gap: 28, paddingTop: 20, paddingBottom: Math.max(32, safeArea().bottom + 16) }}>{props.children}</View>
      </Scroll>
    </View>
  );
}

function SaveNote(props: { settings: Settings }) {
  return (
    <If when={props.settings.error()}>
      <Text testID="settings-note" style={{ paddingHorizontal: 32, paddingVertical: 8, fontSize: 13, color: props.settings.error() ? colors.danger : colors.up }}>
        {props.settings.error()}
      </Text>
    </If>
  );
}

const routineValue = (r: { enabled: boolean; every: string }) => (r.enabled ? everyLabel(r.every) : L("Off", "已关闭"));

/** 设置 on a phone: a list of sections; 通知, each member and each routine push pages of their own. */
function PhoneSettings(props: { hub: Hub; push: Push; settings: Settings; onOpen: (r: Route) => void; onDisconnect: () => void }) {
  const { view, error, save } = props.settings;
  props.settings.load();
  const notify = notifyModel(props.push, view, save);
  const eff = () => view()?.effective;
  async function logout() {
    const r = await AlertDialog.show({
      title: L("Sign out?", "退出登录？"),
      description: L("Notifications will be turned off on this device, and you’ll need to sign in again next time.", "这台设备会关闭通知，下次打开需要重新登录。"),
      actions: [
        { id: "cancel", label: L("Cancel", "取消"), role: "cancel" },
        { id: "logout", label: L("Sign out", "退出登录"), role: "destructive" },
      ],
    });
    if (r.action === "logout") props.onDisconnect();
  }
  return (
    <Grouped testID="phone-settings" settings={props.settings}>
      <Section title={L("Notifications", "通知")} hint={L("Decisions that need you are pushed to this device. You can pick an option right from the notification.", "需要你拍板的事推送到这台设备；通知上可以直接选择选项。")}>
        <SetRow first label={L("Notifications", "通知")} value={notify.short()} chevron onPress={() => props.onOpen({ name: "notify" })} testID="settings-notify" />
      </Section>
      <Section title={L("Language", "语言")}>
        <LangChoices />
      </Section>
      <Section title={L("Memory", "记忆")} hint={L("The rules the team works by, your preferences, member profiles and past decisions. Read-only.", "团队做事依据的规则、你的偏好、成员档案和决策先例。只读。")}>
        <SetRow first label={L("Rules & memory", "规则与记忆")} chevron onPress={() => props.onOpen({ name: "rules" })} testID="settings-rules" />
      </Section>
      <If when={eff()} else={<Text style={{ paddingHorizontal: 32, fontSize: 14, color: colors.faint }}>{error() ? L("Couldn’t load settings", "设置读取失败") : L("Loading…", "读取中…")}</Text>}>
        {(e) => (
          <View style={{ gap: 28 }}>
            <Section title={L("Members", "成员")} hint={L("Model: which to use first, and which to switch to on failure or when out of quota. Autonomy: how big a decision needs your input first.", "模型：先用哪个、失败或额度用尽时换哪个；自主程度：多大的事需要先问你。")}>
              <Each of={e().agents} key={(a) => a.id}>
                {(a, i) => (
                  <SetRow
                    first={i() === 0}
                    inset={58}
                    leading={<Avatar from={a().id} />}
                    label={displayName(a().id)}
                    detail={`${cliLabel(a().clis)} · ${autonomyLabel(a().autonomy)}`}
                    chevron
                    onPress={() => props.onOpen({ name: "member", id: a().id })}
                    testID={`member-${a().id}`}
                  />
                )}
              </Each>
            </Section>
            <Section title={L("Routines", "例行任务")} hint={L("Things the team does on a schedule.", "团队定时自己做的事。")}>
              <Each of={e().routines} key={(r) => r.name}>
                {(r, i) => (
                  <SetRow
                    first={i() === 0}
                    label={r().name}
                    detail={r().agent}
                    value={routineValue(r())}
                    chevron
                    onPress={() => props.onOpen({ name: "routine", routine: r().name })}
                    testID={`routine-row-${r().name}`}
                  />
                )}
              </Each>
            </Section>
            <Section title={L("Parallelism", "并行")} hint={L("Tasks each machine runs at once, 1 to 32.", "每台机器同时运行的任务数，1 到 32。")}>
              <SetRow
                first
                label={L("At once", "同时运行")}
                trailing={
                  <ParallelInput value={e().max_parallel ?? 2} onChange={(value) => save(patches.maxParallel(value))} />
                }
              />
            </Section>
          </View>
        )}
      </If>
      <Section title={L("Commands", "常用指令")} hint={L("Type / in the message box to use one. Built-in commands perform an action; ones you add send a message to the team.", "在输入框里输入 / 选用。内置指令执行操作，你添加的指令把一段话发给团队。")}>
        <CommandRows settings={props.settings} />
      </Section>
      <Section title={L("Image retention", "图片保留")} hint={MEDIA_HINT()}>
        <MediaDaysChoices settings={props.settings} />
      </Section>
      <Section title={L("Version", "版本")} hint={L("The code each machine runs. Updating makes every machine pull the latest code, and the primary also redeploys the server.", "每台机器运行的代码。更新会让所有机器拉取最新代码，主控机同时重新发布线上。")}>
        <VersionRows hub={props.hub} />
      </Section>
      <Section title={L("Account", "账号与连接")} hint={L("You stay signed in on this device and reconnect automatically next time.", "登录状态保存在这台设备上，下次打开自动连接。")}>
        <SetRow
          first
          leading={<Dot tone={props.hub.conn() === "live" ? "on" : props.hub.conn() === "unauthorized" || props.hub.conn() === "blocked" ? "bad" : "wait"} />}
          label={props.hub.cfg.url.replace(/^https?:\/\//, "")}
        />
        <SetRow label={L("Sign out", "退出登录")} tone="danger" onPress={() => void logout()} testID="logout" inset={0} />
      </Section>
    </Grouped>
  );
}

/** 通知 on a phone: this device, what is pushed, and the quiet hours. */
function PhoneNotify(props: { push: Push; settings: Settings }) {
  const push = props.push;
  const { view, save } = props.settings;
  const notify = notifyModel(push, view, save);
  return (
    <Grouped testID="phone-notify" settings={props.settings}>
      <Section title={L("This device", "本设备")} hint={L("When on, important messages are pushed to this device.", "开启后，重要消息会推送到这台设备。")}>
        <SetRow first label={push.info()?.device ?? L("This device", "本设备")} trailing={<Text testID="push-state" style={{ fontSize: 16, color: colors.muted }}>{notify.short()}</Text>} />
        <If
          when={push.info()?.subscribed}
          else={<SetRow label={L("Turn on notifications", "开启通知")} tone="accent" disabled={!push.canAsk() || push.busy()} onPress={push.enable} testID="push-enable" />}
        >
          <SetRow label={L("Send test notification", "发送测试通知")} tone="accent" disabled={push.busy()} onPress={push.test} testID="push-test" />
          <SetRow label={L("Turn off on this device", "关闭本设备通知")} tone="danger" onPress={push.disable} testID="push-disable" />
        </If>
      </Section>
      <If when={push.note()}>
        <Text testID="push-note" style={{ marginTop: -20, paddingHorizontal: 32, fontSize: 13, color: colors.danger }}>{push.note()}</Text>
      </If>
      <If when={push.needsHomeScreen()}>
        <Section title={L("Turn on notifications on iPhone", "在 iPhone 上开启通知")}>
          <View style={{ padding: 16 }}>
            <Steps steps={[L("In Safari, tap the Share button at the bottom", "在 Safari 里点底部的「分享」按钮"), L("Choose “Add to Home Screen”, then tap “Add”", "选「添加到主屏幕」，再点「添加」"), L("Open Noop from the Home Screen, sign in, and tap “Turn on notifications” here", "从主屏幕打开 Noop，登录后回到这里点「开启通知」")]} />
          </View>
        </Section>
      </If>
      <If when={push.info()?.permission === "denied" && !push.needsHomeScreen()}>
        <Text style={{ paddingHorizontal: 32, fontSize: 13, lineHeight: 18, color: colors.muted }}>{L(`${notify.state()}: allow Noop in the browser’s site settings (or System Settings → Notifications), then reload and turn it on.`, `${notify.state()}：在浏览器的网站设置（或系统设置 → 通知）里允许 Noop，然后刷新页面再开启。`)}</Text>
      </If>
      <If when={view()}>
        <Section title={L("What to push", "推送哪些")}>
          <Each of={NOTIFY_KINDS()}>
            {(k, i) => (
              <SetRow
                first={i() === 0}
                label={k()[1]}
                trailing={
                  <Toggle
                    testID={`notify-${k()[0]}`}
                    label={k()[1]}
                    value={notify.prefs().kinds[k()[0]]}
                    onChange={(on) => notify.setPrefs({ kinds: { ...notify.prefs().kinds, [k()[0]]: on } })}
                  />
                }
              />
            )}
          </Each>
        </Section>
        <Section title={L("Quiet hours", "免打扰时段")} hint={L(`Recorded but not pushed during these hours (time zone ${notify.prefs().tz}).`, `这段时间只记下，不推送（时区 ${notify.prefs().tz}）。`)}>
          <Choices
            label={L("Quiet hours", "免打扰时段")}
            choices={QUIET_PRESETS().map((q) => ({ id: quietKey(q.value), label: q.label, testID: `quiet-${quietKey(q.value)}` }))}
            selected={quietKey(notify.prefs().quiet_hours)}
            onPick={(id) => notify.setPrefs({ quiet_hours: QUIET_PRESETS().find((q) => quietKey(q.value) === id)!.value })}
          />
        </Section>
      </If>
    </Grouped>
  );
}

/** A member on a phone: its models and its autonomy. */
function PhoneMember(props: { id: string; settings: Settings }) {
  const { view, save } = props.settings;
  const agent = () => view()?.effective.agents.find((a) => a.id === props.id);
  return (
    <Grouped testID="phone-member" settings={props.settings}>
      <If when={agent()} else={<Text style={{ paddingHorizontal: 32, fontSize: 14, color: colors.faint }}>{L("No such member", "没有这个成员")}</Text>}>
        {(a) => (
          <>
            <Section title={L("Model", "模型")} hint={L("Which to use first; switches to the next on failure or when out of quota.", "先用哪个；失败或额度用尽时换下一个。")}>
              <Choices
                label={L("Model", "模型")}
                choices={view()!.options.clis.map((c) => ({ id: cliKey(c), label: cliLabel(c), testID: `cli-${props.id}-${cliKey(c)}` }))}
                selected={cliKey(a().clis)}
                onPick={(id) => save(patches.clis(props.id, view()!.options.clis.find((c) => cliKey(c) === id)!))}
              />
            </Section>
            <Section title={L("Autonomy", "自主程度")} hint={L("How big a decision needs your input first.", "多大的事需要先问你。")}>
              <Choices
                label={L("Autonomy", "自主程度")}
                choices={view()!.options.autonomy.map((l) => ({ id: l, label: autonomyLabel(l), testID: `autonomy-${props.id}-${l}` }))}
                selected={a().autonomy}
                onPick={(l) => save(patches.autonomy(props.id, l))}
              />
            </Section>
          </>
        )}
      </If>
    </Grouped>
  );
}

/** A routine on a phone: on or off, and how often. */
function PhoneRoutine(props: { name: string; settings: Settings }) {
  const { view, save } = props.settings;
  const routine = () => view()?.effective.routines.find((r) => r.name === props.name);
  return (
    <Grouped testID="phone-routine" settings={props.settings}>
      <If when={routine()} else={<Text style={{ paddingHorizontal: 32, fontSize: 14, color: colors.faint }}>{L("No such routine", "没有这个例行任务")}</Text>}>
        {(r) => (
          <>
            <Section hint={[r().desc, r().agent && L(`Run by ${r().agent}.`, `由 ${r().agent} 执行。`)].filter(Boolean).join("\n")}>
              <SetRow
                first
                label={L("Enabled", "启用")}
                trailing={<Toggle testID={`routine-${props.name}`} label={L("Enabled", "启用")} value={r().enabled} onChange={(on) => save(patches.routine(props.name, { enabled: on }))} />}
              />
            </Section>
            <Section title={L("Interval", "运行间隔")}>
              <Choices
                label={L("Interval", "运行间隔")}
                choices={intervalsWith(r().every).map((iv) => ({ id: iv, label: everyLabel(iv), testID: `every-${props.name}-${iv}` }))}
                selected={r().every}
                onPick={(iv) => save(patches.routine(props.name, { every: iv }))}
              />
            </Section>
          </>
        )}
      </If>
    </Grouped>
  );
}

// ---------------------------------------------------------------- the team's rules and memory (read-only)

/** 记忆: policies, the owner's memory, each agent's profile and memory, closed decisions. */
function RulesList(props: { hub: Hub; onOpen: (path: string) => void }) {
  const groups = signal<RuleGroup[] | null>(null);
  const error = signal("");
  void (async () => {
    const lists: Record<string, DataFile[]> = {};
    for (const pre of RULE_PREFIXES) {
      const r = await props.hub.api("GET", `/api/files/list?prefix=${encodeURIComponent(pre)}`);
      if (!r.ok) { error.set(r.status ? L(`Couldn’t load (${r.status})`, `读取失败（${r.status}）`) : L("Can’t reach the server", "连不上服务器")); return; }
      lists[pre] = (r.data.files as DataFile[] | undefined) ?? [];
    }
    groups.set(groupRules(lists));
  })();
  return (
    <Grouped testID="rules">
      <Text style={{ paddingHorizontal: 32, fontSize: 13, lineHeight: 18, color: colors.muted }}>{L("The rules and memory the team works by. Read-only; the team maintains them as it works.", "团队做事依据的规则和记忆。这里只读，内容由团队在工作中维护。")}</Text>
      <If when={groups()} else={<Text style={{ paddingHorizontal: 32, fontSize: 14, color: error() ? colors.danger : colors.faint }}>{error() || L("Loading…", "读取中…")}</Text>}>
        {(gs) => (
          <Each of={gs()} key={(g) => g.key}>
            {(g) => (
              <Section title={g().title} hint={g().hint} testID={`rules-${g().key}`}>
                <If when={g().items.length} else={<SetRow first label={L("Nothing yet", "暂无内容")} disabled />}>
                  <Each of={g().items} key={(it) => it.path}>
                    {(it, i) => (
                      <SetRow first={i() === 0} label={it().title} value={it().detail} chevron onPress={() => props.onOpen(it().path)} testID={`rule-${it().path}`} />
                    )}
                  </Each>
                </If>
              </Section>
            )}
          </Each>
        )}
      </If>
    </Grouped>
  );
}

/** One rules or memory file, rendered as markdown. Read-only. */
function RuleDoc(props: { hub: Hub; path: string; wide: boolean }) {
  const text = signal<string | null>(null);
  const error = signal("");
  void props.hub.api("GET", `/api/files/read?path=${encodeURIComponent(props.path)}`).then((r) => {
    if (r.ok && typeof r.data.content === "string") text.set(stripFrontMatter(r.data.content));
    else error.set(r.status === 404 ? L("This file no longer exists.", "这个文件已经不在了。") : r.status ? L(`Couldn’t load (${r.status})`, `读取失败（${r.status}）`) : L("Can’t reach the server", "连不上服务器"));
  });
  return (
    <Scroll testID="rule-doc" style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ width: "100%", maxWidth: size.column, alignSelf: "center", gap: 12, paddingHorizontal: props.wide ? 32 : 16, paddingTop: 20, paddingBottom: Math.max(32, safeArea().bottom + 16) }}>
        <Text style={{ fontFamily: MONO, fontSize: 12.5, color: colors.faint }}>{props.path}</Text>
        <If when={text() !== null} else={<Text style={{ fontSize: 14, color: error() ? colors.danger : colors.faint }}>{error() || L("Loading…", "读取中…")}</Text>}>
          <If when={(text() ?? "").trim()} else={<Text style={{ fontSize: 14, color: colors.faint }}>{L("(Empty file)", "（空文件）")}</Text>}>
            <View selectable><Rich text={text() ?? ""} /></View>
          </If>
        </If>
      </View>
    </Scroll>
  );
}

// ---------------------------------------------------------------- commands ("/" in the composer)

/** The commands a "/" draft matches, above the composer. While it shows, Up / Down (and Ctrl+P / Ctrl+N) move the
 * pick, Tab or Return runs it, Escape closes the list (clearing the "/"). */
function CommandList(props: {
  items: CommandItem[];
  selected: number;
  touch: boolean;
  onHover: (i: number) => void;
  onMove: (delta: number) => void;
  onRun: (c: CommandItem) => void;
  onClose: () => void;
  onManage: () => void;
}) {
  const run = () => { const c = props.items[props.selected]; if (c) props.onRun(c); };
  keymap.bind(
    { up: () => props.onMove(-1), down: () => props.onMove(1), "ctrl+p": () => props.onMove(-1), "ctrl+n": () => props.onMove(1), tab: run, escape: props.onClose },
    { when: "always", repeat: true },
  );
  return (
    <View
      testID="commands"
      role="menu"
      accessibilityLabel={L("Commands", "指令")}
      style={{ width: "100%", maxWidth: 380, borderRadius: radius.card, borderCurve: "continuous", borderWidth: 0.5, borderColor: surfaceEdge(), backgroundColor: colors.surface, padding: 4, overflow: "hidden" }}
    >
      <Each of={props.items} key={(c) => c.id}>
        {(c, i) => (
          <View
            testID={`command-${c().id}`}
            role="menuitem"
            accessibilityLabel={c().name}
            accessibilityState={{ selected: i() === props.selected }}
            onPress={() => props.onRun(c())}
            onMouseEnter={() => props.onHover(i())}
            style={{ flexDirection: "row", alignItems: "center", gap: 10, height: 34, paddingHorizontal: 10, borderRadius: 8, backgroundColor: i() === props.selected ? colors.raised : undefined }}
          >
            <Text style={{ flexShrink: 0, maxWidth: 180, fontSize: 14.5, fontWeight: "500", color: colors.text, numberOfLines: 1 }}>{`/${c().name}`}</Text>
            <Text style={{ flex: 1, minWidth: 0, fontSize: 13, color: colors.faint, numberOfLines: 1 }}>{c().detail}</Text>
            <If when={i() === props.selected && !props.touch}>
              <Text style={{ fontSize: 12, color: colors.faint }}>↵</Text>
            </If>
          </View>
        )}
      </Each>
      <If when={!props.items.length}>
        <Text style={{ paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, color: colors.muted }}>{L("No matching commands", "没有匹配的指令")}</Text>
      </If>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, height: 30, paddingHorizontal: 10, marginTop: 2, borderTopWidth: 0.5, borderTopColor: surfaceEdge() }}>
        <If when={!props.touch}>
          <Text style={{ flex: 1, fontSize: 12, color: colors.faint }}>{L("↑↓ Select · ↵ Run · Esc Close", "↑↓ 选择 · ↵ 执行 · Esc 关闭")}</Text>
        </If>
        <View testID="manage-commands" role="button" onPress={props.onManage} style={{ marginLeft: props.touch ? 0 : undefined }}>
          <Text style={{ fontSize: 12.5, color: colors.accent }}>{L("Manage…", "管理…")}</Text>
        </View>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- keyboard help

const SHORTCUTS = (): [string, string][] => [
  ["Enter", L("Send", "发送")],
  ["Shift+Enter", L("New line", "换行")],
  [`${keymap.label("mod+enter")}`, L("Send (anytime)", "发送（任何时候）")],
  [`/  ·  ${keymap.label("mod+k")}`, L("Focus the message box", "聚焦输入框")],
  [`1 – 9  ·  ${keymap.label("alt+1")}…`, L("Pick an option on the current decision", "选择当前决策的选项")],
  [`J / K  ·  ${keymap.label("alt+j")} / ${keymap.label("alt+k")}`, L("Next / previous pending decision", "下一个 / 上一个待决策")],
  [`R  ·  ${keymap.label("alt+r")}`, L("Reply to the current decision (other instructions)", "回复当前决策（其他指示）")],
  [`G  ·  ${keymap.label("alt+g")}`, L("Back to bottom", "回到底部")],
  ["Esc", L("Cancel reply / leave the message box / close", "取消回复 / 离开输入框 / 关闭")],
  [keymap.label("mod+,"), L("Team settings", "团队设置")],
  [keymap.label("mod+b"), L("Show / hide sidebar", "显示 / 隐藏侧栏")],
  [keymap.label("mod+shift+l"), L("Toggle light / dark", "切换浅色 / 深色")],
  ["?", L("All keyboard shortcuts", "快捷键一览")],
];

/** The keyboard shortcuts, in a `Dialog`: Escape, the backdrop and the close button close it. */
function HelpSheet(props: { open: boolean; onClose: () => void }) {
  return (
    <Dialog
      testID="help"
      open={props.open}
      animation="fade"
      onOpenChange={({ open }) => !open && props.onClose()}
      backdropClass="bg-scrim"
      backdropTestID="help-backdrop"
      style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 16, pointerEvents: "box-none" }}
    >
      <View
        accessibilityLabel={L("Keyboard shortcuts", "键盘快捷键")}
        style={{
          width: "100%",
          maxWidth: 520,
          borderRadius: 16,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface,
          overflow: "hidden",
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: 20, paddingRight: 10, height: 56, borderBottomWidth: 0.5, borderBottomColor: surfaceEdge() }}>
          <Text style={{ flex: 1, fontSize: 17, fontWeight: "600", color: colors.text }}>{L("Keyboard shortcuts", "键盘快捷键")}</Text>
          <ToolButton icon="close" label={L("Close", "关闭")} shortcut="Esc" onPress={props.onClose} />
        </View>
        <View style={{ paddingVertical: 8 }}>
          <Each of={SHORTCUTS()}>
            {(s) => (
              <View style={{ flexDirection: "row", alignItems: "center", minHeight: 38, paddingHorizontal: 20, gap: 12 }}>
                <Text style={{ flex: 1, fontSize: 15, color: colors.text }}>{s()[1]}</Text>
                <View style={{ flexDirection: "row", gap: 4 }}>
                  <Each of={s()[0].split("  ·  ")}>{(k) => <Kbd k={k()} />}</Each>
                </View>
              </View>
            )}
          </Each>
        </View>
        <Text style={{ fontSize: 13, color: colors.faint, paddingHorizontal: 20, paddingBottom: 16 }}>{L("Single-key shortcuts work outside the message box; while typing, use the Alt (⌥) combinations.", "单键快捷键在输入框外生效；打字时用带 Alt（⌥）的组合键。")}</Text>
      </View>
    </Dialog>
  );
}

// ---------------------------------------------------------------- chat

/** The pages of the stack: the channel, what the sidebar opens, and settings with the pages it pushes on phones. */
type Route =
  | { name: "channel" }
  | { name: "team" }
  | { name: "task"; id: string }
  | { name: "host"; host: string }
  | { name: "notify" }
  | { name: "member"; id: string }
  | { name: "routine"; routine: string }
  | { name: "rules" }
  | { name: "tasks" }
  | { name: "doc"; path: string };
const CHANNEL: Route = { name: "channel" };

function Chat(props: { hub: Hub; openRef?: string | null; onConnection: () => void; onDisconnect: () => void; onTray?: (chat: TrayChat | null) => void }) {
  const hub = props.hub;
  const settings = createSettings(hub);
  const push = createPush(hub, settings.toast.show);
  const reads = createMessageReads(hub);
  const channels = createChannels(hub, reads);
  const wide = () => windowSize().width >= WIDE;
  const drawer = signal(false);
  const drawerDragging = signal(false);
  const drawerVisible = signal(false);
  let drawerHideTimer: ReturnType<typeof setTimeout> | undefined;
  cleanup(() => clearTimeout(drawerHideTimer));
  const drawerX = createAnimatedValue(0);
  const drawerWidth = () => Math.min(size.sidebar + 16, windowSize().width * 0.86);
  const drawerTranslate = () => drawerX.interpolate({ inputRange: [0, drawerWidth()], outputRange: [0, drawerWidth()] });
  const animateDrawer = (open: boolean) => {
    if (reduceMotion()) drawerX.set(open ? drawerWidth() : 0);
    else drawerX.timing(open ? drawerWidth() : 0, { duration: 200, easing: "easeOut" });
  };
  effect(() => {
    if (wide()) return;
    const open = drawer();
    clearTimeout(drawerHideTimer);
    if (open) drawerVisible.set(true);
    else drawerHideTimer = setTimeout(() => drawerVisible.set(false), reduceMotion() ? 0 : 200);
    animateDrawer(open);
  });
  const finishDrawerPan = (e: { cancelled: boolean; translation: { x: number } }) => {
    const wasOpen = untracked(drawer);
    const next = e.cancelled ? wasOpen : wasOpen ? e.translation.x > -45 : e.translation.x > 45;
    drawerDragging.set(false);
    if (next === wasOpen) animateDrawer(next);
    else drawer.set(next);
  };
  const sidebarOpen = signal(true);
  const setSidebarOpen = (open: boolean) => {
    if (open === untracked(sidebarOpen)) return;
    if (!reduceMotion()) LayoutAnimation.configureNext(LayoutAnimation.create(200, "easeInEaseOut"));
    sidebarOpen.set(open);
  };
  const help = signal(false);
  // The pages: the channel at the bottom, what the sidebar, a link or settings opened above it.
  const nav = createNavStack<Route>([CHANNEL]);
  const top = () => { const r = nav.routes(); return r[r.length - 1]; };
  const onChannel = () => nav.routes().length === 1;
  /** The channel the conversation is narrowed to (a Slack-like topic), or null for the main chat. Same view, same composer. */
  const scope = signal<string | null>(null);
  const scoped = () => { const slug = scope(); return slug ? channels.list().find((c) => c.slug === slug) : undefined; };
  const openScope = (slug: string | null) => { drawer.set(false); nav.popToRoot(); scope.set(slug); };
  // a channel's history beyond what this device holds; what is said there arrives live like the main chat's
  const channelFeed = signal<HubEvent[]>([]);
  effect(() => {
    const slug = scope();
    scoped()?.last_activity;
    if (!slug) { channelFeed.set([]); return; }
    void hub.api("GET", `/api/channels/feed?slug=${encodeURIComponent(slug)}`).then((r) => {
      if (untracked(scope) === slug && r?.ok && Array.isArray(r.data.events)) channelFeed.set(r.data.events as HubEvent[]);
    }).catch(() => {});
  });
  /** Shows a page over the channel, in place of the one shown (the sidebar's pages are siblings). */
  const show = (...routes: Route[]) => { drawer.set(false); nav.setRoutes([CHANNEL, ...routes]); };
  const openHost = (h: string) => show({ name: "host", host: h });
  /** A task: from a machine's page it goes on top (back returns to the machine), else in place. */
  const openTask = (id: string) => {
    const t = untracked(top);
    if (t.name === "host" || t.name === "tasks" || (t.name === "channel" && untracked(scope))) { drawer.set(false); nav.push({ name: "task", id }); }
    else show({ name: "task", id });
  };
  taskLink = openTask;
  const repos = computed(() => { const m = new Map<string, string>(); for (const e of props.hub.events()) reposIn(`${e.text}\n${(e.options ?? []).join("\n")}`, m); return m; });
  knownRepos = repos;
  taskState = (id) => { const s = props.hub.status(); return [...(s?.active ?? []), ...(s?.recent ?? [])].find((t) => t.id === id)?.state ?? (s?.active.some((t) => t.id === id) ? "active" : undefined); };
  /** A card being scrolled to (picked from the sidebar, a notification): entering the channel leaves the scroll to it. */
  let jumping: string | null = null;
  // Entering the channel (first load, back from a task or settings) shows the latest messages.
  effect(() => { if (onChannel() && !jumping) { atEnd.set(true); unseen.set(0); toEnd(); } });
  const draft = signal("");
  const excerpt = signal<{ text: string; ref?: string } | null>(null);
  const replyTo = signal<string | null>(null);
  /** What the reply answers, for the chip ("Kai：nsh #812 主要修的是…"); none for a decision (its id says it). */
  const replyNote = signal<string | null>(null);
  const focused = signal(false);
  const inputHeight = signal(28);
  const outbox = signal<Outgoing[]>([]);
  const atEnd = signal(true);
  const unseen = signal(0);
  const chosen = signal<string | null>(null);

  // The server can accept a message even when the POST response is lost (e.g. iOS
  // suspends the app). A streamed/replayed event is also a delivery receipt.
  effect(() => {
    const receipts = new Set(hub.events().filter((e) => e.kind === "owner").map((e) => e.client_id));
    const pending = untracked(outbox);
    const remaining = pending.filter((o) => !receipts.has(o.id));
    if (remaining.length !== pending.length) outbox.set(remaining);
  });

  /** The timeline: the hub's events and the messages on their way. */
  const shown = computed(() => {
    const slug = scope();
    const outgoing = outbox().filter((o) => (o.channel ?? null) === slug).map((o) => ({
      id: o.id, ts: o.ts, from: "owner", kind: "owner" as const, text: o.text, ref: o.ref ?? undefined, channel: o.channel,
      attachments: o.files.length ? o.files.map((f) => f.preview) : undefined,
    }));
    if (slug) {
      const ch = untracked(scoped);
      const refs = scoped()?.refs ?? ch?.items.filter((i) => i.kind !== "report").map((i) => i.id) ?? [];
      return merge(channelDigest(merge(channelFeed(), hub.events()), refs, slug, Infinity), outgoing);
    }
    return merge(hub.events().filter((e) => !e.thread && !e.channel && !(e.kind === "system" && e.text.startsWith("⚙️ 设置已更新"))), outgoing);
  });
  const answered = computed(() => answeredIds(shown()));
  // "以下为新消息": above the first event from others after what this device last saw.
  const seen = signal<string | null | undefined>(undefined);
  Storage.getItem(KEYS.seen).then((v) => seen.set(v ?? null));
  const visibleMessages = signal<HubEvent[]>([]);
  effect(() => {
    if (!reads.loaded() || lifecycle() !== "active") return;
    const route = top();
    if (onChannel()) reads.read(visibleMessages());
    else if (route.name === "task") { hub.events(); reads.ref(route.id); }
  });
  const divider = signal<string | null | undefined>(undefined);
  effect(() => {
    if (untracked(divider) !== undefined || !hub.loaded() || seen() === undefined || !reads.loaded()) return;
    divider.set(firstUnread(shown().filter((e) => !isRead(e, reads.state())), seen() ?? null));
  });
  // List diffs its items by identity: rebuilt rows would read as all replaced on every new message,
  // losing their measurements and the reader's place. Reuse each row while its event is the same.
  type TimelineRow = Row | { key: string; unread: true } | { key: string; more: number } | { key: string; head: string };
  /** The newest messages shown; older ones wait behind 「加载更早的消息」 so the list stays short. */
  const PAGE = 200;
  const limit = signal(PAGE);
  let built = new Map<string, TimelineRow>();
  let timelineWindow = createTimelineWindow(PAGE);
  const UNREAD: TimelineRow = { key: "unread", unread: true };
  const timeline = computed((): TimelineRow[] => {
    const d = scope() ? null : divider();
    const next = new Map<string, TimelineRow>();
    const out: TimelineRow[] = [];
    const all = shown();
    const hidden = timelineWindow.update(all, hub.loaded(), limit(), untracked(atEnd) && untracked(onChannel));
    if (hidden) {
      const old = built.get("more");
      const more = old && "more" in old && old.more === hidden ? old : { key: "more", more: hidden };
      next.set("more", more);
      out.push(more);
    }
    const slug = scope();
    if (slug && !hidden) out.push({ key: `head:${slug}`, head: slug });
    for (const row of rows(hidden ? all.slice(hidden) : all)) {
      if ("event" in row && row.event.id === d) out.push(UNREAD);
      const old = built.get(row.key);
      const keep = old && ("event" in row ? "event" in old && old.event === row.event : "day" in old);
      const r = keep ? old : row;
      next.set(r.key, r);
      out.push(r);
    }
    built = next;
    return out;
  });
  const pending = computed(() => hub.events().filter((e) => isAsk(e) && !answered().has(e.ref!)));
  /** The pending ask the keys act on: the one picked (J / K, the sidebar), else the newest. */
  const target = computed(() => {
    const p = pending();
    const c = chosen();
    return p.find((e) => e.ref === c)?.ref ?? p[p.length - 1]?.ref ?? null;
  });
  const proposalSelection = new Map<string, Signal<Set<string>>>();
  let scroller: ListRef | undefined;
  let composer: InputRef | undefined;

  let count = 0;
  const toEnd = (animated = false) => setTimeout(() => scroller?.scrollToEnd({ animated }), 40);
  // The list follows its end by itself (alignment="bottom"); scrolled further up than AT_END, it stays put and this counts what came below.
  const AT_END = 24;
  effect(() => {
    const n = shown().length;
    const grew = n > count;
    count = n;
    if (grew && !untracked(atEnd)) unseen.update((u) => u + 1);
  });
  /** What the floating composer covers at the bottom of the timeline. */
  const composerHeight = signal(0);
  // Keep every explicit timeline jump short, including off-screen decision cards.
  // Stage the target one viewport away, let recycled rows lay out, then use the
  // platform's smooth scroll for the final screen instead of traversing the history.
  let firstVisibleRow = -1;
  let lastVisibleRow = -1;
  let timelineHeight = 600;
  let jumpVersion = 0;
  const cancelJump = () => { jumpVersion++; };
  cleanup(cancelJump);
  function scrollTimeline(index: number, end = false) {
    const list = scroller;
    if (!list || index < 0) return;
    const version = ++jumpVersion;
    const animated = !reduceMotion();
    const finish = () => {
      if (version !== jumpVersion || scroller !== list) return;
      if (end) list.scrollToEnd({ animated });
      else list.scrollToIndex({ index, viewOffset: 24, animated });
    };
    const far = firstVisibleRow >= 0 && (index < firstVisibleRow - 1 || index > lastVisibleRow + 1);
    if (!animated || !far) { finish(); return; }
    const direction = index > lastVisibleRow ? 1 : -1;
    list.scrollToIndex({
      index, viewPosition: end ? 1 : 0,
      viewOffset: (end ? 0 : 24) + direction * timelineHeight,
      animated: false,
    });
    requestAnimationFrame(() => requestAnimationFrame(finish));
  }
  const jumpToEnd = () => {
    unseen.set(0);
    scrollTimeline(untracked(timeline).length - 1, true);
  };
  // another channel is another conversation: its own window, its own page of history, opened at its latest
  let windowScope: string | null = null;
  effect(() => {
    const slug = scope();
    if (slug === windowScope) return;
    windowScope = slug;
    timelineWindow = createTimelineWindow(PAGE);
    built = new Map();
    limit.set(PAGE);
    atEnd.set(true); unseen.set(0); count = untracked(shown).length; toEnd();
  });

  const reply = (ref: string, note?: string) => {
    replyNote.set(note ?? null);
    replyTo.set(ref);
    if (!untracked(onChannel)) nav.popToRoot();
    composer?.focus();
  };

  // A message reads as sent at once but leaves a few seconds later, so 撤回 (or Mod+Z) can still take it back.
  const UNDO_MS = 5000;
  const holds = new Map<string, ReturnType<typeof setTimeout>>();
  function send(text: string, ref: string | null, id = `local:${crypto.randomUUID()}`, files: Attachment[] = []) {
    const ts = new Date().toISOString();
    const channel = untracked(scope) ?? undefined;
    outbox.update((o) => [...o.filter((x) => x.id !== id), { id, ts, text, ref, files, state: "held", channel }]);
    jumpToEnd();
    holds.set(id, setTimeout(() => { holds.delete(id); void deliver(id); }, UNDO_MS));
  }
  function deliverHeld() {
    return [...holds].map(([id, hold]) => {
      clearTimeout(hold);
      holds.delete(id);
      return deliver(id);
    });
  }
  // Leaving the app must not strand a message that already looks sent.
  effect(() => {
    if (lifecycle() !== "active") deliverHeld();
  });
  // An update restarts the app: what looks sent leaves first, and what is being typed comes back.
  async function restartToUpdate() {
    await Promise.allSettled(deliverHeld());
    if (draft()) await Storage.setItem(KEYS.draft, draft());
    await updates.install();
    await Storage.removeItem(KEYS.draft); // the install failed: this run still holds the draft
  }
  Storage.getItem(KEYS.draft).then((v) => {
    if (!v) return;
    if (!untracked(draft)) draft.set(v);
    void Storage.removeItem(KEYS.draft);
  });
  function undo(id?: string) {
    const o = id ? outbox().find((x) => x.id === id) : [...outbox()].reverse().find((x) => x.state === "held");
    if (!o || !holds.has(o.id)) return false;
    clearTimeout(holds.get(o.id));
    holds.delete(o.id);
    outbox.update((list) => list.filter((x) => x.id !== o.id));
    if (!/^[DLP]-[A-Z]?\d{4} \S+$/.test(o.text) || o.ref || o.files.length) {
      draft.set(o.text);
      replyNote.set(null);
      replyTo.set(o.ref);
      attachments.update((a) => [...o.files, ...a]);
      composer?.focus();
    }
    return true;
  }
  async function deliver(id: string) {
    const o = outbox().find((x) => x.id === id);
    if (!o || o.state === "sending") return;
    const { text, ref, files, channel } = o;
    outbox.update((l) => l.map((x) => (x.id === id ? { ...x, state: "sending" } : x)));
    try {
      markSent(await hub.send(text, ref, files, false, id, channel));
      outbox.update((o) => o.filter((x) => x.id !== id));
    } catch {
      outbox.update((o) => o.map((x) => (x.id === id ? { ...x, state: "failed" } : x)));
    }
  }
  // Commands: a draft of "/<query>" lists the built-in and saved commands; Return runs the first one.
  const slash = () => slashQuery(draft());
  const commands = () => { const q = slash(); return q == null ? [] : commandItems(settings.view(), q).slice(0, 8); };
  /** The command Return runs: Up and Down move it, a new query starts it over at the first. */
  const cmdSel = signal(0);
  effect(() => { slash(); cmdSel.set(0); });
  const pickedCommand = () => commands()[Math.min(cmdSel(), commands().length - 1)];
  effect(() => { if (slash() != null && !untracked(settings.view)) settings.load(); });
  function runCommand(c: CommandItem) {
    draft.set("");
    inputHeight.set(28);
    if (c.action === "update-fleet") void updateAllMachines(hub);
    else if (c.text) void send(c.text, null);
  }

  function submit() {
    if (speech() !== "off") stopDictation(true);
    if (slash() != null && commands().length && !attachments().length) return runCommand(pickedCommand()!);
    const v = draft().trim();
    const files = attachments();
    if (!v && !files.length) return;
    // A bare choice ("1", "B", "1,3", "全部") answers the decision the keyboard is on, never becomes a new task.
    const r = replyTo() ?? (!files.length && /^([1-9](\s*[,，]\s*[1-9])*|[A-Za-z]|全部|都不要)$/.test(v) ? target() : null);
    draft.set("");
    replyTo.set(null);
    selectionGeneration++;
    excerpt.set(null);
    attachments.set([]);
    attachNote.set(null);
    inputHeight.set(28);
    send(v, r, undefined, files);
  }

  // Images the owner attaches: pasted, dropped on the window, or picked.
  const attachments = signal<Attachment[]>([]);
  const attachNote = signal<string | null>(null);
  const dropping = signal(false);
  let attachSeq = 0;
  function attach(file: Blob, name: string, fromPicker = false) {
    // the photo picker only returns images, but phones often give them no type or extension; the server reads the bytes
    const type = imageType(file.type, name) ?? (fromPicker ? "image/jpeg" : null);
    const problem = attachProblem(type, file.size, attachments().length);
    if (problem) return attachNote.set(problem);
    attachNote.set(null);
    const typed = file.type === type ? file : new Blob([file], { type: type! });
    const preview = URL.createObjectURL(typed);
    attachments.update((a) => [...a, { id: `a${++attachSeq}`, name: name || `image-${attachSeq}.png`, type: type!, size: file.size, file: typed, preview }]);
  }
  function unattach(id: string) {
    const a = attachments().find((x) => x.id === id);
    if (a) URL.revokeObjectURL(a.preview);
    attachments.update((list) => list.filter((x) => x.id !== id));
    attachNote.set(null);
  }
  /** Local files (`file:` URLs from a drop or a file manager's copy): read the images among them. */
  async function attachUris(uris: string[]) {
    for (const u of uris) {
      const path = filePath(u);
      const name = path.split(/[\\/]/).pop() ?? "image";
      if (!imageType(undefined, name)) { attachNote.set(L("Only images can be sent", "只能发送图片")); continue; }
      try {
        const bytes = await fs.readFile(path);
        attach(new Blob([bytes as Uint8Array<ArrayBuffer>]), name);
      } catch {
        attachNote.set(L(`Can’t read ${name}`, `读不到 ${name}`));
      }
    }
  }
  async function pickImages() {
    try {
      const picked = await Picker.pickImages({ multiple: true, limit: 10 });
      for (const p of picked) attach(p.file, p.file.name, true);
    } catch {
      attachNote.set(L("Can’t pick images on this device", "这台设备上不能选择图片"));
    }
    composer?.focus();
  }
  // Dictation (语音输入): nsh's Speech in the native apps, the browser's speech recognition (through
  // host.js) on the web. Its words land in the composer where the caret was (or at the end), live as
  // they are heard; nothing is sent. Where there is neither, there is no button.
  const canDictate = signal(false);
  const speech = signal<"off" | "on" | "stopping">("off");
  let native = false;
  let session: SpeechSession | null = null;
  void Speech.available()
    .catch(() => false)
    .then(async (ok) => {
      native = ok;
      canDictate.set(ok || !!(await hostCall<{ supported: boolean }>("speechState"))?.supported);
    });
  let caret: { start: number; end: number } | null = null;
  let before = "";
  let after = "";
  let dictated = ""; // the draft as dictation last left it: anything else is the owner typing
  /** The recognizer's language: the device's Chinese, else Mandarin (the team is written to in Chinese). */
  const speechLang = () => {
    const l = String(locale() ?? "");
    return /^zh\b/i.test(l) ? l : "zh-CN";
  };
  const speechError = (e: string) =>
    e === "not-allowed" || e === "service-not-allowed" ? (native ? L("No microphone or speech recognition permission. Allow it in System Settings.", "没有麦克风或语音识别权限，请在系统设置里允许") : L("No microphone permission. Allow the microphone in your browser settings.", "没有麦克风权限，请在浏览器设置里允许使用麦克风"))
      : e === "no-speech" ? L("Didn’t hear anything", "没有听到声音")
      : e === "audio-capture" ? L("No microphone found", "找不到麦克风")
      : e === "network" ? L("Speech recognition needs a network connection", "语音识别需要联网")
      : e === "language-not-supported" ? L("This device doesn’t support Chinese speech recognition", "这台设备不支持中文语音识别")
      : e === "unavailable" ? L("Voice input isn’t available on this device", "这台设备不能语音输入")
      : L("Voice input failed", "语音输入出错了");
  /** The whole transcript so far (final and still-being-heard words). */
  const heard = (text: string) => {
    if (untracked(speech) === "off") return;
    const words = text.trim();
    // a space between Latin words, none in Chinese
    const gap = /[A-Za-z0-9.,!?;:]$/.test(before) && /^[A-Za-z0-9]/.test(words) ? " " : "";
    const head = before + gap + words;
    dictated = head + after;
    draft.set(dictated);
    composer?.setSelection(head.length, head.length);
  };
  const ended = (error?: string | null) => {
    if (untracked(speech) === "off") return;
    speech.set("off");
    if (error) attachNote.set(speechError(error));
  };
  async function startDictation() {
    const v = draft();
    const start = Math.min(caret?.start ?? v.length, v.length);
    const end = Math.min(Math.max(caret?.end ?? v.length, start), v.length);
    before = v.slice(0, start);
    after = v.slice(end);
    dictated = v;
    attachNote.set(null);
    speech.set("on");
    if (native) {
      try {
        const s = Speech.start({ lang: speechLang() });
        session = s;
        s.on("result", (r) => session === s && heard(r.text));
        s.on("end", (e) => {
          if (session !== s) return;
          session = null;
          ended(e.error);
        });
      } catch {
        session = null;
        speech.set("off");
        attachNote.set(L("Couldn’t start voice input", "无法开始语音输入"));
      }
      return;
    }
    if (!(await hostCall("speechStart", { lang: speechLang() })) && untracked(speech) === "on") {
      speech.set("off");
      attachNote.set(L("Couldn’t start voice input", "无法开始语音输入"));
    }
  }
  /** Stop listening: the words still being heard arrive first, unless `drop` (the draft was sent or edited). */
  function stopDictation(drop = false) {
    if (drop) {
      speech.set("off");
      if (session) { const s = session; session = null; s.abort(); }
      else void hostCall("speechAbort");
    } else {
      speech.set("stopping");
      if (session) session.stop();
      else void hostCall("speechStop");
    }
  }
  /** The mic / stop button: start, stop (keeping the words), and if the recognizer hangs while finishing, a second press ends it. */
  const toggleDictation = () => (speech() === "off" ? void startDictation() : stopDictation(speech() === "stopping"));
  if (host.available()) {
    host.on("speech", (p) => heard(String((p as { text?: string })?.text ?? "")));
    host.on("speechEnd", (p) => ended((p as { error?: string })?.error));
  }
  cleanup(() => {
    if (untracked(speech) !== "off") stopDictation(true);
  });

  const canSend = () => !!draft().trim() || attachments().length > 0;
  const compactComposer = () => !focused() && !draft() && !attachments().length && !replyTo() && speech() === "off";
  const answer = (ref: string, c: string) => {
    clearNotification(ref);
    return send(`${ref} ${c}`, null);
  };

  function pick(ref: string) {
    drawer.set(false);
    // set before the channel comes back: entering it would otherwise scroll to the latest messages, over this card
    jumping = ref;
    atEnd.set(false);
    const back = !untracked(onChannel);
    nav.popToRoot();
    if (untracked(scope) && !untracked(shown).some((e) => e.ref === ref)) scope.set(null);
    chosen.set(ref);
    clearNotification(ref);
    // back from another page the channel lays out first
    setTimeout(() => toCard(ref, 4), back ? 120 : 0);
  }
  /** Virtualized cards can be off screen; locate the row by identity instead of measuring a view. */
  function toCard(ref: string, tries: number) {
    const at = shown().findIndex((e) => e.ref === ref && isAsk(e));
    if (at >= 0 && shown().length - at > untracked(limit)) limit.set(shown().length - at); // older than the page: show it
    const index = timeline().findIndex((row) => "event" in row && row.event.ref === ref && isAsk(row.event));
    if (index >= 0 && scroller) {
      scrollTimeline(index);
      if (jumping === ref) jumping = null;
    } else if (tries > 0 && !scroller) {
      setTimeout(() => toCard(ref, tries - 1), 80);
    } else {
      if (jumping === ref) jumping = null;
      if (pending().some((e) => e.ref === ref)) reply(ref);
    }
  }

  // Opened from a notification (`?ref=`), or one clicked while the app is open: show that event.
  let openRef = props.openRef ?? null;
  effect(() => {
    const loaded = hub.loaded();
    if (!openRef || !loaded) return;
    const ref = openRef;
    openRef = null;
    setTimeout(() => pick(ref), 300);
  });
  if (host.available()) {
    host.on("open", (p) => {
      const ref = (p as { ref?: string | null } | null)?.ref;
      if (ref) setTimeout(() => pick(ref), 50);
    });
  }
  // The app's badge and the page's title count the decisions waiting. iOS needs the permission, so it follows that too.
  effect(() => {
    const n = pending().length;
    push.info();
    if (hub.loaded()) setBadge(n);
  });
  if (systemNotifications()) {
    // A press can start the app; before the timeline loads the effect above opens it.
    cleanup(Notifications.on("press", ({ id }) => {
      if (id.startsWith("noop:")) return;
      if (untracked(hub.loaded)) setTimeout(() => pick(id), 50);
      else openRef = id;
    }));
    // Back in the app: the owner may have changed the permission in the system's settings.
    effect(() => {
      if (lifecycle() === "active") void push.refresh();
    });
    // While the app is not in front, what would reach a browser as Web Push shows as a system notification.
    let latest: string | null = null;
    effect(() => {
      const evs = hub.events();
      if (!hub.loaded()) return;
      const last = evs[evs.length - 1]?.ts ?? "";
      if (latest === null) {
        latest = last;
        return;
      }
      const since: string = latest;
      const fresh = evs.filter((e) => e.ts > since);
      if (!fresh.length) return;
      latest = last;
      if (untracked(lifecycle) === "active" || !untracked(push.info)?.subscribed) return;
      void hub.api("GET", "/api/settings").then((r) => {
        const prefs = (r.data.current as { notify_prefs?: NotifyRules } | undefined)?.notify_prefs ?? {};
        // Waking from sleep can bring many: the latest few say enough, the badge counts the rest.
        for (const e of fresh.slice(-5)) {
          const note = notificationFor(e, { ...prefs, lang: lang() });
          if (!note) continue;
          const id = e.ref ?? `noop:${e.kind}`;
          showing.add(id);
          void Notifications.show({ id, ...note, silent: true }); // Noop is quiet: the notification alone, no sound
        }
      });
    });
    // Answered, here or on another device: the notification has done its job.
    effect(() => {
      const done = answered();
      for (const id of [...showing]) if (done.has(id)) closeNotification(id);
    });
  }
  // This device has seen what reached the bottom.
  effect(() => {
    const evs = shown();
    if (!atEnd() || !evs.length || divider() === undefined) return;
    Storage.setItem(KEYS.seen, evs[evs.length - 1].ts);
  });
  // A new decision while the app is open: a quiet toast and a short vibration.
  const toast = signal<{ ref: string; text: string } | null>(null);
  let known: Set<string> | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  cleanup(() => clearTimeout(toastTimer));
  effect(() => {
    const asks = pending();
    if (!hub.loaded()) return;
    if (!known) {
      known = new Set(asks.map((e) => e.ref!));
      return;
    }
    const fresh = asks.filter((e) => !known!.has(e.ref!));
    for (const e of asks) known.add(e.ref!);
    if (!fresh.length) return;
    const e = fresh[fresh.length - 1];
    toast.set({ ref: e.ref!, text: e.text.split("\n")[0].replace(/[*`]/g, "").slice(0, 80) });
    hostCall("vibrate");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.set(null), 6000);
  });
  /** J / K: the next or the previous pending ask, scrolled into view. */
  function step(by: number) {
    const p = pending();
    if (!p.length) return;
    const at = p.findIndex((e) => e.ref === target());
    const next = p[Math.max(0, Math.min(p.length - 1, (at < 0 ? p.length - 1 : at) + by))];
    pick(next.ref!);
  }
  function choose(n: number) {
    const ref = target();
    const e = pending().find((x) => x.ref === ref);
    if (!e || !onChannel()) return;
    const c = choicesOf(e)[n];
    if (c) answer(e.ref!, c);
  }
  /** 记忆: from the sidebar in place; from settings on top (back returns to settings). */
  const openRules = (fromSettings = false) => {
    if (fromSettings) { drawer.set(false); nav.push({ name: "rules" }); }
    else show({ name: "rules" });
  };
  const openTeam = () => {
    if (untracked(top).name === "team") { drawer.set(false); nav.popToRoot(); }
    else show({ name: "team" });
  };
  // The tray menu counts the decisions waiting and opens the one the keys act on, or the team settings.
  effect(() => props.onTray?.({ pending: pending().length, review: () => { const ref = untracked(target); if (ref) pick(ref); }, settings: openTeam }));
  cleanup(() => props.onTray?.(null));

  // Shortcuts. Single keys never fire while typing (`notEditing`).
  keymap.bind("mod+enter", submit, { when: "always" });
  keymap.bind("mod+k", () => composer?.focus(), { when: "always" });
  keymap.bind("mod+z", () => { if (!draft()) undo(); }, { when: "always" });
  keymap.bind("mod+,", openTeam, { when: "always" });
  keymap.bind("mod+b", () => setSidebarOpen(!untracked(sidebarOpen)), { when: "always" });
  keymap.bind("mod+shift+l", toggleTheme, { when: "always" });
  keymap.bind(
    {
      "/": () => composer?.focus(),
      "shift+/": () => help.set(!untracked(help)),
      j: () => step(1),
      k: () => step(-1),
      r: () => target() && reply(target()!),
      g: jumpToEnd,
      "shift+g": jumpToEnd,
      ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i + 1), () => choose(i)])),
    },
    { when: "notEditing" },
  );
  // The same moves with Alt work while typing, so the cursor never has to leave the composer.
  keymap.bind(
    {
      "alt+j": () => step(1),
      "alt+k": () => step(-1),
      "alt+r": () => target() && reply(target()!),
      "alt+g": jumpToEnd,
      ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`alt+${i + 1}`, () => choose(i)])),
    },
    { when: "always" },
  );
  keymap.bind("escape", () => {
    if (help()) help.set(false);
    else if (drawer()) drawer.set(false);
    else if (replyTo()) replyTo.set(null);
    else if (focused()) composer?.blur();
    else if (nav.routes().length > 1) nav.pop();
  }, { when: "always" });

  const connLabel = () => ({ connecting: L("Connecting…", "连接中…"), live: L("Live", "实时"), offline: L("Disconnected, reconnecting…", "已断开，重连中…"), unauthorized: L("Session expired", "登录已过期"), blocked: L(`IP ${hub.blockedIp()} not allowed`, `IP ${hub.blockedIp()} 未放行`) })[hub.conn()];
  const connTone = () => (hub.conn() === "live" ? "on" : hub.conn() === "unauthorized" || hub.conn() === "blocked" ? "bad" : hub.conn() === "offline" ? "wait" : "off");
  const sidebar = (inDrawer: boolean) => (
    <Sidebar
      onRestart={() => void restartToUpdate()}
      hub={hub}
      target={target}
      onPick={pick}
      onIgnore={(ref) => void answer(ref, IGNORE)}
      task={() => { const t = top(); return t.name === "task" ? t.id : null; }}
      onTask={openTask}
      machine={() => { const t = top(); return t.name === "host" ? t.host : null; }}
      onMachine={openHost}
      onSettings={openTeam}
      rules={() => { const n = top().name; return n === "rules" || n === "doc"; }}
      onRules={() => openRules()}
      tasks={() => top().name === "tasks"}
      onTasks={() => show({ name: "tasks" })}
      channels={channels}
      channel={() => (onChannel() ? scope() : null)}
      onChannel={(slug) => openScope(slug)}
      onHelp={() => help.set(true)}
      onClose={inDrawer ? () => drawer.set(false) : undefined}
      chrome={!inDrawer}
      onCollapse={inDrawer ? undefined : () => setSidebarOpen(false)}
      home={() => onChannel() && !scope()}
      unread={() => reads.main().length}
      onReadAll={reads.all}
      onHome={() => openScope(null)}
    />
  );
  // Only a touchscreen swipes the sidebar in: a pan handler takes every mouse press on the web,
  // so dragging over a message would select nothing.
  const swipeDrawer = () => touch && !wide() && !drawer();
  /** The channel: the timeline and the composer. */
  const channelPage = () => (
      <View testID="channel-swipe" pan={swipeDrawer() ? { x: drawerX } : undefined}
        onPanStart={swipeDrawer() ? () => drawerDragging.set(true) : undefined}
        onPanEnd={swipeDrawer() ? finishDrawerPan : undefined}
        style={{ flex: 1, backgroundColor: colors.background, paddingBottom: keyboardFrame().height, transitionProperty: "padding-bottom", transitionDuration: keyboardFrame().duration }}>
          {/* Files dropped on the timeline or the composer attach their images. */}
          <View
            testID="composer-area"
            onFileDragEnter={() => dropping.set(true)}
            onFileDragLeave={() => dropping.set(false)}
            onFileDrop={({ uris }) => { dropping.set(false); void attachUris(uris); }}
            style={{ flex: 1 }}
          >
            <List
              testID="timeline"
              each={timeline()}
              viewabilityConfig={{ minimumViewTime: 300 }}
              onViewableItemsChange={({ viewableItems }) => {
                firstVisibleRow = viewableItems.reduce((m, t) => Math.min(m, t.index ?? Infinity), Infinity);
                lastVisibleRow = viewableItems.reduce((m, t) => Math.max(m, t.index ?? -1), -1);
                visibleMessages.set(viewableItems.flatMap((t) => "event" in t.item ? [t.item.event] : []));
              }}
              alignment="bottom"
              maintainVisibleContentPosition={{ autoscrollToBottomThreshold: AT_END }}
              estimatedItemSize={120}
              contentStyle={{ paddingTop: wide() ? 24 : 12, paddingBottom: composerHeight() + 16 }}
              keyExtractor={(row) => row.key}
              ref={(r) => { scroller = r; }}
              onLayout={({ bounds }) => { timelineHeight = Math.max(1, bounds.size.height); }}
              onTouchStartCapture={() => { cancelJump(); if (platform.os === "macos" && focused()) composer?.blur(); }}
              style={{ flex: 1 }}
              scrollEventThrottle={100}
              keyboardShouldPersistTaps="handled"
              onScroll={(ev) => {
                const end = ev.contentSize.height - ev.offset.y - ev.size.height <= AT_END;
                if (end !== untracked(atEnd)) atEnd.set(end);
                if (end) unseen.set(0);
              }}
              empty={() => <View style={{ width: "100%", maxWidth: size.column + gutter() * 2, alignSelf: "center", paddingHorizontal: gutter(), paddingTop: wide() ? 24 : 12, paddingBottom: composerHeight() + 16 }}>
                <If when={!hub.loaded()}>
                  <View style={{ alignItems: "center", paddingTop: 120, gap: 14 }}>
                    <Spinner size={22} tint={colors.muted} />
                    <Text style={{ fontSize: 15, color: colors.muted }}>{L("Loading channel…", "正在载入频道…")}</Text>
                  </View>
                </If>
                <If when={hub.loaded() && shown().length === 0}>
                  <View style={{ alignItems: "center", paddingTop: wide() ? 120 : 64, paddingBottom: 32, gap: 12 }}>
                    <Mark size={44} />
                    <Text style={{ fontSize: 30, fontWeight: "600", color: colors.text, letterSpacing: -0.4 }}>{greeting()}</Text>
                    <Text style={{ fontSize: 16, lineHeight: 24, color: colors.muted, textAlign: "center" }}>{L("The team works in the background. Decisions that need you appear here.", "团队在后台运转。需要你拍板的事会出现在这里。")}</Text>
                    <If when={!touch}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 }}>
                        <Kbd k="/" />
                        <Text style={{ fontSize: 14, color: colors.faint }}>{L("Start typing", "开始输入")}</Text>
                        <View style={{ width: 12 }} />
                        <Kbd k="?" />
                        <Text style={{ fontSize: 14, color: colors.faint }}>{L("All shortcuts", "全部快捷键")}</Text>
                      </View>
                    </If>
                  </View>
                </If>
              </View>}
            >
              {(item) => (
                <View style={{ width: "100%", maxWidth: size.column + gutter() * 2, alignSelf: "center", paddingHorizontal: gutter() }}>
                <Each of={[item()]} key={(r) => r.key}>
                  {(r) => {
                    const row = r();
                    if ("head" in row) {
                      return (
                        <View>
                          <ChannelHeader channels={channels} slug={row.head} />
                          <If when={shown().length === 0}>
                            <View testID="channel-empty" style={{ gap: 6, paddingVertical: 16 }}>
                              <Text style={{ fontSize: 16, fontWeight: "600", color: colors.text }}>{L(`This is the start of #${scoped()?.name ?? row.head}`, `这里是 #${scoped()?.name ?? row.head} 的开始`)}</Text>
                              <Text style={{ fontSize: 14, lineHeight: 21, color: colors.muted }}>{L("Results and decisions for this topic land here. What you say here stays here, out of the main chat.", "这个话题的结果和决策会出现在这里。在这里说的话只留在这里，不进主会话。")}</Text>
                            </View>
                          </If>
                        </View>
                      );
                    }
                    if ("more" in row) {
                      return (
                        <View style={{ alignItems: "center", marginTop: 16, marginBottom: 4 }}>
                          <Btn testID="timeline-more" label={L(`Load earlier messages (${row.more})`, `加载更早的消息（还有 ${row.more} 条）`)} kind="secondary" onPress={() => limit.set(untracked(limit) + PAGE)} />
                        </View>
                      );
                    }
                    if ("unread" in row) {
                      return (
                        <View testID="unread" style={{ flexDirection: "row", alignItems: "center", gap: 12, marginTop: 16, marginBottom: 4 }}>
                          <View style={{ flex: 1, height: 1, backgroundColor: alpha(colors.danger, 0.4) }} />
                          <Text style={{ fontSize: 13, fontWeight: "600", color: colors.danger }}>{L("New messages", "以下为新消息")}</Text>
                          <View style={{ flex: 1, height: 1, backgroundColor: alpha(colors.danger, 0.4) }} />
                        </View>
                      );
                    }
                    if ("day" in row) {
                      return (
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginTop: 24, marginBottom: 8 }}>
                          <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
                          <Text style={{ fontSize: 13, fontWeight: "500", color: colors.faint }}>{dayLabel(row.day)}</Text>
                          <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
                        </View>
                      );
                    }
                    const entrance = timelineWindow.takeArrival(row.event.id) ? createMotion({
                      enter: { keyframes: { opacity: [0, 1], translateY: [8, 0] }, duration: 180, easing: "easeOut" },
                    }) : undefined;
                    if (row.event.kind === "owner") {
                      const out = () => outbox().find((o) => o.id === row.event.id);
                      return <View style={entrance?.style}><OwnerBubble hub={hub} event={row.event} out={out()} onRetry={() => void deliver(row.event.id)} onRecall={() => undo(row.event.id)} onRef={pick} /></View>;
                    }
                    return (
                      <View style={entrance?.style}>
                        <Message
                          hub={hub}
                          event={row.event}
                          answered={answered}
                          target={target}
                          onAnswer={answer}
                          onReply={reply}
                          onQuote={(text, ref) => excerpt.set({ text, ref })}
                          selection={proposalSelection}
                          unread={() => reads.loaded() && !isRead(row.event, reads.state())}
                          onToggleRead={() => reads.toggle(row.event)}
                        />
                      </View>
                    );
                  }}
                </Each>
                </View>
              )}
            </List>

            <If when={!atEnd() && shown().length > 0}>
              <View style={{ position: "absolute", left: 0, right: 0, bottom: composerHeight() + 4, paddingVertical: 4, alignItems: "center", pointerEvents: "box-none" }}>
                <View
                  role="button"
                  accessibilityLabel={L("Back to bottom", "回到底部")}
                  onPress={jumpToEnd}
                  hoverStyle={{ opacity: 0.92 }}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                    height: 38,
                    paddingHorizontal: 16,
                    ...glass(unseen() ? colors.accentFill : colors.surface, 19),
                    backgroundColor: platform.os === "linux" || (platform.os === "android" && Number(platform.version) < 31)
                      ? (unseen() ? colors.accentFill : colors.surface)
                      : (unseen() ? alpha(colors.accentFill, 0.85) : alpha(colors.surface, 0.25)),
                    borderWidth: platform.os === "ios" || platform.os === "macos" ? 0 : 1,
                    boxShadow: "0 4px 16px rgba(0,0,0,0.08)",
                  }}
                >
                  <Icon name="arrow-down" size={15} tint={unseen() ? colors.onAccent : colors.text} />
                  <Text style={{ fontSize: 14, fontWeight: "600", color: unseen() ? colors.onAccent : colors.text }}>
                    {unseen() ? L(`${unseen()} new messages`, `${unseen()} 条新消息`) : L("Back to bottom", "回到底部")}
                  </Text>
                  <If when={!touch}>
                    <Text style={{ fontSize: 12, color: unseen() ? alpha(colors.onAccent, 0.7) : colors.faint }}>G</Text>
                  </If>
                </View>
              </View>
            </If>

          {/* The composer floats over the timeline, which scrolls on under its glass. */}
          <View
            onLayout={({ bounds }) => composerHeight.set(bounds.size.height)}
            style={{ position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: wide() ? 32 : 10, paddingTop: 4, paddingBottom: keyboardFrame().height > 0 ? 8 : Math.max(12, safeArea().bottom + 8), transitionProperty: "padding-bottom", transitionDuration: keyboardFrame().duration, pointerEvents: "box-none" }}
          >
            <View style={{ width: "100%", maxWidth: size.column, alignSelf: "center", gap: 8, pointerEvents: "box-none" }}>
              <If when={hub.conn() === "blocked"}>
                <View style={{ gap: 6, paddingHorizontal: 14, paddingVertical: 10, borderRadius: radius.inset, backgroundColor: colors.surface, backgroundImage: `linear-gradient(${tints.danger}, ${tints.danger})` }}>
                  <Text style={{ fontSize: 14, color: colors.danger }}>
                    {L(`This device's public IP ${hub.blockedIp()} isn't on the Worker's allow-list (HUB_ALLOW_IPS). Add it on the host; Noop reconnects by itself.`,
                      `这台设备的出口 IP ${hub.blockedIp()} 不在允许名单（HUB_ALLOW_IPS）里。在主机上把它加进去，Noop 会自动重连。`)}
                  </Text>
                  <View style={{ flexDirection: "row" }}>
                    <Btn label={L("Copy IP", "复制 IP")} onPress={() => void Clipboard.writeText(hub.blockedIp())} />
                  </View>
                </View>
              </If>
              <If when={hub.conn() === "offline" || hub.conn() === "unauthorized"}>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 10,
                    paddingHorizontal: 14,
                    paddingVertical: 8,
                    borderRadius: radius.inset,
                    // over the timeline: the tint needs a solid base, or the messages show through
                    backgroundColor: colors.surface,
                    backgroundImage: `linear-gradient(${hub.conn() === "unauthorized" ? tints.danger : tints.warn}, ${hub.conn() === "unauthorized" ? tints.danger : tints.warn})`,
                  }}
                >
                  <Text style={{ flex: 1, fontSize: 14, color: hub.conn() === "unauthorized" ? colors.danger : colors.warn }}>
                    {hub.conn() === "unauthorized" ? L("Your session expired. Please sign in again.", "登录已过期，请重新登录。") : L("Lost connection to Noop. Reconnecting…", "与 Noop 的连接断开了，正在自动重连…")}
                  </Text>
                  <If when={hub.conn() === "unauthorized"}>
                    <Btn label={L("Sign in again", "重新登录")} kind="danger" onPress={props.onConnection} />
                  </If>
                </View>
              </If>
              <QuotePreview text={excerpt()?.text ?? ""} onCancel={() => excerpt.set(null)} onQuote={() => {
                const selected = excerpt();
                if (!selected) return;
                excerpt.set(null);
                draft.update((value) => appendQuote(value, selected.text));
                replyNote.set(null);
                replyTo.set(selected.ref ?? null);
                composer?.focus();
                composer?.setSelection(draft().length);
              }} />
              <If when={slash() != null}>
                <CommandList
                  items={commands()}
                  selected={commands().indexOf(pickedCommand()!)}
                  touch={touch}
                  onHover={(i) => cmdSel.set(i)}
                  onMove={(d) => { const n = untracked(commands).length; if (n) cmdSel.set((untracked(cmdSel) + d + n) % n); }}
                  onRun={(c) => runCommand(c)}
                  onClose={() => draft.set("")}
                  onManage={() => { draft.set(""); openTeam(); }}
                />
              </If>
              <View
                style={{
                  flexDirection: "column",
                  alignItems: "stretch",
                  overflow: "hidden",
                  gap: 6,
                  paddingTop: compactComposer() ? 4 : 12,
                  paddingBottom: compactComposer() ? 4 : (touch ? 44 : 36) + 14,
                  paddingLeft: 18,
                  paddingRight: 8,
                  ...composerGlass(focused()),
                  ...(dropping() ? { borderColor: colors.accent, borderStyle: "dashed" as const } : {}),
                }}
              >
                <If when={replyTo()}>
                  {(ref) => (
                    <View testID="reply-chip" style={{ flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-start", maxWidth: "100%", height: 30, paddingLeft: 10, paddingRight: 4, borderRadius: 8, backgroundColor: tints.accent }}>
                      <Text style={{ ...chipText, flexShrink: 1, numberOfLines: 1, fontSize: 14, fontWeight: "500", color: colors.accent }}>{firstLine(replyNote() ?? shown().findLast((e) => e.ref === ref())?.text ?? ref()).replace(/\s+/g, " ").trim()}</Text>
                      <View
                        onPress={() => replyTo.set(null)}
                        role="button"
                        accessibilityLabel={L("Cancel reply", "取消回复")}
                        tooltip={<Tip label={L("Cancel reply", "取消回复")} shortcut="Esc" />}
                        hoverStyle={hovered()}
                        style={{ width: 24, height: 24, borderRadius: 6, alignItems: "center", justifyContent: "center" }}
                      >
                        <Icon name="close" size={13} tint={colors.accent} />
                      </View>
                    </View>
                  )}
                </If>
                <If when={attachments().length}>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingTop: 2 }}>
                    <Each of={attachments()} key={(a) => a.id}>
                      {(a) => (
                        <View testID="attachment" accessibilityLabel={a().name} style={{ width: 64, height: 64 }}>
                          <Image
                            src={a().preview}
                            style={{ width: 64, height: 64, borderRadius: radius.inset, backgroundColor: colors.inset, objectFit: "cover" }}
                          />
                          <View
                            testID="remove-attachment"
                            role="button"
                            accessibilityLabel={L(`Remove ${a().name}`, `移除 ${a().name}`)}
                            tooltip={touch ? undefined : <Tip label={L("Remove", "移除")} />}
                            onPress={() => unattach(a().id)}
                            hoverStyle={{ opacity: 0.85 }}
                            style={{
                              position: "absolute", top: -6, right: -6, width: 22, height: 22, borderRadius: 11,
                              alignItems: "center", justifyContent: "center",
                              backgroundColor: colors.text,
                            }}
                          >
                            <Icon name="close" size={10} tint={colors.background} />
                          </View>
                        </View>
                      )}
                    </Each>
                  </View>
                </If>
                <If when={attachNote()}>
                  {(note) => <Text testID="attach-note" style={{ fontSize: 13, color: colors.danger }}>{note()}</Text>}
                </If>
                <Input
                  testID="composer"
                  ref={(r) => (composer = r)}
                  multiline
                  submitBehavior={touch ? "newline" : "submit"}
                  onSubmit={submit}
                  value={draft()}
                  onChange={({ value }) => {
                    draft.set(value);
                    if (untracked(speech) !== "off" && value !== dictated) stopDictation(true);
                  }}
                  onSelectionChange={({ start, end }) => (caret = { start, end })}
                  onPaste={({ files, uris }) => {
                    for (const f of files) attach(f, f.name);
                    if (uris.length) void attachUris(uris);
                  }}
                  onFocus={() => {
                    if (compactComposer() && !reduceMotion()) LayoutAnimation.configureNext(LayoutAnimation.create(180, "easeInEaseOut", "opacity"));
                    focused.set(true);
                  }}
                  onBlur={() => {
                    if (!draft() && !attachments().length && !replyTo() && !reduceMotion()) LayoutAnimation.configureNext(LayoutAnimation.create(180, "easeInEaseOut", "opacity"));
                    focused.set(false);
                  }}
                  onContentSizeChange={({ size: s }) => inputHeight.set(Math.min(220, Math.max(28, s.height)))}
                  placeholder={replyTo() ? L(`Reply to ${replyTo()}…`, `回复 ${replyTo()}…`) : scope() ? L(`Message #${scoped()?.name ?? scope()}`, `在 #${scoped()?.name ?? scope()} 里讨论…`) : wide() ? L("Tell the team what to do, e.g. screenshot and check the nsh gallery on Linux", "给团队下指令，例如：把 nsh 的 gallery 在 Linux 上截图检查一遍") : L("Tell the team what to do…", "给团队下指令…")}
                  class={platform.os === "ios" ? "placeholder:text-muted-foreground" : "placeholder:text-faint"}
                  style={{
                    height: compactComposer() ? (touch ? 44 : 36) : inputHeight(),
                    marginLeft: compactComposer() ? (touch ? 44 : 36) - 2 : 0,
                    marginRight: compactComposer() && canDictate() ? (touch ? 44 : 36) + 8 : 0,
                    minWidth: 0, fontSize: size.text, lineHeight: 24, color: colors.text,
                    paddingVertical: compactComposer() ? (touch ? 10 : 6) : 2,
                  }}
                />
                {/* Keep the toolbar and its buttons in one place in the tree as the field expands. */}
                <View style={{ position: "absolute", left: 18, right: 8, bottom: compactComposer() ? 4 : 8, flexDirection: "row", alignItems: "center", gap: 8, pointerEvents: "box-none" }}>
                  <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0, pointerEvents: "box-none" }}>
                    <View
                      testID="attach"
                      role="button"
                      accessibilityLabel={L("Add image", "添加图片")}
                      tooltip={touch ? undefined : <Tip label={L("Add image (or paste or drop)", "添加图片（也可粘贴或拖入）")} />}
                      onPress={() => void pickImages()}
                      hoverStyle={hovered()}
                      style={{ width: touch ? 44 : 36, height: touch ? 44 : 36, marginLeft: -8, borderRadius: touch ? 22 : 18, alignItems: "center", justifyContent: "center" }}
                    >
                      <Icon name="plus" size={touch ? 22 : 18} tint={colors.text} />
                    </View>
                    <If when={speech() !== "off"}>
                      <Text testID="dictating" style={{ fontSize: 13, color: colors.accent, numberOfLines: 1 }}>
                        {speech() === "on" ? L("Listening…", "正在听…") : L("Recognizing…", "正在识别…")}
                      </Text>
                    </If>
                  </View>
                  <If when={canDictate()}>
                    {/* a large round target beside send, unfilled so it does not compete with send; while listening it becomes a red stop in the same place */}
                    <View
                      testID="dictate"
                      role="button"
                      accessibilityLabel={speech() === "off" ? L("Voice input", "语音输入") : L("Stop voice input", "停止语音输入")}
                      accessibilityState={{ selected: speech() !== "off" }}
                      tooltip={touch ? undefined : <Tip label={speech() === "off" ? L("Voice input", "语音输入") : L("Stop voice input", "停止语音输入")} />}
                      onPress={toggleDictation}
                      hoverStyle={speech() === "off" ? hovered() : { opacity: 0.9 }}
                      style={{
                        width: touch ? 44 : 36,
                        height: touch ? 44 : 36,
                        borderRadius: touch ? 22 : 18,
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: speech() === "off" ? undefined : tints.danger,
                        transitionProperty: "background-color",
                        transitionDuration: 120,
                      }}
                    >
                      <Icon name={speech() === "off" ? "mic" : "stop"} size={speech() === "off" ? (touch ? 22 : 19) : (touch ? 18 : 16)} tint={speech() === "off" ? colors.text : colors.danger} />
                    </View>
                  </If>
                  <If when={!compactComposer()}>
                    <SendButton testID="send" disabled={!canSend()} onPress={submit} />
                  </If>
                </View>
              </View>
            </View>
          </View>
          </View>
      </View>
  );

  const gutter = () => (wide() ? 32 : 16);
  const titleOf = (r: Route): string => {
    switch (r.name) {
      case "channel": return scope() ? `# ${scoped()?.name ?? scope()}` : L("Channel", "主会话");
      case "team": return wide() ? L("Team settings", "团队设置") : L("Settings", "设置");
      case "task": return L(`Task ${r.id}`, `任务 ${r.id}`);
      case "tasks": return L("All tasks", "全部任务");
      case "host": return L(`Machine ${r.host}`, `机器 ${r.host}`);
      case "notify": return L("Notifications", "通知");
      case "member": return displayName(r.id);
      case "routine": return r.routine;
      case "rules": return L("Memory", "记忆");
      case "doc": return r.path.split("/").pop()!.replace(/\.md$/i, "");
    }
  };
  /** The back button's label, the page below's short name. */
  const backTitle = (r: Route | undefined) => (!r ? "" : r.name === "channel" ? L("Channel", "主会话") : r.name === "team" ? L("Settings", "设置") : r.name === "host" ? L("Machines", "机器") : r.name === "rules" ? L("Memory", "记忆") : r.name === "tasks" ? L("All tasks", "全部任务") : titleOf(r));
  const below = (r: Route) => { const rs = nav.routes(); const i = rs.indexOf(r); return i > 0 ? rs[i - 1] : undefined; };
  const connPill = () => (
    <View
      tooltip={<Tip label={hub.cfg.url} />}
      accessibilityLabel={connLabel()}
      testID="conn"
      style={{ flexDirection: "row", alignItems: "center", gap: 7, height: 30, paddingHorizontal: wide() ? 10 : 11 }}
    >
      <Dot tone={connTone()} />
      <If when={wide()}>
        <Text style={{ fontSize: 13.5, color: hub.conn() === "unauthorized" ? colors.danger : colors.muted }}>{connLabel()}</Text>
      </If>
    </View>
  );
  /** The page header on desktops and the web; phones use the system header. */
  const Bar = (p: { route: Route }) => (
    <View
      desktop={{ windowDrag: true }}
      onTouchStartCapture={() => { if (platform.os === "macos" && focused()) composer?.blur(); }}
      style={{
        height: size.bar,
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingLeft: (wide() && sidebarOpen() ? 0 : hasWindow ? titleBar().left : 0) + (wide() ? 24 : 8),
        paddingRight: (hasWindow ? titleBar().right : 0) + (wide() ? 16 : 8),
        borderBottomWidth: 0.5,
        borderBottomColor: surfaceEdge(),
        backgroundColor: colors.background,
      }}
    >
      <If when={!wide() && p.route === CHANNEL}>
        <ToolButton icon="menu" label={L("Menu", "菜单")} onPress={() => drawer.set(true)} />
      </If>
      <If when={wide() && !sidebarOpen()}>
        <ToolButton icon="sidebar" label={L("Show sidebar", "显示侧栏")} shortcut={keymap.label("mod+b")} onPress={() => setSidebarOpen(true)} />
      </If>
      <If when={below(p.route)}>
        {(b) => (
          <View
            role="button"
            accessibilityLabel={L(`Back to ${backTitle(b())}`, `返回${backTitle(b())}`)}
            onPress={() => nav.pop()}
            hoverStyle={hovered()}
            style={{ height: touch ? 44 : 32, flexDirection: "row", alignItems: "center", gap: 2, paddingLeft: 4, paddingRight: 10, borderRadius: radius.control, borderCurve: "continuous" }}
          >
            <Icon name="back" size={18} tint={colors.accent} />
            <Text style={{ fontSize: 15, fontWeight: "500", color: colors.accent }}>{backTitle(b())}</Text>
          </View>
        )}
      </If>
      <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 }}>
        <Text style={{ fontSize: 16, fontWeight: "600", color: colors.text, numberOfLines: 1 }}>{titleOf(p.route)}</Text>
      </View>
      {connPill()}
      <If when={!wide() && p.route === CHANNEL}>
        <ToolButton icon="sliders" label={L("Settings", "设置")} onPress={openTeam} testID="settings-top" />
      </If>
    </View>
  );
  const content = (r: Route) => {
    switch (r.name) {
      case "channel": return channelPage();
      case "task": return <TaskDetail hub={hub} id={r.id} wide={wide()} />;
      case "tasks": return <TaskHistory hub={hub} wide={wide()} onTask={openTask} />;
      case "host": return <MachineDetail hub={hub} host={r.host} wide={wide()} onTask={openTask} />;
      case "team":
        return (
          <If
            when={wide()}
            else={<PhoneSettings hub={hub} push={push} settings={settings} onOpen={(x) => nav.push(x)} onDisconnect={props.onDisconnect} />}
          >
            <TeamSettings hub={hub} push={push} settings={settings} wide={wide()} onRules={() => openRules(true)} onConnection={props.onConnection} onDisconnect={props.onDisconnect} />
          </If>
        );
      case "notify": return <PhoneNotify push={push} settings={settings} />;
      case "member": return <PhoneMember id={r.id} settings={settings} />;
      case "routine": return <PhoneRoutine name={r.routine} settings={settings} />;
      case "rules": return <RulesList hub={hub} onOpen={(path) => nav.push({ name: "doc", path })} />;
      case "doc": return <RuleDoc hub={hub} path={r.path} wide={wide()} />;
    }
  };

  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: colors.sidebar, overflow: "hidden" }}>
      <If when={platform.os === "macos" && wide() && sidebarOpen()}>
        <View style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: size.sidebar + 20, ...glass(colors.sidebar, 0), backgroundColor: alpha(colors.sidebar, 0.25), borderWidth: 0, boxShadow: "none", pointerEvents: "none" }} />
      </If>
      <If when={wide() && sidebarOpen()}>
        <View onTouchStartCapture={() => { if (platform.os === "macos" && focused()) composer?.blur(); }} style={{ width: size.sidebar, paddingTop: sidebarInset }}>{sidebar(false)}</View>
      </If>
      <If when={!wide()}>
        <View testID="drawer" pan={drawer() ? { x: drawerX } : undefined} onPanStart={() => drawerDragging.set(true)} onPanEnd={finishDrawerPan} style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: drawerWidth(), paddingTop: touch ? safeArea().top : 0, visibility: drawerVisible() || drawerDragging() ? "visible" : "hidden", pointerEvents: drawer() ? "auto" : "none" }}>{sidebar(true)}</View>
      </If>
      <View style={{ flex: 1, minWidth: 0, backgroundColor: colors.background, borderTopLeftRadius: wide() && sidebarOpen() ? 20 : 0, borderBottomLeftRadius: wide() && sidebarOpen() ? 20 : 0, borderCurve: "continuous", borderLeftWidth: !wide() && (drawer() || drawerDragging()) ? 1 : 0, borderLeftColor: colors.line, overflow: "hidden", translate: [wide() ? 0 : drawerTranslate(), 0], boxShadow: wide() && sidebarOpen() ? "-3px 0 18px rgba(0,0,0,0.08)" : undefined }}>
      <NavStack state={nav} testID="pages" style={{ flex: 1, minWidth: 0 }}>
        {(route, index) => (
          <NavPage
            testID={`page-${route.name}`}
            // with the sidebar beside it, a page picked there replaces the view at once; only a page opened from a page slides in
            animation={wide() && index() <= 1 ? "none" : "default"}
            title={titleOf(route)}
            header={systemHeader ? undefined : <Bar route={route} />}
            headerBackTitle={backTitle(route)}
            headerLeft={systemHeader && route === CHANNEL && !wide() ? <ToolButton icon="menu" label={L("Menu", "菜单")} onPress={() => drawer.set(true)} /> : undefined}
            ios={{ headerLeftSymbol: "sidebar.left", headerRightSymbol: "gearshape" }}
            headerTitle={
              // iOS: the bar's buttons are UIKit's own, so the connection sits by the title.
              platform.os === "ios" && route === CHANNEL ? (
                <View testID="conn" accessibilityLabel={connLabel()} style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
                  <Dot tone={connTone()} />
                  <Text style={{ fontSize: 17, fontWeight: "600", color: colors.text }}>{titleOf(route)}</Text>
                </View>
              ) : undefined
            }
            headerRight={
              platform.os === "ios" ? (
                route === CHANNEL ? <ToolButton icon="sliders" label={L("Settings", "设置")} onPress={openTeam} testID="settings-top" /> : undefined
              ) : systemHeader ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                  {connPill()}
                  <If when={route === CHANNEL}>
                    <ToolButton icon="sliders" label={L("Settings", "设置")} onPress={openTeam} testID="settings-top" />
                  </If>
                </View>
              ) : undefined
            }
            style={{ backgroundColor: colors.background }}
          >
            {content(route)}
          </NavPage>
        )}
      </NavStack>
      <If when={!wide() && drawer()}>
        <View testID="drawer-dismiss" role="button" accessibilityLabel={L("Close sidebar", "关闭侧栏")} onPress={() => drawer.set(false)} pan={{ x: drawerX }} onPanStart={() => drawerDragging.set(true)} onPanEnd={finishDrawerPan} style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, backgroundColor: "rgba(0,0,0,0.08)" }} />
      </If>
      </View>

      <SettingsToast state={settings.toast} />
      <If when={toast()}>
        {(t) => (
          <View style={{ position: "absolute", top: size.bar + 10, left: 0, right: 0, alignItems: "center", paddingHorizontal: 12, pointerEvents: "box-none" }}>
            <View
              role="button"
              testID="toast"
              accessibilityLabel={L(`View ${t().ref}`, `查看 ${t().ref}`)}
              onPress={() => {
                const ref = t().ref; // read before clearing: the toast's accessor is null after set(null)
                toast.set(null);
                pick(ref);
              }}
              style={{
                maxWidth: 520,
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                paddingVertical: 10,
                paddingHorizontal: 14,
                borderRadius: 14,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surface,
                boxShadow: "0 10px 30px rgba(0,0,0,0.16)",
              }}
            >
              <Dot tone="wait" />
              <Text style={{ flexShrink: 1, fontSize: 14.5, color: colors.text, numberOfLines: 1 }}>
                <Text style={{ fontWeight: "600" }}>{L(`New decision ${t().ref}`, `新决策 ${t().ref}`)}</Text> · {t().text}
              </Text>
              <Text style={{ fontSize: 14, fontWeight: "600", color: colors.accent }}>{L("View", "查看")}</Text>
            </View>
          </View>
        )}
      </If>

      <HelpSheet open={help()} onClose={() => help.set(false)} />
    </View>
  );
}

// ---------------------------------------------------------------- connect

function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  masked?: boolean;
  testID?: string;
  hint?: string;
  autoFocus?: boolean;
  keyboardType?: "email-address" | "number-pad" | "url";
  autoComplete?: "email" | "one-time-code" | "url";
  maxLength?: number;
  big?: boolean;
}) {
  const focused = signal(false);
  return (
    <View style={{ gap: 7 }}>
      <Text style={{ fontSize: 14, fontWeight: "600", color: colors.text }}>{props.label}</Text>
      <Input
        testID={props.testID}
        value={props.value}
        masked={props.masked}
        autoFocus={props.autoFocus}
        keyboardType={props.keyboardType}
        autoComplete={props.autoComplete}
        maxLength={props.maxLength}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={props.placeholder}
        class="placeholder:text-faint"
        submitBehavior="submit"
        onSubmit={() => props.onSubmit?.()}
        onChange={({ value }) => props.onChange(value)}
        onFocus={() => focused.set(true)}
        onBlur={() => focused.set(false)}
        style={{
          height: props.big ? 56 : 44,
          paddingHorizontal: 14,
          borderRadius: radius.control,
          borderWidth: 1,
          borderColor: focused() ? colors.accent : colors.fieldBorder,
          backgroundColor: colors.field,
          fontSize: 16,
          color: colors.text,
          ...(props.big ? { fontSize: 26, letterSpacing: 10, textAlign: "center", fontVariant: ["tabular-nums"] } : {}),
          ...(focused() ? { outlineStyle: "solid", outlineWidth: 3, outlineColor: alpha(colors.accent, 0.12) } : {}),
        }}
      />
      <If when={props.hint}>
        <Text style={{ fontSize: 13, lineHeight: 19, color: colors.muted }}>{props.hint}</Text>
      </If>
    </View>
  );
}

const RESEND = 60;

async function postJson(url: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  let r: Response;
  try {
    r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new Error("unreachable");
  }
  let data: Record<string, unknown> = {};
  try {
    data = ((await r.json()) ?? {}) as Record<string, unknown>;
  } catch {
    /* no body */
  }
  return { status: r.status, data };
}

/** Login: the email gets a one-time code. On the web served by the hub the server is the page's own origin. */
function Login(props: { url: string; served: boolean; email: string; notice?: string; onLogin: (c: Config) => void }) {
  const url = signal(props.url);
  const editUrl = signal(!props.served);
  const email = signal(props.email);
  const code = signal("");
  const totp = signal(""); // the authenticator app's 6 digits: every sign-in needs it (bound on the host: noop 2fa setup)
  const step = signal<"email" | "code">("email");
  const error = signal(props.notice ?? "");
  const busy = signal(false);
  const wait = signal(0);
  let timer: ReturnType<typeof setInterval> | undefined;
  cleanup(() => clearInterval(timer));
  const server = () => normalizeUrl(url());
  const unreachable = () => L(`Can’t reach ${server()}. Check the address and your network.`, `连不上服务器 ${server()}，请检查地址和网络`);

  const viaCli = signal(false); // email not set up yet: the code is shown by `noop login` on the owner's machine
  async function sendCode() {
    const e = email().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return error.set(L("Enter a valid email address", "请填写有效的邮箱地址"));
    if (!server()) return error.set(L("Enter the server address", "请填写服务器地址"));
    busy.set(true);
    error.set("");
    try {
      const r = await postJson(`${server()}/api/auth/start`, { email: e });
      if (r.status === 429) throw new Error(String(r.data.error ?? L("Too many requests. Try again later.", "请求太频繁，请稍后再试")));
      const ip = ipBlocked(r.status, r.data);
      if (ip) throw new Error(L(`This device's public IP ${ip} isn't on the allow-list (HUB_ALLOW_IPS). Add it on the host, then try again.`, `这台设备的出口 IP ${ip} 不在允许名单（HUB_ALLOW_IPS）里，在主机上加进去后再试。`));
      if (r.data.error === "totp_not_setup") throw new Error(L("Two-step verification isn’t set up yet, so nobody can sign in. Run noop 2fa setup on your host first.", "还没有绑定两步验证，任何人都无法登录：先在你的主机上运行 noop 2fa setup"));
      if (r.status === 403) throw new Error(L("This email isn’t allowed to sign in", "这个邮箱不允许登录"));
      if (r.status === 503) throw new Error(L("The server can’t send email yet, so email sign-in isn’t available", "服务器还没有配置发信，暂时无法用邮箱登录"));
      if (r.status >= 400) throw new Error(L(`The server returned ${r.status}. This address may not be a noop server.`, `服务器返回 ${r.status}，这个地址可能不是 noop`));
      await Storage.setItem(KEYS.email, e);
      viaCli.set(r.data.delivery === "cli");
      code.set("");
      step.set("code");
      wait.set(RESEND);
      clearInterval(timer);
      timer = setInterval(() => {
        wait.update((w) => Math.max(0, w - 1));
        if (untracked(wait) === 0) clearInterval(timer);
      }, 1000);
    } catch (err) {
      error.set(err instanceof Error && err.message !== "unreachable" ? err.message : unreachable());
    } finally {
      busy.set(false);
    }
  }

  async function verify() {
    const c = code().toUpperCase().replace(/[^A-Z0-9]/g, ""), t = totp().replace(/\D/g, "");
    if (c.length !== CODE_LEN || t.length !== 6 || busy()) return;
    busy.set(true);
    error.set("");
    try {
      const r = await postJson(`${server()}/api/auth/verify`, { email: email().trim(), code: c, totp: t });
      if (r.status === 401) throw new Error(typeof r.data.error === "string" ? r.data.error : L("The code is wrong or expired. Enter it again.", "验证码不对或已过期，请重新输入"));
      if (r.status === 403 && typeof r.data.error === "string") throw new Error(r.data.error);
      if (r.status === 429) throw new Error(String(r.data.error ?? L("Too many attempts. Try again later.", "尝试太频繁，请稍后再试")));
      if (r.status >= 400 || typeof r.data.session !== "string") throw new Error(L(`The server returned ${r.status}`, `服务器返回 ${r.status}`));
      await Storage.setItem(KEYS.url, server());
      await Storage.setItem(KEYS.token, r.data.session);
      props.onLogin({ url: server(), token: r.data.session });
    } catch (err) {
      totp.set(""); // a TOTP is good for 30 s: retype it; the email code stays (it survives a wrong TOTP)
      error.set(err instanceof Error && err.message !== "unreachable" ? err.message : unreachable());
    } finally {
      busy.set(false);
    }
  }
  const onCode = (v: string) => {
    const c = v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, CODE_LEN);
    code.set(c);
    if (c.length === CODE_LEN && totp().length === 6) verify();
  };
  const onTotp = (v: string) => {
    const t = v.replace(/\D/g, "").slice(0, 6);
    totp.set(t);
    if (t.length === 6 && code().length === CODE_LEN) verify();
  };

  return (
    <Scroll style={{ flex: 1, backgroundColor: colors.background }} keyboardShouldPersistTaps="handled">
      <View style={{ minHeight: windowSize().height - (touch ? safeArea().top : 0), alignItems: "center", justifyContent: "center", paddingHorizontal: 16, paddingTop: 48, paddingBottom: 48 }}>
        <View style={{ width: "100%", maxWidth: 440, gap: 24 }}>
          <View style={{ alignItems: "center", gap: 12 }}>
            <Mark size={48} />
            <Text style={{ fontSize: 28, fontWeight: "600", color: colors.text, letterSpacing: -0.3 }}>{L("Sign in to Noop", "登录 Noop")}</Text>
            <Text style={{ fontSize: 15.5, lineHeight: 23, color: colors.muted, textAlign: "center" }}>
              {step() === "email" ? L("Sign in with email. We’ll send you an 8-character code.", "用邮箱登录：我们会发一个 8 位验证码给你（字母和数字）。") : viaCli() ? L("Email isn’t set up yet. Run noop login in your host’s terminal to see the code.", "还没配置发信邮箱：在你的主机终端运行 noop login 查看验证码。") : L(`We sent a code to ${email().trim()}. Check your email.`, `验证码已发到 ${email().trim()}，请查收邮件。`)}
            </Text>
          </View>
          <View style={{ gap: 18, padding: 22, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }}>
            <If
              when={step() === "code"}
              else={
                <>
                  <Field
                    label={L("Email", "邮箱")}
                    value={email()}
                    onChange={(v) => email.set(v)}
                    onSubmit={sendCode}
                    placeholder="you@example.com"
                    keyboardType="email-address"
                    autoComplete="email"
                    autoFocus
                    testID="email"
                  />
                  <If
                    when={editUrl()}
                    else={
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                        <Dot tone="on" />
                        <Text style={{ flex: 1, fontSize: 14, color: colors.muted, numberOfLines: 1 }}>{L(`Server: ${server()}`, `服务器：${server()}`)}</Text>
                        <View role="button" accessibilityLabel={L("Change server", "更改服务器")} onPress={() => editUrl.set(true)} hoverStyle={hovered()} style={{ height: 30, justifyContent: "center", paddingHorizontal: 8, borderRadius: 6 }}>
                          <Text style={{ fontSize: 14, fontWeight: "500", color: colors.accent }}>{L("Change", "更改")}</Text>
                        </View>
                      </View>
                    }
                  >
                    <Field label={L("Server address", "服务器地址")} value={url()} onChange={(v) => url.set(v)} onSubmit={sendCode} placeholder={L("https://noop.<your-account>.workers.dev", "https://noop.<你的账号>.workers.dev")} keyboardType="url" testID="url" hint={L("Your noop address. It’s shown after install, or run noop status --brief on the host.", "你的 noop 地址：安装完成时显示，也可以在主机上运行 noop status --brief 查看")} />
                  </If>
                </>
              }
            >
              <Field
                label={L("Code", "验证码")}
                value={code()}
                onChange={onCode}
                onSubmit={verify}
                placeholder="········"
                autoComplete="one-time-code"
                autoFocus
                big
                testID="code"
              />
              <Field
                label={L("Authenticator code", "两步验证码（验证器 App）")}
                value={totp()}
                onChange={onTotp}
                onSubmit={verify}
                placeholder="······"
                keyboardType="number-pad"
                big
                testID="totp"
              />
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <View role="button" accessibilityLabel={L("Use another email", "换个邮箱")} onPress={() => { step.set("email"); error.set(""); }} hoverStyle={hovered()} style={{ height: 30, justifyContent: "center", paddingHorizontal: 8, borderRadius: 6 }}>
                  <Text style={{ fontSize: 14, color: colors.muted }}>{L("‹ Use another email", "‹ 换个邮箱")}</Text>
                </View>
                <View style={{ flex: 1 }} />
                <View
                  role="button"
                  testID="resend"
                  accessibilityLabel={L("Resend", "重新发送")}
                  accessibilityState={{ disabled: wait() > 0 }}
                  onPress={() => wait() === 0 && !busy() && sendCode()}
                  hoverStyle={wait() ? undefined : hovered()}
                  style={{ height: 30, justifyContent: "center", paddingHorizontal: 8, borderRadius: 6 }}
                >
                  <Text style={{ fontSize: 14, fontWeight: "500", color: wait() ? colors.faint : colors.accent, fontVariant: ["tabular-nums"] }}>
                    {wait() ? L(`Resend (${wait()}s)`, `重新发送（${wait()}s）`) : L("Resend", "重新发送")}
                  </Text>
                </View>
              </View>
            </If>
            <If when={error()}>
              <View style={{ paddingHorizontal: 12, paddingVertical: 10, borderRadius: radius.control, backgroundColor: tints.danger }}>
                <Text testID="login-error" style={{ fontSize: 14, lineHeight: 20, color: colors.danger }}>{error()}</Text>
              </View>
            </If>
            <If
              when={step() === "code"}
              else={<Btn testID="send-code" label={busy() ? L("Sending…", "发送中…") : L("Send code", "发送验证码")} kind="primary" busy={busy()} grow onPress={sendCode} />}
            >
              <Btn testID="verify" label={busy() ? L("Signing in…", "登录中…") : L("Sign in", "登录")} kind="primary" busy={busy()} disabled={code().length !== CODE_LEN || totp().length !== 6} grow onPress={verify} />
            </If>
          </View>
        </View>
      </View>
    </Scroll>
  );
}

// ---------------------------------------------------------------- app

function Connected(props: { config: Config; openRef: string | null; onExpired: () => void; onLogout: () => void; onTray: (chat: TrayChat | null) => void }) {
  const hub = createHub(props.config);
  cleanup(hub.dispose);
  // The service worker answers decisions from notifications with the session.
  hostCall("setSession", { session: props.config.token, origin: props.config.url });
  // A 401 on any call: the session is gone, back to the login.
  effect(() => {
    if (hub.conn() === "unauthorized") props.onExpired();
  });
  return (
    <Chat
      hub={hub}
      openRef={props.openRef}
      onConnection={props.onExpired}
      onTray={props.onTray}
      onDisconnect={async () => {
        const off = await hostCall<{ endpoint: string | null }>("pushDisable");
        if (off?.endpoint) await hub.api("POST", "/api/push/unsubscribe", { endpoint: off.endpoint });
        await hostCall("setSession", { session: null });
        for (const id of [...showing]) closeNotification(id);
        setBadge(0);
        await hub.logout();
        props.onLogout();
      }}
    />
  );
}

function App() {
  if (hasWindow) {
    currentWindow().set({ title: "Noop", titleBar: { style: "hidden", height: size.bar } });
  }
  Scrollbar.setTheme(scrollbarTheme);
  watchUpdates();
  const trayChat = signal<TrayChat | null>(null);
  setupTray(trayChat);
  const ready = signal(false);
  const config = signal<Config | null>(null);
  const url = signal("");
  const served = signal(false);
  const email = signal("");
  const notice = signal("");
  let openRef: string | null = null;
  loadConfig().then((r) => {
    openRef = r.ref;
    config.set(r.config);
    url.set(r.config?.url ?? r.suggested);
    served.set(r.served);
    email.set(r.email);
    ready.set(true);
  });
  async function forget(message: string) {
    await Storage.removeItem(KEYS.token);
    email.set((await Storage.getItem(KEYS.email)) ?? untracked(email));
    notice.set(message);
    config.set(null);
  }
  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: touch && !(systemHeader && config()) ? safeArea().top : 0 }}>
      <If when={ready()}>
        <If
          when={config()}
          else={
            <Login
              url={url()}
              served={served()}
              email={email()}
              notice={notice()}
              onLogin={(c) => {
                notice.set("");
                url.set(c.url);
                config.set(c);
              }}
            />
          }
        >
          {(c) => <Connected config={c()} openRef={openRef} onExpired={() => forget(L("Your session expired. Please sign in again.", "登录已过期，请重新登录"))} onLogout={() => forget("")} onTray={(chat) => trayChat.set(chat)} />}
        </If>
      </If>
    </View>
  );
}

mount(App);
