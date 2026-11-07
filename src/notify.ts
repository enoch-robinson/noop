// Slack / Discord: outbound notifications + polling owner replies (no public webhook server needed).
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { buttonOptions, discordComponents, ntfyActions, rfc2047, slackBody } from "./cards";
import { type Cfg, P, fileId, hostName, isPrimary, list, readDoc } from "./core";
import { appendEvent, type CardOption, type Event, forwardEvent, storeMedia, uploadMedia } from "./server";

export type NotifyOpts = { kind?: Event["kind"]; ref?: string; options?: string[]; choices?: CardOption[]; attachments?: string[]; from?: string;
  /** Team channel only: no ntfy / Slack / Discord (agents' routine results). */ quiet?: boolean };


async function slackUpload(n: Cfg, file: string, thread?: string) {
  const f = Bun.file(file);
  const h = { Authorization: `Bearer ${n.slack_bot_token}` };
  const u = await (await fetch(`https://slack.com/api/files.getUploadURLExternal?filename=${encodeURIComponent(basename(file))}&length=${f.size}`, { headers: h })).json() as any;
  if (!u.ok) return;
  await fetch(u.upload_url, { method: "POST", body: f });
  await fetch("https://slack.com/api/files.completeUploadExternal", { method: "POST", headers: { ...h, "Content-Type": "application/json" },
    body: JSON.stringify({ files: [{ id: u.file_id }], channel_id: n.slack_channel, thread_ts: thread }) });
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  try { return JSON.parse(t || "{}"); } catch { return {}; }
}

const discordHeaders = (n: Cfg) => ({ Authorization: `Bot ${n.discord_bot_token}`, "User-Agent": "noop (1.0)" });

export async function notify(text: string, cfg: Cfg, o: NotifyOpts = {}): Promise<string[]> {
  const n = cfg.notify ?? {};
  const ids: string[] = [];
  const files = (o.attachments ?? []).filter((f) => existsSync(f));
  // 1) the hub's own chat timeline (primary-local; workers forward to the primary server)
  const ev = { from: o.from ?? `hub@${hostName(cfg)}`, kind: o.kind ?? "notice", text, ref: o.ref, options: o.options,
    ...(o.choices?.length ? { choices: o.choices } : {}) } as Omit<Event, "id" | "ts">;
  if (isPrimary(cfg)) { appendEvent({ ...ev, attachments: files.map(storeMedia) }); ids.push("hub"); }
  else {
    const urls = (await Promise.all(files.map((f) => uploadMedia(f, cfg)))).filter(Boolean) as string[];
    if (await forwardEvent({ ...ev, attachments: urls }, cfg)) ids.push("hub");
  }
  if (o.quiet) return ids;
  // 2) phone push via ntfy (self-hostable); card taps open the Worker's /card/<id> (login-aware, public), other
  // pushes fall back to the primary's chat page; keyed options become banner buttons when the answer-only token
  // and the Worker URL are known (safe options POST /api/answer and clear the banner; risky ones open the card page)
  try {
    if (n.ntfy_url) {
      const cardRef = o.ref && /^[DLP]-[A-Z]?\d{4}$/.test(o.ref) ? o.ref : "";
      const click = cardRef && cfg.cloud?.url ? `${String(cfg.cloud.url).replace(/\/$/, "")}/card/${cardRef}` : cfg.server?.public_url;
      const headers: Record<string, string> = { Title: "Noop", ...(click ? { Click: click } : {}),
        ...(n.ntfy_token ? { Authorization: `Bearer ${n.ntfy_token}` } : {}) };
      const actions = ntfyActions(o.ref ?? "", buttonOptions(o.kind, o.choices), cfg.cloud?.url ?? "", n.ntfy_answer_token);
      if (actions) headers.Actions = rfc2047(actions); // a UTF-8 label would make fetch throw and lose the push
      await fetch(n.ntfy_url, { method: "POST", body: text.replace(/\*/g, "").slice(0, 3000), headers });
    }
  } catch (e) { console.error("ntfy failed", e); }
  try {
    if (n.slack_bot_token && n.slack_channel) {
      // the bot app can receive clicks: keyed options become Block Kit buttons (the webhook fallback cannot, so it stays plain)
      const r = await post("https://slack.com/api/chat.postMessage", { channel: n.slack_channel, ...slackBody(text, o.ref, o.kind, o.choices) },
        { Authorization: `Bearer ${n.slack_bot_token}` });
      if (r.ok) { ids.push(`slack:${r.ts}`); for (const f of files) await slackUpload(n, f, r.ts).catch(() => {}); }
      else console.error("slack:", r.error);
    } else if (n.slack_webhook) { await post(n.slack_webhook, { text }); ids.push("slack:webhook"); }
  } catch (e) { console.error("slack notify failed", e); }
  try {
    const content = text.replace(/\*/g, "**").slice(0, 1900);
    const btns = buttonOptions(o.kind, o.choices); // the bot app can receive clicks; the webhook fallback cannot
    if (n.discord_bot_token && n.discord_channel) {
      const fd = new FormData();
      fd.append("payload_json", JSON.stringify({ content, ...(o.ref && btns.length ? { components: discordComponents(o.ref, btns, cfg.cloud?.url ? String(cfg.cloud.url) : undefined) } : {}) }));
      files.slice(0, 10).forEach((f, i) => fd.append(`files[${i}]`, Bun.file(f), basename(f)));
      const r = await (await fetch(`https://discord.com/api/v10/channels/${n.discord_channel}/messages`, { method: "POST", body: fd, headers: discordHeaders(n) })).json() as any;
      if (r.id) ids.push(`discord:${r.id}`); else console.error("discord:", r.message);
    } else if (n.discord_webhook) { await post(n.discord_webhook, { content }); ids.push("discord:webhook"); }
  } catch (e) { console.error("discord notify failed", e); }
  if (ids.length <= 1) console.log(`[notify]\n${text}`);
  return ids;
}

/** Owner replies look like `D-0012 A`, `D-0012 do B but keep tests`, or `D-0012 override: ...`. */
const ANSWER = /\b([DLP]-[A-Z]?\d{4})\b[\s:：,，\-]*([\s\S]+)/;

export type Reply = { id: string; answer: string; source: string; via?: string };

export async function pollReplies(cfg: Cfg, ids: Set<string>): Promise<Reply[]> {
  if (!ids.size) return [];
  const n = cfg.notify ?? {};
  const msgs: { text: string; source: string; ts: number }[] = [];
  try {
    if (n.slack_bot_token && n.slack_channel) {
      const r = await (await fetch(`https://slack.com/api/conversations.history?channel=${n.slack_channel}&limit=50`,
        { headers: { Authorization: `Bearer ${n.slack_bot_token}` } })).json() as any;
      for (const m of r.messages ?? []) {
        if (m.bot_id || (n.slack_owner_user_id && m.user !== n.slack_owner_user_id)) continue;
        msgs.push({ text: m.text ?? "", source: "slack", ts: parseFloat(m.ts) * 1000 });
      }
    }
  } catch (e) { console.error("slack poll failed", e); }
  try {
    if (n.discord_bot_token && n.discord_channel) {
      const r = await (await fetch(`https://discord.com/api/v10/channels/${n.discord_channel}/messages?limit=50`,
        { headers: discordHeaders(n) })).json() as any[];
      for (const m of Array.isArray(r) ? r : []) {
        if (m.author?.bot || (n.discord_owner_user_id && m.author?.id !== n.discord_owner_user_id)) continue;
        msgs.push({ text: m.content ?? "", source: "discord", ts: Date.parse(m.timestamp) });
      }
    }
  } catch (e) { console.error("discord poll failed", e); }
  const found = new Map<string, Reply>();
  for (const m of msgs.sort((a, b) => a.ts - b.ts)) {
    const mm = m.text.replace(/`/g, "").match(ANSWER);
    if (mm && ids.has(mm[1])) found.set(mm[1], { id: mm[1], answer: mm[2].trim(), source: m.source, via: `text:${m.source}` });
  }
  return [...found.values()];
}

/** IDs (not paths) of the cards waiting for the owner. `basename` so Windows' "\" separators don't leak into the set:
 * splitting on "/" returned the whole path there, so every chat reply to a D-card matched nothing and was dropped. */
export const openDecisionIds = () => new Set(list(P("decisions", "open")).map(fileId));

/** Best-effort channel receipt after a card resolves: rewrite the source Slack/Discord messages so their buttons die
 * (chat.update / PATCH with components stripped). Stale clicks already fail safe — the Worker answers them
 * 「已处理」— this just keeps the channel honest. Never throws, never blocks the caller for long. */
export async function resolveReceipt(id: string, cfg: Cfg, answer: string, by: string): Promise<void> {
  try {
    const n = cfg.notify ?? {};
    const f = P("decisions", "closed", `${id}.md`);
    const notified = existsSync(f) ? (readDoc(f).meta.notified ?? "") : "";
    const line = `✅ ${id} 已处理：${answer}（${by}）`;
    for (const mid of notified.split(",").filter(Boolean)) {
      // the id is file data (prompt injection is in the threat model): only well-formed ts/message ids may reach
      // the API call — a hostile "discord:x/../../users/@me" must never ride the URL path
      const slackTs = mid.match(/^slack:(\d+\.\d+)$/)?.[1];
      const discordId = mid.match(/^discord:(\d+)$/)?.[1];
      if (slackTs && n.slack_bot_token && n.slack_channel) {
        await fetch("https://slack.com/api/chat.update", { method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${n.slack_bot_token}` },
          body: JSON.stringify({ channel: n.slack_channel, ts: slackTs, text: line, blocks: [] }) }).catch(() => {});
      } else if (discordId && n.discord_bot_token && n.discord_channel) {
        await fetch(`https://discord.com/api/v10/channels/${n.discord_channel}/messages/${discordId}`, { method: "PATCH",
          headers: { ...discordHeaders(n), "Content-Type": "application/json" },
          body: JSON.stringify({ content: line, components: [] }) }).catch(() => {});
      }
    }
  } catch { // a receipt is polish: any failure is silent (the fleet's own notify of the answer still went out)
  }
}
