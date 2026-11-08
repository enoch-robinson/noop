// Built-in weekly usage report: what the fleet did in the last 7 days, compared with the 7 days before, in the style
// of a hosting provider's weekly analytics email. Computed from the hub files (no AI run, no model cost), written to
// reports/usage/<date>.md and posted to the main chat so everyone using this Noop sees it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { P, list, readDoc } from "./core";

const FOLDERS = ["done", "failed", "blocked", "rejected", "waiting", "active", "inbox", "proposed"] as const;
const FINISHED = new Set(["done", "failed", "blocked"]);
const PR = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;

type Window = {
  created: number; finished: number; done: number; failed: number; blocked: number; hours: number;
  fromOwner: number; fromRoutines: number;
  agents: Record<string, number>; hosts: Record<string, number>; models: Record<string, number>; channels: Record<string, number>;
  prs: Set<string>; decisions: number; byOwner: number; byJudge: number; quotaHits: number;
};

const empty = (): Window => ({ created: 0, finished: 0, done: 0, failed: 0, blocked: 0, hours: 0, fromOwner: 0, fromRoutines: 0,
  agents: {}, hosts: {}, models: {}, channels: {}, prs: new Set(), decisions: 0, byOwner: 0, byJudge: 0, quotaHits: 0 });
const bump = (o: Record<string, number>, k: string | undefined) => { if (k) o[k] = (o[k] ?? 0) + 1; };

/** Counts for [from, to). */
export function usageWindow(from: number, to: number): Window {
  const w = empty();
  const inside = (t?: string) => { const n = Date.parse(t ?? ""); return n >= from && n < to; };
  for (const folder of FOLDERS)
    for (const p of list(P("tasks", folder), /^T-.*\.md$/)) {
      const { meta: m, body } = readDoc(p);
      if (inside(m.created)) {
        w.created++;
        if (/^owner/.test(m.source ?? "")) w.fromOwner++;
        else if (/^routine:/.test(m.source ?? "")) w.fromRoutines++;
      }
      if (!FINISHED.has(folder) || !inside(m.finished)) continue;
      w.finished++;
      w[folder as "done" | "failed" | "blocked"]++;
      if (m.started && m.finished) w.hours += Math.max(0, Date.parse(m.finished) - Date.parse(m.started)) / 3600e3;
      bump(w.agents, m.agent || "lead");
      bump(w.hosts, m.claimed_by);
      bump(w.models, m.model || m.cli_used);
      for (const c of (m.channels ?? "").split(",").map((s: string) => s.trim()).filter(Boolean)) bump(w.channels, c);
      for (const x of body.matchAll(PR)) w.prs.add(`${x[1]}#${x[2]}`);
    }
  for (const p of list(P("decisions", "closed"))) {
    const m = readDoc(p).meta;
    if (!inside(m.answered)) continue;
    w.decisions++;
    if (/^owner/.test(m.answered_by ?? "")) w.byOwner++;
    else if (/^judge/.test(m.answered_by ?? "")) w.byJudge++;
  }
  for (let t = from; t < to; t += 86400e3) {
    const f = P("journal", `${new Date(t).toISOString().slice(0, 10)}.md`);
    if (existsSync(f)) w.quotaHits += (readFileSync(f, "utf8").match(/hit usage limit/g) ?? []).length;
  }
  return w;
}

const delta = (now: number, before: number) => {
  if (!before) return now ? "new" : "–";
  const d = Math.round(((now - before) / before) * 100);
  return d === 0 ? "±0%" : `${d > 0 ? "+" : ""}${d}%`;
};
const top = (o: Record<string, number>, n = 6) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** The report as Markdown, for the week ending at `end`. */
export function usageReport(end = Date.now()) {
  const week = 7 * 86400e3;
  const now = usageWindow(end - week, end), prev = usageWindow(end - 2 * week, end - week);
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const rate = (w: Window) => (w.finished ? Math.round((w.done / w.finished) * 100) : 0);
  const row = (label: string, a: number, b: number, suffix = "") => `| ${label} | ${fmt(a)}${suffix} | ${fmt(b)}${suffix} | ${delta(a, b)} |`;
  const lines = [
    `# Noop weekly usage · ${day(end - week)} → ${day(end - 1)}`,
    "",
    `**${now.done}** tasks done, **${now.prs.size}** pull requests touched, **${fmt(now.hours)} h** of agent time. Success rate ${rate(now)}% (previous week ${rate(prev)}%).`,
    "",
    "| Metric | This week | Previous week | Change |",
    "|---|---|---|---|",
    row("Tasks created", now.created, prev.created),
    row("· from the owner", now.fromOwner, prev.fromOwner),
    row("· from routines", now.fromRoutines, prev.fromRoutines),
    row("Tasks finished", now.finished, prev.finished),
    row("· done", now.done, prev.done),
    row("· failed", now.failed, prev.failed),
    row("· blocked", now.blocked, prev.blocked),
    row("Agent time", now.hours, prev.hours, " h"),
    row("Pull requests touched", now.prs.size, prev.prs.size),
    row("Decisions answered", now.decisions, prev.decisions),
    row("· by the owner", now.byOwner, prev.byOwner),
    row("· by the judge", now.byJudge, prev.byJudge),
    row("Model quota hits", now.quotaHits, prev.quotaHits),
  ];
  const section = (title: string, o: Record<string, number>) => {
    const t = top(o);
    if (t.length) lines.push("", `**${title}**: ${t.map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  };
  section("By agent", now.agents);
  section("By machine", now.hosts);
  section("By model", now.models);
  section("By channel", now.channels);
  return { markdown: lines.join("\n") + "\n", now, prev, file: `reports/usage/${day(end)}.md` };
}

/** Writes the report into the hub and returns it (the caller posts it to the chat). */
export function writeUsageReport(end = Date.now()) {
  const r = usageReport(end);
  mkdirSync(P("reports", "usage"), { recursive: true });
  writeFileSync(P(r.file), r.markdown);
  return r;
}
