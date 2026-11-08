// Chat brain: the owner's main channel, ChatGPT-style. Every owner message that isn't a bare decision answer ("D-0012 A")
// goes to a fast model (Claude Haiku via the local `claude` CLI, on the primary daemon) that runs a short agent loop over
// noop's own tools (cloud/src/tools.ts — the same tools the MCP server offers): it can answer directly, look things up,
// create/amend/cancel/reprioritise/reassign tasks, answer decisions and write memory. No canned replies: when it has
// nothing useful to say it posts nothing.
//
// Credential locality: the model runs here, under the owner's own `claude` login. The Cloudflare Worker never sees it:
// owner messages reach this daemon over the existing owner→fleet inbox (long-polled, so within milliseconds), and the
// reply goes back as a normal feed event.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { channelPrompt } from "./channels";
import { join, relative } from "node:path";
import { DATA, HOME_DIR, P, _commitPush, _pull, journal, locked, now, readDoc, writeDoc } from "./core";
import { type Ev, type FileRow, type ToolStore, type WriteOp, isWrite, listDecisions, listRoutines, listTasks, editMemoryEntry, runTool, toolsFor, writeOp } from "../cloud/src/tools";

// ---------------------------------------------------------------- the local tool store (the data repo on this machine)

/** What the daemon does for each write; injected so tests (and the cloud) can stand in. */
export type Acts = { [K in WriteOp["tool"]]?: (op: Extract<WriteOp, { tool: K }>) => Promise<Record<string, unknown>> };

export function localStore(o: { acts: Acts; status: () => any; feed: () => { ts: string; [k: string]: any }[]; root?: string }): ToolStore {
  const root = o.root ?? DATA;
  const row = (abs: string): FileRow => ({ path: relative(root, abs).replaceAll("\\", "/"), text: readFileSync(abs, "utf8"), updated: statSync(abs).mtime.toISOString() });
  const walk = (dir: string): string[] => {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".md") || e.name.endsWith(".toml") ? [join(dir, e.name)] : []);
  };
  const safe = (p: string) => !p.includes("..") && !p.startsWith("/");
  return {
    read: (p) => (safe(p) && existsSync(join(root, p)) && statSync(join(root, p)).isFile() ? row(join(root, p)) : null),
    list: (d) => (safe(d) ? walk(join(root, d)).sort().reverse().slice(0, 2000).map(row) : []),
    status: o.status,
    events: (after, limit) => o.feed().map((ev, i) => ({ seq: i + 1, ev: ev as Ev })).filter((r) => r.seq > after).slice(0, limit),
    lastSeq: () => o.feed().length,
    act: async (op) => {
      const fn = o.acts[op.tool] as ((op: WriteOp) => Promise<Record<string, unknown>>) | undefined;
      if (!fn) throw new Error(`${op.tool} is not available here`);
      return fn(op);
    },
  };
}

/** A task is one conversation: the owner's message on a finished task puts it back in the queue, same id, its runs as context. */
export function reopenTask(file: string, text: string) {
  const { meta, body } = readDoc(file);
  writeDoc(P("tasks", "inbox", `${meta.id}.md`), { ...meta, claimed_by: undefined, status: undefined, finished: undefined, wake_at: undefined, decision: undefined, attempt: undefined, resumed: "yes" },
    `${body}\n\n## Owner follow-up ${now()}\n> ${text.replace(/\n/g, "\n> ")}\n\nReopened by the owner's message above: the earlier runs are your context, act on it now.\n`);
  unlinkSync(file);
}

/** Writes that only touch task metadata or memory files: done right here (git-synced data repo). */
export function dataActs(host: string, io = { pull: _pull, push: _commitPush }): Acts {
  const pull = () => io.pull(), push = (m: string) => io.push(m);
  const findTask = (id: string, dirs: string[]) => dirs.map((d) => P("tasks", d, `${id}.md`)).find(existsSync);
  return {
    set_priority: (op) => locked(async () => {
      await pull();
      const f = findTask(op.id, ["inbox", "active", "waiting", "blocked"]);
      if (!f) return { ok: false, error: `${op.id} is not open` };
      const { meta, body } = readDoc(f);
      writeDoc(f, { ...meta, priority: op.priority }, body);
      journal(host, `↕️ ${op.id} priority → ${op.priority} (owner chat)`);
      await push(`[${host}] priority ${op.id} ${op.priority}`);
      return { ok: true, id: op.id, priority: op.priority };
    }),
    reassign_task: (op) => locked(async () => {
      await pull();
      const f = findTask(op.id, ["inbox", "waiting", "blocked"]);
      if (!f) return { ok: false, error: `${op.id} is not queued, waiting or blocked` };
      const { meta, body } = readDoc(f);
      writeDoc(f, { ...meta, agent: op.agent }, `${body}\n\n## Reassigned ${now()}\nThe owner gave this task to ${op.agent} (was ${meta.agent ?? "?"}).\n`);
      journal(host, `🔀 ${op.id} reassigned ${meta.agent ?? "?"} → ${op.agent} (owner chat)`);
      await push(`[${host}] reassign ${op.id} ${op.agent}`);
      return { ok: true, id: op.id, agent: op.agent };
    }),
    remember: (op) => locked(async () => {
      await pull();
      const f = P(...op.file.split("/"));
      mkdirSync(join(f, ".."), { recursive: true });
      const line = `- ${op.text.replace(/\s*\n\s*/g, " ")} _(owner, ${now().slice(0, 10)}, via chat)_\n`;
      const prev = existsSync(f) ? readFileSync(f, "utf8") : "";
      if (prev.includes(op.text.trim())) return { ok: true, file: op.file, note: "already there" };
      writeFileSync(f, prev && !prev.endsWith("\n") ? `${prev}\n${line}` : prev + line);
      journal(host, `🧠 remembered in ${op.file}: ${op.text.slice(0, 80)}`);
      await push(`[${host}] memory ${op.file}`);
      return { ok: true, file: op.file };
    }),
    edit_memory: (op) => locked(async () => {
      await pull();
      const f = P(...op.file.split("/"));
      if (!existsSync(f)) return { ok: false, error: `${op.file} not found` };
      const edit = editMemoryEntry(readFileSync(f, "utf8"), op.match, op.text);
      if (typeof edit === "string") return { ok: false, error: edit };
      writeFileSync(f, edit.text);
      journal(host, `🧠 ${op.text ? "edited" : "deleted"} in ${op.file}: ${edit.entry.replace(/\s*\n\s*/g, " ").slice(0, 300)}`);
      await push(`[${host}] memory ${op.file}`);
      return { ok: true, file: op.file, [op.text ? "replaced" : "deleted"]: edit.entry };
    }),
  };
}

// ---------------------------------------------------------------- the model (a warm `claude` process)

export interface Model {
  /** One conversation: send a user turn, get the assistant's text. close() when done. */
  open(system: string): Promise<{ send(text: string): Promise<string>; close(): void }>;
}

const BRAIN_DIR = join(HOME_DIR, "brain"); // empty cwd: no project CLAUDE.md, no repo context for the CLI to load

/** `claude -p` in stream-json mode, spawned ahead of time so a message only pays for the model call (~1.5 s), not the
 * CLI start (~2 s). One process per conversation (no history carries over); the next one is spawned as this one is used. */
export class ClaudeModel implements Model {
  private next: { proc: ReturnType<typeof Bun.spawn>; system: string } | null = null;
  constructor(private model = "claude-haiku-5-5", private cli = "claude", private timeoutMs = 45_000) {}
  private spawn(system: string) {
    mkdirSync(BRAIN_DIR, { recursive: true });
    const proc = Bun.spawn([this.cli, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--model", this.model, "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--disable-slash-commands",
      "--no-session-persistence", "--system-prompt", system], { cwd: BRAIN_DIR, stdin: "pipe", stdout: "pipe", stderr: "ignore", env: { ...process.env, ...userSettingsEnv() } });
    return { proc, system };
  }
  /** Spawn the next process now (the daemon calls this at start), so the first message is fast too. */
  warm(system: string) { if (!this.next || this.next.system !== system || this.next.proc.exitCode !== null) { this.next?.proc.kill(); this.next = this.spawn(system); } }
  async open(system: string) {
    this.warm(system);
    const { proc } = this.next!;
    this.next = null;
    setTimeout(() => this.warm(system), 0); // the one after
    const stdin = proc.stdin as import("bun").FileSink;
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buf = "";
    const nextResult = async (): Promise<string> => {
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          let m: any; try { m = JSON.parse(line); } catch { continue; }
          if (m.type === "result") { if (m.is_error) throw new Error(String(m.result ?? m.subtype)); return String(m.result ?? ""); }
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("model process ended");
        buf += dec.decode(value, { stream: true });
      }
    };
    return {
      send: async (text: string) => {
        stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
        stdin.flush();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([nextResult(), new Promise<string>((_, rej) => { timer = setTimeout(() => rej(new Error("model timeout")), this.timeoutMs); })]);
        } finally { clearTimeout(timer); }
      },
      close: () => { try { stdin.end(); } catch {} proc.kill(); },
    };
  }
}

// ---------------------------------------------------------------- the brain

const BRAIN_TOOLS = toolsFor("brain");
const MAX_ROUNDS = 4;

export const SYSTEM = `You are Noop: the front of the owner's AI agent team, answering in the team chat channel the way a sharp
chief of staff would in a chat app. The owner (Jason, CEO) writes tersely, usually in Chinese.

You act through tools. Each turn, answer with exactly ONE JSON object and nothing else:
{"calls": [{"tool": "<name>", "args": {…}}], "reply": "<what you say in the channel, or empty>"}

How to decide:
- Chit-chat, thanks, a quick question you can answer from the context below: just reply (no calls).
- A status question ("X 怎么样了", "现在在跑什么"): answer from the context if it is there; otherwise call read tools with
  reply "" — you get their results next turn and answer then.
- Real work (code, PR review, release prep, investigation, anything that takes more than a minute): create_task with a
  clear title and the owner's request in details (quote it; add the context that the agent needs, e.g. which PR/repo,
  and "follows" when it continues or corrects a task from the channel). Agents do the work; you never claim to do it.
- About an existing task, open or finished (corrections, "不行", "再…", more requirements): amend_task on it with the owner's
  words, not a new task. A task is one conversation: amending a finished one reopens it under the same id. When it is
  waiting on the owner's decision card, the text answers that card. Use create_task with follows=<that task> only for
  clearly separate new work.
- "记住/以后都这样/记下来" or a standing rule for how the fleet should work: remember it (pick the file that fits;
  agents/<name>/memory.md when it only concerns one agent's kind of work). If it also asks for work, do both.
- A complaint or change request about a product (Noop, NSH, ...) is work, not a rule: create_task only, never remember it.
  Read it together with the owner's previous messages: one in a series of product changes belongs to that series. When
  you cannot tell, do not remember; say what you took it as, so the owner can correct you.
- A memory is wrong, outdated or should go ("删掉那条", "记错了"): find it with read_memory (query), then edit_memory; only when the
  owner asks. Without text it deletes the entry.
- Answering or changing the answer to a decision card: answer_decision. Stop/drop a task only when clearly asked: cancel_task.
  Priority / who does it: set_priority / reassign_task.
- Merging, releases, deploys, settings, money, messages to people: you cannot; create_task and the agent asks the owner
  with a decision card.

The reply:
- In the owner's language; one or two short sentences (a list only when asked for one); specific, like a person. Say what you did or found ("记下了：…", "T-0184 在 macbook 上跑，
  正在写测试"). Never a template, never process promises ("做完带结果回来", "需要你拍板时…"), no filler.
- Empty when there is nothing useful to say (a bare "A", "ok", "好的", or when the action speaks for itself).
- Never invent facts: if you did not see it in the context or a tool result, look it up or say you don't know.

Tools (args as JSON; [w] = write):
${BRAIN_TOOLS.map((t) => `- ${t.name}${t.write ? " [w]" : ""}: ${t.description} Args: ${JSON.stringify(Object.fromEntries(Object.entries(t.inputSchema.properties ?? {}).map(([k, v]: [string, any]) => [k, `${(t.inputSchema.required ?? []).includes(k) ? "" : "optional "}${v.enum ? v.enum.join("|") : v.type}`])))}`).join("\n")}
After write calls only, you are done (they run after your reply is posted). After any read call or an error you get the
results and answer again.`;

export type BrainIn = {
  text: string;
  /** The task the owner replied to / wrote on (T-…). */
  replyTo?: string;
  /** The decision the owner answered minutes ago (the message may change that answer). */
  answered?: string;
  /** The channel just before this message, oldest first ("owner: …", "lead: …"). */
  chat?: string[];
  /** When the owner sent it (feed ts), for latency. */
  sentAt?: string;
  /** Said inside a channel: the discussion and the work it starts stay there. */
  channel?: { slug: string; name: string; goal: string };
};
export type BrainOut = { reply: string; calls: { tool: string; args: any; ok: boolean; result?: any; error?: string }[]; rounds: number; ms: { first_reply?: number; model: number[]; total: number }; fallback?: boolean };

/** The context block: what the brain sees before deciding (open work, decisions, relevant memory, the channel). */
export function context(st: ToolStore, m: BrainIn): string {
  const open = listTasks(st, "open", "", 40);
  const done = listTasks(st, "done", "", 8);
  const dec = listDecisions(st, "open", 15);
  const ids = [...new Set([...(m.chat ?? []).join("\n").matchAll(/\bT-\d{4}\b/g)].map((x) => x[0]))];
  // relevant memory: lines of memory/*.md that share a word with the message (latin words ≥ 4 letters, CJK bigrams)
  const words = [...new Set([...(m.text.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []),
    ...[...m.text.matchAll(/[一-鿿]{2,}/g)].flatMap((x) => [...x[0]].slice(0, -1).map((c, i) => c + x[0][i + 1]))])].slice(0, 30);
  const mem = words.length ? st.list("memory/").flatMap((f) => f.text.split("\n").filter((l) => l.startsWith("-") || l.startsWith("|")).filter((l) => words.some((w) => l.toLowerCase().includes(w))).map((l) => `${f.path}: ${l.slice(0, 300)}`)).slice(0, 12) : [];
  const s = st.status() ?? {};
  return [
    `Now: ${new Date().toISOString()}`,
    channelPrompt(),
    "When calling create_task, set channels by these goals. Existing slugs or {name, goal} for a new work topic; [] for none.",
    `Routines: ${listRoutines(st).map((r) => `${r.name} (${r.every ?? r.at ?? "?"}, ${r.agent}${r.enabled ? "" : ", off"})`).join("; ") || "(none)"}`,
    `Machines online: ${(s.hosts ?? []).filter((h: any) => h.online !== false).map((h: any) => h.host).join(", ") || "unknown"}`,
    `Open tasks:\n${open.map((t) => `- ${t.id} [${t.state}${t.agent ? `, ${t.agent}` : ""}${t.host ? ` on ${t.host}` : ""}${t.priority ? `, ${t.priority}` : ""}] ${t.title}`).join("\n") || "(none)"}`,
    `Recently finished:\n${done.map((t) => `- ${t.id} ${t.title}`).join("\n") || "(none)"}`,
    `Decision cards waiting for the owner:\n${dec.map((d) => `- ${d.id}: ${d.question} — ${d.options.join(" / ")}${d.recommendation ? ` (recommended ${d.recommendation})` : ""}`).join("\n") || "(none)"}`,
    m.answered ? `The owner answered ${m.answered} a few minutes ago; this message may change that answer.` : "",
    mem.length ? `Memory lines that may be relevant (read_memory for more):\n${mem.join("\n")}` : "",
    ids.length ? `Tasks mentioned in the channel: ${ids.join(", ")}` : "",
    `The channel just before (oldest first):\n${(m.chat ?? []).join("\n") || "(empty)"}`,
    m.channel ? `The owner wrote this inside the channel #${m.channel.name} (\`${m.channel.slug}\`), goal: ${m.channel.goal || "(none)"}. Read it in that context; the conversation above is this channel's. Your reply and any task you create belong to this channel (it is added to the task's channels automatically).` : "",
    m.replyTo ? `The owner wrote this as a reply to the team's message about ${m.replyTo}.` : "",
    `The owner's message:\n${m.text.slice(0, 4000)}`,
  ].filter(Boolean).join("\n\n");
}

/** `{"calls": [...], "reply": "..."}` from the model's text (tolerates a code fence or prose around it). */
export function parseTurn(out: string): { calls: { tool: string; args: any }[]; reply: string } | null {
  const cands = [...out.matchAll(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/g)].map((m) => m[1]);
  const a = out.indexOf("{"), b = out.lastIndexOf("}");
  if (a >= 0 && b > a) cands.push(out.slice(a, b + 1));
  for (const c of cands.reverse()) {
    try {
      const j = JSON.parse(c);
      if (j && typeof j === "object" && ("calls" in j || "reply" in j)) {
        const calls = (Array.isArray(j.calls) ? j.calls : []).filter((x: any) => x && typeof x.tool === "string").map((x: any) => ({ tool: x.tool, args: x.args ?? {} }));
        return { calls, reply: typeof j.reply === "string" ? j.reply.trim() : "" };
      }
    } catch {}
  }
  return null;
}

/** One owner message → reply + tool calls. `post` puts the reply in the channel (as soon as it is final, before the
 * writes run, so the owner sees it within seconds even when a write syncs the data repo). */
export async function think(m: BrainIn, st: ToolStore, model: Model, post: (reply: string, ref?: string) => void): Promise<BrainOut> {
  const t0 = Date.now();
  const res: BrainOut = { reply: "", calls: [], rounds: 0, ms: { model: [], total: 0 } };
  const conv = await model.open(SYSTEM);
  try {
    let input = context(st, m);
    for (let round = 0; round < MAX_ROUNDS; round++) {
      res.rounds++;
      const tm = Date.now();
      const out = await conv.send(input);
      res.ms.model.push(Date.now() - tm);
      const turn = parseTurn(out);
      if (!turn) { input = `That was not one JSON object. Answer again with exactly {"calls": [...], "reply": "..."}.`; continue; }
      const reads = turn.calls.filter((c) => !isWrite(c.tool) && BRAIN_TOOLS.some((t) => t.name === c.tool));
      const writes = turn.calls.filter((c) => isWrite(c.tool) && BRAIN_TOOLS.some((t) => t.name === c.tool));
      const unknown = turn.calls.filter((c) => !BRAIN_TOOLS.some((t) => t.name === c.tool));
      const invalid = writes.map((c) => ({ c, op: writeOp(c.tool, c.args, st) })).filter((x) => typeof x.op === "string");
      if (reads.length || unknown.length || invalid.length) {
        const results: string[] = [];
        for (const c of reads) {
          const r = await runTool(st, c.tool, c.args);
          res.calls.push({ ...c, ok: r.ok, ...(r.ok ? { result: r.data } : { error: r.error }) });
          results.push(`${c.tool}(${JSON.stringify(c.args)}) → ${r.ok ? JSON.stringify(r.data).slice(0, 6000) : `ERROR ${r.error}`}`);
        }
        for (const c of unknown) results.push(`${c.tool}: ERROR no such tool`);
        for (const x of invalid) { res.calls.push({ ...x.c, ok: false, error: x.op as string }); results.push(`${x.c.tool}(${JSON.stringify(x.c.args)}) → ERROR ${x.op}`); }
        const pending = writes.filter((c) => !invalid.some((x) => x.c === c));
        if (pending.length) results.push(`Not run yet (send them again if still wanted): ${pending.map((c) => c.tool).join(", ")}`);
        input = `Tool results:\n${results.join("\n")}\n\nNow answer: one JSON object.`;
        continue;
      }
      // final turn: post the reply, then run the writes
      res.reply = turn.reply;
      const ref = m.replyTo ?? writes.map((c) => c.args?.id).find((x) => typeof x === "string" && /^T-/.test(x));
      if (turn.reply) { post(turn.reply, ref); res.ms.first_reply = Date.now() - t0; }
      for (const c of writes) {
        const r = await runTool(st, c.tool, c.args);
        res.calls.push({ ...c, ok: r.ok, ...(r.ok ? { result: r.data } : { error: r.error }) });
      }
      break;
    }
  } finally { conv.close(); }
  res.ms.total = Date.now() - t0;
  return res;
}

/** Latency log (one JSON line per message): ~/.noop/brain.jsonl, local to this machine. */
/** Without the model: the task a terse follow-up continues. A short one-line message sent within 10 minutes of the team's
 *  last message about a task ("应该转发…", "给我中文") belongs to that task's conversation, not to a new task. */
export function followUpTarget(text: string, events: { from: string; ts: string; ref?: string }[], now = Date.now()): string | undefined {
  const t = text.trim();
  if (!t || t.includes("\n") || [...t].length > 40) return undefined;
  const last = [...events].reverse().find((e) => e.from !== "owner" && /^T-\w+$/.test(e.ref ?? ""));
  return last && now - Date.parse(last.ts) <= 10 * 60_000 ? last.ref : undefined;
}

export function logBrain(m: BrainIn, out: BrainOut, receivedAt: number) {
  try {
    mkdirSync(HOME_DIR, { recursive: true });
    const sent = m.sentAt ? Date.parse(m.sentAt) : NaN;
    appendFileSync(join(HOME_DIR, "brain.jsonl"), JSON.stringify({
      at: new Date().toISOString(), text: m.text.slice(0, 120),
      // owner pressed send → daemon has it (the Worker→daemon hop), and → reply posted
      transport_ms: Number.isFinite(sent) ? receivedAt - sent : undefined,
      first_reply_ms: out.ms.first_reply, end_to_end_ms: Number.isFinite(sent) && out.ms.first_reply ? receivedAt - sent + out.ms.first_reply : undefined,
      model_ms: out.ms.model, total_ms: out.ms.total, rounds: out.rounds, fallback: out.fallback,
      calls: out.calls.map((c) => ({ tool: c.tool, ok: c.ok, ...(c.error ? { error: c.error } : {}) })),
    }) + "\n");
  } catch {}
}

/** `--setting-sources ""` also drops the `env` block of ~/.claude/settings.json, where an API gateway
 *  (ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY) is configured; without it the brain falls back to the OAuth login
 *  and fails with "Not logged in" while every task run works. Pass that env through explicitly. */
export function userSettingsEnv(path = `${process.env.CLAUDE_CONFIG_DIR ?? `${process.env.HOME}/.claude`}/settings.json`): Record<string, string> {
  try {
    const env = JSON.parse(readFileSync(path, "utf8"))?.env;
    if (!env || typeof env !== "object") return {};
    return Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  } catch { return {}; }
}
