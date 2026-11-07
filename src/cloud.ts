// Cloud bridge: connects the fleet to the owner's own Cloudflare Worker (cloud/). Outbound HTTPS only.
//   primary: mirrors every feed event up, pulls the owner's messages/settings down, pushes status + settings snapshots.
//   workers: forward events/media straight to the Worker (cfg.server.url points there).
// `hub cloud deploy` deploys the Worker into the owner's Cloudflare account (wrangler login once) and records the URL.
import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { type Jwk, newVapidKeys } from "../cloud/src/push";
import { type Cfg, CODE, P, _commitPush, _pull, hostName, journal, locked, HOME_DIR } from "./core";
import { writeHubToml } from "./sync";
import { ensureWebClient } from "./webclient";
import { type Event, MEDIA, appendEvent, applyOp, handleOwnerMessage, saveSettings, setMirror, settingsView, status, cancelTask, updateFleet } from "./server";

const base = (cfg: Cfg) => String(cfg.cloud?.url ?? "").replace(/\/$/, "");
const headers = (cfg: Cfg) => ({ Authorization: `Bearer ${cfg.server?.token}`, "Content-Type": "application/json" });

async function call(cfg: Cfg, path: string, init: RequestInit = {}, timeoutMs = 15_000) {
  const r = await fetch(base(cfg) + path, { ...init, headers: headers(cfg), signal: AbortSignal.timeout(timeoutMs) }).catch(() => null);
  if (!r?.ok) return null;
  return r.json() as Promise<any>;
}

/** One of the Worker's media files ("/media/<id>": the owner's uploaded images), as bytes. */
export async function cloudMedia(cfg: Cfg, path: string): Promise<Uint8Array | null> {
  if (!/^\/media\/[\w.\-]+$/.test(path)) return null;
  const r = await fetch(base(cfg) + path, { headers: { Authorization: `Bearer ${cfg.server?.token}` }, signal: AbortSignal.timeout(60_000) }).catch(() => null);
  return r?.ok ? new Uint8Array(await r.arrayBuffer()) : null;
}

/** Primary: run the bridge loop. */
export function startCloudBridge(cfg: Cfg) {
  if (!base(cfg) || !cfg.server?.token) return;
  const pending: Event[] = [];
  // an event's images live in this machine's media folder ("/media/<name>"): upload them first, then point the event at the copies
  const upload = async (url: string): Promise<string | null> => {
    const f = join(MEDIA, basename(url));
    if (!url.startsWith("/media/") || !existsSync(f)) return url;
    const fd = new FormData();
    fd.append("file", Bun.file(f), basename(f));
    const r = await fetch(base(cfg) + "/api/media", { method: "POST", body: fd, headers: { Authorization: `Bearer ${cfg.server?.token}` }, signal: AbortSignal.timeout(60_000) }).catch(() => null);
    return r?.ok ? ((await r.json()) as { url: string }).url : null;
  };
  const flush = async () => {
    while (pending.length) {
      const e = pending[0];
      if (e.attachments?.length) {
        const urls = await Promise.all(e.attachments.map(upload));
        if (urls.some((u) => !u)) return; // retry on the next poll
        pending[0] = { ...e, attachments: urls as string[] };
      }
      if (!(await call(cfg, "/api/events", { method: "POST", body: JSON.stringify(pending[0]) }))) return;
      pending.shift();
    }
  };
  setMirror((e) => { pending.push(e); void flush(); });

  // the inbox cursor and the ids already handled survive restarts: the Worker only drops a message once a later poll
  // acks it, so a daemon restarting mid-batch got the same owner messages again and made duplicate tasks (T-0641)
  const cursorFile = join(HOME_DIR, "cloud-inbox.json");
  const saved = (() => { try { return JSON.parse(readFileSync(cursorFile, "utf8")); } catch { return {}; } })();
  const sameHub = saved.url === base(cfg);
  const seen: string[] = Array.isArray(saved.seen) ? saved.seen : [];
  const saveCursor = () => { try { writeFileSync(cursorFile, JSON.stringify({ url: base(cfg), after, seen: seen.slice(-500) })); } catch {} };
  let after = sameHub ? Number(saved.after) || 0 : 0, n = 0, busy = false, lastStatus = "", lastShape = "", lastPush = 0;
  let watchers = 1; // owner clients connected (the Worker reports it); until it says otherwise, assume someone looks
  // push the dashboard at once when its shape changes (an answered decision must leave "待你决定" at once); live agent
  // activity alone is pushed at most once a minute and only while an owner client is open; an unchanged dashboard
  // every ~15 min (Cloudflare free plan: cloud/src/budget.ts)
  const pushStatus = async (force = false) => {
    const s = status();
    const st = JSON.stringify(s);
    const shape = JSON.stringify({ ...s, active: s.active.map(({ activity: _, ...t }) => t) });
    const due = shape !== lastShape || (watchers > 0 && st !== lastStatus && Date.now() - lastPush > 60_000) || force;
    if (!due) return;
    const r = await call(cfg, "/api/host/state", { method: "PUT", body: JSON.stringify({ status: s, settings: settingsView() }) });
    if (r) { lastStatus = st; lastShape = shape; lastPush = Date.now(); if (typeof r.watchers === "number") watchers = r.watchers; }
  };
  // housekeeping every few seconds: mirror events up, push the dashboard (both cost nothing when nothing changed)
  const loop = async () => {
    if (busy) return; busy = true;
    try {
      await flush();
      await pushStatus(n++ % 300 === 0); // a forced re-push every ~15 min; the Worker skips unchanged writes
      if (!live && Date.now() - lastDrain > 60_000) void drain(); // no socket: poll the inbox once a minute
    } catch (err) { console.error(`cloud bridge: ${err}`); }
    busy = false;
  };
  // the owner→fleet inbox. A hibernating WebSocket carries a nudge per item (the Durable Object sleeps in between, and
  // pings are answered without waking it), then the items come over plain GETs, so the chat brain here gets an owner
  // message within milliseconds (the owner's model login never leaves this machine; only the message and the reply travel)
  let live = false, lastDrain = 0, draining = false, again = false;
  const handle = async (it: any) => {
    if (it.type === "message") {
      const e = it.event as Event;
      const fresh = claimInboxMessage(seen, e.id); // redelivered (restart, Worker switch): already handled
      after = it.seq; saveCursor(); // before handling, so a restart mid-message doesn't replay it
      if (!fresh) return;
      appendEvent(e, { mirror: false }); // keep the local record (learning reads it); the cloud already has it
      await handleOwnerMessage(e.text, e.ref, false, { paths: e.attachments, key: e.id, fetch: (p) => cloudMedia(cfg, p), sentAt: e.ts, thread: e.thread, via: typeof e.via === "string" ? e.via : undefined });
    } else if (it.type === "op" && it.op) {
      await applyOp(it.op);
    } else if (it.type === "cancel" && typeof it.id === "string") {
      await cancelTask(it.id, it.done === true);
    } else if (it.type === "update") {
      await updateFleet();
    } else if (it.type === "settings") {
      await saveSettings(it.patch);
      await call(cfg, "/api/host/state", { method: "PUT", body: JSON.stringify({ settings: settingsView() }) });
    }
    after = it.seq; saveCursor();
  };
  /** Fetch and handle inbox items until none are left (each call also acks what came before `after`). */
  const drain = async () => {
    if (draining) { again = true; return; }
    draining = true; lastDrain = Date.now();
    try {
      do {
        again = false;
        for (let page = 0; page < 20; page++) {
          const r = await call(cfg, `/api/host/inbox?after=${after}`);
          const items = r?.items ?? [];
          for (const it of items) await handle(it);
          if (!items.length) break;
          await pushStatus();
        }
      } while (again);
    } catch (err) { console.error(`cloud bridge inbox: ${err}`); }
    draining = false;
  };
  let backoff = 5_000;
  const connect = () => {
    const ws = new WebSocket(base(cfg).replace(/^http/i, "ws") + "/api/host/stream", { headers: { Authorization: `Bearer ${cfg.server?.token}` } } as any);
    let ping: ReturnType<typeof setInterval> | undefined, pong = Date.now();
    ws.onopen = () => {
      live = true; backoff = 5_000; pong = Date.now();
      // keep NAT paths open and notice a dead link; the Worker answers "ping" without waking up
      ping = setInterval(() => { if (Date.now() - pong > 150_000) ws.close(); else try { ws.send("ping"); } catch {} }, 60_000);
      void drain(); // whatever arrived while disconnected
    };
    ws.onmessage = (m) => {
      pong = Date.now();
      let d: any; try { d = JSON.parse(String(m.data)); } catch { return; } // "pong"
      if (d?.type === "inbox") void drain();
      else if (d?.type === "watchers" && typeof d.n === "number") { const was = watchers; watchers = d.n; if (d.n > was) void pushStatus(true); }
    };
    ws.onclose = () => {
      live = false; clearInterval(ping);
      setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 5 * 60_000);
    };
    ws.onerror = () => {};
  };
  void loop();
  connect();
  setInterval(loop, (cfg.cloud?.poll_seconds ?? 3) * 1000);
  console.log(`cloud bridge → ${base(cfg)}`);
}

/** Web Push VAPID keypair: generated once, kept in ~/.noop/vapid.json (0600) so redeploys keep phones subscribed. */
async function vapidKeys(): Promise<{ publicKey: string; privateJwk: Jwk }> {
  const f = join(HOME_DIR, "vapid.json");
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
  const k = await newVapidKeys();
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, JSON.stringify(k), { mode: 0o600 });
  return k;
}

/** Why the last cloudDeploy returned false (for the journal: a daemon's console is out of the owner's sight). */
export let lastDeployError = "";

/** Deploy the Worker into the owner's Cloudflare account; set the token secret; record the URL (noop.toml + shared config). */
export async function cloudDeploy(cfg: Cfg) {
  lastDeployError = "";
  const fail = (why: string) => { lastDeployError = why; console.log(why); return false as const; };
  const dir = join(CODE, "cloud");
  const wr = ["bunx", "wrangler"];
  // a login with several accounts can't deploy non-interactively: [cloud] account (or CLOUDFLARE_ACCOUNT_ID) picks one
  const account = process.env.CLOUDFLARE_ACCOUNT_ID || cfg.cloud?.account;
  const env = { ...process.env, ...(account ? { CLOUDFLARE_ACCOUNT_ID: account } : {}) };
  const who = await $`${wr} whoami`.cwd(dir).env(env).quiet().nothrow();
  if (!/logged in/i.test(who.stdout.toString())) {
    return fail("先登录你自己的 Cloudflare 账号（免费版即可）：\n  bunx wrangler login\n然后重新运行：hub cloud deploy");
  }
  if (!cfg.server?.token) return fail("缺少 [server] token，先运行 hub init");
  if (!(await ensureWebClient())) return fail("客户端网页下载失败，Worker 没有部署。请检查网络后重新运行：noop cloud deploy");
  const name = cfg.cloud?.name ?? "noop";
  console.log(`部署到你的 Cloudflare 账号（Worker：${name}）…`);
  // [cloud] domain (e.g. noop.example.com on a zone in the same account) attaches a Custom Domain and becomes the URL
  const domain = String(cfg.cloud?.domain ?? "").trim();
  const dep = await $`${wr} deploy --name ${name} ${domain ? ["--domain", domain] : []}`.cwd(dir).env(env).quiet().nothrow();
  const out = dep.stdout.toString() + dep.stderr.toString();
  if (dep.exitCode !== 0) return fail(out.slice(-1500));
  const url = domain ? `https://${domain}` : out.match(/https:\/\/[\w.-]+\.workers\.dev/)?.[0];
  const secrets: Record<string, string> = { HUB_TOKEN: cfg.server.token };
  const e = cfg.email ?? {};
  if (e.to && e.host) {
    secrets.HUB_OWNER_EMAIL = String(e.to);
    secrets.HUB_SMTP = JSON.stringify({ host: e.host, port: e.port ?? 465, secure: e.secure ?? (e.port ?? 465) === 465, user: e.user, pass: e.pass, from: e.from ?? e.user });
  } else if (e.to && e.from) { // Cloudflare Email Routing: no SMTP, `from` is an address on a domain with Email Routing on
    secrets.HUB_OWNER_EMAIL = String(e.to);
    secrets.HUB_MAIL_FROM = String(e.from).match(/<([^>]+)>/)?.[1] ?? String(e.from);
  } else console.log("还没配置邮箱：登录验证码发不出去，在共享的 config.toml 里填 [email] 后重新运行 noop cloud deploy");
  const vapid = await vapidKeys();
  secrets.HUB_VAPID_PUBLIC = vapid.publicKey;
  secrets.HUB_VAPID_PRIVATE = JSON.stringify(vapid.privateJwk);
  // Channel button callbacks: Slack/Discord verification keys come from [notify] (hand-set); the ntfy banner
  // buttons need an answer-only token because their Actions header passes it through the ntfy server (a third
  // party) — never HUB_TOKEN. It is generated once and kept in the shared config.toml [notify]: leaking it lets a
  // holder answer cards, nothing more (Worker enforces answer-only; see HUB_ANSWER_TOKEN in cloud/src/index.ts).
  let pendingAnswerToken = "";
  const n = cfg.notify ?? {};
  if (n.slack_signing_secret) secrets.HUB_SLACK_SIGNING_SECRET = String(n.slack_signing_secret);
  if (n.discord_public_key) secrets.HUB_DISCORD_PUBLIC_KEY = String(n.discord_public_key);
  if (n.ntfy_url) {
    const tok = String(n.ntfy_answer_token ?? "");
    if (/^[0-9a-f]{32,}$/.test(tok)) secrets.HUB_ANSWER_TOKEN = tok;
    else {
      if (tok) console.log(`警告：config 里现有的 ntfy_answer_token 格式无效，已生成新令牌写入共享 config.toml；请删除 config.local.toml 里的旧值（它会覆盖共享配置）`);
      pendingAnswerToken = [...crypto.getRandomValues(new Uint8Array(32))].map((x) => x.toString(16).padStart(2, "0")).join("");
      secrets.HUB_ANSWER_TOKEN = pendingAnswerToken;
    }
  }
  // `secret bulk` reads JSON from stdin — values never touch argv or the console.
  const sec = Bun.spawn([...wr, "secret", "bulk", "--name", name], { cwd: dir, env, stdin: new Blob([JSON.stringify(secrets)]), stdout: "pipe", stderr: "pipe" });
  if ((await sec.exited) !== 0) return fail("设置 Worker 密钥失败：\n" + (await new Response(sec.stderr).text()).slice(-800));
  if (!url) return fail("部署成功，但没识别到地址；请把 workers.dev 地址写进 config.toml 的 [cloud] url");
  // ---- record the URL (machine-local noop.toml first: the data sync itself goes through this Worker)
  writeHubToml({ cloud: { url, name, ...(account ? { account } : {}), ...(domain ? { domain } : {}) } });
  await locked(async () => {
    await _pull();
    const f = P("config.toml");
    let s = readFileSync(f, "utf8");
    // keep the account too: without it the primary's next redeploy (on every update) may land in another account
    const block = `[cloud]\nurl = "${url}"\nname = "${name}"\n${account ? `account = "${account}"\n` : ""}${domain ? `domain = "${domain}"\n` : ""}`;
    s = /^\[cloud\]/m.test(s) ? s.replace(/^\[cloud\][^\[]*/m, `${block}\n`) : `${s.trimEnd()}\n\n${block}`;
    if (pendingAnswerToken) { // new banner-button token: record it where notify() reads it, so restarts reuse it
      const line = `ntfy_answer_token = "${pendingAnswerToken}"`;
      s = /^\s*ntfy_answer_token\s*=/m.test(s) ? s.replace(/^\s*ntfy_answer_token\s*=.*$/m, line)
        : /^\[notify\]/m.test(s) ? s.replace(/^\[notify\][^\[]*/m, (b) => `${b.trimEnd()}\n${line}  # banner buttons: can only answer cards; safe in the shared config (or move to config.local.toml)\n\n`)
        : `${s.trimEnd()}\n\n[notify]\n${line}\n`;
      console.log(`已生成 ntfy 按钮令牌并写入共享 config.toml；重启 hub 后横幅按钮生效`);
    }
    writeFileSync(f, s);
    writeFileSync(P("README.md"), `# noop data\n\n私有数据（保存在你自己的 Cloudflare Worker 里）：任务、决策、记忆、日志。\n\n## 客户端\n\n地址：**${url}**\n\n打开后粘贴 token 连接（或用邮箱验证码登录；机器 token 在主机的 ~/.noop/noop.toml 里）。这个地址部署在你自己的 Cloudflare 账号里，固定不变。\n`);
    journal(hostName(cfg), `☁️ cloud hub deployed: ${url}`);
    await _commitPush(`cloud hub ${url}`);
  });
  console.log(`✓ 已部署：${url}`);
  return url;
}

/** Record an owner message id as handled; false when it was already handled (a replay after a restart or Worker switch). */
export function claimInboxMessage(seen: string[], id?: string): boolean {
  if (!id) return true;
  if (seen.includes(id)) return false;
  seen.push(id);
  return true;
}
