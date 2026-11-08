// Learn the CEO: extract the owner's own words from local agent CLI session history (Claude Code, Codex, pi, omp;
// opencode keeps sessions in a SQLite db and is not parsed) into a redacted digest that an agent distills
// into memory/taste.md + principles. Raw transcripts never leave this machine; only the distilled
// principles are synced to the shared data.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { type Cfg, P, list, readDoc, HOME_DIR } from "./core";
import { feed } from "./server";

/** Owner's interactions inside noop since `since`: chat instructions + decisions (incl. overrides of the judge). */
function hubInteractions(since: string): string {
  const out: string[] = [];
  for (const e of feed(since, 2000)) if (e.kind === "owner") out.push(`- [${e.ts.slice(0, 16)} hub-chat${e.ref ? " ↳" + e.ref : ""}] ${redact(e.text)}`);
  for (const p of list(P("decisions", "closed"))) {
    const m = readDoc(p).meta;
    if (!m.answered || m.answered < since || !/^owner/.test(m.answered_by ?? "")) continue;
    const shadow = m.shadow_verdict ? ` · judge would have: ${m.shadow_verdict} "${m.shadow_answer ?? ""}"` : "";
    const over = m.overridden_judge ? ` · OVERRODE judge's "${m.overridden_judge}"` : "";
    out.push(`- [${m.answered.slice(0, 16)} hub-decision ${m.id} · ${m.agent ?? m.kind}] Q: ${redact(m.question ?? "")} · options: ${redact(m.options ?? m.items ?? "")} · recommended: ${m.recommendation ?? "-"} → owner: **${redact(m.answer ?? "")}**${shadow}${over}`);
  }
  for (const p of list(P("tasks", "rejected"), /^T-.*\.md$/)) {
    const m = readDoc(p).meta;
    if ((m.created ?? "") >= since) out.push(`- [hub-rejected] owner declined proposed task: ${redact(m.title ?? "")} (${m.agent})`);
  }
  return out.join("\n");
}

const STATE = join(HOME_DIR, "learn", "state.json");
const OUT = join(HOME_DIR, "learn");

type Turn = { ts: string; project: string; tool: string; text: string; prev?: string };
type SessionReader = (file: string, tool: string) => Turn[];

// ---------------------------------------------------------------- redaction
const SECRET = [
  /\b(sk-(?:ant|proj|live|test)?-?[\w-]{16,})/g, /\b(gh[pousr]_[A-Za-z0-9]{20,})/g, /\b(xox[abpr]-[\w-]{10,})/g,
  /\b(AKIA[0-9A-Z]{16})\b/g, /\b(eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,})/g, /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /((?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*)\S+/gi, /\b[0-9a-f]{32,}\b/gi,
];
export function redact(s: string): string {
  let out = s;
  for (const re of SECRET) out = out.replace(re, (_m, g1) => (typeof g1 === "string" && /[:=]\s*$/.test(g1) ? `${g1}[REDACTED]` : "[REDACTED]"));
  return out.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]");
}

// ---------------------------------------------------------------- filters
const FLEET_PROMPT = /^You are \*\*[^*]+\*\*, a permanent member|You are the owner's JUDGE|^\[SYSTEM NOTIFICATION/;
const INJECTED = /^(<environment_context>|<user_instructions>|# AGENTS\.md|<permissions instructions>|<local-command|<command-name>|<command-message>|<task-notification>|<bash-|<agent-message|Caveat:|\[Request interrupted|This session is being continued)/;

function clean(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<pasted_content[\s\S]*?<\/pasted_content[^>]*>/g, "[pasted]")
    .replace(/```[\s\S]{600,}?```/g, "[long code block]")
    .trim();
}

function ownerText(raw: string): string | null {
  if (!raw || FLEET_PROMPT.test(raw) || INJECTED.test(raw.trim())) return null;
  const t = clean(raw);
  if (t.length < 4 || /^\[pasted\]$/.test(t) || /^\[Image #\d+\]$/.test(t)) return null;
  return t.length > 1500 ? t.slice(0, 1500) + " …" : t;
}

// ---------------------------------------------------------------- readers
function readClaude(file: string, tool: string): Turn[] {
  const out: Turn[] = [];
  const project = basename(join(file, "..")).replace(/^-(home|Users)-[^-]+-/, "").replace(/^work-/, "").replace(/--claude-worktrees-.*$/, "");
  let lastAssistant = "";
  let fleet = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let l: any; try { l = JSON.parse(line); } catch { continue; }
    if (l.type === "assistant") {
      const c = l.message?.content;
      const txt = Array.isArray(c) ? c.filter((x: any) => x.type === "text").map((x: any) => x.text).join(" ") : String(c ?? "");
      if (txt) lastAssistant = txt;
      continue;
    }
    if (l.type !== "user" || l.isMeta || l.isSidechain) continue;
    const c = l.message?.content;
    const raw = typeof c === "string" ? c : Array.isArray(c) ? c.filter((x: any) => x.type === "text").map((x: any) => x.text).join("\n") : "";
    if (FLEET_PROMPT.test(raw)) { fleet = true; break; } // whole session is a fleet agent run
    const t = ownerText(raw);
    if (t) out.push({ ts: l.timestamp ?? "", project, tool, text: t, prev: lastAssistant.slice(-400) });
  }
  return fleet ? [] : out;
}

function readCodex(file: string, tool: string): Turn[] {
  const out: Turn[] = [];
  let project = "codex", lastAssistant = "";
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let l: any; try { l = JSON.parse(line); } catch { continue; }
    const p = l.payload ?? {};
    if (l.type === "session_meta" && p.cwd) project = basename(p.cwd);
    if (l.type === "turn_context" && p.cwd) project = basename(p.cwd);
    if (l.type !== "response_item" || p.type !== "message") continue;
    const txt = textContent(p.content);
    if (p.role === "assistant") { lastAssistant = txt; continue; }
    if (p.role !== "user") continue;
    if (FLEET_PROMPT.test(txt)) return [];
    const t = ownerText(txt);
    if (t) out.push({ ts: l.timestamp ?? "", project, tool, text: t, prev: lastAssistant.slice(-400) });
  }
  return out;
}

/** Message content arrives as a text-part array in most formats but as a plain string in others
 *  (pi/omp v3 system messages, some codex items). One reader for both shapes, so a shape change
 *  can never crash the learn run again (2026-11-08: a string content killed every tick for hours). */
function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((x: any) => x?.type === "text").map((x: any) => x.text ?? "").join("\n");
  return "";
}

/** pi/omp session JSONL (omp derives from pi): the session line carries the cwd, message lines carry role + text content. */
export function readPiStyle(file: string, tool: string): Turn[] {
  const out: Turn[] = [];
  let project = tool, lastAssistant = ""; // fallback when the session file has no cwd line (readCodex: "codex")
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let l: any; try { l = JSON.parse(line); } catch { continue; }
    if (l.type === "session" && l.cwd) project = basename(l.cwd);
    if (l.type !== "message") continue;
    const m = l.message ?? {};
    const txt = textContent(m.content);
    if (m.role === "assistant") { if (txt) lastAssistant = txt; continue; }
    if (m.role !== "user") continue;
    if (FLEET_PROMPT.test(txt)) return []; // whole session is a fleet agent run
    const t = ownerText(txt);
    if (t) out.push({ ts: l.timestamp ?? "", project, tool, text: t, prev: lastAssistant.slice(-400) });
  }
  return out;
}

/** Session sources per CLI, in registry order. Config [learn] `<name>_dir` overrides the default root;
 *  opencode is absent: its sessions live in a SQLite db (~/.local/share/opencode/opencode.db), not JSONL. */
const SOURCES: { name: string; dir: string; read: SessionReader }[] = [
  { name: "claude", dir: join(homedir(), ".claude", "projects"), read: readClaude },
  { name: "codex", dir: join(homedir(), ".codex", "sessions"), read: readCodex },
  { name: "pi", dir: join(homedir(), ".pi", "agent", "sessions"), read: readPiStyle },
  { name: "omp", dir: join(homedir(), ".omp", "agent", "sessions"), read: readPiStyle },
];

function walk(dir: string, re: RegExp, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, re, acc); else if (re.test(e.name)) acc.push(p);
  }
  return acc;
}

/** Incrementally collect owner turns since the last run; writes a redacted digest file and returns its path. */
export function collect(cfg: Cfg, opts: { full?: boolean; maxChars?: number } = {}): { file: string | null; turns: number; sessions: number } {
  mkdirSync(OUT, { recursive: true });
  const state: Record<string, any> = !opts.full && existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
  const roots = (cfg.learn ?? {}) as Record<string, string>;
  const turns: Turn[] = [];
  let sessions = 0;
  for (const s of SOURCES) {
    const dir = (roots[`${s.name}_dir`] ?? s.dir).replace(/^~/, homedir());
    for (const f of walk(dir, /\.jsonl$/)) {
      const m = statSync(f).mtimeMs;
      if (typeof state[f] === "number" && state[f] >= m) continue;
      if (Date.now() - m < 10 * 60_000) continue; // skip live sessions
      let t: Turn[];
      try { t = s.read(f, s.name); } catch (e) {
        // one unreadable session file must not kill the learn run (or the whole tick); retry it next run
        console.error(`learn: skipping unreadable ${f}: ${(e as Error).message}`);
        continue;
      }
      state[f] = m;
      if (t.length) { sessions++; turns.push(...t); }
    }
  }
  const hubSince = opts.full ? "" : (state.__hub_since as unknown as string) ?? "";
  const hub = existsSync(P("decisions")) ? hubInteractions(hubSince) : "";
  (state as any).__hub_since = new Date().toISOString();
  writeFileSync(STATE, JSON.stringify(state));
  if (!turns.length && !hub) return { file: null, turns: 0, sessions };
  turns.sort((a, b) => a.ts.localeCompare(b.ts));
  const max = opts.maxChars ?? cfg.learn?.max_digest_chars ?? 400_000;
  const byProject = new Map<string, Turn[]>();
  for (const t of turns) byProject.set(t.project, [...(byProject.get(t.project) ?? []), t]);
  let body = "";
  for (const [proj, ts] of byProject) {
    body += `\n\n## ${proj}\n`;
    for (const t of ts) {
      const ctx = t.prev ? `  ↳ (after AI said: ${redact(t.prev).replace(/\s+/g, " ").slice(0, 220)})\n` : "";
      body += `\n- [${t.ts.slice(0, 16)} ${t.tool}] ${redact(t.text).replace(/\n/g, "\n  ")}\n${ctx}`;
    }
  }
  if (body.length > max) body = body.slice(-max); // keep the most recent
  const file = join(OUT, `digest-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.md`);
  const hubPart = hub ? `\n\n## Noop (decisions & chat — how the owner judges the fleet's questions)\n${hub}\n` : "";
  writeFileSync(file, `# Owner's own words from ${sessions} sessions (${turns.length} turns, redacted)\n${hubPart}${body}\n`, { mode: 0o600 });
  return { file, turns: turns.length, sessions };
}

export const LEARN_PROMPT = (digest: string) => `Learn the CEO. Read the redacted digest of the owner's own messages to AI coding agents at:
${digest}
(local to this machine; never copy raw text or the file into the hub repo, never quote anything that looks like a secret or a private person's data).

Distill durable, actionable knowledge — how the owner works, judges and decides — and update the hub's memory:
1. memory/taste.md — the owner's taste as concrete rules with an example each: UI/UX/visual ("too slow, not delightful"), code
   ("delete this path", naming, API shape), product calls, quality bar, what they reject and why, phrases they use when unhappy.
2. memory/principles.md — decision principles (what they approve/decline, trade-offs they repeatedly pick, risk appetite, when they
   want to be asked vs. not). Each entry: the rule, evidence count, latest date, source "session:<project>/<date>".
3. memory/focus.md — only if the digest clearly shows a shift in what they work on now (dated).
4. memory/projects.md / memory/release-cadence.md / memory/owner.md — correct facts (repos, cadences, tools, people roles) the digest reveals.
5. agents/<id>/memory.md — role-specific lessons (e.g. reviewer: what the owner checks in PRs; maintainer: build/test habits).

6. From the Noop section: for each agent/decision category, how often did the owner pick the recommendation, override the
   judge, or reject proposals? Record per-category rules in memory/principles.md so the judge can decide them next time, and note in
   your summary which agents look ready for more autonomy (the architect proposes graduation; you never change config).

Rules: merge with existing entries (strengthen counts/dates) instead of appending duplicates; keep each file < 200 lines; date everything;
prefer patterns seen ≥ 2 times; mark single-observation items "(weak)". Owner's corrections of AI ("不对", "不要", "revert", "太慢") are the
most valuable signal — capture what was wrong and what they wanted instead. Summary: top 5 new or strengthened insights.`;
