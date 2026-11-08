// Per-CLI adapters: everything specific to one agent CLI lives here, so adding a CLI means adding one
// adapter, not new branches in runner/core/accounts. runner.ts owns prompt building and result parsing;
// this module stays free of src imports (only types) — runner injects the runtime context (hub root,
// gate deny list), which keeps core.ts free to import the registry without a module cycle.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Cfg } from "./core";

/** Runtime values the adapters need from the host; injected by runner.ts/cli.ts. */
export type CliCtx = { hub: string; gates: string[] };

/** Live parse state for one agent run; adapters annotate it, runAgent consumes it. */
export type RunEvents = {
  step: string | undefined;        // "Bash · gh pr checks 814" — the step shown as the task's latest activity
  steps: number;                   // tool calls so far
  assistantText: string;           // accumulated assistant text (the report, when there is no final-result event)
  resultText: string | undefined;  // explicit final result (Claude result events)
  error?: string;                  // provider error event (HTTP 429 quota, 401 auth, …) — runAgent appends it as [provider-error]
  inFlight: Map<string, string>;   // in-flight tool call id → name; dedupes tool updates, spots Claude subagents
};

export type CliAdapter = {
  name: string;
  /** Default model shown when a task starts; config `[clis.<name>] model` wins. */
  defaultModel?: string;
  /** How the task planner describes when to pick this CLI. */
  plannerHint?: string;
  /** Headless task command; the prompt arrives on stdin. `ctx.gates` is the (possibly decision-unlocked) deny list. */
  command(cfg: Cfg, ctx: CliCtx): string[];
  /** Line-delimited JSON output native to the CLI (Claude stream-json): runAgent reads steps and the report from it. */
  streamJson?: boolean;
  /** Parse one output event into `ev`. Called only when the output is parsed as JSON lines. */
  parseEvent?(e: any, ev: RunEvents): void;
  /** One quick plain-text call for the router (no tools, fastest model). */
  routerCommand(model?: string): string[];
  /** One plain-text call for the judge. */
  judgeCommand(model?: string): string[];
  /** One plain-text call with tools for the hub medic (unattended fixes); the prompt arrives on stdin.
   *  Unlike router/judge this needs tool use, so each CLI states its own unattended form. */
  medicCommand?(): string[];
  /** Per-CLI account knowledge; omit only when the CLI is not wired into rotation yet. */
  accounts?: CliAccounts;
  /** The CLI's user-level instructions file that rules.ts may generate; omit when the path is unverified or the CLI needs hand wiring (claude/codex). */
  rules?: { file(): string };
};

export type CliAccounts = {
  /** Human label for notifications ("Claude"). */
  label: string;
  /** The CLI's default login: directory + credentials file name, for login-change detection. */
  creds: { dir(): string; file(): string };
  /** Isolated-home env for an [[accounts]] entry; return {} when isolation is unverified for this CLI. */
  isolatedEnv(dir: string, token?: string): Record<string, string>;
  /** One shell hint to fix the login by hand ("claude /login"). */
  loginHint: string;
  /** Remote-assisted login flow; omit when the CLI has no verified headless login (auth failures just flag needs_login). */
  login?: { cmd(): string[]; needsCode: boolean };
};

const conf = (cfg: Cfg, name: string): any => cfg.clis?.[name] ?? {};

/** One line saying what a tool call does ("gh pr checks 814 -R o/r", "读 src/cli.ts"), for "最近在做". */
function toolStep(name: string, input: any): string {
  const i = input ?? {};
  const v = i.description || i.command || i.file_path || i.filePath || i.path || i.pattern || i.url || i.query || i.prompt || "";
  return `${name}${v ? ` · ${String(v).split("\n")[0].slice(0, 120)}` : ""}`;
}

/** Claude Code's stream-json shape; the fallback parser for unknown CLI names and codex (no parseEvent). */
export function parseStreamJson(e: any, ev: RunEvents) {
  if (e.type === "assistant") {
    for (const c of e.message?.content ?? []) {
      if (c.type === "tool_use") { ev.inFlight.set(c.id, c.name); ev.step = toolStep(c.name, c.input); ev.steps++; }
      else if (c.type === "text" && !e.parent_tool_use_id) ev.assistantText += c.text;
    }
  } else if (e.type === "user") {
    for (const c of e.message?.content ?? []) if (c.type === "tool_result") ev.inFlight.delete(c.tool_use_id);
  } else if (e.type === "result") {
    // a background task finishing starts another turn with its own result, so keep every turn's text: the real report
    // may be followed by "that notification changes nothing"
    const text = typeof e.result === "string" ? e.result : "";
    ev.resultText = ev.resultText === undefined ? text : `${ev.resultText}\n\n${text}`;
  }
}

/** pi/omp JSONL events (omp derives from pi): message_update carries toolcall events, message_end carries a turn's text. */
export function parseAgentEvent(e: any, ev: RunEvents) {
  const t = e.assistantMessageEvent?.toolCall;
  if (e.type === "message_update" && e.assistantMessageEvent?.type === "toolcall_end" && t) {
    if (!ev.inFlight.has(t.id)) { ev.inFlight.set(t.id, t.name); ev.steps++; }
    ev.step = toolStep(t.name, t.arguments);
  } else if (e.type === "message_end" && e.message?.role === "assistant") {
    const text = (e.message.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
    if (text) ev.assistantText += (ev.assistantText ? "\n\n" : "") + text;
  }
}

/** workspace-write only covers the cwd and /tmp; agents also need project checkouts, scratch, the hub and cargo's caches.
 *  `hub` is core.ROOT (runner injects it); the default only serves direct calls (tests). */
export function codexWritableDirs(home = homedir(), hub = join(homedir(), ".noop", "data")): string[] {
  const dirs = [join(home, "work"), join(home, ".noop", "work"), join(home, ".agent-hub", "work"), hub, join(home, ".cargo")];
  const real = dirs.filter((d) => existsSync(d)).map((d) => realpathSync(d));
  return [...new Set(real)];
}

const claude: CliAdapter = {
  name: "claude",
  defaultModel: "claude-opus-5-5",
  plannerHint: "for engineering, debugging, design, UI or judgement",
  streamJson: true,
  command(cfg, ctx) {
    const c = conf(cfg, "claude");
    const cmd = ["claude", "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", c.permission_mode ?? "bypassPermissions"];
    cmd.push("--model", c.model ?? "claude-opus-5-5");
    // the agent signature is the only attribution; drop Claude Code's own "Generated with" / co-author lines
    cmd.push("--settings", JSON.stringify({ attribution: { commit: "", pr: "" }, includeCoAuthoredBy: false }));
    if (ctx.gates.length) cmd.push("--disallowedTools", ...ctx.gates);
    return cmd;
  },
  parseEvent: parseStreamJson,
  routerCommand(model) {
    return ["claude", "-p", "--output-format", "text", "--tools", "", "--strict-mcp-config", ...(model ? ["--model", model] : [])];
  },
  judgeCommand(model) {
    return ["claude", "-p", "--output-format", "text", "--model", model ?? "claude-opus-5-5", "--tools", ""];
  },
  medicCommand() {
    // unattended fixes, but mechanically deny the irreversible moves the prompt already forbids
    return ["claude", "-p", "--output-format", "text", "--permission-mode", "bypassPermissions", "--disallowedTools", "Bash(git push --force:*)", "Bash(git push -f:*)", "Bash(rm -rf /:*)", "Bash(rm -rf ~:*)"];
  },
  accounts: {
    label: "Claude",
    creds: { dir: () => join(homedir(), ".claude"), file: () => ".credentials.json" },
    isolatedEnv(dir, token) { return { CLAUDE_CONFIG_DIR: dir, ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}) }; },
    loginHint: "claude /login",
    login: { cmd: () => ["claude", "setup-token"], needsCode: true },
  },
};

const codex: CliAdapter = {
  name: "codex",
  plannerHint: "for routine triage, monitoring, reports, first-pass reviews",
  command(cfg, ctx) {
    const c = conf(cfg, "codex");
    // non-interactive: workspace-write sandbox with network, never ask for approval
    const cmd = ["codex", "exec", "--skip-git-repo-check", "--sandbox", "workspace-write",
      "-c", 'approval_policy="never"', "-c", "sandbox_workspace_write.network_access=true"];
    for (const dir of codexWritableDirs(homedir(), ctx.hub)) cmd.push("--add-dir", dir);
    if (c.model) cmd.push("-m", c.model);
    return [...cmd, "-"];
  },
  routerCommand(model) {
    return ["codex", "exec", "--skip-git-repo-check", "--sandbox", "read-only", ...(model ? ["-m", model] : []), "-c", 'model_reasoning_effort="low"', "-"];
  },
  judgeCommand() {
    return ["codex", "exec", "--skip-git-repo-check", "-"];
  },
  medicCommand() {
    return ["codex", "exec", "--skip-git-repo-check", "--approve-for-me", "-c", "sandbox_workspace_write.network_access=true", "-"];
  },
  accounts: {
    label: "Codex",
    creds: { dir: () => join(homedir(), ".codex"), file: () => "auth.json" },
    isolatedEnv(dir) { return { CODEX_HOME: dir }; },
    loginHint: "codex login",
    login: { cmd: () => ["codex", "login", "--device-auth"], needsCode: false },
  },
};

// ------------------------------------------------------------------ opencode
// Gates ride on a generated global agent (`~/.config/opencode/agents/noop.md`) whose permissions deny the gate
// list; opencode appends agent rules last, so they outrank project/global allows, and saved approvals never
// override a deny. A decision-unlocked run (ctx.gates empty) simply omits --agent, which is the unlock.
const GATE_AGENT = "noop";
const gateAgentFile = () => join(homedir(), ".config", "opencode", "agents", `${GATE_AGENT}.md`);

/** "Bash(gh pr merge:*)" (Claude's command-prefix deny) → "gh pr merge*" — opencode's whole-value wildcard with `*` matching zero-or-more chars, i.e. the same prefix semantics, and it also matches the bare command. */
export function gateDeny(gate: string): string {
  const m = gate.match(/^Bash\((.+):\*\)$/);
  return m ? `${m[1]}*` : gate.replace(/^Bash\((.+)\)$/, "$1");
}

/** The generated agent markdown; exported for tests — installGateAgent writes it unchanged. */
export const gateAgentMd = (gates: string[]) => `---
description: Noop fleet task runner — irreversible actions (merge, release, force-push, publish, secrets) are hard-denied here; the owner's approval unlocks them per run
mode: all
permissions:
${gates.map((g) => `  - { action: shell, resource: "${gateDeny(g)}", effect: deny }`).join("\n")}
---
`;

/** Write (or refresh) the noop gate agent so `--agent noop` always matches the current gate list. On failure the
 *  agent file may be missing/stale — opencode then errors on the unknown agent (fail-closed, unlike codex). */
function installGateAgent(gates: string[]) {
  try {
    const md = gateAgentMd(gates);
    const f = gateAgentFile();
    if (existsSync(f) && readFileSync(f, "utf8") === md) return;
    mkdirSync(join(f, ".."), { recursive: true });
    writeFileSync(f, md);
  } catch {}
}

const opencode: CliAdapter = {
  name: "opencode",
  plannerHint: "for hands-on coding, debugging and multi-step engineering work",
  command(cfg, ctx) {
    const c = conf(cfg, "opencode");
    // non-interactive: --auto approves whatever the gate agent does not deny; the prompt arrives on stdin
    const cmd = ["opencode", "run", "--format", "json", "--auto"];
    if (c.model) cmd.push("--model", c.model);
    if (ctx.gates.length) { installGateAgent(ctx.gates); cmd.push("--agent", GATE_AGENT); }
    return cmd;
  },
  parseEvent(e, ev) {
    const p = e.part ?? {};
    if (e.type === "tool_use" && p.type === "tool") {
      if (!ev.inFlight.has(p.id)) { ev.inFlight.set(p.id, p.tool); ev.steps++; } // updates re-emit the same id
      ev.step = toolStep(p.tool, p.state?.input);
    } else if (e.type === "text" && typeof p.text === "string") {
      ev.assistantText += p.text;
    }
  },
  routerCommand(model) {
    return ["opencode", "run", "--format", "text", ...(model ? ["--model", model] : [])];
  },
  judgeCommand(model) {
    return ["opencode", "run", "--format", "text", ...(model ? ["--model", model] : [])];
  },
  medicCommand() {
    // --auto approves tool use; plain text so the ```json result block survives into stdout
    return ["opencode", "run", "--format", "text", "--auto"];
  },
  accounts: {
    label: "opencode",
    // auth.json lives in the data dir; env-key installs (like this one) never write it, so the stamp is best-effort
    creds: { dir: () => join(homedir(), ".local", "share", "opencode"), file: () => "auth.json" },
    isolatedEnv() { return {}; }, // isolation unverified: [[accounts]] entries for opencode share the default login
    loginHint: "opencode auth login",
    // no verified remote login: `opencode auth login` is an interactive provider-selection TUI
  },
  // verified against opencode.ai/docs/rules: the global AGENTS.md applies across all sessions (v2)
  rules: { file: () => join(homedir(), ".config", "opencode", "AGENTS.md") },
};

// ------------------------------------------------------------------ pi & omp
// Same JSONL event family; neither pi nor omp has command-level permission machinery beyond omp's bash.patterns,
// so gates are enforced only on omp (per-run overlay). pi runs like codex: unenforced, documented.

/** The per-run gate overlay for omp (`--config <file>`): yolo keeps the run unattended, bash.patterns deny is
 *  absolute under yolo and matches compound-command segments; eval is denied too since bash patterns do not cover it. */
export const ompGateOverlayMd = (gates: string[]) => `tools:
  approvalMode: yolo
  approval:
    eval: deny
bash:
  patterns:
${gates.map((g) => `    - match: "${gateDeny(g)}"\n      approval: deny`).join("\n")}
`;

/** Write (or refresh) the overlay; null on failure → the run proceeds without it (omp defaults, like codex). */
function ensureOmpGateOverlay(gates: string[]): string | null {
  try {
    const yml = ompGateOverlayMd(gates);
    const f = join(homedir(), ".noop", "omp-gates.yml");
    if (existsSync(f) && readFileSync(f, "utf8") === yml) return f;
    mkdirSync(join(f, ".."), { recursive: true });
    writeFileSync(f, yml);
    return f;
  } catch { return null; }
}

const pi: CliAdapter = {
  name: "pi",
  plannerHint: "for hands-on coding, reviews and multi-step engineering work",
  command(cfg) {
    const c = conf(cfg, "pi");
    // print mode has no approval machinery: like codex, gates are not mechanically enforced on pi
    const cmd = ["pi", "-p", "--mode", "json"];
    if (c.model) cmd.push("--model", c.model);
    return cmd;
  },
  parseEvent: parseAgentEvent,
  routerCommand(model) {
    return ["pi", "-p", "--mode", "text", "--no-tools", ...(model ? ["--model", model] : [])];
  },
  judgeCommand(model) {
    return ["pi", "-p", "--mode", "text", "--no-tools", ...(model ? ["--model", model] : [])];
  },
  medicCommand() {
    // print mode runs tools unattended (pi has no approval machinery to configure)
    return ["pi", "-p", "--mode", "text"];
  },
  accounts: {
    label: "pi",
    creds: { dir: () => join(homedir(), ".pi", "agent"), file: () => "auth.json" },
    isolatedEnv() { return {}; }, // isolation unverified: [[accounts]] entries for pi share the default login
    loginHint: "set the provider API key (env or ~/.pi/agent/settings.json)",
    // no remote login flow (pi auth only prints/checks credentials)
  },
  // verified in pi 1.5.0's installed source: the global context file is the first of AGENTS.override.md/AGENTS.md/… in ~/.pi/agent
  rules: { file: () => join(homedir(), ".pi", "agent", "AGENTS.md") },
};

const omp: CliAdapter = {
  name: "omp",
  plannerHint: "for hands-on coding, debugging and multi-step engineering work",
  command(cfg, ctx) {
    const c = conf(cfg, "omp");
    // headless: yolo approvals; the gate overlay hard-denies the gate list (absolute under yolo, compound-aware)
    const cmd = ["omp", "-p", "--mode", "json", "--approval-mode", "yolo"];
    if (c.model) cmd.push("--model", c.model);
    if (ctx.gates.length) {
      const overlay = ensureOmpGateOverlay(ctx.gates);
      if (overlay) cmd.push("--config", overlay);
    }
    return cmd;
  },
  parseEvent: parseAgentEvent,
  routerCommand(model) {
    return ["omp", "-p", "--mode", "text", "--no-tools", ...(model ? ["--model", model] : [])];
  },
  judgeCommand(model) {
    return ["omp", "-p", "--mode", "text", "--no-tools", ...(model ? ["--model", model] : [])];
  },
  medicCommand() {
    // yolo approves tool use; the medic prompt itself forbids the irreversible moves (no gate overlay here)
    return ["omp", "-p", "--mode", "text", "--approval-mode", "yolo"];
  },
  accounts: {
    label: "omp",
    // credentials live in the agent db / config.yml (omp auth export/import); no single stampable file
    creds: { dir: () => join(homedir(), ".omp", "agent"), file: () => "auth.json" },
    isolatedEnv() { return {}; }, // [[accounts]] isolation rides omp's --profile flag (not env) — not wired yet
    loginHint: "omp auth import / provider login",
  },
  // verified in the omp 18.16.0 binary's own help text: user-level instructions live at ~/.omp/agent/AGENTS.md
  rules: { file: () => join(homedir(), ".omp", "agent", "AGENTS.md") },
};

/** Registered CLIs, in preference order (Claude first, per [clis] defaults). */
export const CLIS: CliAdapter[] = [claude, codex, opencode, pi, omp];

export const byName = (name: string) => CLIS.find((a) => a.name === name);

/** Command for one task run: config `[clis.<name>] command = [...]` overrides the adapter's default. */
export function command(cli: string, cfg: Cfg, ctx: CliCtx): string[] {
  const c = conf(cfg, cli);
  if (Array.isArray(c.command)) return c.command;
  const a = byName(cli);
  if (!a) throw new Error(`unknown cli ${cli}`);
  return a.command(cfg, ctx);
}
