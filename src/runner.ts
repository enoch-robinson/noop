// Builds the prompt for an agent, runs Claude Code / Codex headless, parses the structured result.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type Cfg, P, ROOT, agentActivity, agentName, precedents, readAll, readIf, recentJournal, signature,
} from "./core";
import { byName, command as runCommand, parseStreamJson, type CliCtx, type RunEvents } from "./clis";
import { gateList } from "./gates";
import { channelPrompt } from "./channels";

export type Result = {
  status: "done" | "needs_decision" | "failed" | "delegated" | "waiting";
  wait_minutes?: number;
  waiting_on?: string;
  wait_check?: string;
  wait_kind?: "human" | "ci";
  summary: string;
  question?: string;
  options?: string[];
  recommendation?: string;
  lessons?: string[];
  attachments?: string[];
  channels?: unknown[];
  followups?: { title: string; body?: string; agent?: string; priority?: string; repo?: string; requires?: string; host?: string }[];
};

const RESULT_SPEC = `Finish the work, then end your final reply with EXACTLY one fenced \`\`\`json block:
{
  "status": "done" | "needs_decision" | "failed" | "delegated" | "waiting",   // delegated = you split the work into followups and want to be woken up to consolidate when they finish; waiting = see below
  "waiting_on": "waiting only: what you wait for and how to check it, e.g. CI run https://github.com/o/r/actions/runs/123 (gh run view 123)",
  "wait_kind": "waiting only: human when it waits on a person (the owner merging, publishing, answering) — then it wakes only on an event, never on a timer; ci for machines (CI, deploys)",
  "wait_minutes": 15,   // waiting only: latest time to wake you to check again (5-120)
  "wait_check": "waiting only: a quick read-only shell command whose exit code changes when the wait is over, e.g. gh pr checks 123 -R o/r (exits 8 while pending); the daemon runs it every few minutes and wakes you as soon as it changes",
  "summary": "1-3 sentences: what you did / found (links to PRs, commits, files). For needs_decision this is all the owner reads before choosing: say what the PR / change does and what is at stake, the facts they need to choose (not why it needs them, they know)",
  "question": "needs_decision only: one short sentence (under 30 characters) naming what to decide, e.g. 现在合并 gpui-fast #97 吗？; name PRs/issues with their full URL in summary and options",
  "options": ["A: <recommended> — consequence", "B: ... — consequence"],
  "recommendation": "A",
  "lessons": ["durable lesson for your own memory (optional)"],
  "attachments": ["/abs/path/screenshot.png", "/abs/path/recording.mp4"],   // optional: shown to the owner with the message
  "channels": ["existing-slug", {"name": "New topic", "goal": "what it is for"}],   // see # Channels; [] when none fits
  "followups": [{"title": "...", "body": "...", "agent": "<agent id>", "priority": "normal", "difficulty": "hard if it needs deep engineering/design work", "requires": "os:macos when it needs macOS/iOS/Xcode (os:windows for Windows); omit otherwise"}]
}
Write summary, question and options in the owner's language (Simplified Chinese unless the owner writes otherwise), plain text, no emoji; keep identifiers, links and code as they are.
Only use needs_decision after doing all preparation that does not depend on the answer.
Never sit idle waiting on something slow (GitHub Actions/CI, a release, a review, a deploy): if the next step needs it, return "waiting" with waiting_on, wait_minutes and wait_check.
Before returning "waiting", do every part of the task that does not depend on the condition (other platforms, docs, tests, screenshots, the next PR): implement and let CI verify rather than wait for a host. Waiting on another PR to merge is not a reason to stop: build on its branch or merge it locally, and note the dependency.
The machine then runs other work and wakes you later with your notes; check the condition first, then continue from where you left off.`;

export function buildPrompt(meta: Record<string, string>, body: string, cfg: Cfg, resourceNote = ""): string {
  const agent = meta.agent || "lead";
  const host = meta.claimed_by || "?";
  return `You are **${agentName(agent)}**, a permanent member of ${cfg.owner?.name ?? "the owner"}'s AI agent fleet, running headless on host \`${host}\`.
The fleet coordinates through the shared hub folder at ${ROOT} (tasks/, journal/, decisions/, agents/). Read it when you need context; you do not message other agents — you leave traces (commits in project repos, journal lines, follow-up tasks) that they pick up.
The hub folder is not a git repository: files you write there (reports/, memory) are synced to the cloud by the daemon after your run. Never git add/commit them, and never report a task as failed because the hub has no git metadata.

# Your profile
${readIf(P("agents", agent, "profile.md"))}

# Your memory
${readIf(P("agents", agent, "memory.md"), 8000) || "(empty)"}

# Fleet-wide policy
${readAll(P("policies"))}

# Owner profile & principles
${readAll(P("memory"))}

# Owner decision precedents (follow them; never re-ask a decided question)
${precedents(25) || "(none yet)"}

# Recent fleet journal
${recentJournal() || "(empty)"}

# Fleet roster (for follow-up routing)
${rosterLine()}

# External signature (MANDATORY)
Anything you post outside the hub — GitHub PR/issue/review comments, PR descriptions, Slack, Discord, email, OKR entries — must end with this exact line, after a blank line:
${signature(agent, host, cfg)}
Git commits you create must carry the trailer:  Agent: ${agent}
Outside the hub you are Noop: never use your agent name (${agentName(agent)}) or any other agent's name in GitHub text, commits or messages.

# Resource budget
${resourceNote}

${channelPrompt()}

# Task ${meta.id}: ${meta.title}
Working directory: ${meta.repo || ROOT}   Scratch space (checkouts, worktrees, build targets): ~/.agent-hub/work — never inside the hub folder ${ROOT}, which syncs to the cloud   Host capabilities: ${meta.host_caps ?? ""}
Priority: ${meta.priority}   Source: ${meta.source}

${body}

${RESULT_SPEC}`;
}

function rosterLine(): string {
  return readdirSync(P("agents"), { withFileTypes: true }).filter((d) => d.isDirectory())
    .map((d) => {
      const prof = readIf(P("agents", d.name, "profile.md"), 100000);
      const first = prof.split("\n").find((l) => l.startsWith("# ")) ?? d.name;
      return `- \`${d.name}\` ${agentName(d.name)}: ${first.replace(/^# /, "")}`;
    }).join("\n");
}

export { codexWritableDirs } from "./clis";

/** The command line for one agent run; [clis.<name>] command = [...] overrides the adapter's default. */
export function cliCommand(cli: string, cfg: Cfg, gateOverride = false): string[] {
  const ctx: CliCtx = { hub: ROOT, gates: gateList(cfg, gateOverride) };
  return runCommand(cli, cfg, ctx);
}

/** The model a CLI is started with: an explicit `--model`/`-m`, else Codex's own config default. */
export function startModel(cli: string, cmd: string[], codexHome?: string): string | undefined {
  codexHome ??= process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const i = cmd.findIndex((c) => c === "--model" || c === "-m");
  if (i >= 0 && cmd[i + 1]) return cmd[i + 1];
  if (cli === "codex") return readIf(join(codexHome, "config.toml"), 100000).match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1];
  return undefined;
}

/** Running agent processes by task id (so the owner can cancel one). */
export const agentProcs = new Map<string, { kill: (sig?: number | NodeJS.Signals) => void }>();

/** Marker runAgent appends when it stopped a run that went quiet (see stall_minutes). */
export const STALLED = "\n[stalled]";

/** `retryEmpty` is internal: an empty completion gets exactly one rerun (see the end of the function). */
export async function runAgent(cli: string, prompt: string, cwd: string, cfg: Cfg, logFile: string, gateOverride = false,
  extraEnv: Record<string, string> = {}, retryEmpty = true): Promise<string> {
  const cmd = cliCommand(cli, cfg, gateOverride);
  const adapter = byName(cli);
  const timeoutMs = (cfg.clis?.timeout_minutes ?? 60) * 60_000;
  const stallMs = (cfg.clis?.stall_minutes ?? 20) * 60_000;
  const dir = cwd.replace(/^~/, homedir());
  const proc = Bun.spawn(cmd, {
    cwd: existsSync(dir) ? dir : ROOT, stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe",
    // Claude -p stops background subagents 10 min after the last turn; our own run limit bounds the run instead
    env: { ...process.env, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0", ...extraEnv, HUB_DATA: ROOT },
  });
  const tid = logFile.split("/").pop()!.match(/^([A-Z]-[\w]*?\d{4})-\d{10,}/)?.[1];
  if (tid) agentProcs.set(tid, proc);
  void proc.exited.then(() => { if (tid && agentProcs.get(tid) === proc) agentProcs.delete(tid); });

  // what the agent is doing: every chunk of output is a sign of life; stream adapters also name each step
  const ev: RunEvents = { step: undefined, steps: 0, assistantText: "", resultText: undefined, error: undefined, inFlight: new Map() };
  // a stream adapter's output is parsed for steps and the report; anything else is returned as-is.
  // Claude's stream-json shape is the fallback parser for unknown CLI names and codex (no parseEvent);
  // a registered adapter's parseEvent always wins, even when a config command override emits another shape.
  const json = cmd.includes("stream-json") || (!!adapter?.parseEvent && !adapter.streamJson);
  const parse = adapter?.parseEvent ?? parseStreamJson;
  const act = { at: Date.now(), model: startModel(cli, cmd, extraEnv.CODEX_HOME) };
  const touch = () => {
    act.at = Date.now();
    if (tid) agentActivity.set(tid, { at: new Date(act.at).toISOString(), step: ev.step, steps: ev.steps, model: act.model });
  };
  touch();
  const onLine = (line: string) => {
    let e: any;
    try { e = JSON.parse(line); } catch { return; }
    // model display (#94): generic capture ahead of the adapter parse — Claude's init/assistant events carry it;
    // adapters without such events keep the startModel estimate
    if (e.type === "system" && e.subtype === "init" && e.model) act.model = String(e.model);
    if (e.type === "assistant" && e.message?.model && !e.parent_tool_use_id) act.model = String(e.message.model);
    // a provider error (429 quota, 401 auth, …) ends the run without a result block: remember the first one so the
    // caller's classify → failover/cooldown reacts instead of reporting a vague "no result block"
    if (e.type === "error" && !ev.error) {
      const er = e.error ?? e.part ?? e;
      const msg = typeof er?.message === "string" ? er.message : typeof er?.error?.message === "string" ? er.error.message : undefined;
      const bits = [er?.type && er.type !== "error" ? String(er.type) : undefined, er?.status ? `HTTP ${er.status}` : undefined,
        msg, Number.isFinite(er?.retryAfterMs) ? `(retryAfterMs ${er.retryAfterMs})` : undefined].filter(Boolean);
      if (bits.length) ev.error = bits.join(" ");
    }
    parse(e, ev);
  };
  const read = async (stream: ReadableStream<Uint8Array>, lines: boolean) => {
    const dec = new TextDecoder();
    let all = "", buf = "";
    for await (const chunk of stream) {
      const t = dec.decode(chunk, { stream: true });
      all += t;
      if (lines) {
        buf += t;
        const parts = buf.split("\n");
        buf = parts.pop()!;
        parts.forEach(onLine);
      }
      touch();
    }
    if (lines && buf) onLine(buf);
    return all;
  };

  let stalled = false, timedOut = false;
  // hitting the run limit is not a tooling fault: report it like a stall so the task continues where it got to
  const timer = setTimeout(() => { timedOut = true; proc.kill(); }, timeoutMs);
  // a run that has gone quiet: no output at all, and nothing slow in flight (a sub-agent may work quietly for long)
  const watch = setInterval(() => {
    const slow = [...ev.inFlight.values()].some((n) => /^(Task|Agent)$/.test(n));
    if (!slow && Date.now() - act.at > stallMs) { stalled = true; proc.kill(); }
  }, 30_000);
  const [raw, err] = await Promise.all([read(proc.stdout, json), read(proc.stderr, false)]);
  const code = await proc.exited;
  clearTimeout(timer);
  clearInterval(watch);
  if (tid) agentActivity.delete(tid);
  mkdirSync(P("logs", "runs"), { recursive: true });
  writeFileSync(logFile, `$ ${cmd.join(" ")}\n(exit ${code})\n\n${raw}\n\n[stderr]\n${err}`);
  let out = json ? (ev.resultText ?? ev.assistantText) : raw;
  // quota/auth walls never yield a result block: surface the provider's own words so classify() sees them
  if (ev.error) out += `${out.trim() ? "\n" : ""}[provider-error] ${ev.error}`;
  if (timedOut) return `${out}${STALLED} hit the ${Math.round(timeoutMs / 60_000)}-minute run limit (clis.timeout_minutes)${ev.step ? `; last step: ${ev.step}` : ""}; run long builds in the background and return "waiting"`;
  if (stalled) return `${out}${STALLED} no output for ${Math.round(stallMs / 60_000)} minutes${ev.step ? `; last step: ${ev.step}` : ""}`;
  // A provider occasionally answers with an empty completion (no text, no tool call, exit 0) and Claude Code's own
  // "no visible output" retry gets nothing either. That is a flake of the tool chain, not the task failing: rerun the
  // same prompt once, and never hand the empty run back to the caller as the task's result.
  // Do not retry when the run already used a tool or printed visible assistant text: an empty final result can still
  // sit on top of side effects (a posted comment, a commit), and replaying the prompt would repeat them. `out` is only
  // the final/assistant text, so also require ev.steps === 0 and no accumulated assistantText.
  if (retryEmpty && !out.trim() && !code && !ev.steps && !ev.assistantText.trim()) {
    const first = readFileSync(logFile, "utf8");
    const again = await runAgent(cli, prompt, cwd, cfg, logFile, gateOverride, extraEnv, false);
    writeFileSync(logFile, `${first}\n\n[retried after an empty response]\n${readFileSync(logFile, "utf8")}`); // keep both attempts
    return again;
  }
  return out + (code ? `\n[exit ${code}] ${err.slice(-2000)}` : "");
}

export function parseResult(out: string): Result {
  const blocks = [...out.matchAll(/```json\s*(\{[\s\S]*?\})\s*```/g)].map((m) => m[1]).reverse();
  for (const b of blocks) {
    try {
      const r = JSON.parse(b);
      if (r.status) return r;
    } catch {}
  }
  return { status: "failed", summary: `agent returned no result block. tail: ${out.slice(-300)}` };
}

/** The models that route each owner message, fastest first: a choice made within seconds, not a judgement.
 *  `[router] cli/model` in config.toml puts one first; the others are fallbacks when its CLI is missing or fails. */
const ROUTERS = [{ cli: "claude", model: "claude-haiku-5-5" }, { cli: "codex", model: "gpt-6-luna" }, { cli: "pi" }, { cli: "omp" }];

/** One quick structured call for routing (the fastest model available); null when none answered. */
export async function quickAsk(prompt: string, cfg: Cfg, logFile: string): Promise<any> {
  const own = cfg.router?.cli ? [{ cli: String(cfg.router.cli), model: String(cfg.router.model ?? "") }] : [];
  for (const r of [...own, ...ROUTERS.filter((x) => x.cli !== own[0]?.cli)]) {
    if (!Bun.which(r.cli)) continue;
    const a = byName(r.cli);
    if (!a) continue;
    const cmd = a.routerCommand(r.model || undefined);
    const proc = Bun.spawn(cmd, { cwd: ROOT, stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill("SIGKILL"), (cfg.router?.timeout_seconds ?? 45) * 1000);
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    clearTimeout(timer);
    mkdirSync(P("logs", "runs"), { recursive: true });
    writeFileSync(logFile, `${r.cli} ${r.model}\n${out}`);
    const m = [...out.matchAll(/```json\s*(\{[\s\S]*?\})\s*```/g)].pop() ?? out.match(/(\{[\s\S]*\})/);
    try { return JSON.parse(m![1]); } catch {}
  }
  return null;
}

/** One-shot structured call (used by the judge). */
export async function ask(prompt: string, cfg: Cfg, logFile: string): Promise<any> {
  const a = byName(cfg.judge?.cli ?? "claude");
  if (!a) return null; // unregistered judge CLI: same net result as a failed call
  const cmd = a.judgeCommand(cfg.judge?.model);
  const proc = Bun.spawn(cmd, { cwd: ROOT, stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill("SIGKILL"), (cfg.judge?.timeout_minutes ?? 10) * 60_000); // runs inside locked()
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  clearTimeout(timer);
  mkdirSync(P("logs", "runs"), { recursive: true });
  writeFileSync(logFile, out);
  const m = [...out.matchAll(/```json\s*(\{[\s\S]*?\})\s*```/g)].pop() ?? out.match(/(\{[\s\S]*\})/);
  try { return JSON.parse(m![1]); } catch { return null; }
}
