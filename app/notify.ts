// Which events become a notification, and what it says. The Worker applies it to Web Push and the app to the
// system's notifications, so both follow the owner's preferences (settings `notify_prefs`). No UI, no I/O.

type Quiet = { start: string; end: string } | string | null;
/** `lang` picks the title language ("en" by default); this file stays free of the app's signals so the Worker can use it. */
export type NotifyRules = { kinds?: Record<string, boolean>; quiet_hours?: Quiet; tz?: string; lang?: "en" | "zh" };
export type NotifyEvent = { kind: string; from?: unknown; text?: unknown; priority?: unknown };

const KINDS = ["decision", "menu", "proposals", "login", "notice"];
const TITLES: Record<string, [string, string]> = {
  decision: ["Needs your call", "需要你拍板"],
  menu: ["Pick the next step", "可以选下一步"],
  proposals: ["New proposals", "新的提议"],
  login: ["Login reminder", "登录提醒"],
  notice: ["Noop", "Noop"],
};

/** Is `now` inside the quiet hours (`{start, end}` from the app, "23:00-08:00" written by hand) in `tz`? */
export function inQuiet(range: Quiet | undefined, tz: string | undefined, now = new Date()) {
  const text = range && typeof range === "object" ? `${range.start}-${range.end}` : range;
  const m = text?.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  let hm: string;
  try { hm = new Intl.DateTimeFormat("en-GB", { timeZone: tz || "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now); }
  catch { hm = now.toISOString().slice(11, 16); }
  const [h, mi] = hm.split(":").map(Number), t = h * 60 + mi;
  const a = +m[1] * 60 + +m[2], b = +m[3] * 60 + +m[4];
  return a <= b ? t >= a && t < b : t >= a || t < b;
}

const plain = (s: string) => s.replace(/```[\s\S]*?```/g, " ").replace(/[*_`#>\[\]]/g, "").replace(/\(https?:[^)]*\)/g, "").replace(/\s+/g, " ").trim();

/** The title and body for an event, or null when it should not notify. */
export function notificationFor(ev: NotifyEvent, prefs: NotifyRules, now = new Date()): { title: string; body: string } | null {
  const kind = ev.kind;
  if (!KINDS.includes(kind)) return null; // never system / owner
  if (kind === "notice" && /^hub(@|$)/.test(String(ev.from ?? ""))) return null; // hub's own housekeeping
  // a judge receipt ("judge 已代答 …" + the veto button) is quiet by design: the answer itself is the news,
  // and the card stays interactive in the feed — it just never buzzes the owner's phone
  if (kind === "decision" && /^judge(@|$)/.test(String(ev.from ?? ""))) return null;
  // Settings call notices "results".
  if (prefs.kinds?.[kind === "notice" ? "result" : kind] === false) return null;
  const urgent = kind === "decision" && ev.priority === "urgent";
  if (inQuiet(prefs.quiet_hours, prefs.tz, now) && kind !== "login" && !urgent) return null;
  const body = plain(String(ev.text ?? ""));
  return { title: TITLES[kind]?.[prefs.lang === "zh" ? 1 : 0] ?? "Noop", body: body.length > 140 ? `${body.slice(0, 139)}…` : body };
}
