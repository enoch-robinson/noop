// noop core — shared files as the world (stigmergy; synced via the owner's Worker, src/sync.ts), task queue, agent runner, journal, memory.
import { OFFLINE_AFTER_MINUTES } from "../cloud/src/budget";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import * as sync from "./sync";
import { CLIS } from "./clis";
import { BUILTIN_ROUTINES } from "./builtin-routines";

/** Framework code (this repo, self-updating). */
export const CODE = resolve(import.meta.dir, "..");
/** Machine-local home: $NOOP_HOME, else ~/.noop if it exists, else ~/.noop (older installs) if it exists, else ~/.noop. */
export function homeDir(): string {
  if (process.env.NOOP_HOME) return resolve(process.env.NOOP_HOME.replace(/^~/, homedir()));
  for (const d of [".noop", ".agent-hub"]) if (existsSync(join(homedir(), d))) return join(homedir(), d);
  return join(homedir(), ".noop");
}
export const HOME_DIR = homeDir();
/** Fleet state: local mirror of the files shared by all machines through the owner's Worker (tasks, journal, decisions, agents, memory, config). */
export const DATA = resolve((process.env.HUB_DATA || join(HOME_DIR, "data")).replace(/^~/, homedir()));
export const ROOT = DATA;
export const P = (...p: string[]) => join(DATA, ...p);
// sync state (noop.toml, sync.json) lives in HOME_DIR; a custom HUB_DATA (tests, extra mirrors) keeps its own next to it
sync.setSyncData(DATA, process.env.HUB_DATA && !process.env.NOOP_HOME ? dirname(DATA) : HOME_DIR);

// ------------------------------------------------------------------ config
export type Cfg = Record<string, any>;

function merge(a: any, b: any): any {
  const out = { ...a };
  for (const [k, v] of Object.entries(b ?? {}))
    out[k] = v && typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object" ? merge(out[k], v) : v;
  return out;
}

export function loadConfig(): Cfg {
  const read = (f: string) => (existsSync(P(f)) ? Bun.TOML.parse(readFileSync(P(f), "utf8")) : {});
  // noop.toml = machine-local bootstrap (Worker url + machine token), outside DATA because DATA itself comes from the Worker
  // settings.json = changes made from the UI (shared via the data repo), applied over config.toml; config.local.toml wins last
  const ui = existsSync(P("settings.json")) ? JSON.parse(readFileSync(P("settings.json"), "utf8")) : {};
  const cfg: Cfg = merge(merge(merge(sync.readHubToml(), read("config.toml")), ui), read("config.local.toml"));
  // built-in routines (src/builtin-routines.ts) unless config.toml defines one of the same name
  cfg.routine = Array.isArray(cfg.routine) ? cfg.routine : [];
  for (const b of BUILTIN_ROUTINES) if (!cfg.routine.some((r: any) => r.name === b.name)) {
    const r: Record<string, unknown> = { ...b, builtin: true };
    if (r.agent && !existsSync(P("agents", String(r.agent)))) r.agent = "lead"; // a fleet without that member
    cfg.routine.push(r);
  }
  // routine tweaks from the UI: { routines: { <name>: { enabled, every } } }
  for (const r of cfg.routine ?? []) Object.assign(r, ui.routines?.[r.name] ?? {});
  cfg.notify ??= {};
  // the owner's own Cloudflare hub (hub cloud deploy) is the fixed address for clients and workers
  if (cfg.cloud?.url) { cfg.server ??= {}; cfg.server.url ??= cfg.cloud.url; cfg.server.public_url ??= cfg.cloud.url; }
  // public hub URL published by the primary's tunnel (fleet/hub.json) → workers and push links use it unless pinned locally
  if (existsSync(P("fleet", "hub.json"))) try {
    const { url } = JSON.parse(readFileSync(P("fleet", "hub.json"), "utf8"));
    cfg.server ??= {};
    if (url && !cfg.server.url) cfg.server.url = url;
    if (url && !cfg.server.public_url) cfg.server.public_url = url;
  } catch {}
  const envMap: Record<string, string> = {
    slack_bot_token: "HUB_SLACK_BOT_TOKEN", slack_channel: "HUB_SLACK_CHANNEL", slack_webhook: "HUB_SLACK_WEBHOOK",
    discord_bot_token: "HUB_DISCORD_BOT_TOKEN", discord_channel: "HUB_DISCORD_CHANNEL", discord_webhook: "HUB_DISCORD_WEBHOOK",
  };
  for (const [k, env] of Object.entries(envMap)) if (process.env[env]) cfg.notify[k] = process.env[env];
  return cfg;
}

export const hostName = (cfg: Cfg): string =>
  process.env.HUB_HOST || cfg.host?.name || hostname().split(".")[0];

export const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
export const today = () => new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD local
export const hhmm = () => new Date().toLocaleTimeString("sv-SE").slice(0, 5);

/** Answer provenance for the decision metrics: "button:slack" → answered_via "button" + answered_channel "slack";
 *  every owner answer also records created→answered ms (old cards just lack the fields, and readers skip them). */
export const answeredMeta = (meta: Record<string, string>, via?: string) => ({
  ...(via ? { answered_via: via.split(":")[0], answered_channel: via.split(":")[1] ?? "" } : {}),
  answered_ms: String(Math.max(0, Date.now() - (Date.parse(meta.created) || Date.now()))),
});

// ------------------------------------------------------------------ data sync (src/sync.ts)
// All data mutations are serialized so parallel workers in one daemon never race on the mirror.
let chain: Promise<unknown> = Promise.resolve();
export function locked<T>(fn: () => Promise<T> | T): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

export const hasRemote = async () => (await sync.syncMode()) === "remote";

export const pull = (opts?: { force?: boolean }) => locked(() => _pull(opts));
/** Apply remote changes to DATA (remote wins on paths edited on both sides, except mergeable appends). */
export const _pull = (opts?: { force?: boolean }): Promise<boolean> => sync.pull(opts);

/** Commit every local change via the Worker's compare-and-swap; false if we lost a race (or are offline). */
export const commitPush = (msg: string, opts?: { force?: boolean }) => locked(() => _commitPush(msg, opts));
export const _commitPush = (msg: string, opts?: { force?: boolean }): Promise<boolean> => sync.commitPush(msg, opts);

/** Discard local edits and re-pull. */
export const resetToUpstream = () => sync.resetToUpstream();

// ------------------------------------------------------------------ markdown docs w/ front-matter
export type Doc = { meta: Record<string, string>; body: string };

export function readDoc(path: string): Doc {
  const text = readFileSync(path, "utf8");
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m[2] };
}

export function writeDoc(path: string, meta: Record<string, string | undefined>, body: string) {
  mkdirSync(dirname(path), { recursive: true });
  const head = Object.entries(meta).filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${String(v).replace(/\n/g, " ")}`).join("\n");
  writeFileSync(path, `---\n${head}\n---\n${body.trimEnd()}\n`);
}

export const list = (dir: string, re = /\.md$/) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => join(dir, f)) : [];

/** "…/decisions/open/D-0001.md" → "D-0001". Always use this (not split("/")): on Windows list() returns
 *  backslash paths, so splitting on "/" yields the whole path — that silently broke every chat reply to a card. */
export const fileId = (path: string) => (path.split(/[\\/]/).pop() ?? path).replace(/\.md$/, "");

/** Non-primary hosts mint IDs with a host letter (T-M0001) so two machines never create the same ID. */
let idTag = "";
export const setIdTag = (tag: string) => { idTag = tag; };

export function nextId(prefix: string, dir: string): string {
  let max = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      const m = e.name.match(new RegExp(`^${prefix}-${idTag}(\\d+)`));
      if (m) max = Math.max(max, +m[1]);
    }
  };
  if (existsSync(dir)) walk(dir);
  // the local mirror can lag other hosts: never hand out an id whose file already exists in any state folder
  const taken = (id: string) => existsSync(dir) && readdirSync(dir, { withFileTypes: true })
    .some((e) => e.isDirectory() ? existsSync(join(dir, e.name, `${id}.md`)) : e.name === `${id}.md`);
  let n = max + 1;
  while (taken(`${prefix}-${idTag}${String(n).padStart(4, "0")}`)) n++;
  return `${prefix}-${idTag}${String(n).padStart(4, "0")}`;
}

/**
 * Whether `host` is the fleet's primary (runs routines, the judge, the server, mints untagged ids). Named by
 * [fleet] primary; with none named, a host is the primary only while it is alone: once another host's heartbeat
 * is in the data, it is a worker, so a machine that joined before its config synced never takes over.
 */
export function isPrimary(cfg: Cfg, host = hostName(cfg)): boolean {
  if (cfg.fleet?.primary) return cfg.fleet.primary === host;
  return !list(P("fleet", "hosts"), /\.json$/).some((p) => basename(p, ".json") !== host);
}

/** Id tag for a host: "" on the primary, else [host].id_tag or the host name's first letter, upper-cased. */
export function idTagFor(cfg: Cfg, host: string): string {
  if (isPrimary(cfg, host)) return "";
  return String(cfg.host?.id_tag ?? (host.replace(/[^a-z]/gi, "").charAt(0) || "W")).toUpperCase();
}

// ------------------------------------------------------------------ tasks
export type TaskOpts = {
  agent?: string; cli?: string; host?: string; requires?: string; prefer?: string; weight?: string; repo?: string; priority?: string; source?: string;
  extra?: Record<string, string>;
};

/** Capabilities of this machine: os:<linux|macos|windows>, host:<name>, plus config [host].caps (e.g. gpu, docker, home). */
export function hostCaps(cfg: Cfg): string[] {
  const os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
  const clis = [...CLIS.map((a) => a.name), "gh", "cargo", "bun", "node"].filter((c) => Bun.which(c)).map((c) => `cli:${c}`);
  return [`os:${os}`, `host:${hostName(cfg)}`, `arch:${process.arch}`, ...clis, ...(cfg.host?.caps ?? [])];
}

/** One requirement; "a|b" means either cap will do (e.g. cli:bun|cli:node). */
export const capOk = (req: string, caps: string[]) => req.split("|").some((r) => caps.includes(r.trim()));

/** Toolchain a repo needs, read from its manifest files. Empty when the repo dir is not on this machine. */
export function repoRequires(repo?: string): string[] {
  if (!repo) return [];
  const dir = resolve(repo.replace(/^~/, homedir()));
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  if (existsSync(join(dir, "Cargo.toml"))) out.push("cli:cargo");
  if (existsSync(join(dir, "package.json"))) out.push("cli:bun|cli:node");
  return out;
}

/** A task matches if every comma-separated requirement is in the host's caps (plus what its local repo needs). */
export function matches(meta: Record<string, string>, caps: string[]): boolean {
  const reqs = [meta.requires, meta.host && meta.host !== "any" ? `host:${meta.host}` : "", ...repoRequires(meta.repo)]
    .join(",").split(",").map((s) => s.trim()).filter(Boolean);
  return reqs.every((r) => capOk(r, caps));
}

/** Hook set by the CLI so core stays free of policy imports. */
export let approvalGate: (source: string) => boolean = () => false;
export const setApprovalGate = (fn: (source: string) => boolean) => { approvalGate = fn; };

export function newTask(title: string, body = "", o: TaskOpts = {}): string {
  const id = nextId("T", P("tasks"));
  // work the owner asked for (directly or via a delegated parent) never needs re-approval
  const folder = o.extra?.origin !== "owner" && approvalGate(o.source ?? "owner") ? "proposed" : "inbox";
  writeDoc(P("tasks", folder, `${id}.md`), {
    id, title, agent: o.agent ?? "lead", cli: o.cli ?? "auto", host: o.host ?? "any",
    // stored at creation so hosts without the repo checked out still know what it needs
    requires: [...new Set([...(o.requires ?? "").split(","), ...repoRequires(o.repo)].map((x) => x.trim()).filter(Boolean))].join(","), prefer: o.prefer ?? "", weight: o.weight ?? "normal", repo: o.repo ?? "", priority: o.priority ?? "normal", source: o.source ?? "owner",
    created: now(), ...(o.extra ?? {}),
  }, body || title);
  return id;
}

export const which = (bin: string) => Bun.which(bin) !== null;

/** Which CLI runs a task: the owner's per-agent config wins, else what the planner (an AI call, see planInbox) chose.
 *  A pinned CLI that isn't installed here falls through to the rest of the pool instead of parking the task in a
 *  claim/requeue loop no host could satisfy (a planner that names claude/codex on a host without them used to queue
 *  tasks forever). Unplanned tasks may use any registered CLI, Claude first. */
export function allowedClis(meta: Record<string, string>, cfg: Cfg): string[] {
  const pinned = meta.cli && meta.cli !== "auto" ? [meta.cli] : [];
  const per = cfg.clis?.agents?.[meta.agent || "lead"] as string[] | undefined;
  const pool = per ?? CLIS.map((a) => a.name);
  return [...new Set([...pinned.filter(which), ...pool])];
}

export function chooseCli(meta: Record<string, string>, cfg: Cfg): string | null {
  return allowedClis(meta, cfg).find(which) ?? null;
}

// ------------------------------------------------------------------ fleet presence (heartbeats)
export type HostBeat = { host: string; caps: string[]; seen: string; busy: number; version: string; stats?: any;
  /** The noop code this host runs: its commit and that commit's page. */ rev?: string; rev_url?: string;
  /** How this host is doing with the owner's latest "update every machine". */ update?: UpdateState;
  /** Per running task: when its agent last showed a sign of life and what it was doing. */ activity?: Record<string, Activity> };

/** A running agent's latest sign of life: any output; for Claude also the step it took ("Bash · gh pr checks 814"). */
export type Activity = { at: string; step?: string; steps: number;
  /** The model actually answering (Claude reports it in its stream; Codex: the one it was started with). */ model?: string };
/** This process's running agents (written by runAgent, published in the heartbeat). */
export const agentActivity = new Map<string, Activity>();

/** One host's progress on an update request (`at` names the request), shown per machine in Settings › 版本. */
export type UpdateState = {
  at: string; ts: string;
  state: "updating" | "waiting" | "restarting" | "deploying" | "done" | "current" | "failed";
  detail?: string;
  /** The commit it ran when the update started (a restart onto another commit means it updated). */ from?: string;
};
const STARTED = Date.now();
const UPDATE_STATE = () => join(HOME_DIR, "update-state.json"); // machine-local: survives the restart it reports on
export function setUpdateState(u: Omit<UpdateState, "ts">) {
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(UPDATE_STATE(), JSON.stringify({ ...u, ts: now() }, null, 2));
}
/** This host's update progress; a restart that finished turns "restarting" into "done" (or "failed" on the same commit). */
export function updateState(): UpdateState | undefined {
  let u: UpdateState;
  try { u = JSON.parse(readFileSync(UPDATE_STATE(), "utf8")); } catch { return undefined; }
  // written by the process before this one: the restart it waited for has happened
  if ((u.state === "restarting" || u.state === "waiting") && Date.parse(u.ts) < STARTED) {
    const rev = runningRev().rev;
    if (rev && rev !== u.from) setUpdateState({ at: u.at, state: "done", detail: rev.slice(0, 7), from: u.from });
    else setUpdateState({ at: u.at, state: "failed", detail: "重启后仍是旧代码", from: u.from });
    return updateState();
  }
  return u;
}

/** The commit of the code this process runs (read once: an update restarts the daemon) and its GitHub page. */
let codeRev: { rev?: string; rev_url?: string } | undefined;
export function runningRev(): { rev?: string; rev_url?: string } {
  if (codeRev) return codeRev;
  const git = (...a: string[]) => { try { return Bun.spawnSync(["git", "-C", CODE, ...a], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim(); } catch { return ""; } };
  const rev = git("rev-parse", "HEAD") || undefined;
  const repo = git("remote", "get-url", "origin").match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(\.git)?$/)?.[1];
  return (codeRev = { rev, rev_url: rev && repo ? `https://github.com/${repo}/commit/${rev}` : undefined });
}

/** The owner's "update every machine" (fleet/update.json, synced): each host updates once per request. */
export const UPDATE_REQUEST = () => P("fleet", "update.json");

export function heartbeat(cfg: Cfg, busy: number, stats?: unknown) {
  const host = hostName(cfg);
  const f = P("fleet", "hosts", `${host}.json`);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify({ host, caps: hostCaps(cfg), seen: now(), busy, version: "1", stats, ...runningRev(), update: updateState(), activity: agentActivity.size ? Object.fromEntries(agentActivity) : undefined } satisfies HostBeat, null, 2));
}

export function onlineHosts(cfg: Cfg): HostBeat[] {
  // heartbeats go up lazily (LAZY_PUSH_MS), so a shorter window would flap machines offline
  const staleMs = Math.max(cfg.fleet?.offline_after_minutes ?? 0, OFFLINE_AFTER_MINUTES) * 60_000;
  return list(P("fleet", "hosts"), /\.json$/).map((p) => JSON.parse(readFileSync(p, "utf8")) as HostBeat)
    .filter((h) => Date.now() - Date.parse(h.seen) < staleMs);
}

const reqList = (s?: string) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

/** Should this host leave the task for a preferred, currently-online host? */
function yieldToPreferred(meta: Record<string, string>, caps: string[], cfg: Cfg): boolean {
  const prefer = reqList(meta.prefer);
  if (!prefer.length || prefer.every((r) => caps.includes(r))) return false;
  const waitMs = (cfg.fleet?.prefer_wait_minutes ?? 10) * 60_000;
  if (Date.now() - Date.parse(meta.created) > waitMs) return false; // waited long enough
  return onlineHosts(cfg).some((h) => h.host !== hostName(cfg) && prefer.every((r) => h.caps.includes(r)));
}

/** Heavy work goes to the least-loaded capable online host. */
function yieldHeavy(meta: Record<string, string>, cfg: Cfg, myLoad: number, heavyOk: boolean): boolean {
  if (meta.weight !== "heavy") return false;
  if (!heavyOk) return true;
  const me = hostName(cfg);
  return onlineHosts(cfg).some((h) => h.host !== me && matches(meta, h.caps) && h.stats
    && h.stats.loadRatio + 0.2 < myLoad && h.busy === 0);
}

export function pickTask(cfg: Cfg, myLoad = 0, heavyOk = true): string | null {
  const caps = hostCaps(cfg);
  const rank: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
  const cands = list(P("tasks", "inbox"), /^T-.*\.md$/)
    .map((p) => ({ p, m: readDoc(p).meta }))
    // the planner decides where a task runs first; unplanned tasks wait for it (at most plan_wait_minutes)
    .filter(({ m }) => (m.planned || Date.now() - Date.parse(m.created ?? "") > (cfg.fleet?.plan_wait_minutes ?? 3) * 60_000) && matches(m, caps) && chooseCli(m, cfg) && !yieldToPreferred(m, caps, cfg) && !yieldHeavy(m, cfg, myLoad, heavyOk))
    .sort((a, b) => (rank[a.m.priority] ?? 2) - (rank[b.m.priority] ?? 2) || a.p.localeCompare(b.p));
  return cands[0]?.p ?? null;
}

/** Move inbox → active and push. The Worker's compare-and-swap commit is the distributed lock between machines. */
export const claim = (path: string, host: string) => locked(() => _claim(path, host));
async function _claim(path: string, host: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  const { meta, body } = readDoc(path);
  const dest = P("tasks", "active", `${meta.id}.md`);
  writeDoc(dest, { ...meta, claimed_by: host, started: now(), host_caps: hostCaps(loadConfig()).join(",") }, body);
  unlinkSync(path);
  if (await _commitPush(`[${host}] claim ${meta.id}: ${meta.title}`)) return dest;
  // undo only our claim (other pending local results stay queued); after a lost race the pull already applied the winner
  sync.revertLocal([relative(DATA, dest), relative(DATA, path)]);
  return null;
}

// ------------------------------------------------------------------ journal & memory
export function journal(host: string, line: string) {
  const f = P("journal", `${today()}.md`);
  if (!existsSync(f)) writeFileSync(f, `# Journal ${today()}\n\n`);
  appendFileSync(f, `- ${hhmm()} \`${host}\` ${line}\n`);
}

export function remember(agent: string, lessons: string[] | undefined, source: string) {
  if (!lessons?.length) return;
  const f = P("agents", agent, "memory.md");
  if (!existsSync(f)) { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, `# ${agent} memory\n\n`); }
  appendFileSync(f, lessons.map((l) => `- ${l} _(${source}, ${today()})_\n`).join(""));
}

export const readIf = (p: string, tail = 12000) => (existsSync(p) ? readFileSync(p, "utf8").slice(-tail) : "");

export const readAll = (dir: string, tail = 12000) =>
  list(dir).map((p) => `### ${p.split("/").pop()}\n${readFileSync(p, "utf8").trim()}`).join("\n\n").slice(-tail);

export const recentJournal = (days = 2) =>
  list(P("journal")).slice(-days).map((p) => readFileSync(p, "utf8").slice(-4000)).join("\n");

export function precedents(n = 30): string {
  return list(P("decisions", "closed")).slice(-n).map((p) => {
    const { meta } = readDoc(p);
    return `- ${meta.id} [${meta.agent}] Q: ${meta.question}\n  → **${meta.answer}** (by ${meta.answered_by})`;
  }).join("\n");
}

export function signature(agent: string, host: string, cfg: Cfg) {
  return `🤖 [Noop](https://huacnlee.github.io/noop) (${agent}) · AI agent acting for @${cfg.owner?.github ?? "owner"}`;
}

export function agentName(agent: string): string {
  const p = P("agents", agent, "profile.md");
  const m = existsSync(p) ? readFileSync(p, "utf8").match(/^Name:\s*(.+)$/m) : null;
  return m ? m[1].trim() : agent;
}
