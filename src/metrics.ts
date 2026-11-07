// Fleet metrics → fleet/metrics.json; the architect uses them to evolve prompts, rules and memory.
import { writeFileSync } from "node:fs";
import { P, list, readDoc } from "./core";
import { judgeAccuracy } from "./autonomy";

export function computeMetrics(days = 7) {
  const since = Date.now() - days * 86400e3;
  const per: Record<string, { done: number; failed: number; blocked: number; minutes: number[] }> = {};
  for (const folder of ["done", "failed", "blocked"] as const)
    for (const p of list(P("tasks", folder), /^T-.*\.md$/)) {
      const m = readDoc(p).meta;
      if (Date.parse(m.finished ?? m.created) < since) continue;
      const a = (per[m.agent || "generalist"] ??= { done: 0, failed: 0, blocked: 0, minutes: [] });
      a[folder]++;
      if (m.started && m.finished) a.minutes.push((Date.parse(m.finished) - Date.parse(m.started)) / 60e3);
    }
  const decisions = list(P("decisions", "closed")).map((p) => readDoc(p).meta).filter((m) => Date.parse(m.answered ?? "") > since);
  const byWho = (re: RegExp) => decisions.filter((m) => re.test(m.answered_by ?? "")).length;
  // owner answering the same agent's questions with the recommended option → candidate for auto-approval
  const rubberStamp: Record<string, number> = {};
  for (const m of decisions) if (/^owner/.test(m.answered_by) && m.recommendation && m.answer?.trim().startsWith(m.recommendation.trim()))
    rubberStamp[m.agent] = (rubberStamp[m.agent] ?? 0) + 1;
  const agents = Object.fromEntries(Object.entries(per).map(([k, v]) => {
    const n = v.done + v.failed + v.blocked;
    const med = v.minutes.sort((a, b) => a - b)[Math.floor(v.minutes.length / 2)] ?? 0;
    return [k, { runs: n, success: +(v.done / (n || 1)).toFixed(2), failed: v.failed, blocked: v.blocked, median_minutes: Math.round(med) }];
  }));
  const approvals = list(P("decisions", "closed")).map((p) => readDoc(p).meta).filter((m) => m.kind === "proposals");
  const rejected = list(P("tasks", "rejected"), /^T-.*\.md$/).length;
  // answer latency + how/where the owner answers: old closed cards lack answered_ms/answered_via → skipped, not errors
  const ownerReplied = decisions.filter((m) => /^owner/.test(m.answered_by ?? ""));
  const ms = ownerReplied.map((m) => Number(m.answered_ms)).filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  const latency: Record<string, number> = { under_5m: 0, under_1h: 0, under_1d: 0, older: 0 };
  for (const n of ms) latency[n < 5 * 60e3 ? "under_5m" : n < 3600e3 ? "under_1h" : n < 86400e3 ? "under_1d" : "older"]++;
  const medianMs = ms.length ? (ms.length % 2 ? ms[(ms.length - 1) / 2] : (ms[ms.length / 2 - 1] + ms[ms.length / 2]) / 2) : null;
  const tally = (f: (m: (typeof ownerReplied)[number]) => string) => {
    const o: Record<string, number> = {};
    for (const m of ownerReplied) { const k = f(m) || "unknown"; o[k] = (o[k] ?? 0) + 1; }
    return o;
  };
  const out = {
    shadow_judge: judgeAccuracy(),
    shadow_judge_by_agent: Object.fromEntries(Object.keys(per).map((a) => [a, judgeAccuracy(a)])), proposal_batches: approvals.length, proposals_rejected_total: rejected,
    window_days: days, generated: new Date().toISOString(), agents,
    decisions: { total: decisions.length, by_judge: byWho(/^judge/), by_owner: byWho(/^owner\(/), owner_overrides_of_judge: byWho(/override/),
      owner_accepted_recommendation: rubberStamp,
      reply_latency: { sampled: ms.length, median_minutes: medianMs == null ? null : Math.round(medianMs / 60e3), buckets: latency },
      by_channel: tally((m) => String(m.answered_channel ?? "")), by_via: tally((m) => String(m.answered_via ?? "")) },
  };
  writeFileSync(P("fleet", "metrics.json"), JSON.stringify(out, null, 2));
  return out;
}
