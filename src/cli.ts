#!/usr/bin/env bun
// hub — CLI + daemon for the agent fleet.
import { $ } from "bun";
import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  type Cfg, P, ROOT, _commitPush, _pull, agentName, chooseCli, claim, commitPush, heartbeat, hostCaps, hostName, journal,
  list, loadConfig, locked, newTask, now, onlineHosts, pickTask, pull, readDoc, remember, writeDoc,
} from "./core";
import { amendDecision, arbitrateReply, closeDecision, IGNORE, holdNotify, ignoreDecision, openDecision, overrideJudge, parseOptions, recentJudgeIds, refuseHighRiskWords, routeDecision, snoozeDecision, summarizeOpenCards, wakeDue } from "./decisions";
import { parseChoice } from "./reply-parse";
import { notify, openDecisionIds, pollReplies, resolveReceipt } from "./notify";
import { STALLED, agentProcs, ask, buildPrompt, parseResult, quickAsk, runAgent } from "./runner";
import { byName, CLIS } from "./clis";
import { writeRules } from "./rules";
import { backoffMinutes, isNoChangeRoutine, tooManyWakes, waitMeta } from "./waits";
import { allowedParallel, budget, canRunHeavy, ensureDisk, sample } from "./resources";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { init, install, selfUpdate } from "./setup";
import { computeMetrics } from "./metrics";
import { writeUsageReport } from "./usage-report";
import { supervise } from "./supervisor";
import { collect, LEARN_PROMPT } from "./sessions";
import { medic } from "./medic";
import { githubStarved } from "./github";
import { doctor, visual } from "./visual";
import { answerFromChat, AMEND_MS, appendEvent, cancelTask, drainInbound, feed, handleOwnerMessage, mediaDays, pruneMedia, recentChat, setApplyOp, setCancelTask, setUpdateFleet, onSettingsSaved, startServer, status as hubStatus } from "./server";
import { followUpTarget, reopenTask, type BrainOut, ClaudeModel, SYSTEM, dataActs, localStore, logBrain, think } from "./brain";
import { runTool } from "../cloud/src/tools";
import { cloudDeploy, startCloudBridge } from "./cloud";
import { adoptCloudUrl, readHubToml } from "./sync";
import { judgeAccuracy, level, needsApproval, proposeBatch, resolveProposals, routineQueued, supersedeProposed, supersedeStaleQueued } from "./autonomy";
import { CODE, UPDATE_REQUEST, type UpdateState, setUpdateState, updateState, allowedClis, capOk, idTagFor, isPrimary, runningRev, setApprovalGate, setIdTag, which } from "./core";
import { accountEnv, accountsStatus, classify, failoverAccount, pendingLoginIds, pickAccount, reportFailure, retryLogins, submitLoginCode } from "./accounts";
import { channelPrompt, channels, resolveChannels, updateChannel } from "./channels";

// ------------------------------------------------------------------ routines (scheduled task generators)
const STATE = P("logs", "routine-state.json");

/** every: "15m" | "hourly" | "daily HH:MM" | "weekdays HH:MM" | "weekly MON HH:MM" */
export function due(every: string, last: string | undefined, t = new Date()): boolean {
  const parts = every.trim().split(/\s+/);
  const lastT = last ? new Date(last) : null;
  if (parts[0] === "hourly" || /^\d+m$/.test(parts[0])) {
    const mins = parts[0] === "hourly" ? 60 : parseInt(parts[0]);
    return !lastT || +t - +lastT >= mins * 60_000;
  }
  const [h, m] = parts.at(-1)!.split(":").map(Number);
  const target = new Date(t); target.setHours(h, m, 0, 0);
  if (t < target) return false;
  const dow = t.getDay();
  if (parts[0] === "weekdays" && (dow === 0 || dow === 6)) return false;
  if (parts[0] === "weekly" && ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][dow] !== parts[1].toUpperCase().slice(0, 3)) return false;
  if (!lastT) return +t - +target < 60 * 60_000; // first run ever: only fire near the scheduled time
  return lastT < target;
}

/** The routine's interval in minutes (hourly → 60, "10m" → 10, daily → 1440, weekly → 10080). */
export function everyMinutes(every: string): number {
  const p = every.trim().split(/\s+/)[0];
  if (p === "hourly") return 60;
  if (/^\d+m$/.test(p)) return parseInt(p);
  if (p === "weekly") return 10_080;
  return 1440; // daily and every other slot form
}

/** Cheap pre-check: run the routine's `signal` shell command; only an output change wakes an agent.
 * A failing command counts as changed (the agent then looks). */
export function signalChanged(r: { name: string; signal?: string }, state: Record<string, string>): boolean {
  const key = `${r.name}#signal`;
  // Non-login: the service already carries the user's PATH, and sourcing their profile can cost seconds (conda, etc.).
  const res = Bun.spawnSync(["bash", "-c", r.signal!], { cwd: existsSync(ROOT) ? ROOT : undefined, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  if (res.exitCode !== 0) return true;
  const hash = new Bun.CryptoHasher("sha1").update(res.stdout).digest("hex");
  if (state[key] === hash) return false;
  state[key] = hash;
  return true;
}

export function runRoutines(cfg: Cfg, host: string, primary: boolean) {
  const state: Record<string, string> = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
  try {
    maybeProposeNext(cfg, host, state);
    for (const r of cfg.routine ?? []) {
      // one broken routine must not kill the rest, rewind every schedule (state is persisted in `finally`),
      // or abort the tick before the task-claim loop (2026-11-08: a bad session file starved the queue overnight)
      try {
        if (r.enabled === false) continue;
        const owner = r.scheduler ?? (r.kind === "learn" ? "each" : "primary"); // which host generates the task
        if (owner === "primary" ? !primary : owner !== "each" && owner !== host) continue;
        if (!due(r.every, state[r.name])) continue;
        if (r.kind === "learn") { // local session history → digest → task pinned to this host
          state[r.name] = new Date().toISOString();
          const d = collect(cfg);
          if (!d.file) { journal(host, `📚 learn: no new sessions`); continue; }
          const id = newTask(`learn the CEO · ${host} · ${d.sessions} sessions`, LEARN_PROMPT(d.file),
            { agent: "apprentice", host, source: `routine:learn`, priority: "normal" });
          journal(host, `📚 learn: ${d.turns} owner turns from ${d.sessions} sessions → ${id}`);
          continue;
        }
        if (r.kind === "usage-report") { // computed by code, posted to the main chat; no task, no model cost
          state[r.name] = new Date().toISOString();
          try {
            const rep = writeUsageReport();
            appendEvent({ from: "hub", kind: "notice", text: rep.markdown });
            journal(host, `📊 usage report → ${rep.file}`);
          } catch (e) { journal(host, `📊 usage report failed: ${(e as Error).message}`); }
          continue;
        }
        // scheduler "each": every machine runs its own copy, pinned to it (e.g. the weekly security check of this computer)
        const pin = owner === "each" ? host : undefined;
        const queued = routineQueued(r.name, pin); // a copy queued or running → this run is redundant
        if (queued) {
          // a copy stuck in the queue for a full interval (or queue_release_minutes) is never going to claim
          // (host lost a capability, CLI gone, claim loop stalled): release the routine instead of skipping forever
          const release = Math.max(everyMinutes(r.every), cfg.fleet?.queue_release_minutes ?? 60);
          const freed = supersedeStaleQueued(r.name, release, pin);
          if (!freed.length) { state[r.name] = new Date().toISOString(); journal(host, `⏰ routine \`${r.name}\` skipped: ${queued} still queued/running`); continue; }
          journal(host, `⏰ routine \`${r.name}\`: stale queued ${freed.join(", ")} released after > ${release}m in the queue`);
        }
        if (r.signal && !signalChanged(r, state)) { state[r.name] = new Date().toISOString(); continue; } // nothing new → no AI run
        if (r.agent === "architect") computeMetrics(r.name === "evolve-deep" ? 30 : 7);
        const prompt = r.readonly ? `${r.prompt}\n\nRead-only routine: observe and report only. Do not change code, PRs, issues or settings; propose any change as a follow-up.` : r.prompt;
        const id = newTask(`${r.name}${pin ? ` · ${pin}` : ""} · ${new Date().toLocaleString("sv-SE").slice(0, 16)}`, prompt, {
          agent: r.agent, cli: r.cli, requires: r.requires, prefer: r.prefer, weight: r.weight, repo: r.repo, priority: r.priority, source: `routine:${r.name}`,
          ...(pin ? { host: pin } : {}),
        });
        const old = supersedeProposed(r.name, id, pin); // a newer run replaces older unapproved copies
        if (old.length) journal(host, `⏰ routine \`${r.name}\`: ${id} supersedes ${old.join(", ")}`);
        state[r.name] = new Date().toISOString();
        journal(host, `⏰ routine \`${r.name}\` → ${id} (${r.agent})`);
      } catch (e) { state[r.name] = new Date().toISOString(); journal(host, `💥 routine \`${r.name}\` failed, others continue: ${(e as Error).message?.slice(0, 200)}`); }
    }
  } finally {
    // always persist what ran: losing this file re-fires every short routine on the next tick
    mkdirSync(P("logs"), { recursive: true });
    writeFileSync(STATE, JSON.stringify(state, null, 2));
  }
}

// ------------------------------------------------------------------ task processing
const pendingRoute: string[] = [];
const cancelled = new Set<string>(); // tasks the owner cancelled while their agent ran // decisions opened by workers, routed by the next tick
async function processTask(path: string, cfg: Cfg, host: string) {
  const { meta, body } = readDoc(path);
  const wanted = allowedClis(meta, cfg);
  const installed = (c: string) => !!Bun.which(c);
  const first = pickAccount(cfg, wanted.filter(installed)) ?? failoverAccount(cfg, null, wanted, installed);
  const agent = meta.agent || "lead";
  if (!first) { // no usable account right now → put it back, don't fail it
    await locked(async () => {
      writeDoc(P("tasks", "inbox", `${meta.id}.md`), { ...meta, claimed_by: undefined }, body);
      if (existsSync(path)) unlinkSync(path);
      await _commitPush(`[${host}] requeue ${meta.id} (no AI account available)`);
    });
    return;
  }
  // the recovery note (meta.requeue_note) reaches the agent, but never becomes part of the owner's request text
  let acct: NonNullable<typeof first> = first;
  const promptBody = meta.requeue_note ? `${body}\n\n> ${meta.requeue_note}\n` : body;
  let cli = acct.cli, out = "", res!: ReturnType<typeof parseResult>;
  for (let hop = 0; ; hop++) { // quota / login trouble: switch account or CLI on this host instead of waiting it out
    cli = acct.cli;
    const model = cfg.clis?.[cli]?.model ?? byName(cli)?.defaultModel ?? "default";
    meta.cli_used = cli; meta.model = model; meta.account = acct.name;
    await locked(async () => {
      if (existsSync(path)) writeDoc(path, meta, body); // the app shows which model runs it
      journal(host, `▶ ${meta.id} ${agentName(agent)}/${cli}: ${meta.title}`);
      await _commitPush(`[${host}] start ${meta.id}`);
    });

    const log = P("logs", "runs", `${meta.id}-${Date.now()}-${cli}.log`);
    const gh = await githubStarved(cfg);
    const b = budget(sample(cfg), running, meta.weight === "heavy");
    b.note += gh.note ? `\n${gh.note}` : "";
    out = await runAgent(cli, buildPrompt(meta, promptBody, cfg, b.note), meta.repo || P(), cfg, log, !!meta.gate_override,
      { ...b.env, ...accountEnv(acct) });
    if (cancelled.has(meta.id)) { cancelled.delete(meta.id); return; } // the owner cancelled it while it ran
    if (out.includes(STALLED)) { // went quiet and was stopped: run it again from where it got to, up to twice
      const why = out.slice(out.indexOf(STALLED) + STALLED.length).trim();
      const stalls = Number(meta.stalls ?? 0) + 1;
      if (stalls <= 2) {
        await locked(async () => {
          await _pull();
          writeDoc(P("tasks", "inbox", `${meta.id}.md`), { ...meta, claimed_by: undefined, stalls: String(stalls),
            requeue_note: `Your previous run was stopped: ${why}. Continue from where it got to: first check what is already done (branch agent/${meta.id}-*, commits, PRs, comments you posted) and don't redo it. If you are waiting on something slow, return "waiting" instead of sitting idle.` },
            body);
          if (existsSync(path)) unlinkSync(path);
          journal(host, `🔁 ${meta.id} 没有动静被中止（${why}），接着跑（第 ${stalls} 次）`);
          await _commitPush(`[${host}] ${meta.id} stalled, rerun`);
        });
        return;
      }
      res = { status: "failed", summary: `连续 ${stalls} 次运行都卡住没有动静（${why}），已停止重试` };
      break;
    }
    res = parseResult(out);
    const failure = res.status === "failed" ? classify(out) : null;
    if (!failure) break;
    await reportFailure(acct, failure, out, cfg); // puts this account on cooldown / needs-login
    const next: typeof first | null = hop < 4 ? failoverAccount(cfg, acct, wanted, installed) : null;
    if (next) {
      const was = `${acct.cli}/${acct.name}`;
      await locked(async () => {
        await _pull();
        journal(host, `🔀 ${meta.id} ${was} ${failure === "quota" ? "额度用完" : "需要登录"}，立即改用 ${next.cli}/${next.name} 在本机重跑`);
        await _commitPush(`[${host}] ${meta.id} switch to ${next.cli}`);
      });
      acct = next;
      continue;
    }
    await locked(async () => { // nothing usable on this host → requeue
      await _pull();
      writeDoc(P("tasks", "inbox", `${meta.id}.md`), { ...meta, claimed_by: undefined, retried_after: failure }, body);
      if (existsSync(path)) unlinkSync(path);
      journal(host, `↻ ${meta.id} requeued (${cli}/${acct!.name}: ${failure})`);
      await _commitPush(`[${host}] requeue ${meta.id} (${failure})`);
    });
    return;
  }
  await locked(async () => {
  await _pull();

  remember(agent, res.lessons, meta.id);
  const depth = Number(meta.depth ?? 0) + 1;
  const maxDepth = cfg.fleet?.max_followup_depth ?? 4;
  const ownerWork = meta.origin === "owner" || /^owner/.test(meta.source ?? "");
  const delegated = res.status === "delegated" && (res.followups?.length ?? 0) > 0;
  const children: string[] = [];
  const chans = [...new Set([...(meta.channels ?? "").split(",").filter(Boolean), ...resolveChannels(res.channels)])].join(",") || undefined;
  for (const f of (res.followups ?? []).slice(0, depth > maxDepth ? 0 : 8)) {
    const id = newTask(f.title, f.body ?? "", { agent: f.agent ?? agent, priority: f.priority ?? meta.priority, repo: f.repo, requires: f.requires, host: f.host,
      source: `followup:${meta.id}`, extra: { depth: String(depth), ...((f as any).difficulty === "hard" ? { difficulty: "hard" } : {}), ...(ownerWork ? { origin: "owner" } : {}), ...(delegated ? { parent: meta.id } : {}), ...(meta.origin_channel ? { origin_channel: meta.origin_channel } : {}), ...(chans ? { channels: resolveChannels(chans.split(",")).join(",") } : {}) } });
    children.push(id);
    journal(host, `  ↳ ${id} → ${f.agent ?? agent}: ${f.title}`);
  }
  const done = { ...meta, channels: chans, cli_used: cli, finished: now(), status: res.status, gate_override: undefined, requeue_note: undefined, stalls: undefined };
  const runNote = `\n\n## Run ${now()} · ${host} · ${cli}\n**${res.status}** — ${res.summary}\n`;
  // the owner added to the request while it ran: run again with the additions instead of reporting a stale result
  const latest = existsSync(path) ? readDoc(path).body : body;
  const added = latest.length > body.length && latest.startsWith(body) ? latest.slice(body.length) : "";
  if (existsSync(path)) unlinkSync(path);
  if (added.includes(FOLLOW_UP) && !delegated) {
    writeDoc(P("tasks", "inbox", `${meta.id}.md`), { ...meta, claimed_by: undefined }, body + runNote + added +
      "\nThe owner added the follow-up above while you were working: handle the whole request including it.\n");
    journal(host, `↻ ${meta.id} rerun with the owner's follow-up`);
    await _commitPush(`[${host}] ${meta.id} follow-up`);
    return;
  }

  if (delegated && children.length) { // wait for children, then wake up to consolidate
    writeDoc(P("tasks", "waiting", `${meta.id}.md`), { ...done, children: children.join(",") }, body + runNote);
    journal(host, `🧩 ${meta.id} delegated to ${children.join(", ")}`);
  } else if (res.status === "waiting") { // parked: the slot is free until the wait is over
    const w = waitMeta(res);
    const wakes = Number(meta.wakes ?? 0);
    // the owner's approval covers the whole task: a wait for CI before the approved merge must not revoke it
    writeDoc(P("tasks", "waiting", `${meta.id}.md`), { ...done, gate_override: meta.gate_override, waiting_since: meta.waiting_since || now(), wake_at: w.wake_at, wait_kind: w.kind, wakes: wakes ? String(wakes) : undefined,
      waiting_on: res.waiting_on ?? "", wait_check: res.wait_check || undefined, wait_check_base: undefined },
      body + runNote + `\n**Waiting on:** ${res.waiting_on ?? "?"} (${w.kind === "human" ? "wakes on the owner's answer or an event" : `check again ${w.wake_at}`})\n`);
    journal(host, w.kind === "human" ? `⏳ ${meta.id} 等你处理：${res.waiting_on ?? ""}（不定时唤醒，事件到达再继续）` : `⏳ ${meta.id} 等待 ${res.waiting_on ?? ""}，${w.minutes} 分钟后再看`);
  } else if (res.status === "needs_decision") {
    const did = openDecision(meta, res, host);
    writeDoc(P("tasks", "blocked", `${meta.id}.md`), { ...done, decision: did }, body + runNote);
    journal(host, `⏸ ${meta.id} → ${did}: ${res.question}`);
    pendingRoute.push(did);
  } else {
    const folder = res.status === "done" ? "done" : "failed";
    writeDoc(P("tasks", folder, `${meta.id}.md`), done, body + runNote);
    journal(host, `${res.status === "done" ? "✅" : "❌"} ${meta.id} ${res.summary}`);
    // the owner asked for this (and it is not an internal sub-step) → bring back the result
    if (res.status === "done" && !res.attachments?.length && !res.followups?.length && isNoChangeRoutine(meta.source, res.summary)) {} // journal only
    else if (res.status === "done" && ownerWork && !meta.parent)
      void notify(meta.source === "owner@chat" ? res.summary : `${meta.title}\n${res.summary}`, cfg, { kind: "notice", ref: meta.id, attachments: res.attachments, from: `${agentName(agent)}@${host}` });
    // every other finished task (routines, follow-ups, sub-steps) → a quiet result line in the team channel, no push
    else if (res.status === "done")
      void notify(`${meta.title}\n${res.summary}`, cfg, { kind: "system", ref: meta.id, attachments: res.attachments, from: `${agentName(agent)}@${host}`, quiet: true });
    if (res.status !== "done") void track(handleFailure(meta, body, res.summary, out, cfg, host));
  }
  await _commitPush(`[${host}] ${res.status} ${meta.id}: ${meta.title}`);
  });
}

const FOLLOW_UP = "## Owner follow-up";

export async function handleReplies(cfg: Cfg, host: string) {
  const open = openDecisionIds();
  const judged = recentJudgeIds();
  const replies = [...drainInbound(), ...await pollReplies(cfg, new Set([...open, ...judged, ...pendingLoginIds()]))];
  for (const r of replies) {
    if (r.id.startsWith("P-")) {
      if (resolveProposals(r.id, r.answer, `owner(${r.source})`, r.via)) {
        journal(host, `${r.id} owner approved: ${r.answer}`);
        await notify(`${r.id} 已按你的选择排队`, cfg);
        void resolveReceipt(r.id, cfg, r.answer, `owner(${r.source})`);
      }
      continue;
    }
    if (r.id.startsWith("L-")) {
      if (submitLoginCode(r.id, r.answer)) journal(host, `🔑 ${r.id} login code received via ${r.source}`);
      continue;
    }
    if (r.source === "chat-amend") {
      const tid = amendDecision(r.id, r.answer, "owner(chat)");
      if (tid) {
        journal(host, `${r.id} owner correction: ${r.answer}`);
        await notify(`已按你的纠正更新 ${r.id}（${tid}），之前的选择作废`, cfg);
      } else await handleOwnerMessage(r.answer, undefined, true);
      continue;
    }
    const snooze = r.answer.trim().match(/^(稍后|snooze)\s*(\d+)\s*(m|分|h|小时|小時)?/i);
    if (open.has(r.id) && r.answer.trim() === IGNORE) {
      ignoreDecision(r.id, `owner(${r.source})`, r.via);
      journal(host, `🙈 ${r.id} owner ignored it`);
      await notify(`已忽略 ${r.id}：任务继续，由 agent 自己判断，不再追问`, cfg);
      void resolveReceipt(r.id, cfg, IGNORE, `owner(${r.source})`);
    } else if (open.has(r.id) && snooze) {
      // 稍后 [30m|2h]: the card stays open and the tick re-presents it; default honors the renotify interval
      const mins = snooze[2] ? Number(snooze[2]) * (snooze[3] && /^h/i.test(snooze[3]) ? 60 : 1)
        : (cfg.autonomy?.renotify_hours ?? 3) * 60;
      snoozeDecision(r.id, mins, `owner(${r.source})`);
      journal(host, `⏰ ${r.id} snoozed for ${Math.round(mins / 60)}h`);
      await notify(`已推迟 ${r.id}，${mins >= 60 ? `${Math.round(mins / 60)} 小时` : `${mins} 分钟`}后会再提醒（任务继续等着）`, cfg);
    } else if (open.has(r.id)) {
      // the set was taken before the loop: an earlier reply in this same batch may have closed the card already
      const f = P("decisions", "open", `${r.id}.md`);
      if (!existsSync(f)) continue;
      // typed replies are read as forgivingly as they are typed: a key, a key list or one unambiguous label is a
      // choice; anything else goes to the brain (arbitrateReply), which maps it or asks — never a guess
      const parsed = parseChoice(r.answer, parseOptions(readDoc(f).meta));
      if ("unrecognized" in parsed) {
        journal(host, `💬 ${r.id} 自由文本（未直接对应选项）: ${r.answer}`);
        await arbitrateReply(r.id, r.answer, cfg, host, r.source, r.via);
      } else {
        // a fragment ("先 merge 再说") is the fuzzy reading — it must not unlock a merge/release, same as the brain
        // path; an exact key or the full label echo is the deliberate typed confirmation and closes as before
        const opt = parsed.how === "fragment" ? parseOptions(readDoc(f).meta).find((o) => o.key === parsed.choice) : undefined;
        if (opt?.risk === "high") {
          await refuseHighRiskWords(r.id, opt, r.answer, cfg, host);
          continue;
        }
        const answer = parsed.choice;
        closeDecision(r.id, answer, `owner(${r.source})`, undefined, r.via);
        journal(host, `✔ ${r.id} owner answered via ${r.source}: ${answer}`);
        await notify(`收到 ${r.id}：${answer} — 任务已重新排队`, cfg);
        void resolveReceipt(r.id, cfg, answer, `owner(${r.source})`);
      }
    } else if (r.id.startsWith("D-") && /^(override|veto)\b/i.test(r.answer.trim())) {
      // a judge-ruled card can still be vetoed — this must come BEFORE the already-closed drop below, or the
      // text protocol could never reach overrideJudge (the receipt card's button posts the bare keyword)
      const answer = r.answer.trim().replace(/^(override|veto)[\s:：]*/i, "").trim() || "否决，请重新决定";
      if (overrideJudge(r.id, answer, r.source, host, r.via)) {
        await notify(`已否决 ${r.id}：judge 的代答作废，已记入 feedback 并创建重做任务`, cfg);
        void resolveReceipt(r.id, cfg, answer, `owner-override(${r.source})`);
      } else await notify(`无法否决 ${r.id}：它不是 judge 代答的卡，答案不变`, cfg);
    } else if (r.id.startsWith("D-") && existsSync(P("decisions", "closed", `${r.id}.md`))) {
      // a reply moments after the answer is a correction ("D-0012 其实选 B"), not a repeat: amend while the window is
      // open — the app's 修改 button (and a chat follow-up) lands here; past the window it is a new instruction
      const m = readDoc(P("decisions", "closed", `${r.id}.md`)).meta;
      if (m.amended && Date.now() - Date.parse(m.amended) < AMEND_MS) {
        // a polled channel message re-arrives every tick: one correction per window, the repeats are noise
        journal(host, `↩️ ${r.id} 刚刚更正过，这条重复回复被忽略`);
      } else if (m.answered && Date.now() - Date.parse(m.answered) < AMEND_MS) {
        const tid = amendDecision(r.id, r.answer, `owner(${r.source})`);
        if (tid) {
          journal(host, `✏️ ${r.id} owner corrected: ${r.answer}`);
          await notify(`已按你的纠正更新 ${r.id}（${tid}），之前的选择作废`, cfg);
          void resolveReceipt(r.id, cfg, r.answer, `owner(${r.source}) 改答`);
        } else await handleOwnerMessage(r.answer, undefined, true); // no linked task: it is just a chat message
      } else journal(host, `↩️ ${r.id} 已经答过，这次的重复回复被忽略`);
    }
  }
}

/** Requeue tasks whose claiming host went silent (crash, sleep, network loss). */
function reapStale(cfg: Cfg, host: string, ownOnly = false) {
  const alive = new Set(onlineHosts(cfg).map((h) => h.host));
  const graceMs = (cfg.fleet?.reap_after_minutes ?? 20) * 60_000;
  for (const p of list(P("tasks", "active"), /^T-.*\.md$/)) {
    const { meta, body } = readDoc(p);
    // own tasks not run by this process were orphaned by a crash/restart (we're alive, so no one else reaps them)
    if (meta.claimed_by === host ? runningIds.has(meta.id) : ownOnly || alive.has(meta.claimed_by)) continue;
    if (Date.now() - Date.parse(meta.started) < graceMs) continue;
    writeDoc(P("tasks", "inbox", `${meta.id}.md`), { ...meta, claimed_by: undefined, requeued: now(),
      requeue_note: `Requeued: host ${meta.claimed_by} went offline mid-task. Check for partial work (branch agent/${meta.id}-*).` }, body);
    require("node:fs").unlinkSync(p);
    journal(host, `♻️ requeued ${meta.id} (host ${meta.claimed_by} offline)`);
  }
}

/** Tasks whose hard requirements no online host satisfies: note once, never block the queue.
 *  A pin to one machine (host:X) is a preference once X has been offline for a while: if an online host meets
 *  every other requirement (os, cli…), the pin becomes `prefer` so the task moves to another machine. */
function noteUnservable(cfg: Cfg, host: string) {
  const hosts = onlineHosts(cfg);
  const graceMs = (cfg.fleet?.host_pin_wait_minutes ?? 20) * 60_000;
  for (const p of list(P("tasks", "inbox"), /^T-.*\.md$/)) {
    const { meta, body } = readDoc(p);
    const reqs = (meta.requires ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    const pins = reqs.filter((r) => r.startsWith("host:"));
    if (!pins.length || hosts.some((h) => reqs.every((r) => capOk(r, h.caps)))) continue;
    const rest = reqs.filter((r) => !r.startsWith("host:"));
    const since = Date.parse(meta.parked ?? meta.created ?? "") || Date.now();
    if (Date.now() - since < graceMs || !hosts.some((h) => rest.every((r) => capOk(r, h.caps)))) continue;
    const prefer = [...new Set([...(meta.prefer ?? "").split(","), ...pins].map((x) => x.trim()).filter(Boolean))].join(",");
    writeDoc(p, { ...meta, requires: rest.join(",") || undefined, prefer, parked: undefined }, body);
    journal(host, `🔀 ${meta.id} ${pins.join("+")} 离线超过 ${Math.round(graceMs / 60_000)} 分钟，改由其他在线机器执行`);
  }
  for (const p of list(P("tasks", "inbox"), /^T-.*\.md$/)) {
    const { meta, body } = readDoc(p);
    const reqs = (meta.requires ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    if (!reqs.length || meta.parked) continue;
    if (!hosts.some((h) => reqs.every((r) => capOk(r, h.caps)))) {
      writeDoc(p, { ...meta, parked: now() }, body);
      journal(host, `🅿️ ${meta.id} parked until a host with ${reqs.join("+")} comes online`);
    }
  }
  for (const p of list(P("tasks", "inbox"), /^T-.*\.md$/)) { // unpark when capable host returns
    const { meta, body } = readDoc(p);
    const reqs = (meta.requires ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    if (meta.parked && hosts.some((h) => reqs.every((r) => capOk(r, h.caps)))) writeDoc(p, { ...meta, parked: undefined }, body);
  }
}

let running = 0;
/** Set when the daemon is asked to stop or restart: running agents finish first instead of being killed and redone. */
let draining = false;
const RESTART_FLAG = () => P("..", "restart-requested");
/** Follow-up work a finished task still owes (retry bookkeeping etc.): drain waits for it too. */
const inflight = new Set<Promise<unknown>>();
const track = <T,>(p: Promise<T>) => { inflight.add(p); void p.finally(() => inflight.delete(p)).catch(() => {}); return p; };
const LAST_RESTART = () => P("logs", "last-restart");
/** At most one voluntary restart (self-update, `hub restart`) per hour unless forced; signals are never throttled. */
export function restartAllowed(force = false, file = LAST_RESTART(), t = Date.now(), minGapMs = 60 * 60_000): boolean {
  if (force) return true;
  try { return t - Date.parse(readFileSync(file, "utf8").trim()) >= minGapMs; } catch { return true; }
}
async function drainAndExit(why: string, host: string) {
  if (draining) return;
  draining = true;
  if (running) console.log(`${why}: waiting for ${running} running task(s) to finish`);
  // `running` covers each task from claim until its agent process exited and its result was committed
  while (running > 0 || inflight.size > 0) { await Bun.sleep(3000); await Promise.allSettled([...inflight]); }
  try {
    mkdirSync(P("logs"), { recursive: true });
    writeFileSync(LAST_RESTART(), new Date().toISOString());
    const u = updateState();
    if (u?.state === "waiting") setUpdateState({ at: u.at, state: "restarting", from: u.from });
    await locked(async () => {
      await _pull();
      if (u?.state === "waiting") heartbeat(loadConfig(), running, sample(loadConfig()));
      journal(host, `🔄 daemon ${why}: all running work finished, exiting`);
      await _commitPush(`[${host}] ${why}`, { force: true });
    });
  } catch {}
  process.exit(0);
}

const UPDATE_DONE = () => P("..", "update-handled");
/** The owner's "update every machine": once per request, now (not at the hourly check), running work finishing
 *  first. The primary redeploys the Worker and the web app even when its code was already current. */
async function ownerUpdate(c: Cfg, host: string) {
  let at = "";
  try { at = JSON.parse(readFileSync(UPDATE_REQUEST(), "utf8")).at ?? ""; } catch { return; }
  let done = "";
  try { done = readFileSync(UPDATE_DONE(), "utf8").trim(); } catch {}
  if (!at || at <= done) return;
  writeFileSync(UPDATE_DONE(), at);
  const from = runningRev().rev;
  const before = from?.slice(0, 7) ?? "?";
  // each step goes out in the heartbeat at once, so the owner watches it in Settings › 版本
  const report = async (state: UpdateState["state"], detail?: string) => {
    setUpdateState({ at, state, detail, from });
    await locked(async () => { await _pull(); heartbeat(c, running, sample(c)); await _commitPush(`[${host}] update: ${state}`, { force: true }); }).catch(() => {});
  };
  await report("updating", "拉取并测试新代码");
  const updated = await selfUpdate({ force: true, deploy: true }).catch(() => false);
  if (updated) {
    journal(host, `⬆️ updated on the owner's request (was ${before}); restarting${running ? ` after ${running} running task(s)` : ""}`);
    await report(running ? "waiting" : "restarting", running ? `等 ${running} 个任务跑完后重启` : undefined);
    void drainAndExit("self-update", host);
    return;
  }
  const now7 = (Bun.spawnSync(["git", "-C", CODE, "rev-parse", "--short", "HEAD"], { stdout: "pipe" }).stdout.toString().trim()) || before;
  const stale = now7 !== before; // the code moved but this process could not take it (local edits, failing tests)
  if (isPrimary(c, host) && c.cloud?.url) {
    await report("deploying", "重新发布线上");
    const cloud = await import("./cloud");
    const err = await cloud.cloudDeploy(c).then((u) => (u ? "" : cloud.lastDeployError || "unknown"), (e) => String(e));
    journal(host, `⬆️ already at ${now7}; ${err ? `redeploying the Worker failed: ${err.replace(/\s+/g, " ").slice(-300)}` : "redeployed the Worker and the web app"}`);
    await report(err ? "failed" : "current", err ? `代码已是最新，重新发布线上失败：${err.replace(/\s+/g, " ").slice(0, 120)}` : "已重新发布线上");
  } else {
    journal(host, stale ? `⬆️ not updated (still running ${before}; local edits or failing tests)` : `⬆️ already at ${now7}`);
    await report(stale ? "failed" : "current", stale ? "有本地改动或测试没通过，仍在运行旧代码" : undefined);
  }
}

/** A good report doesn't forward raw errors. Retry, call the medic for tooling problems, and only after that
 *  tell the owner — in one plain sentence, and only for work the owner actually cares about. */
async function handleFailure(meta: Record<string, string>, body: string, summary: string, out: string, cfg: Cfg, host: string) {
  const attempt = Number(meta.attempt ?? 1);
  // no keyword matching: when the agent could not even report a result, the medic (AI) decides whether the tooling broke
  const tooling = /agent returned no result block/.test(summary);
  if (tooling) void medic(`Agent run for ${meta.id} on ${host} ended without a result. Decide whether the tooling (CLI, auth, environment) is at fault and fix it; ignore it if the task itself failed:\n${out.slice(-2500)}`,
    cfg, { auto: true, kind: `tool-${meta.cli_used ?? "agent"}` });
  if (attempt < (cfg.fleet?.max_attempts ?? 2)) {
    await locked(async () => {
      await _pull();
      const f = P("tasks", "failed", `${meta.id}.md`);
      if (existsSync(f)) unlinkSync(f);
      writeDoc(P("tasks", "inbox", `${meta.id}.md`), { ...meta, claimed_by: undefined, status: undefined, attempt: String(attempt + 1) },
        `${body}\n\n> Attempt ${attempt} failed: ${summary.slice(0, 300)}. Try a different approach.\n`);
      journal(host, `↻ ${meta.id} retry ${attempt + 1} (${tooling ? "tooling issue → medic" : "task failure"})`);
      await _commitPush(`[${host}] retry ${meta.id}`);
    });
    return;
  }
  const ownerCares = meta.origin === "owner" || /^owner/.test(meta.source ?? "") || meta.priority === "urgent";
  if (!ownerCares || cfg.notify?.on_failure === false) return; // routine/internal work: journal only; architect reviews failures
  const reason = summary.split("\n")[0].replace(/\s+/g, " ").slice(0, 140);
  await notify(`没能完成「${meta.title}」：${reason}。我会在日报里跟进；需要换个做法可以直接告诉我。`, cfg,
    { kind: "notice", ref: meta.id, from: `${agentName(meta.agent || "lead")}@${host}` });
}
const GH_HEAVY = new Set(["dispatcher", "reviewer", "ops-watcher", "oss-triage", "release-manager"]);

/** Parent tasks waiting on delegated children: when every child is finished, requeue the parent to consolidate. */
function wakeParents(host: string, ready = new Set<string>()) {
  for (const p of list(P("tasks", "waiting"), /^T-.*\.md$/)) {
    const { meta, body } = readDoc(p);
    if (meta.wait_kind === "human" && !meta.wake_at) { // waits on a person: only an event wakes it, never the clock
      if (!ready.has(meta.id)) continue;
    }
    if (meta.wake_at || meta.wait_kind) { // parked on something slow: back to the queue once the time is up, or as soon as its check changes
      if (meta.wake_at && Date.parse(meta.wake_at) > Date.now() && !ready.has(meta.id)) continue;
      const wakes = Number(meta.wakes ?? 0) + 1;
      if (tooManyWakes(wakes)) { // cycling without progress: stop waking it, tell the owner once what blocks it
        writeDoc(P("tasks", "blocked", `${meta.id}.md`), { ...meta, wake_at: undefined, wakes: String(wakes), status: "blocked" },
          `${body}\nBlocked after ${wakes} wake-ups, still waiting on: ${meta.waiting_on ?? "?"}\n`);
        unlinkSync(p);
        journal(host, `🧱 ${meta.id} 唤醒 ${wakes} 次仍未就绪，转为 blocked：${meta.waiting_on ?? "?"}`);
        void notify(`${meta.id} 卡住了：${meta.waiting_on ?? "?"}（已唤醒 ${wakes} 次，不再自动重试）`, loadConfig(), { kind: "notice", ref: meta.id });
        continue;
      }
      writeDoc(P("tasks", "inbox", `${meta.id}.md`), { ...meta, wake_at: undefined, wait_kind: undefined, status: undefined, claimed_by: undefined, resumed: "yes", wakes: String(wakes) },
        `${body}\nResumed after waiting on: ${meta.waiting_on ?? "?"}. Check it now; if still not ready, return "waiting" again.\n`);
      unlinkSync(p);
      journal(host, `⏰ ${meta.id} 等待结束，重新排队检查`);
      continue;
    }
    const kids = (meta.children ?? "").split(",").filter(Boolean);
    const where = (id: string) => ["done", "failed", "rejected"].find((f) => existsSync(P("tasks", f, `${id}.md`)));
    if (!kids.every(where)) continue;
    const results = kids.map((id) => {
      const f = where(id)!;
      const k = readDoc(P("tasks", f, `${id}.md`));
      const last = k.body.split("## Run ").pop() ?? "";
      return `### ${id} [${k.meta.agent}] ${k.meta.title} — ${f}\n${last.slice(-1500)}`;
    }).join("\n\n");
    writeDoc(P("tasks", "inbox", `${meta.id}.md`), { ...meta, children: undefined, status: undefined, claimed_by: undefined, consolidating: "yes", priority: "high" },
      `${body}\n\n## Results from delegated subtasks\n${results}\n\nConsolidate these into the final outcome for the owner: return "done" with a crisp result summary (+attachments), or "needs_decision" with options if the owner must choose. Do not delegate again unless something essential is missing.\n`);
    unlinkSync(p);
    journal(host, `🧩 ${meta.id} subtasks finished → consolidating`);
  }
}
const runningIds = new Set<string>();

/** Queue-flow observability: when tasks keep waiting while the claim loop bails (no AI account, GitHub
 *  starved, nothing claimable), journal it at most once an hour — a blind queue must be visible at once,
 *  not discovered hours later (2026-11-08: the queue starved silently overnight). */
let stallSince = 0, stallReason = "", lastStallNote = 0;

/** Waits with a wait_check: the daemon runs it itself (no agent) with backoff 5 → 10 → 20 → 40 minutes; once its exit
 * code differs from the first run, the wait is over. Human waits are checked too: that is how an event (PR merged) wakes them. */
const waitChecks = new Map<string, { cmd: string; base?: number; next: number; n: number }>();
export async function checkWaits(now = Date.now(), everyMs?: number): Promise<Set<string>> {
  const ready = new Set<string>();
  const due: [string, string, string][] = [];
  const waiting = new Set<string>();
  for (const p of list(P("tasks", "waiting"), /^T-.*\.md$/)) {
    const { meta } = readDoc(p);
    if (!(meta.wake_at || meta.wait_kind) || !meta.wait_check) continue;
    waiting.add(meta.id);
    const c = waitChecks.get(meta.id);
    if (c && c.cmd === meta.wait_check && c.next > now) continue;
    due.push([meta.id, meta.wait_check, p]);
  }
  await Promise.all(due.map(async ([id, cmd, path]) => {
    // Non-login: the service already carries the user's PATH, and sourcing their profile can cost seconds (conda, etc.).
    const proc = Bun.spawn(["bash", "-c", cmd], { stdout: "ignore", stderr: "ignore", cwd: homedir() });
    const timer = setTimeout(() => proc.kill(), 60_000);
    const code = await proc.exited;
    clearTimeout(timer);
    if (proc.signalCode) return; // timed out: no answer this round
    const prev = waitChecks.get(id);
    const same = prev && prev.cmd === cmd;
    const n = same ? prev.n + 1 : 0;
    // The baseline is persisted in the task, so a daemon restart can't make a wait that finished meanwhile its new baseline.
    let base = same ? prev.base : undefined;
    if (base === undefined) {
      const doc = existsSync(path) ? readDoc(path) : undefined;
      const saved = doc?.meta.wait_check_base?.match(/^(-?\d+) ([\s\S]*)$/);
      if (saved && saved[2] === cmd) base = Number(saved[1]);
      else if (doc) writeDoc(path, { ...doc.meta, wait_check_base: `${code} ${cmd}` }, doc.body);
    }
    waitChecks.set(id, { cmd, base: base ?? code, next: now + (everyMs ?? backoffMinutes(n) * 60_000), n });
    if (base !== undefined && code !== base) { ready.add(id); waitChecks.delete(id); }
  }));
  for (const id of waitChecks.keys()) if (!waiting.has(id)) waitChecks.delete(id);
  return ready;
}

// ------------------------------------------------------------------ idle → ask owner with a concrete menu
const inQuietHours = (cfg: Cfg) => {
  const q = cfg.idle?.quiet_hours as string | undefined; // "23:00-08:30"
  if (!q) return false;
  const [a, b] = q.split("-");
  const cur = new Date().toTimeString().slice(0, 5);
  return a < b ? cur >= a && cur < b : cur >= a || cur < b;
};

export function maybeProposeNext(cfg: Cfg, host: string, state: Record<string, string>) {
  if (cfg.idle?.enabled === false || inQuietHours(cfg)) return;
  const busy = ["inbox", "active"].some((f) => list(P("tasks", f), /^T-.*\.md$/)
    .some((p) => !readDoc(p).meta.parked));
  if (busy || running > 0) { delete state.idle_since; return; }
  state.idle_since ??= new Date().toISOString();
  const idleMin = (Date.now() - Date.parse(state.idle_since)) / 60_000;
  if (idleMin < (cfg.idle?.after_minutes ?? 20)) return;
  // Re-offer after the latest unanswered menu's cooldown, regardless of filename order.
  const pendingMenu = list(P("decisions", "open")).map((p) => readDoc(p).meta)
    .filter((m) => m.kind === "menu")
    .sort((a, b) => Date.parse(b.created) - Date.parse(a.created))[0];
  const cooldown = (cfg.idle?.cooldown_minutes ?? 180) * 60_000;
  if (pendingMenu && Date.now() - Date.parse(pendingMenu.created) < cooldown) return;
  if (state.last_menu && Date.now() - Date.parse(state.last_menu) < 15 * 60_000) return;
  const id = newTask("Propose next actions (fleet idle)", `The fleet has been idle for ${Math.round(idleMin)} minutes.
Build the owner's next-action menu per your profile and return needs_decision.${pendingMenu ? `\nAn earlier menu ${pendingMenu.id} is still unanswered — refresh it (drop stale items) rather than repeating it verbatim.` : ""}`,
    { agent: "chief-of-staff", priority: "high", source: "idle", extra: { kind: "menu" } });
  state.last_menu = new Date().toISOString();
  journal(host, `💤 fleet idle ${Math.round(idleMin)}m → ${id} chief-of-staff drafting a next-steps menu`);
}

/** This machine's copies of images (served media, downloaded attachments) go after `media_days`, checked hourly. */
let mediaPruned = 0;
function pruneMediaHourly(cfg: Cfg) {
  if (Date.now() - mediaPruned < 3_600_000) return;
  mediaPruned = Date.now();
  try {
    const n = pruneMedia(mediaDays(cfg));
    if (n) console.log(`media: removed ${n} older than ${mediaDays(cfg)} days`);
  } catch (e) { console.error(`media prune: ${e}`); }
}

/** Stall supervisor (T-0728): every [supervisor] every_minutes (30) chase waiting/blocked tasks like a team lead. */
let lastSupervise = 0;
function maybeSupervise(cfg: Cfg, host: string) {
  if (cfg.supervisor?.enabled === false) return;
  const every = (cfg.supervisor?.every_minutes ?? 30) * 60_000;
  if (Date.now() - lastSupervise < every) return;
  lastSupervise = Date.now();
  try { supervise(cfg, host); } catch (e) { journal(host, `💥 supervisor: ${e}`); }
}

export async function tick(cfg: Cfg, background = false) {
  const host = hostName(cfg);
  const primary = isPrimary(cfg, host);
  const ready = primary ? await checkWaits().catch(() => new Set<string>()) : new Set<string>();
  await locked(async () => {
    await _pull();
    // every step isolated: one failing step must never skip the rest or the claim loop below
    const guard = async (name: string, fn: () => unknown | Promise<unknown>) => {
      try { await fn(); } catch (e) { journal(host, `💥 ${name}: ${(e as Error).message?.slice(0, 200)}`); }
    };
    try { writeRules(); } catch (e) { console.error(`rules.md: ${e}`); }
    await guard("heartbeat", () => heartbeat(cfg, running, sample(cfg)));
    if (primary) {
      await guard("routines", () => runRoutines(cfg, host, primary));
      await guard("reap", () => reapStale(cfg, host));
      await guard("wake parents", () => wakeParents(host, ready));
      await guard("supervisor", () => maybeSupervise(cfg, host));
      await guard("proposals", () => proposeBatch(cfg, host));
      await guard("placement", () => noteUnservable(cfg, host));
    } else await guard("reap", () => reapStale(cfg, host, true));
    await _commitPush(`[${host}] tick`);
  });
  pruneMediaHourly(cfg);
  await retryLogins(cfg);
  if (primary || pendingLoginIds().size) await handleReplies(cfg, host);
  if (primary) for (const id of wakeDue()) await holdNotify(id, cfg, host); // snoozed cards come back on their own
  if (primary) await summarizeOpenCards(cfg, host).catch((e) => console.error(`summary: ${e}`));
  if (primary) await planInbox(cfg, host);
  if (primary) {
    const toRoute = [...pendingRoute.splice(0), ...list(P("decisions", "open")).map((p) => readDoc(p).meta)
      .filter((m) => !m.held && m.kind !== "proposals").map((m) => m.id)];
    for (const id of new Set(toRoute)) {
      if (!require("node:fs").existsSync(P("decisions", "open", `${id}.md`))) continue;
      await locked(async () => { await _pull(); await routeDecision(id, cfg, host); await _commitPush(`[${host}] route ${id}`); });
    }
  }
  // resource governor: disk first, then adaptive parallelism
  const busyRepos = new Set(list(P("tasks", "active"), /^T-.*\.md$/).map((p) => readDoc(p).meta)
    .filter((m) => m.claimed_by === host && m.repo).map((m) => resolve(m.repo.replace(/^~/, homedir()))));
  await ensureDisk(cfg, host, busyRepos, (t) => notify(t, cfg));
  const jobs: Promise<void>[] = [];
  const tried = new Set<string>();
  for (;;) {
    if (draining) break; // stopping: finish what runs, start nothing new
    const s = sample(cfg);
    const max = allowedParallel(s, cfg, running);
    if (running >= max) break;
    if (!pickAccount(cfg, CLIS.map((a) => a.name).filter((c) => Bun.which(c)))) { stallSince ||= Date.now(); stallReason = "no usable AI account"; break; }
    if ((await githubStarved(cfg)).starved && list(P("tasks", "inbox"), /^T-.*\.md$/).every((p) => GH_HEAVY.has(readDoc(p).meta.agent))) { stallSince ||= Date.now(); stallReason = "GitHub quota starved"; break; }
    const t = pickTask(cfg, s.loadRatio, canRunHeavy(s, cfg, running));
    if (!t) {
      const waiting = list(P("tasks", "inbox"), /^T-.*\.md$/).length;
      if (!waiting) stallSince = 0;
      else { stallSince ||= Date.now(); stallReason = "no claimable task (requirements no host here meets)"; }
      break;
    }
    stallSince = 0;
    const active = await claim(t, host);
    if (!active) {
      // e.g. offline: don't spin on the same task; if the claim keeps failing while tasks wait, say so
      if (tried.has(t)) { stallSince ||= Date.now(); stallReason = "task claim could not be committed (sync lost a race, or offline)"; break; }
      tried.add(t); continue;
    }
    running++;
    const tid = readDoc(active).meta.id;
    runningIds.add(tid);
    const job = processTask(active, cfg, host)
      .catch((e) => { console.error(e); journal(host, `💥 worker crashed on ${active}: ${e}`); })
      .finally(() => { running--; runningIds.delete(tid); });
    jobs.push(job);
  }
  // say it once an hour until it clears: tasks are waiting and nothing can claim them
  const waitingTasks = list(P("tasks", "inbox"), /^T-.*\.md$/).filter((p) => !readDoc(p).meta.parked);
  if (!draining && waitingTasks.length && stallSince && Date.now() - stallSince > 10 * 60_000 && Date.now() - lastStallNote > 3_600_000) {
    lastStallNote = Date.now();
    const oldest = Math.min(...waitingTasks.map((p) => Date.parse(readDoc(p).meta.created ?? "") || Date.now()));
    journal(host, `⏸ queue stalled: ${stallReason} — ${waitingTasks.length} task(s) waiting, oldest ${Math.round((Date.now() - oldest) / 60_000)} min (check accounts: hub status)`);
  }
  if (!waitingTasks.length) stallSince = 0;
  if (!background) await Promise.all(jobs);
}

/** AI placement for new tasks: which host capabilities a task needs (e.g. os:macos for iOS screenshots), which CLI
 *  fits it (Claude for hard engineering, Codex for routine work), and how hard it is. One call for the whole batch. */
let planning: Promise<void> | null = null;
/** One planner run at a time (a chat task plans at once, the tick plans the rest): a second caller waits for the first. */
function planInbox(cfg: Cfg, host: string): Promise<void> {
  planning ??= planNow(cfg, host).finally(() => { planning = null; });
  return planning;
}

/** The daemon's sleep between ticks; `wakeDaemon` ends it early (a chat task just planned: claim it now, not next minute). */
let wakeUp: (() => void) | null = null;
const wakeDaemon = () => wakeUp?.();
const nap = (ms: number) => Promise.race([Bun.sleep(ms), new Promise<void>((r) => { wakeUp = r; })]).finally(() => { wakeUp = null; });

async function planNow(cfg: Cfg, host: string) {
  const todo = list(P("tasks", "inbox"), /^T-.*\.md$/).map((p) => ({ p, ...readDoc(p) })).filter((t) => !t.meta.planned).slice(0, 12);
  if (!todo.length) return;
  const hosts = onlineHosts(cfg).map((h) => `- ${h.host}: ${h.caps.join(",")}`).join("\n");
  const installed = CLIS.filter((a) => which(a.name)); // never offer the planner a CLI this fleet can't run
  const cliLine = (installed.length ? installed : CLIS).map((a) => `"${a.name}"${a.plannerHint ? ` ${a.plannerHint}` : ""}`).join("; ");
  const r = await quickAsk(`You place tasks for an AI agent fleet running on several machines.
For each task decide:
- channels: zero to three slugs from the channel goals below, or {"name":"...","goal":"..."} for a new work topic.
- requires: host capabilities it truly needs, comma-separated, from the hosts' caps below (e.g. "os:macos" for iOS/macOS builds,
  simulators or screenshots; "os:windows"; "" when any host will do). Only require what the work cannot be done without.
- cli: one of ${cliLine}.
- difficulty: "hard" or "normal".

${channelPrompt()}

Online hosts:
${hosts || "(unknown)"}

Tasks:
${todo.map((t) => `- ${t.meta.id} [agent ${t.meta.agent}${t.meta.requires ? `, already requires ${t.meta.requires}` : ""}]: ${t.meta.title} — ${t.body.slice(0, 500).replace(/\s+/g, " ")}`).join("\n")}

Reply with exactly one fenced json block: {"<task id>": {"requires": "", "cli": "claude", "difficulty": "normal", "channels": []}, ...}`,
    cfg, P("logs", "runs", `plan-${Date.now()}.log`));
  if (!r || typeof r !== "object") return; // planner unavailable: tasks run unplanned after plan_wait_minutes
  await locked(async () => {
    await _pull();
    // the planner names caps from the host list, but sometimes without the kind prefix ("cargo" instead of
    // "cli:cargo") — a bare name no host can ever match would park the task forever (T-0057, 2026-11-08)
    const tools = [...CLIS.map((a) => a.name), "gh", "cargo", "bun", "node"];
    const norm = (t: string) => (/^(os|host|arch|cli):/.test(t) ? t : tools.includes(t) ? `cli:${t}` : t);
    for (const t of todo) {
      const v = r[t.meta.id];
      if (!v || !existsSync(t.p)) continue;
      const req = [...new Set([...(t.meta.requires ?? "").split(","), ...String(v.requires ?? "").split(",")].map((x) => norm(x.trim())).filter(Boolean))].join(",");
      const pinned = t.meta.cli && t.meta.cli !== "auto";
      const channelSlugs = [...new Set([...(t.meta.channels ?? "").split(",").filter(Boolean), ...resolveChannels(v.channels)])].join(",");
      const planned = byName(String(v.cli ?? ""))?.name;
      // planner named an unregistered CLI: still stored as claude; the journal below logs the raw name
      if (!pinned && v.cli && !planned) journal(host, `⚠️ ${t.meta.id}: planner named unknown cli "${v.cli}", using claude`);
      else if (!pinned && planned && !which(planned)) journal(host, `⚠️ ${t.meta.id}: planner named uninstalled cli "${planned}", an installed CLI will run it`);
      writeDoc(t.p, { ...readDoc(t.p).meta, channels: channelSlugs, requires: req, ...(pinned ? {} : { cli: planned ?? CLIS.map((a) => a.name).find(which) ?? "claude" }),
        ...(v.difficulty === "hard" ? { difficulty: "hard" } : {}), planned: now() }, t.body);
      journal(host, `🧭 ${t.meta.id} planned: ${req || "any host"} · ${pinned ? t.meta.cli : v.cli}`);
    }
    await _commitPush(`[${host}] plan ${todo.length} tasks`);
  });
}

async function daemon(cfg: Cfg) {
  const host = hostName(cfg);
  const every = (cfg.host?.tick_seconds ?? 60) * 1000;
  console.log(`hub daemon on ${host} caps=${hostCaps(cfg).join(",")} tick=${every / 1000}s parallel≤${cfg.host?.max_parallel ?? "cores/3"}`);
  onSettingsSaved((summary) => locked(async () => {
    await _pull();
    journal(host, `⚙️ owner changed settings: ${summary}`);
    await _commitPush(`[${host}] settings: ${summary.slice(0, 60)}`);
  }));
  if (isPrimary(cfg, host)) startCloudBridge(cfg);
  const appendFollowUp = (tid: string, text: string) => locked(async () => {
    await _pull();
    for (const dir of ["inbox", "active", "waiting", "blocked", "done", "failed"]) {
      const f = P("tasks", dir, `${tid}.md`);
      if (!existsSync(f)) continue;
      const { meta, body } = readDoc(f);
      // waiting on the owner's card: what they write on the task is their answer to it
      if (dir === "blocked" && meta.decision && existsSync(P("decisions", "open", `${meta.decision}.md`))) {
        answerFromChat(String(meta.decision), text, false);
        return String(meta.title ?? tid);
      }
      if (dir === "blocked" || dir === "done" || dir === "failed") { // a task is a conversation: talking to a finished one continues it, under the same id
        reopenTask(f, text);
        journal(host, `💬 ${tid} reopened by owner: ${text.slice(0, 80)}`);
        await _commitPush(`[${host}] reopen ${tid}`);
        queueMicrotask(() => void planInbox(cfg, host).then(wakeDaemon).catch(() => {}));
        return String(meta.title ?? tid);
      }
      const added = `${body}\n\n${FOLLOW_UP} ${now()}\n> ${text.replace(/\n/g, "\n> ")}\n`;
      if (dir === "waiting") { // parked until its sub-tasks finish: the owner's new message is acted on now, not then
        const kids = meta.children ? ` Its sub-tasks (${meta.children}) may still be open: check them, don't start them again.` : "";
        writeDoc(P("tasks", "inbox", `${tid}.md`), { ...meta, claimed_by: undefined, status: undefined, wake_at: undefined, resumed: "yes" },
          `${added}\nWoken from waiting by the owner's message above: act on it now.${kids}\n`);
        unlinkSync(f);
      } else writeDoc(f, meta, added);
      journal(host, `💬 ${tid} owner added${dir === "waiting" ? " (woken from waiting)" : ""}: ${text.slice(0, 80)}`);
      await _commitPush(`[${host}] chat follow-up ${tid}`);
      return String(meta.title ?? tid);
    }
    return "";
  });
  setUpdateFleet(() => locked(async () => {
    await _pull();
    mkdirSync(P("fleet"), { recursive: true });
    writeFileSync(UPDATE_REQUEST(), JSON.stringify({ at: now(), by: "owner" }, null, 2));
    journal(host, "⬆️ owner asked every machine to update");
    await _commitPush(`[${host}] update requested`);
    return onlineHosts(cfg).length;
  }));
  setCancelTask((tid, done) => locked(async () => {
    await _pull();
    const where = ["inbox", "waiting", "blocked", "proposed", "active"].find((d) => existsSync(P("tasks", d, `${tid}.md`)));
    if (!where) return "not found";
    const f = P("tasks", where, `${tid}.md`);
    const { meta, body } = readDoc(f);
    if (where === "active" && meta.claimed_by && meta.claimed_by !== host) return `running on ${meta.claimed_by}`;
    cancelled.add(tid);
    agentProcs.get(tid)?.kill("SIGTERM");
    if (done) writeDoc(P("tasks", "done", `${tid}.md`), { ...meta, claimed_by: undefined, finished: now(), wake_at: undefined },
      `${body}\n\n## Done ${now()}\nThe owner marked this task done (finished it himself).\n`);
    else writeDoc(P("tasks", "rejected", `${tid}.md`), { ...meta, claimed_by: undefined, cancelled: now(), wake_at: undefined },
      `${body}\n\n## Cancelled ${now()}\nThe owner cancelled this task.\n`);
    unlinkSync(f);
    for (const kid of (meta.children ?? "").split(",").filter(Boolean)) { // its sub-tasks go with it
      const k = ["inbox", "waiting", "blocked", "proposed"].find((d) => existsSync(P("tasks", d, `${kid}.md`)));
      if (!k) continue;
      const kd = readDoc(P("tasks", k, `${kid}.md`));
      if (done) writeDoc(P("tasks", "done", `${kid}.md`), { ...kd.meta, finished: now() }, `${kd.body}\n\n## Done ${now()}\nParent ${tid} was marked done by the owner.\n`);
      else writeDoc(P("tasks", "rejected", `${kid}.md`), { ...kd.meta, cancelled: now() }, `${kd.body}\n\n## Cancelled ${now()}\nParent ${tid} was cancelled.\n`);
      unlinkSync(P("tasks", k, `${kid}.md`));
    }
    for (const d of list(P("decisions", "open"))) { // its open cards go too: nothing is left to answer
      const dd = readDoc(d);
      if (dd.meta.task !== tid) continue;
      writeDoc(P("decisions", "closed", basename(d)), { ...dd.meta, answer: done ? "已完成" : "已取消", answered_by: "owner(app)", answered: now() },
        `${dd.body}\n## Closed (owner)\nTask ${tid} was ${done ? "marked done" : "cancelled"} by the owner.\n`);
      unlinkSync(d);
    }
    journal(host, done ? `✅ ${tid} 你已标记为完成` : `🛑 ${tid} 已按你的要求取消`);
    await _commitPush(`[${host}] ${done ? "finish" : "cancel"} ${tid}`);
    return done ? "done" : "cancelled";
  }));
  // A new task from the owner's chat (created by the chat brain, or by create_task over MCP). It carries the channel's
  // recent conversation and the task it continues, so terse follow-ups ("不行，…", "这个细节记下来") keep their meaning.
  let chatNow: { text: string; chat: string[]; reply?: string; thread?: boolean; channel?: string } | null = null; // the owner message the brain is handling
  const createOwnerTask = (op: { title: string; details?: string; repo?: string; agent?: string; follows?: string; channels?: unknown[] }) => locked(async () => {
    await _pull();
    const m = chatNow;
    const prev = op.follows ?? (m?.reply && !["inbox", "active", "waiting"].some((d) => existsSync(P("tasks", d, `${m.reply}.md`))) ? m.reply : undefined);
    const prevFile = prev ? ["done", "failed", "rejected", "blocked", "inbox", "active", "waiting"].map((d) => P("tasks", d, `${prev}.md`)).find(existsSync) : undefined;
    const asked = m ? `The owner (CEO) said in chat:\n\n> ${m.text.replace(/\n/g, "\n> ")}\n` : "The owner asked for this through Noop's MCP connector.\n";
    const context = m && (m.chat.length || m.reply)
      ? (m.reply ? `\nThe owner wrote this as a reply to the team's message about ${m.reply}.\n` : "") +
        `\n## The channel just before this message\nThe owner writes tersely: words like "this", "不行", "这个细节", "以后都这样" refer to what was just said here.\n\n${m.chat.map((l) => `- ${l}`).join("\n")}\n`
      : "";
    const cont = prevFile && prev ? `\nThis continues ${prev} (${prevFile.split("/").slice(-2, -1)[0]}): read tasks/${prevFile.split("/").slice(-2).join("/")} for what was done and how. If the owner is correcting that result, fix it; if they say to remember something ("记录下来", "以后都这样"), write it as a durable rule/memory for the agent and kind of work it concerns, not just in this task.\n` : "";
    // said inside a channel: the task belongs to it and its results go back there
    const assignedChannels = [...new Set([...(m?.channel ? [m.channel] : []), ...resolveChannels(op.channels)])].join(",");
    const id = newTask(op.title.slice(0, 80), `${asked}${op.details ? `\n## What the chat understood\n${op.details}\n` : ""}${op.repo ? `\nRepo: ${op.repo}\n` : ""}${context}${cont}\nHandle it like a capable chief of staff (see your profile: "Owner requests").`,
      { agent: op.agent ?? "lead", source: m ? "owner@chat" : "owner@mcp", priority: "high", extra: { origin: "owner", ...(m?.channel ? { origin_channel: m.channel } : {}), ...(assignedChannels ? { channels: assignedChannels } : {}), ...(op.repo ? { repo: op.repo } : {}), ...(prevFile && prev ? { follows: prev } : {}) } });
    journal(host, `💬 ${id} from owner ${m ? "chat" : "MCP"}${prevFile ? ` (follows ${prev})` : ""}: ${op.title.slice(0, 80)}`);
    await _commitPush(`[${host}] chat ${id}`);
    // plan it now and wake the loop, so an idle machine starts it within seconds instead of after the next tick or two
    queueMicrotask(() => void planInbox(cfg, host).then(wakeDaemon).catch(() => {}));
    return { ok: true, id, ...(prevFile ? { follows: prev } : {}) };
  });
  const store = localStore({
    status: hubStatus, feed: () => feed("", 2000),
    acts: {
      ...dataActs(host),
      // said on a task's page: it stays in that conversation, however the model read it
      create_task: async (op) => {
        const m = chatNow;
        const title = m?.thread && m.reply ? await appendFollowUp(m.reply, m.text) : "";
        return title ? { ok: true, id: m!.reply, title } : createOwnerTask(op);
      },
      amend_task: async (op) => { const title = await appendFollowUp(op.id, op.text); return title ? { ok: true, id: op.id, title } : { ok: false, error: `${op.id} cannot be continued` }; },
      cancel_task: async (op) => { const r = await cancelTask(op.id); return { ok: r === "cancelled", id: op.id, result: r }; },
      answer_decision: async (op) => {
        const open = existsSync(P("decisions", "open", `${op.id}.md`));
        answerFromChat(op.id, op.answer, !open);
        return { ok: true, id: op.id, ...(open ? {} : { amended: true }) };
      },
      send_message: async (op) => { await handleOwnerMessage(op.text, op.reply_to); return { ok: true }; },
    },
  });
  setApplyOp((op) => runTool(store, op?.tool, op));
  const model = new ClaudeModel(String(cfg.router?.model ?? "claude-haiku-5-5"), String(cfg.router?.cli ?? "claude"), (cfg.router?.timeout_seconds ?? 45) * 1000);
  if (isPrimary(cfg, host) && Bun.which(String(cfg.router?.cli ?? "claude"))) model.warm(SYSTEM);
  if (isPrimary(cfg, host)) startServer(cfg, async (text, { reply, answered, sentAt, thread, channel }) => {
    const got = Date.now();
    const room = channel ? channels().find((c) => c.slug === channel) : undefined;
    const m = { text, replyTo: reply, answered, chat: recentChat(text, { channel }), sentAt, ...(room ? { channel: { slug: room.slug, name: room.name, goal: room.goal } } : {}) };
    chatNow = { text, chat: m.chat, reply, thread, channel: room?.slug };
    const post = (r: string, ref?: string) => appendEvent({ from: "hub", kind: "system", text: r.slice(0, 2000), ...(ref ? { ref } : {}), ...(thread ? { thread } : {}), ...(room ? { channel: room.slug } : {}) });
    let out: BrainOut;
    try {
      out = await think(m, store, model, post);
      if (!out.calls.length && !out.reply && out.rounds >= 4) throw new Error("no answer");
    } catch (err) {
      // no model (CLI missing, logged out, timeout): the message still becomes work, silently — never lost, never canned
      console.error(`chat brain: ${err}`);
      // a terse follow-up without a reply target continues the task the channel was just about
      const target = reply ?? followUpTarget(text, feed(new Date(Date.now() - 15 * 60_000).toISOString(), 200));
      const amended = target ? await store.act({ tool: "amend_task", id: target, text }) : null;
      const r = amended?.ok ? amended : await store.act({ tool: "create_task", title: text.split("\n")[0].slice(0, 80) });
      out = { reply: "", calls: [{ tool: "fallback", args: {}, ok: !!r.ok, result: r }], rounds: 0, ms: { model: [], total: Date.now() - got }, fallback: true };
    } finally { chatNow = null; }
    logBrain(m, out, got);
  });
  await locked(async () => { // recover tasks this host was running when it died/restarted
    await _pull();
    for (const p of list(P("tasks", "active"), /^T-.*\.md$/)) {
      const { meta, body } = readDoc(p);
      if (meta.claimed_by !== host) continue;
      // the note goes in meta (shown to the agent, not to the owner as part of the request)
      writeDoc(P("tasks", "inbox", `${meta.id}.md`), { ...meta, claimed_by: undefined, requeued: now(),
        requeue_note: `Requeued after daemon restart on ${host}; check for partial work.` }, body);
      require("node:fs").unlinkSync(p);
      journal(host, `♻️ requeued ${meta.id} after restart`);
    }
    await _commitPush(`[${host}] recover`);
  });
  await locked(async () => { await _pull(); journal(host, `🟢 daemon started (${hostCaps(cfg).join(", ")})`); await _commitPush(`[${host}] up`); });
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => void drainAndExit("stop", host));
  // a stray rejection (a voided notify/medic) used to kill the process → systemd restart → running work requeued
  process.on("unhandledRejection", (e) => console.error("unhandled rejection", e));
  process.on("uncaughtException", (e) => console.error("uncaught exception", e));
  let lastUpdate = 0, failures = 0;
  for (;;) {
    const c = loadConfig();
    if (adoptCloudUrl(c.cloud?.url)) journal(host, `☁️ hub moved: now syncing with ${c.cloud.url}`);
    if (existsSync(RESTART_FLAG())) { // `hub restart` (throttled) / `hub restart --force`
      const force = readFileSync(RESTART_FLAG(), "utf8").includes("force");
      if (restartAllowed(force)) { unlinkSync(RESTART_FLAG()); void drainAndExit("restart", host); }
    }
    if (!draining) await ownerUpdate(c, host);
    try { await tick(c, true); failures = 0; } catch (e) {
      console.error("tick failed", e);
      if (++failures >= 3) void medic(`noop daemon: ${failures} consecutive tick failures on ${host}.\n${(e as Error)?.stack ?? e}`, c, { auto: true, kind: "daemon" });
    }
    // self-update only when idle and not restarted within the hour; otherwise check again next tick
    if (!draining && running === 0 && restartAllowed() && Date.now() - lastUpdate > (c.update?.check_minutes ?? 30) * 60_000) {
      lastUpdate = Date.now();
      if (await selfUpdate({ busy: running }).catch(() => false)) {
        journal(host, "⬆️ framework self-updated; restarting when workers finish");
        void drainAndExit("self-update", host); // service manager restarts us on the new code
      }
    }
    await nap(every);
  }
}

async function status(cfg: Cfg, brief = false) {
  if (brief) { // what a person wants to see right after installing
    const url = cfg.cloud?.url;
    const hosts = onlineHosts(cfg).map((h) => h.host);
    console.log(`  ✓ ${hostName(cfg)} is part of your team${hosts.length > 1 ? ` (${hosts.length} machines online)` : ""}`);
    if (url) console.log(`\n  Open ${url}\n  and sign in with the code sent to your email.`);
    return;
  }
  // the server this machine actually syncs with is noop.toml's; the shared config only proposes one (adopted next tick)
  const hub = String(readHubToml().cloud?.url ?? "").replace(/\/$/, ""), shared = String(cfg.cloud?.url ?? "").replace(/\/$/, "");
  console.log(`server: ${hub || "local (not connected to a hub)"}${shared && hub && shared !== hub ? `   (shared config says ${shared}: switching on the next tick)` : ""}`);
  if (hub) { // today's Cloudflare usage against the free plan (cloud/src/budget.ts)
    const u = await fetch(`${hub}/api/usage`, { headers: { Authorization: `Bearer ${cfg.server?.token}` }, signal: AbortSignal.timeout(5000) })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null) as any;
    const pct = (k: string) => `${Math.round((100 * u[k]) / u.free[k])}%`;
    if (u?.free) console.log(`cloudflare today (UTC): ${u.requests} requests ${pct("requests")} · ${u.rowsRead} rows read ${pct("rowsRead")} · ${u.rowsWritten} rows written ${pct("rowsWritten")} of the free plan · db ${(u.dbBytes / 1e6).toFixed(0)} MB · ${u.level}`);
  }
  console.log(`autonomy: ${level(cfg)}   shadow judge: ${JSON.stringify(judgeAccuracy())}`);
  console.log(`host ${hostName(cfg)}  caps: ${hostCaps(cfg).join(", ")}  primary: ${cfg.fleet?.primary}`);
  console.log("online: " + onlineHosts(cfg).map((h) => `${h.host}(busy ${h.busy}, load ${h.stats?.loadRatio}, disk ${h.stats?.diskFreeGB}GB)`).join(", "));
  const s = sample(cfg);
  console.log("accounts:\n  " + accountsStatus(cfg).join("\n  "));
  console.log(`this host: load ${s.load1}/${s.cores}  mem free ${s.memFreePct}%  disk free ${s.diskFreeGB}GB  → parallel ${allowedParallel(s, cfg, 0)}`);
  for (const f of ["proposed", "inbox", "active", "blocked", "failed", "done"]) {
    const items = list(P("tasks", f), /^T-.*\.md$/);
    console.log(`\n${f.padEnd(8)} ${items.length}`);
    if (f !== "done") for (const p of items.slice(-12)) {
      const m = readDoc(p).meta;
      console.log(`  ${m.id} [${m.agent}] ${m.title}${m.claimed_by ? ` @${m.claimed_by}` : ""}${m.requires ? ` (needs ${m.requires})` : ""}`);
    }
  }
  console.log("\nopen decisions");
  for (const p of list(P("decisions", "open"))) {
    const m = readDoc(p).meta;
    console.log(`  ${m.id} (${m.task}, ${m.agent}) ${m.question}  rec=${m.recommendation}${m.held ? "  [waiting on you]" : ""}`);
  }
}

const HELP = `Noop — your own AI team

  noop init [<hub-url>] [--token <machine-token>]   join your hub (owner email login, or a machine token); asks for the URL if not given
  noop init --primary         the first machine, once: deploy your own Cloudflare Worker (holds the fleet data), seed ~/.noop/data
  noop install                run as a service (systemd / launchd / Task Scheduler)
  noop update                 self-update framework now (also automatic in daemon)
  noop fix ["what is wrong"]  AI medic: diagnose & repair this install (auto-runs on install/update/daemon failures)
  noop doctor                 check dependencies (agents, gh, headless GUI tools)
  noop visual …               headless display for GUI testing: start/run/shot/record/input/stop

  noop daemon                 run forever (tick every host.tick_seconds)
  noop tick                   one cycle: pull → routines → replies → judge → run tasks → push
  noop add "title" [-b body] [-a agent] [-r os:linux (hard)] [--prefer os:macos (soft)] [-w heavy] [--host name] [--repo ~/work/x] [-p high] [--cli ${CLIS.map((a) => a.name).join("|")}]
  noop decide D-0001 "A"      answer a decision from the terminal
  noop status                 queue / decision / accounts / resources overview
  noop learn [--full] [--dry]  learn the CEO from local Claude/Codex sessions (digest stays local; principles go to memory)
  noop metrics [days]         per-agent success, judge vs owner decisions (feeds self-evolution)
  noop usage                  weekly usage report (also posted every Monday by the built-in routine)
  noop agents                 list fleet members
  noop notify "text"          test Slack/Discord
  noop security [--json]      check this Noop deployment (2FA, sessions, OAuth clients, allow-lists) and this machine's Noop setup
  noop 2fa setup              bind (or re-bind) the authenticator app every sign-in requires; noop 2fa confirm <code> · noop 2fa status
  noop revoke-sessions        security valve: sign out every phone, browser and MCP connector at once (machines keep working)
`;

async function main() {
  const [cmd, ...rest] = Bun.argv.slice(2);
  const cfg = loadConfig();
  setApprovalGate((src) => needsApproval(loadConfig(), src));
  setIdTag(idTagFor(cfg, hostName(cfg))); // every id minted on a non-primary host carries its tag (T-M0001)
  const host = hostName(cfg);
  switch (cmd) {
    case "init": {
      // a bare `--worker` (older install lines) means the default: join an existing noop
      const args = rest.flatMap((a, i) => (a === "--worker" && (!rest[i + 1] || rest[i + 1].startsWith("-")) ? [] : [a]));
      const { values, positionals } = parseArgs({ args, allowPositionals: true,
        options: { worker: { type: "string" }, token: { type: "string" }, primary: { type: "boolean" } } });
      return init({ ...values, worker: values.worker ?? positionals[0] });
    }
    case "install": return install();
    case "visual": return visual(rest);
    case "doctor": return doctor();
    case "fix": {
      const what = rest.join(" ") || "Run a health check (hub doctor, hub status, service logs, bun test) and fix whatever is broken.";
      const r = await medic(what, cfg, { kind: "manual" });
      if (!r?.fixed) process.exitCode = 1;
      return;
    }
    case "restart": { // restart once running tasks finish (the service manager starts the new code)
      const force = rest.includes("--force");
      writeFileSync(P("..", "restart-requested"), `${new Date().toISOString()}${force ? " force" : ""}`);
      return void console.log(force ? "noop restarts as soon as its running tasks finish"
        : "noop restarts once its running tasks finish (at most once per hour; --force to skip the limit)");
    }
    case "update": return void console.log((await selfUpdate()) ? "updated" : "up to date");
    case "daemon": return daemon(cfg);
    case "tick": return tick(cfg);
    case "add": {
      const { values, positionals } = parseArgs({
        args: rest, allowPositionals: true, options: {
          body: { type: "string", short: "b" }, agent: { type: "string", short: "a" }, requires: { type: "string", short: "r" }, prefer: { type: "string" }, weight: { type: "string", short: "w" },
          host: { type: "string" }, repo: { type: "string" }, priority: { type: "string", short: "p" }, cli: { type: "string" },
        },
      });
      await pull();
      const id = newTask(positionals.join(" "), values.body ?? "", { ...values, source: `owner@${host}` });
      journal(host, `＋ ${id} by owner: ${positionals.join(" ")}`);
      await commitPush(`[${host}] add ${id}`);
      return console.log(id);
    }
    case "decide": {
      const [id, ...ans] = rest;
      await pull();
      if (id.startsWith("P-")) { if (!resolveProposals(id, ans.join(" "), `owner(cli@${host})`)) process.exit(1); journal(host, `${id} owner approved via cli: ${ans.join(" ")}`); await commitPush(`[${host}] approve ${id}`); return; }
      if (!closeDecision(id, ans.join(" "), `owner(cli@${host})`)) {
        if (!overrideJudge(id, ans.join(" "), `cli@${host}`, host)) { console.error("no such open decision"); process.exit(1); }
      } else journal(host, `✔ ${id} owner answered via cli: ${ans.join(" ")}`);
      await commitPush(`[${host}] decide ${id}`);
      return;
    }
    case "status": return void (await status(cfg, rest.includes("--brief")));
    case "learn": {
      const d = collect(cfg, { full: rest.includes("--full") });
      if (!d.file) return void console.log(`no new sessions (${d.sessions})`);
      console.log(`${d.turns} owner turns from ${d.sessions} sessions → ${d.file}`);
      if (rest.includes("--dry")) return;
      await pull();
      const id = newTask(`learn the CEO · ${host} · ${d.sessions} sessions`, LEARN_PROMPT(d.file), { agent: "apprentice", host, source: `owner@${host}`, priority: "high" });
      journal(host, `📚 ${id} learn from ${d.sessions} local sessions (owner-triggered)`);
      await commitPush(`[${host}] learn ${id}`);
      return console.log(id);
    }
    case "usage": return void console.log(writeUsageReport().markdown);
    case "metrics": return void console.log(JSON.stringify(computeMetrics(Number(rest[0] ?? 7)), null, 2));
    case "agents":
      for (const p of list(P("agents"), /.*/)) {
        const prof = P("agents", p.split("/").pop()!, "profile.md");
        if (existsSync(prof)) console.log(`${p.split("/").pop()!.padEnd(16)} ${readFileSync(prof, "utf8").split("\n")[0].replace(/^# /, "")}`);
      }
      return;
    case "login": { // show the pending sign-in code (used when email isn't configured)
      const url = String(cfg.cloud?.url ?? "").replace(/\/$/, "");
      const r = url ? await fetch(`${url}/api/host/login-code`, { headers: { Authorization: `Bearer ${cfg.server?.token}` } }).catch(() => null) : null;
      if (!r?.ok) return void console.log("没有待使用的验证码：先在 app 里输入邮箱，点「发送验证码」，再运行 noop login");
      const c = (await r.json()) as { email: string; code: string; expires: number };
      return void console.log(`\n  ${c.email} 的验证码：${c.code}  （${Math.max(1, Math.round((c.expires - Date.now()) / 60000))} 分钟内有效）\n`);
    }
    case "security": {
      const { securityReport, formatReport } = await import("./security");
      const items = await securityReport(cfg, host, isPrimary(cfg, host));
      console.log(rest.includes("--json") ? JSON.stringify({ host, items }, null, 2) : formatReport(host, items));
      if (items.some((i) => i.level === "bad")) process.exitCode = 1;
      return;
    }
    case "2fa": { // the mandatory second factor; bound from a machine only (the machine key is the root of trust)
      const url = String(cfg.cloud?.url ?? "").replace(/\/$/, "");
      if (!url) return void console.log("没有配置 [cloud] url");
      const call = (path: string, body?: unknown) => fetch(`${url}${path}`, { method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${cfg.server?.token}`, "x-noop-host": host, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (rest[0] === "status" || !rest[0]) {
        const r = await call("/api/host/2fa");
        if (!r.ok) { process.exitCode = 1; return void console.log(`查询失败：HTTP ${r.status} ${await r.text()}`); }
        const d = (await r.json()) as { bound: boolean; since: number | null };
        return void console.log(d.bound ? `✓ 两步验证已绑定（${new Date(d.since ?? 0).toLocaleString()}）` : "✗ 还没有绑定两步验证：任何人都无法登录。运行 noop 2fa setup");
      }
      if (rest[0] === "confirm") { // the second half of setup when it can't prompt (no terminal)
        const c = await call("/api/host/2fa/confirm", { totp: String(rest[1] ?? "").trim() });
        const d = (await c.json().catch(() => ({}))) as { error?: string; replaced?: boolean };
        if (!c.ok) { process.exitCode = 1; return void console.log(`✗ ${d.error ?? `HTTP ${c.status}`}`); }
        return void console.log(d.replaced ? "✓ 已换绑，旧的验证器已失效。" : "✓ 两步验证已开启：以后登录需要邮箱验证码 + 验证器上的数字。");
      }
      if (rest[0] !== "setup") return void console.log("usage: noop 2fa setup | noop 2fa confirm <6 位数字> | noop 2fa status");
      const st = (await (await call("/api/host/2fa")).json().catch(() => ({}))) as { bound?: boolean };
      if (st.bound) console.log("⚠ 已经绑定过：确认后旧的验证器立即失效。");
      const r = await call("/api/host/2fa/setup", {});
      if (!r.ok) { process.exitCode = 1; return void console.log(`失败：HTTP ${r.status} ${await r.text()}`); }
      const { secret, uri } = (await r.json()) as { secret: string; uri: string };
      console.log("\n用验证器 App（Google Authenticator / 1Password / Authy …）扫描二维码：\n");
      const qr = Bun.which("qrencode") ? await $`qrencode -t ansiutf8 -m 2 ${uri}`.quiet().nothrow() : null;
      if (qr?.exitCode === 0) console.log(qr.stdout.toString());
      else console.log("（装了 qrencode 就能在这里显示二维码）");
      console.log(`扫不了就手动输入密钥：${secret.match(/.{1,4}/g)!.join(" ")}\n`);
      if (!process.stdin.isTTY) return void console.log("扫码后 10 分钟内运行：noop 2fa confirm <验证器上的 6 位数字>");
      for (let i = 0; i < 3; i++) {
        const code = (prompt("输入验证器 App 上的 6 位数字确认：") ?? "").trim();
        if (!code) break;
        const c = await call("/api/host/2fa/confirm", { totp: code });
        const d = (await c.json().catch(() => ({}))) as { ok?: boolean; error?: string; replaced?: boolean };
        if (c.ok) return void console.log(d.replaced ? "✓ 已换绑，旧的验证器已失效。" : "✓ 两步验证已开启：以后登录需要邮箱验证码 + 验证器上的数字。");
        console.log(`✗ ${d.error ?? `HTTP ${c.status}`}`);
      }
      process.exitCode = 1;
      return void console.log("没有确认，绑定未生效。");
    }
    case "revoke-sessions": { // a sign-in alert you didn't expect: everyone but the machines is out
      const url = String(cfg.cloud?.url ?? "").replace(/\/$/, "");
      if (!url) return void console.log("没有配置 [cloud] url");
      const r = await fetch(`${url}/api/host/revoke-sessions`, { method: "POST", headers: { Authorization: `Bearer ${cfg.server?.token}`, "x-noop-host": host } }).catch((e) => e as Error);
      if (r instanceof Error || !r.ok) { process.exitCode = 1; return void console.log(`撤销失败：${r instanceof Error ? r.message : `HTTP ${r.status} ${await r.text()}`}`); }
      const { revoked } = (await r.json()) as { revoked: number };
      return void console.log(`✓ 已撤销 ${revoked} 个登录（手机、浏览器、MCP 连接器）。需要重新用邮箱验证码登录。\n  如果怀疑邮箱被盗，先改邮箱密码，再考虑轮换机器密钥。`);
    }
    case "cloud": {
      if (rest[0] !== "deploy") return void console.log("usage: hub cloud deploy");
      return void (await cloudDeploy(cfg));
    }
    case "notify": return void console.log(await notify(rest.join(" "), cfg));
    default: console.log(HELP);
  }
}

if (import.meta.main) {
  try { await main(); } catch (e) {
    const cmd = Bun.argv[2] ?? "";
    console.error(e);
    if (["init", "install", "update", "tick", "learn"].includes(cmd) && !process.env.HUB_NO_MEDIC) {
      await medic(`\`hub ${Bun.argv.slice(2).join(" ")}\` failed:\n${(e as Error)?.stack ?? e}`, loadConfig(), { auto: true, kind: `cmd-${cmd}` });
    }
    process.exit(1);
  }
}
