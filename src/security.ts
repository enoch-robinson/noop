// `noop security`: a deterministic check of this Noop deployment and this machine's Noop setup. The weekly built-in
// routine `security-check` runs it first, then looks at the rest of the computer. Read-only: it never changes anything.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { okRedirect } from "../cloud/src/mcp";
import { parseAllowList } from "../cloud/src/ipallow";
import { type Cfg, HOME_DIR, P } from "./core";
import { allowIps } from "./cloud";

export type Finding = { level: "ok" | "warn" | "bad"; area: "Worker" | "本机"; text: string };

export async function securityReport(cfg: Cfg, host: string, primary: boolean): Promise<Finding[]> {
  const out: Finding[] = [];
  const add = (level: Finding["level"], area: Finding["area"], text: string) => out.push({ level, area, text });
  const url = String(cfg.cloud?.url ?? "").replace(/\/$/, "");
  const token = String(cfg.server?.token ?? "");
  let live: number | null | undefined; // entries in the Worker's HUB_ALLOW_IPS (null: off; undefined: Worker didn't say)

  // ---- the Worker (the owner's own Cloudflare deployment)
  if (!url) add("warn", "Worker", "没有配置 [cloud] url：没有云端部署可查");
  else {
    const call = (path: string) => fetch(`${url}${path}`, { headers: { Authorization: `Bearer ${token}`, "x-noop-host": host } });
    const tf = await call("/api/host/2fa").catch((e) => e as Error);
    if (tf instanceof Error) add("bad", "Worker", `连不上 ${url}：${tf.message}`);
    else if (tf.status === 403 && (await tf.clone().json().catch(() => ({})) as { error?: string }).error === "ip_blocked")
      add("bad", "Worker", `本机出口 IP 被 HUB_ALLOW_IPS 挡住了：${(await tf.json().catch(() => ({})) as { ip?: string }).ip}`);
    else if (tf.status === 404) add("bad", "Worker", "Worker 运行的是旧代码（没有两步验证）：运行 noop cloud deploy");
    else if (tf.status === 401) add("bad", "Worker", "机器密钥被 Worker 拒绝（401）：本机的 [server] token 和 Worker 的 HUB_TOKEN 不一致");
    else if (!tf.ok) add("bad", "Worker", `查询两步验证失败：HTTP ${tf.status}`);
    else {
      const d = (await tf.json()) as { bound: boolean; since: number | null; allow_ips?: number | null };
      live = d.allow_ips;
      add(d.bound ? "ok" : "bad", "Worker", d.bound ? `两步验证已绑定（${new Date(d.since ?? 0).toISOString().slice(0, 10)}）` : "两步验证还没绑定：任何人都无法登录。运行 noop 2fa setup");
      const rows = async (table: string) => {
        const r = await call(`/api/host/export?table=${table}&after=0&limit=200`).catch(() => null);
        return r?.ok ? ((await r.json()) as { rows: Record<string, any>[] }).rows : null;
      };
      const ownerList = owners(cfg).map((e) => e.toLowerCase());
      const sessions = await rows("sessions");
      if (sessions) {
        const strangers = sessions.filter((s) => ownerList.length && !ownerList.includes(String(s.email).toLowerCase()));
        const lines = sessions.map((s) => `${s.email} · ${s.scope ?? (String(s.ua).startsWith("mcp:") ? "mcp" : "owner")} · ${String(s.ua ?? "").slice(0, 40)} · 最近 ${new Date(Number(s.last_seen)).toISOString().slice(0, 10)}`);
        add(strangers.length ? "bad" : sessions.length > 6 ? "warn" : "ok", "Worker",
          `${sessions.length} 个登录会话${strangers.length ? `，其中 ${strangers.length} 个不是 owner 邮箱` : ""}${sessions.length > 6 ? "（偏多，不认识的就运行 noop revoke-sessions）" : ""}${lines.length ? `：\n    ${lines.join("\n    ")}` : ""}`);
      }
      const clients = await rows("oauth_clients");
      if (clients) {
        const view = clients.map((c) => { const j = JSON.parse(String(c.json)); return { name: String(j.client_name), uris: (j.redirect_uris ?? []) as string[] }; });
        const bad = view.filter((c) => c.uris.some((u) => !okRedirect(u)));
        add(bad.length ? "warn" : "ok", "Worker", `${view.length} 个 MCP/OAuth 客户端${bad.length ? `，${bad.length} 个回调地址不在允许范围（已无法授权）：${bad.map((c) => `${c.name} → ${c.uris.join(" ")}`).join("；")}` : ""}`);
      }
      const kv = await rows("kv");
      const fails = kv?.find((r) => r.k === "auth_fails");
      if (fails) {
        const f = JSON.parse(String(fails.v));
        if (f.day === new Date().toISOString().slice(0, 10) && f.n > 0) add(f.n >= 10 ? "warn" : "ok", "Worker", `今天验证失败 ${f.n} 次（20 次锁定）`);
      }
    }
    // configuration that `noop cloud deploy` turns into Worker secrets
    add(owners(cfg).length ? "ok" : "bad", "Worker", owners(cfg).length ? `owner 邮箱白名单：${owners(cfg).join(", ")}` : "没有配置 [email] to：没有 owner 白名单，登录通知也发不出去");
    add(cfg.email?.host || cfg.email?.from ? "ok" : "warn", "Worker", cfg.email?.host || cfg.email?.from ? "发信已配置（验证码、登录通知）" : "没有配置发信：收不到新登录通知");
    // what the Worker enforces (live) against what config.toml says the next deploy will set
    const allow = allowIps(cfg);
    const { nets, bad } = parseAllowList(allow ?? "");
    if (bad.length) add("bad", "Worker", `[cloud] allow_ips 有无法识别的项：${bad.join(" ")}`);
    if (live === null) add("warn", "Worker", allow ? `IP 白名单没有生效（Worker 上为空），但 [cloud] allow_ips 有 ${nets.length} 项：运行 noop cloud deploy` : "没有开启 IP 白名单：任何网络都能访问登录页");
    else if (typeof live === "number") add(allow !== undefined && nets.length !== live ? "warn" : "ok", "Worker",
      `IP 白名单生效中：${live} 项${allow === undefined ? "（config.toml 里没有 allow_ips，部署不会改动它）" : nets.length !== live ? `，但 [cloud] allow_ips 有 ${nets.length} 项：运行 noop cloud deploy` : `（${allow}）`}`);
    else if (allow) add("ok", "Worker", `IP 白名单（配置）：${allow}`);
  }

  // ---- this machine's Noop setup
  if (token.length < 32) add("bad", "本机", "机器密钥太短（< 32 个字符）");
  for (const f of [join(HOME_DIR, "noop.toml"), join(HOME_DIR, "vapid.json"), P("config.local.toml")]) {
    if (!existsSync(f) || process.platform === "win32") continue;
    const mode = statSync(f).mode & 0o777;
    if (mode & 0o077) add("bad", "本机", `${f} 权限是 ${mode.toString(8)}，其他用户可读：chmod 600 ${f}`);
  }
  const srv = cfg.server ?? {};
  if (primary && srv.enabled !== false) {
    const h = String(srv.host ?? "0.0.0.0");
    if (h === "0.0.0.0" || h === "::") add("warn", "本机", `本机聊天服务监听 ${h}:${srv.port ?? 8787}（明文 HTTP、机器密钥）：局域网里的人都能连。用了云端就改成 127.0.0.1，或只绑 Tailscale IP`);
    else add("ok", "本机", `本机聊天服务只监听 ${h}`);
  }
  return out;
}

const owners = (cfg: Cfg) => String(cfg.email?.to ?? "").split(",").map((e) => e.trim()).filter(Boolean);

export function formatReport(host: string, items: Finding[]): string {
  const icon = { ok: "✓", warn: "⚠", bad: "✗" };
  const bad = items.filter((i) => i.level === "bad").length, warn = items.filter((i) => i.level === "warn").length;
  const head = `Noop 安全检查 · ${host} · ${bad ? `${bad} 个高风险` : "无高风险"}${warn ? `，${warn} 个提醒` : ""}`;
  return [head, ...(["Worker", "本机"] as const).flatMap((a) => {
    const xs = items.filter((i) => i.area === a);
    return xs.length ? [`\n[${a}]`, ...xs.map((i) => `  ${icon[i.level]} ${i.text}`)] : [];
  })].join("\n");
}
