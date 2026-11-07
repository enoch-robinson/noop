// hub fix — the AI medic. When install/update/daemon breaks, call an agent directly (not through the queue,
// which may be what is broken) with the error, logs and environment; it diagnoses, fixes, verifies, and
// if framework code changed, pushes a branch + PR so every machine gets the fix. Inspired by Omarchy's
// "something's wrong → ask AI to fix it" integration.
import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, homedir, platform, release } from "node:os";
import { join } from "node:path";
import { type Cfg, CODE, DATA, hostName, HOME_DIR } from "./core";
import { CLIS } from "./clis";

const STATE = join(HOME_DIR, "medic.json");
const LOGDIR = join(HOME_DIR, "medic");

const tail = (f: string, n = 6000) => (existsSync(f) ? readFileSync(f, "utf8").slice(-n) : "");

async function sh(cmd: string) {
  const r = await $`sh -c ${cmd}`.quiet().nothrow();
  return (r.stdout.toString() + r.stderr.toString()).trim().slice(-3000);
}

async function context(): Promise<string> {
  const svc = platform() === "linux" ? await sh("journalctl --user -u noop -u agent-hub -n 80 --no-pager 2>&1")
    : platform() === "darwin" ? tail(join(DATA, "logs", "daemon.log")) : "";
  return [
    `OS: ${platform()} ${release()} ${arch()} · host ${hostName({})}`,
    `framework: ${CODE} @ ${await sh(`git -C '${CODE}' log -1 --oneline 2>&1`)} · status:\n${await sh(`git -C '${CODE}' status --short 2>&1 | head -20`)}`,
    `data: ${DATA} · sync ${await (await import("./sync")).syncStatus().catch((e) => String(e))}`,
    `tools: ${await sh(`for b in bun git gh ${CLIS.map((a) => a.name).join(" ")}; do printf '%s=%s ' $b "$(command -v $b || echo missing)"; done`)}`,
    `bun ${await sh("bun --version 2>&1")} · gh auth: ${await sh("gh auth status 2>&1 | head -4")}`,
    `service log tail:\n${svc}`,
  ].join("\n");
}

const PROMPT = (problem: string, ctx: string, canPush: boolean) => `You are the Noop MEDIC on this machine. Something is broken; fix it.

## Problem
${problem}

## Environment
${ctx}

## What you may do
- Diagnose from the error, logs and code (framework at ${CODE}, data at ${DATA}). Run commands, read files.
- Fix the root cause with the smallest change. Allowed: framework code/scripts in ${CODE}, per-machine config ${join(DATA, "config.local.toml")},
  re-running \`bun install\`, \`hub init\`/\`hub install\`, restarting the noop service (named agent-hub on older installs), clearing broken local state under ~/.noop (not ~/.noop/data, sync.json or noop.toml).
- Environment problems you cannot fix without the owner (sudo, logging in, 2FA, network/VPN) → do not hack around them; say exactly which one command the owner should run.
- Verify: \`cd ${CODE} && bun test\` must pass, then re-run the failing step and show it works.
- If you changed framework code: make the change in a separate git worktree (\`git worktree add\`) on a new branch \`medic/<yyyymmdd>-<slug>\` — never switch the branch of ${CODE} itself, it is the running install and must stay on main — with a clear message and trailer \`Agent: medic\`${canPush ? `, push it, and open a PR (\`gh pr create --fill\`) so all machines get the fix after the owner merges; keep the fix applied locally meanwhile.` : ". Do not push (push disabled on this host)."}
- Never: force-push, touch main directly, delete ~/.noop/data or the Worker's files, print secrets.

End with one \`\`\`json block: {"fixed": true|false, "summary": "...", "owner_action": "command or empty", "pr": "url or empty"}`;

/** Run the medic. `auto` = triggered by a failure (rate-limited to once per hour per problem kind). */
export async function medic(problem: string, cfg: Cfg, opts: { auto?: boolean; kind?: string } = {}) {
  if (process.env.HUB_NO_MEDIC || cfg.medic?.enabled === false) return null;
  const state: Record<string, string> = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
  const kind = opts.kind ?? "manual";
  if (opts.auto && state[kind] && Date.now() - Date.parse(state[kind]) < 60 * 60_000) return null;
  state[kind] = new Date().toISOString();
  mkdirSync(LOGDIR, { recursive: true });
  writeFileSync(STATE, JSON.stringify(state));

  // registry order = preference order: claude first, then whatever else is installed
  const adapter = CLIS.find((a) => a.medicCommand && Bun.which(a.name));
  if (!adapter) { console.error(`medic: no agent CLI is installed (looked for: ${CLIS.map((a) => a.name).join(", ")})`); return null; }
  const prompt = PROMPT(problem, await context(), cfg.medic?.push !== false);
  const cmd = adapter.medicCommand!();
  const cli = adapter.name;
  console.error(`🩺 medic (${cli}) is looking at: ${problem.split("\n")[0].slice(0, 120)}`);
  const p = Bun.spawn(cmd, { cwd: CODE, stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe", env: { ...process.env, HUB_NO_MEDIC: "1" } });
  const timer = setTimeout(() => p.kill(), (cfg.medic?.timeout_minutes ?? 30) * 60_000);
  const out = await new Response(p.stdout).text();
  await p.exited; clearTimeout(timer);
  const log = join(LOGDIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-${kind}.log`);
  writeFileSync(log, `${problem}\n\n${out}`);
  const m = [...out.matchAll(/```json\s*(\{[\s\S]*?\})\s*```/g)].pop();
  let res: any = null; try { res = m ? JSON.parse(m[1]) : null; } catch {}
  const line = res ? `${res.fixed ? "✅ fixed" : "❌ not fixed"}: ${res.summary}${res.owner_action ? `\n👉 你需要执行: ${res.owner_action}` : ""}${res.pr ? `\nPR: ${res.pr}` : ""}`
    : `medic finished without a result; log: ${log}`;
  console.error(`🩺 ${line}`);
  // CEO only hears about it when he must act (run a command / merge a PR). Silent fixes go to the journal only.
  if (res?.owner_action || res?.pr) try {
    const { notify } = await import("./notify");
    const ask = res.owner_action ? `需要你在 ${hostName(cfg)} 上执行：${res.owner_action}` : `已自动修好，修复 PR 待你合并：${res.pr}`;
    await notify(`${hostName(cfg)} 出了点问题（${String(res.summary ?? "").slice(0, 80)}）。${ask}`, cfg, { kind: "notice", from: `medic@${hostName(cfg)}` });
  } catch {}
  return res;
}
