// noop's tools, defined and implemented ONCE. Used by:
//   - the cloud MCP server (cloud/src/mcp.ts) over the Worker's mirror of the data repo (files table), and
//   - the chat brain on the primary daemon (src/brain.ts) over the local data repo (~/.agent-hub/data).
// A tool reads through a ToolStore; every write goes through ToolStore.act(op). The local store performs the op
// (git-synced data repo, running agents); the cloud store forwards it to the primary daemon over the existing
// owner→fleet inbox — so a write has exactly one implementation, on the machine that owns the data.
// Never exposed here: merge, release, settings, machine credentials (policies/autonomy.md hard gates).

export type Ev = { id: string; ts: string; from: string; kind: string; text: string; ref?: string; [k: string]: unknown };
export type FileRow = { path: string; text: string; updated: string };

/** A write. `tool` is the tool name; the rest are its validated arguments. */
export type WriteOp =
  | { tool: "send_message"; text: string; reply_to?: string }
  | { tool: "create_task"; title: string; details?: string; repo?: string; agent?: string; follows?: string; channels?: unknown[] }
  | { tool: "amend_task"; id: string; text: string }
  | { tool: "cancel_task"; id: string }
  | { tool: "set_priority"; id: string; priority: Priority }
  | { tool: "reassign_task"; id: string; agent: string }
  | { tool: "remember"; text: string; file: string }
  | { tool: "edit_memory"; file: string; match: string; text: string }
  | { tool: "answer_decision"; id: string; answer: string };

export interface ToolStore {
  /** One data-repo file (path relative to the data root), or null. */
  read(path: string): FileRow | null;
  /** Files directly or indirectly under `dir` ("tasks/active/"), newest path first. */
  list(dir: string): FileRow[];
  /** The fleet dashboard (same shape as GET /api/status). */
  status(): any;
  /** Feed events with seq > after, oldest first. */
  events(after: number, limit: number): { seq: number; ev: Ev }[];
  lastSeq(): number;
  /** Performs (local) or forwards (cloud) a write; returns what happened. */
  act(op: WriteOp): Promise<Record<string, unknown>>;
}

export const TASK_STATES = ["inbox", "active", "waiting", "blocked", "failed", "done"] as const;
export const TASK_ID = /^T-[\w-]*\d{4}$/, DECISION_ID = /^[DP]-[\w]*\d{4}$/;
export const PRIORITIES = ["urgent", "high", "normal", "low"] as const;
type Priority = (typeof PRIORITIES)[number];
/** Where `remember` and `edit_memory` may write: the shared memory files, or one agent's memory. */
export const MEMORY_FILE = /^(memory\/[\w.-]+\.md|agents\/[\w-]+\/memory\.md)$/;

/** Replaces the one memory entry containing `match` with `text` (empty: deletes it). An entry is a line plus its indented
 * continuation lines. The new file text and the entry it changed, or the problem when `match` does not pick exactly one. */
export function editMemoryEntry(file: string, match: string, text: string): { text: string; entry: string } | string {
  const lines = file.split("\n");
  const hits = lines.flatMap((l, i) => (l.includes(match) ? [i] : []));
  if (!hits.length) return `no line contains "${match}"`;
  if (hits.length > 1) return `"${match}" matches ${hits.length} lines, be more specific:\n${hits.slice(0, 5).map((i) => lines[i]).join("\n")}`;
  const at = hits[0];
  let end = at + 1;
  while (end < lines.length && /^\s+\S/.test(lines[end])) end++;
  const entry = lines.slice(at, end).join("\n");
  return { text: [...lines.slice(0, at), ...(text ? [text] : []), ...lines.slice(end)].join("\n"), entry };
}

// ---------------------------------------------------------------- data views

/** `---\nk: v\n---\nbody` → {meta, body}. */
export function parseDoc(text: string): { meta: Record<string, string>; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) { const i = line.indexOf(":"); if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return { meta, body: m[2] };
}

export type TaskRow = { id: string; title: string; state: string; agent?: string; host?: string; priority?: string; repo?: string; created?: string; updated?: string };
const taskRow = (path: string, text: string, updated: string): TaskRow => {
  const { meta } = parseDoc(text);
  return { id: meta.id || path.split("/").pop()!.replace(/\.md$/, ""), title: meta.title ?? "", state: path.split("/")[1],
    agent: meta.agent, host: meta.claimed_by || meta.host, priority: meta.priority, repo: meta.repo, created: meta.created, updated };
};
export function listTasks(st: ToolStore, state = "open", query = "", limit = 50, offset = 0): TaskRow[] {
  const states = state === "all" ? TASK_STATES : state === "open" ? TASK_STATES.filter((s) => s !== "done" && s !== "failed") : [state];
  const q = query.toLowerCase();
  return states.flatMap((s) => st.list(`tasks/${s}/`).filter((f) => /^tasks\/[^/]+\/T-[^/]*\.md$/.test(f.path)).map((f) => taskRow(f.path, f.text, f.updated)))
    .filter((t) => !q || `${t.id} ${t.title} ${t.repo ?? ""} ${t.agent ?? ""}`.toLowerCase().includes(q))
    .sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? "")).slice(Math.max(0, offset), Math.max(0, offset) + Math.max(1, Math.min(limit, 200)));
}
export function parseTaskBody(title: string | undefined, body: string) {
  // the owner's words (a quote) or the task's own first paragraph; daemon notes ("Requeued after ...") are not the request
  // (new requeues keep their note in meta.requeue_note; older bodies still carry "> Requeued ..." / "> Attempt N failed" quotes)
  const NOTE = /^>?\s*(Requeued|Retried|Resumed|Attempt \d+ failed)\b/i;
  const own = body.split("\n## ")[0].split(/\n\n+/).filter((p) => !NOTE.test(p.trim()));
  const quote = own.join("\n\n").match(/(^|\n)> [\s\S]*?(?=\n\n[^>]|$)/)?.[0];
  const request = (quote ?? (own.join("\n\n") || title || "")).replace(/^> ?/gm, "").trim().slice(0, 1200);
  const runs = [...body.matchAll(/## Run (\S+) · (\S+) · (\S+)\n\*\*(\w+)\*\* — ([^\n]*)/g)]
    .map((r) => ({ ts: r[1], host: r[2], cli: r[3], status: r[4], summary: r[5] })).slice(-5);
  return { request, runs };
}

/** A task as the app shows it. Cancelled tasks live in rejected/, next to routine copies nobody approved. */
const HISTORY_STATES = [...TASK_STATES, "rejected"] as const;
const historyRow = (f: FileRow, folder: string) => {
  const { meta: m } = parseDoc(f.text);
  const state = folder === "waiting" && m.wake_at ? "parked" : folder === "inbox" && m.parked && m.requires ? "nohost" : folder === "rejected" ? "cancelled" : folder;
  return { id: m.id || f.path.split("/").pop()!.replace(/\.md$/, ""), title: m.title ?? "", agent: m.agent, host: m.claimed_by, state, needs: state === "nohost" ? m.requires : undefined,
    started: m.started, created: m.created, finished: m.finished ?? m.cancelled, updated: m.finished ?? m.cancelled ?? m.started ?? m.created ?? f.updated, attempt: m.attempt, cli: m.cli_used, model: m.model };
};

/** Every task the fleet has, newest first, a page at a time. */
export function taskHistory(st: ToolStore, opts: { query?: string; offset?: number; limit?: number } = {}) {
  const q = (opts.query ?? "").trim().toLowerCase();
  const seen = new Set<string>();
  const all = HISTORY_STATES.flatMap((s) => st.list(`tasks/${s}/`)
    .filter((f) => /^tasks\/[^/]+\/T-[^/]*\.md$/.test(f.path) && (s !== "rejected" || /^cancelled:/m.test(f.text)))
    .map((f) => historyRow(f, s)))
    .filter((t) => !seen.has(t.id) && !!seen.add(t.id)) // a task copied in two folders mid-sync shows once
    .filter((t) => !q || `${t.id} ${t.title} ${t.agent ?? ""}`.toLowerCase().includes(q))
    .sort((a, b) => String(b.updated ?? "").localeCompare(String(a.updated ?? "")));
  const offset = Math.max(0, Number(opts.offset) || 0), limit = Math.max(1, Math.min(Number(opts.limit) || 50, 200));
  return { tasks: all.slice(offset, offset + limit), total: all.length };
}

/** One task for the app's task page, wherever it is. */
export function taskInfo(st: ToolStore, id: string) {
  for (const s of HISTORY_STATES) {
    const f = st.read(`tasks/${s}/${id}.md`);
    if (!f) continue;
    // the cards it asked: they belong to its conversation
    const decisions = ["open", "closed"].flatMap((w) => st.list(`decisions/${w}/`)).map((d) => parseDoc(d.text).meta).filter((m) => m.task === id && m.id).map((m) => String(m.id));
    return { ...historyRow(f, s), ...parseTaskBody(parseDoc(f.text).meta.title, parseDoc(f.text).body), decisions };
  }
  return null;
}

export function getTask(st: ToolStore, id: string) {
  for (const s of TASK_STATES) {
    const f = st.read(`tasks/${s}/${id}.md`);
    if (f) { const { meta, body } = parseDoc(f.text); return { ...taskRow(`tasks/${s}/${id}.md`, f.text, f.updated), meta, body: body.slice(0, 20_000) }; }
  }
  return null;
}
const options = (s?: string) => (s ?? "").split(" | ").map((x) => x.trim()).filter(Boolean);
export function listDecisions(st: ToolStore, which: "open" | "closed" = "open", limit = 30) {
  return st.list(`decisions/${which}/`).filter((f) => f.path.endsWith(".md")).slice(0, limit).map((f) => {
    const { meta, body } = parseDoc(f.text);
    return { id: meta.id, question: meta.question, options: options(meta.options), recommendation: meta.recommendation, task: meta.task,
      agent: meta.agent, created: meta.created, answer: meta.answer, context: body.match(/## Context\n([\s\S]*?)(\n## |$)/)?.[1]?.trim().slice(0, 4000) };
  });
}
/** The roster: every agent's one-line purpose (first line of agents/<name>/profile.md) and how much memory it keeps. */
export function listAgents(st: ToolStore) {
  const files = st.list("agents/");
  const names = [...new Set(files.map((f) => f.path.split("/")[1]).filter(Boolean))].sort();
  return names.map((name) => {
    const prof = files.find((f) => f.path === `agents/${name}/profile.md`)?.text ?? "";
    const mem = files.find((f) => f.path === `agents/${name}/memory.md`)?.text ?? "";
    return { name, about: prof.split("\n").find((l) => l.trim())?.replace(/^#\s*/, "").slice(0, 200) ?? "", memory_lines: mem.split("\n").filter((l) => l.trim()).length };
  });
}
/** Routines from config.toml ([[routine]] blocks): name, schedule, agent, enabled, and the first line of the prompt. */
export function listRoutines(st: ToolStore) {
  const toml = st.read("config.toml")?.text ?? "";
  // changes made from the UI live in settings.json and win over config.toml, as they do for the scheduler (loadConfig)
  let ui: Record<string, { enabled?: boolean; every?: string }> = {};
  try { ui = JSON.parse(st.read("settings.json")?.text ?? "{}").routines ?? {}; } catch {}
  return toml.split(/^\[\[routine\]\]\s*$/m).slice(1).map((b) => {
    const block = b.split(/^\[/m)[0];
    const v = (k: string) => block.match(new RegExp(`^${k}\\s*=\\s*"""([\\s\\S]*?)"""|^${k}\\s*=\\s*"([^"]*)"|^${k}\\s*=\\s*(\\w+)`, "m"));
    const g = (k: string) => { const m = v(k); return m ? (m[1] ?? m[2] ?? m[3]) : undefined; };
    const change = ui[g("name") ?? ""] ?? {};
    return { name: g("name"), every: change.every ?? g("every"), at: g("at"), agent: g("agent"), enabled: change.enabled ?? g("enabled") !== "false", about: (g("desc") ?? g("prompt") ?? "").split("\n")[0].slice(0, 200) };
  }).filter((r) => r.name);
}
/** Lines of the journal (journal/YYYY-MM-DD.md) that contain every word of the query, newest day first. */
export function searchJournal(st: ToolStore, query: string, days = 14, limit = 40) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const out: { day: string; line: string }[] = [];
  for (const f of st.list("journal/").filter((f) => /^journal\/\d{4}-\d{2}-\d{2}\.md$/.test(f.path)).sort((a, b) => b.path.localeCompare(a.path)).slice(0, days)) {
    for (const line of f.text.split("\n").reverse()) {
      const l = line.toLowerCase();
      if (line.trim() && words.every((w) => l.includes(w))) out.push({ day: f.path.slice(8, 18), line: line.slice(0, 400) });
      if (out.length >= limit) return out;
    }
  }
  return out;
}
/** Memory: one file in full, or the index of memory files (shared memory/*.md and agents/<name>/memory.md). */
export function readMemory(st: ToolStore, file?: string, query?: string) {
  if (file) {
    if (!MEMORY_FILE.test(file) && !/^agents\/[\w-]+\/profile\.md$/.test(file) && !/^policies\/[\w.-]+\.md$/.test(file)) return null;
    const f = st.read(file);
    if (!f) return null;
    const q = (query ?? "").toLowerCase();
    return { file, updated: f.updated, text: q ? f.text.split("\n").filter((l) => l.toLowerCase().includes(q)).join("\n").slice(0, 20_000) : f.text.slice(0, 20_000) };
  }
  const files = [...st.list("memory/"), ...st.list("agents/").filter((f) => f.path.endsWith("/memory.md"))].filter((f) => MEMORY_FILE.test(f.path));
  const q = (query ?? "").toLowerCase();
  return { files: files.map((f) => ({ file: f.path, updated: f.updated, lines: f.text.split("\n").length,
    ...(q ? { matches: f.text.split("\n").filter((l) => l.toLowerCase().includes(q)).slice(0, 10) } : {}) }))
    .filter((f) => !q || (f.matches?.length ?? 0) > 0) };
}

/** Fleet status trimmed to what a reader needs. */
export function statusView(st: ToolStore) {
  const s = st.status() ?? {};
  return { hub: s.hub, tasks: s.tasks, decisions: s.decisions,
    hosts: (s.hosts ?? []).map((h: any) => ({ host: h.host, online: h.online, state: h.state, caps: h.caps, running: h.running ?? h.tasks })),
    active: (s.active ?? []).map((t: any) => ({ id: t.id, title: t.title, agent: t.agent, host: t.host, started: t.started, activity: t.activity })),
    open: (s.recent ?? []).filter((t: any) => ["inbox", "nohost", "waiting", "parked", "blocked"].includes(t.state)).map((t: any) => ({ id: t.id, title: t.title, state: t.state, agent: t.agent })) };
}
export function feedView(st: ToolStore, cursor: number | undefined, limit: number) {
  const n = Math.max(1, Math.min(limit || 50, 300));
  const after = cursor === undefined ? st.lastSeq() - n : cursor;
  const rows = st.events(Math.max(0, after), n);
  return { cursor: rows.length ? rows[rows.length - 1].seq : Math.max(cursor ?? 0, st.lastSeq()), events: rows.map((r) => r.ev) };
}

// ---------------------------------------------------------------- tool list
export type Tool = {
  name: string; title: string; description: string; inputSchema: any; annotations: Record<string, boolean>;
  write?: boolean;
  /** Where it is offered: both (default), only the MCP server (needs a live connection), or only the chat brain. */
  only?: "mcp" | "brain";
};
const RO = { readOnlyHint: true, openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const RW_IDEM = { ...RW, idempotentHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
const str = (description: string, extra: object = {}) => ({ type: "string", description, ...extra });
const int = (description: string, extra: object = {}) => ({ type: "integer", description, ...extra });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });

export const TOOLS: Tool[] = [
  // ---- read
  { name: "get_status", title: "Fleet status", annotations: RO, inputSchema: obj({}),
    description: "Current state of the Noop fleet: online machines, running tasks with their latest activity, task counts per state, and decisions waiting for the owner." },
  { name: "list_tasks", title: "List tasks", annotations: RO,
    inputSchema: obj({ state: str("Which tasks: open (default: queued, running, waiting, blocked), all, or one state", { enum: ["open", "all", ...TASK_STATES] }),
      query: str("Case-insensitive filter on id, title, repo, agent"), limit: int("Max rows (default 50, max 200)", { minimum: 1, maximum: 200 }),
      offset: int("Rows to skip, to read further pages", { minimum: 0 }) }),
    description: "List the fleet's tasks (id, title, state, agent, host, repo), newest first." },
  { name: "get_task", title: "Get task", annotations: RO, inputSchema: obj({ id: str("Task id, e.g. T-0184") }, ["id"]),
    description: "One task in full: its metadata, its description/result notes, and the recent feed events about it." },
  { name: "list_decisions", title: "Open decisions", annotations: RO,
    inputSchema: obj({ which: str("open (default) or closed", { enum: ["open", "closed"] }), limit: int("Max rows (default 30)", { minimum: 1, maximum: 100 }) }),
    description: "Decision cards waiting for the owner (question, options, recommendation, context). Answer one with answer_decision." },
  { name: "get_feed", title: "Read the feed", annotations: RO,
    inputSchema: obj({ cursor: int("Return events after this cursor (from a previous call); omit for the latest ones"), limit: int("Max events (default 50, max 300)", { minimum: 1, maximum: 300 }) }),
    description: "The chat/activity feed the owner sees in the Noop app: agent reports, decisions, owner messages, system notices. Returns {cursor, events}; pass cursor back to get only newer events." },
  { name: "wait_for_events", title: "Wait for new events", annotations: RO, only: "mcp",
    inputSchema: obj({ cursor: int("Cursor from get_feed / a previous wait"), timeout_seconds: int("How long to wait (default 30, max 50)", { minimum: 1, maximum: 50 }) }, ["cursor"]),
    description: "Blocks until the fleet emits new events after `cursor` (or the timeout passes) and returns them. For clients that do not receive MCP notifications." },
  { name: "list_agents", title: "List agents", annotations: RO, inputSchema: obj({}),
    description: "The agent roster: each agent's name, what it is for, and how much memory it keeps. Use the names with create_task/reassign_task." },
  { name: "list_routines", title: "List routines", annotations: RO, inputSchema: obj({}),
    description: "The fleet's recurring routines (name, schedule, agent, enabled, what it does)." },
  { name: "read_memory", title: "Read memory", annotations: RO,
    inputSchema: obj({ file: str("Optional: memory/<name>.md, agents/<name>/memory.md, agents/<name>/profile.md or policies/<name>.md; omit to list memory files"),
      query: str("Optional: only lines containing this text (case-insensitive)") }),
    description: "The fleet's durable memory: the owner's preferences, principles, taste, projects (memory/*.md) and each agent's own memory. Without `file`, lists the files (with matching lines when `query` is given)." },
  { name: "search_journal", title: "Search the journal", annotations: RO,
    inputSchema: obj({ query: str("Words that must all appear in the line"), days: int("How many recent days (default 14, max 60)", { minimum: 1, maximum: 60 }) }, ["query"]),
    description: "Search the fleet's daily journal (what every machine did: tasks started/finished, decisions, deploys), newest first." },
  { name: "search", title: "Search", annotations: RO, inputSchema: obj({ query: str("What to look for") }, ["query"]),
    description: "Search Noop tasks and decisions. Returns {results:[{id, title, url}]}; use fetch with an id for the full text." },
  { name: "fetch", title: "Fetch", annotations: RO, inputSchema: obj({ id: str("An id from search: a task (T-…) or decision (D-…)") }, ["id"]),
    description: "Full text of a task or decision found by search. Returns {id, title, text, url, metadata}." },
  // ---- write
  { name: "send_message", title: "Message the fleet", annotations: RW, write: true, only: "mcp",
    inputSchema: obj({ text: str("The message, as the owner would type it in chat"), reply_to: str("Optional: task id (T-…) or event id this replies to") }, ["text"]),
    description: "Send a chat message to the fleet as the owner (same as typing in the Noop app). The chat brain answers it and acts on it." },
  { name: "create_task", title: "Create a task", annotations: RW, write: true,
    inputSchema: obj({ title: str("Short imperative title"), details: str("Goal, context and acceptance criteria — everything the agent needs, in the owner's words"),
      repo: str("Optional repo, e.g. longbridge/nsh"), agent: str("Optional agent name from list_agents (default: lead, who plans and delegates)"),
      channels: { type: "array", description: "Work topics matched by goal: existing slugs, or {name, goal} for a new channel; empty for none", items: { anyOf: [{ type: "string" }, { type: "object", properties: { name: { type: "string" }, goal: { type: "string" } }, required: ["name", "goal"], additionalProperties: false }] }, maxItems: 3 },
      follows: str("Optional: the task (T-…) this continues or corrects; the new task reads its result") }, ["title"]),
    description: "Hand a piece of work to the fleet. An agent picks it up, does it and reports back in the feed. Use for anything that takes more than a quick answer (code, reviews, releases, research)." },
  { name: "amend_task", title: "Add to a task", annotations: RW, write: true,
    inputSchema: obj({ id: str("A task, open or finished, e.g. T-0184"), text: str("What to add or change, in the owner's words") }, ["id", "text"]),
    description: "Add the owner's follow-up to a task: an extra requirement, a correction, more context. The running agent gets it; a waiting task is woken; a finished task reopens under the same id; a task waiting on a decision card takes it as the answer." },
  { name: "cancel_task", title: "Cancel a task", annotations: DESTRUCTIVE, write: true,
    inputSchema: obj({ id: str("Task id, e.g. T-0184") }, ["id"]),
    description: "Cancel a task (queued, waiting, blocked or running; its sub-tasks too). Only when the owner clearly asks to stop or drop it." },
  { name: "set_priority", title: "Reprioritise a task", annotations: RW_IDEM, write: true,
    inputSchema: obj({ id: str("Task id"), priority: str("New priority", { enum: [...PRIORITIES] }) }, ["id", "priority"]),
    description: "Change an open task's priority (urgent, high, normal, low); the scheduler picks higher priority first." },
  { name: "reassign_task", title: "Reassign a task", annotations: RW_IDEM, write: true,
    inputSchema: obj({ id: str("A queued, waiting or blocked task"), agent: str("Agent name from list_agents") }, ["id", "agent"]),
    description: "Give a task that has not started yet (or is parked) to a different agent." },
  { name: "remember", title: "Remember", annotations: RW, write: true,
    inputSchema: obj({ text: str("The rule or fact, one or two sentences, phrased so it is useful later (who/what it applies to, and why)"),
      file: str("memory/owner.md (who the owner is), memory/principles.md (how to work), memory/taste.md (UI/code taste), memory/projects.md, or agents/<name>/memory.md for one agent's know-how") }, ["text", "file"]),
    description: "Write a durable memory the whole fleet reads from now on: the owner's preference, a rule ('以后都这样'), a fact about a project." },
  { name: "edit_memory", title: "Edit or delete a memory", annotations: DESTRUCTIVE, write: true,
    inputSchema: obj({ file: str("The memory file, as listed by read_memory"),
      match: str("Text copied from the entry, enough to pick exactly one line (find it with read_memory first)"),
      text: str("The whole corrected entry, replacing the old one. Omit to delete the entry") }, ["file", "match"]),
    description: "Correct or delete one existing memory entry, when the owner says it is wrong, outdated or should go. New facts go in remember." },
  { name: "answer_decision", title: "Answer a decision", annotations: RW, write: true,
    inputSchema: obj({ id: str("Decision id, e.g. D-0025"), answer: str("An option letter (A, B, …) or a free-text answer") }, ["id", "answer"]),
    description: "Answer a decision card (or change the answer the owner gave minutes ago), exactly like tapping an option in the Noop app." },
];

export const toolsFor = (where: "mcp" | "brain") => TOOLS.filter((t) => !t.only || t.only === where);
export const isWrite = (name: string) => !!TOOLS.find((t) => t.name === name)?.write;

// ---------------------------------------------------------------- run
export type ToolResult = { ok: true; data: any } | { ok: false; error: string };
const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Validates a write's arguments; the op, or the problem. */
export function writeOp(name: string, a: any, st: ToolStore): WriteOp | string {
  a ??= {};
  const open = (id: string, dirs = ["inbox", "active", "waiting", "blocked"]) => dirs.some((d) => st.read(`tasks/${d}/${id}.md`));
  switch (name) {
    case "send_message": return s(a.text) ? { tool: name, text: s(a.text).slice(0, 20_000), ...(s(a.reply_to) ? { reply_to: s(a.reply_to) } : {}) } : "text required";
    case "create_task": {
      if (!s(a.title)) return "title required";
      const agent = s(a.agent);
      if (agent && !st.read(`agents/${agent}/profile.md`)) return `unknown agent ${agent} (see list_agents)`;
      return { tool: name, title: s(a.title).slice(0, 120), details: s(a.details).slice(0, 20_000) || undefined, repo: s(a.repo) || undefined,
        agent: agent || undefined, follows: TASK_ID.test(s(a.follows)) ? s(a.follows) : undefined, ...(Array.isArray(a.channels) ? { channels: a.channels.slice(0, 3) } : {}) };
    }
    case "amend_task": {
      const id = s(a.id);
      if (!TASK_ID.test(id) || !s(a.text)) return "id (T-…) and text required";
      if (!open(id, ["inbox", "active", "waiting", "blocked", "done", "failed"])) return `${id} cannot be continued (unknown or cancelled); create a task instead`;
      return { tool: name, id, text: s(a.text).slice(0, 20_000) };
    }
    case "cancel_task": {
      const id = s(a.id);
      if (!TASK_ID.test(id)) return "id (T-…) required";
      if (!open(id, ["inbox", "active", "waiting", "blocked", "proposed"])) return `${id} is not open`;
      return { tool: name, id };
    }
    case "set_priority": {
      const id = s(a.id), priority = s(a.priority) as Priority;
      if (!TASK_ID.test(id) || !PRIORITIES.includes(priority)) return `id and priority (${PRIORITIES.join("|")}) required`;
      if (!open(id)) return `${id} is not open`;
      return { tool: name, id, priority };
    }
    case "reassign_task": {
      const id = s(a.id), agent = s(a.agent);
      if (!TASK_ID.test(id) || !agent) return "id and agent required";
      if (!st.read(`agents/${agent}/profile.md`)) return `unknown agent ${agent} (see list_agents)`;
      if (!open(id, ["inbox", "waiting", "blocked"])) return `${id} is not queued, waiting or blocked (a running task keeps its agent; amend it instead)`;
      return { tool: name, id, agent };
    }
    case "remember": {
      const text = s(a.text), file = s(a.file);
      if (!text) return "text required";
      if (!MEMORY_FILE.test(file)) return "file must be memory/<name>.md or agents/<name>/memory.md";
      if (file.startsWith("agents/") && !st.read(`agents/${file.split("/")[1]}/profile.md`)) return `unknown agent in ${file}`;
      return { tool: name, text: text.slice(0, 2000), file };
    }
    case "edit_memory": {
      const file = s(a.file), match = s(a.match), text = s(a.text).replace(/\s*\n\s*/g, " ").slice(0, 2000);
      if (!match) return "match required";
      if (!MEMORY_FILE.test(file)) return "file must be memory/<name>.md or agents/<name>/memory.md";
      const row = st.read(file);
      if (!row) return `${file} not found`;
      const edit = editMemoryEntry(row.text, match, text);
      return typeof edit === "string" ? edit : { tool: name, file, match, text };
    }
    case "answer_decision": {
      const id = s(a.id), answer = s(a.answer);
      if (!DECISION_ID.test(id) || !answer) return "id (D-…) and answer required";
      if (!st.read(`decisions/open/${id}.md`) && !st.read(`decisions/closed/${id}.md`)) return `decision ${id} not found`;
      return { tool: name, id, answer: answer.slice(0, 5000) };
    }
  }
  return `unknown tool: ${name}`;
}

/** Runs one tool (everything but the transport-bound wait_for_events). `base`: the hub's public URL, for links. */
export async function runTool(st: ToolStore, name: string, a: any, base = ""): Promise<ToolResult> {
  a ??= {};
  const ok = (data: any): ToolResult => ({ ok: true, data });
  const bad = (error: string): ToolResult => ({ ok: false, error });
  if (isWrite(name)) {
    const op = writeOp(name, a, st);
    if (typeof op === "string") return bad(op);
    try { return ok(await st.act(op)); } catch (e) { return bad(`${name} failed: ${e instanceof Error ? e.message : e}`); }
  }
  switch (name) {
    case "get_status": return ok(statusView(st));
    case "list_tasks": return ok({ tasks: listTasks(st, s(a.state) || "open", s(a.query), Number(a.limit) || 50, Number(a.offset) || 0) });
    case "get_task": {
      const id = s(a.id);
      const t = TASK_ID.test(id) ? getTask(st, id) : null;
      if (!t) return bad(`task ${id} not found`);
      const events = st.events(Math.max(0, st.lastSeq() - 2000), 2000).map((r) => r.ev)
        .filter((e) => e.ref === id || String(e.text ?? "").includes(id)).slice(-20);
      return ok({ ...t, events });
    }
    case "list_decisions": return ok({ decisions: listDecisions(st, a.which === "closed" ? "closed" : "open", Number(a.limit) || 30) });
    case "get_feed": return ok(feedView(st, a.cursor === undefined || a.cursor === null ? undefined : Number(a.cursor), Number(a.limit) || 50));
    case "list_agents": return ok({ agents: listAgents(st) });
    case "list_routines": return ok({ routines: listRoutines(st) });
    case "read_memory": {
      const r = readMemory(st, s(a.file) || undefined, s(a.query) || undefined);
      return r ? ok(r) : bad(`${s(a.file)} not found or not readable`);
    }
    case "search_journal": {
      const q = s(a.query);
      if (!q) return bad("query required");
      return ok({ lines: searchJournal(st, q, Math.max(1, Math.min(Number(a.days) || 14, 60))) });
    }
    case "search": {
      const q = s(a.query);
      const tasks = listTasks(st, "all", q, 20).map((t) => ({ id: t.id, title: `${t.id} ${t.title} (${t.state})`, url: `${base}/?ref=${t.id}` }));
      const ql = q.toLowerCase();
      const decisions = [...listDecisions(st, "open", 100), ...listDecisions(st, "closed", 100)]
        .filter((d) => d.id && (!ql || `${d.id} ${d.question} ${d.context ?? ""}`.toLowerCase().includes(ql)))
        .slice(0, 10).map((d) => ({ id: d.id, title: `${d.id} ${d.question}`, url: `${base}/?ref=${d.id}` }));
      return ok({ results: [...decisions, ...tasks] });
    }
    case "fetch": {
      const id = s(a.id);
      if (TASK_ID.test(id)) {
        const t = getTask(st, id);
        if (t) return ok({ id, title: `${id} ${t.title}`, text: t.body, url: `${base}/?ref=${id}`, metadata: { ...t.meta, state: t.state } });
      }
      if (DECISION_ID.test(id)) for (const w of ["open", "closed"] as const) {
        const f = st.read(`decisions/${w}/${id}.md`);
        if (f) { const { meta, body } = parseDoc(f.text); return ok({ id, title: `${id} ${meta.question ?? ""}`, text: body, url: `${base}/?ref=${id}`, metadata: { ...meta, state: w } }); }
      }
      return bad(`${id} not found`);
    }
  }
  return bad(`unknown tool: ${name}`);
}

// ---------------------------------------------------------------- channels
// A channel is a work topic the AI opens (like a Slack channel in a company): "NSH i18n", "Omamail". Stored as
// channels/<slug>.md (name, goal, status, created); tasks carry `channels: a,b`. Read-only drill-down views of the main chat.
export type ChannelRow = { slug: string; name: string; goal: string; status: "active" | "archived"; created: string };
export type ChannelItem = { id: string; kind: "task" | "decision" | "report"; title: string; state: string; updated: string; task?: string };
export const CHANNEL_SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const STALE_DAYS = 7;

export function slugify(name: string): string {
  const ascii = name.toLowerCase().normalize("NFKD").replace(/[^\x00-\x7f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "");
  if (ascii) return ascii;
  let h = 0; for (const c of name) h = (h * 31 + c.codePointAt(0)!) >>> 0; // all CJK: a stable short id
  return `ch-${h.toString(36)}`;
}

export const taskChannels = (meta: Record<string, string>) => (meta.channels ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export function parseChannel(path: string, text: string): ChannelRow | null {
  const slug = path.split("/").pop()!.replace(/\.md$/, "");
  if (!CHANNEL_SLUG.test(slug)) return null;
  const { meta, body } = parseDoc(text);
  return { slug, name: meta.name || slug, goal: (meta.goal ?? body).trim(), status: meta.status === "archived" ? "archived" : "active", created: meta.created ?? "" };
}

export function listChannelRows(st: ToolStore): ChannelRow[] {
  return st.list("channels/").filter((f) => /^channels\/[^/]+\.md$/.test(f.path)).map((f) => parseChannel(f.path, f.text)).filter((c): c is ChannelRow => !!c)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Every channel with its items (tasks + the cards they asked), newest first; `stale` = no activity for STALE_DAYS. */
export function channelsView(st: ToolStore, nowMs = Date.now(), limit = 100) {
  const chans = listChannelRows(st);
  const items = new Map<string, ChannelItem[]>(chans.map((c) => [c.slug, []]));
  const taskOf = new Map<string, string[]>(); const seen = new Set<string>();
  const reportExists = new Map<string, boolean>();
  for (const s of HISTORY_STATES) for (const f of st.list(`tasks/${s}/`)) {
    if (!/^tasks\/[^/]+\/T-[^/]*\.md$/.test(f.path)) continue;
    const { meta, body } = parseDoc(f.text);
    const cs = taskChannels(meta).filter((c) => items.has(c));
    const id = meta.id || f.path.split("/").pop()!.replace(/\.md$/, "");
    if (!cs.length || seen.has(id)) continue;
    seen.add(id); taskOf.set(id, cs);
    const row = historyRow(f, s);
    for (const c of cs) {
      items.get(c)!.push({ id, kind: "task", title: row.title, state: s, updated: String(row.updated ?? "") });
      for (const path of new Set([...body.matchAll(/\breports\/[\w./-]+\.md\b/g)].map((m) => m[0]))) {
        if (path.split("/").some((s) => s === "..")) continue;
        if (!reportExists.has(path)) reportExists.set(path, !!st.read(path));
        if (!reportExists.get(path)) continue;
        if (!items.get(c)!.some((i) => i.id === path)) items.get(c)!.push({ id: path, kind: "report", title: path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, ""), state: "done", updated: String(row.updated ?? ""), task: id });
      }
    }
  }
  for (const w of ["open", "closed"]) for (const d of st.list(`decisions/${w}/`)) {
    const { meta } = parseDoc(d.text);
    const cs = meta.task ? taskOf.get(meta.task) : undefined;
    if (!cs || !meta.id) continue;
    for (const c of cs) items.get(c)!.push({ id: meta.id, kind: "decision", title: meta.question ?? meta.id, state: w, updated: meta.answered ?? meta.created ?? d.updated, task: meta.task });
  }
  return { channels: chans.map((c) => {
    const list = items.get(c.slug)!.sort((a, b) => b.updated.localeCompare(a.updated));
    const last = list[0]?.updated ?? c.created;
    const stale = !last || nowMs - Date.parse(last) > STALE_DAYS * 86_400_000;
    return { ...c, last_activity: last, stale, count: list.length, refs: list.filter((i) => i.kind !== "report").map((i) => i.id), items: list.slice(0, limit) };
  }) };
}
