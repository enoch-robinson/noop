// Decisions: agent asks → AI judge (owner's precedents & principles) → only unprecedented taste calls reach the owner.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, appendFileSync, writeFileSync } from "node:fs";
import {
  answeredMeta, type Cfg, P, agentName, journal, list, newTask, nextId, now, precedents, readAll, readDoc, readIf, today, writeDoc,
} from "./core";
import { notify, resolveReceipt } from "./notify";
import { asciiFold, choice, parseChoice } from "./reply-parse";
import { appendEvent } from "./server";
import { ask, type Result } from "./runner";
import { judgeMayDecide } from "./autonomy";
import { isMergeCard, mergeHeadline } from "./waits";
import type { CardOption } from "./server";

export function openDecision(task: Record<string, string>, res: Result, host: string): string {
  const id = nextId("D", P("decisions"));
  const labels = res.options?.length ? res.options : ["A: approve", "B: reject"];
  // merge cards always need the owner's click (the judge never answers them): mark every option high-risk
  // from the trusted question rule, not the labels ("A: yes / B: no" carries no verb to match)
  const merge = isMergeCard({ question: res.question ?? "", kind: task.kind === "menu" ? "menu" : undefined });
  const opts = structuredOptions(labels, res.recommendation, merge);
  writeDoc(P("decisions", "open", `${id}.md`), {
    id, task: task.id, agent: task.agent, host, created: now(),
    question: res.question ?? "", recommendation: res.recommendation ?? "",
    options: labels.join(" | "), options_json: JSON.stringify(opts),
    attachments: (res.attachments ?? []).join(" | ") || undefined,
    kind: task.kind === "menu" ? "menu" : undefined,
  }, `## Context\n${res.summary}\n\n## Options\n${labels.map((o) => `- ${o}`).join("\n")}\n`);
  return id;
}

/** The option's key: its leading letter or number ("B: merge…" → "B"); tolerant of leading whitespace, and empty
 *  for free-form labels (模型生成的中文选项常无前缀) — an empty key means the UI should fall back to free-text answering. */
const keyOf = (label: string) => label.match(/^\s*([A-Za-z]|\d+)(?=$|[\s:：.)、,，-])/)?.[1]?.toUpperCase() ?? "";

/** Keyword heuristic over the agent's labels (same keywords as the gates, but model wording can dodge it — the
 *  trusted rule is isMergeCard on the question, applied in openDecision). False positives cost one extra confirm;
 *  the remaining false negatives are acceptable until Task 10 wires confirm against the real gate list. */
const GATED = /(合并|merge|发布|release|publish|deploy|强推|force)/i;

function structuredOptions(labels: string[], recommendation?: string, extraRisk = false): CardOption[] {
  const rec = choice(recommendation ?? "");
  return labels.map((label) => ({
    key: keyOf(label), label,
    ...(rec && choice(label) === rec ? { recommended: true } : {}),
    ...(extraRisk || GATED.test(label) ? { risk: "high" as const } : {}),
  }));
}

/** The card's options as structured data: `options_json` when present, else derived from the legacy " | " string. */
export function parseOptions(meta: Record<string, string>): CardOption[] {
  if (meta.options_json) {
    try {
      const v = JSON.parse(meta.options_json) as unknown;
      if (Array.isArray(v) && v.length && v.every((o) => !!o && typeof o.key === "string" && typeof o.label === "string")) return v as CardOption[];
    } catch {}
  }
  return (meta.options ?? "").split(" | ").filter(Boolean).map((label) => ({ key: keyOf(label), label }));
}

type Verdict = { verdict: "decided" | "sent_back" | "hold"; answer?: string; reason: string; cite?: string };

export async function judge(id: string, cfg: Cfg): Promise<Verdict | null> {
  if (cfg.judge?.enabled === false) return { verdict: "hold", reason: "judge disabled" };
  const { meta, body } = readDoc(P("decisions", "open", `${id}.md`));
  if (meta.kind === "menu") return { verdict: "hold", reason: "next-steps menu is always the owner's call" };
  const prompt = `You are the owner's JUDGE. You apply the owner's recorded taste and past rulings to questions raised by their AI agent fleet.
Decide one of:
- "decided": the owner has clearly answered this kind of question before (precedent or principle). Give the answer and cite where.
- "sent_back": the question is malformed, lacks info the agent could get itself, or is covered by policy the agent should just follow. Say what to do.
- "hold": it needs a genuinely new judgment call, is high-stakes/irreversible beyond precedent, or you are not confident. Wait for the human.
Be conservative: when in doubt, "hold". Never decide anything involving money, credentials, production data deletion, or messages committing the owner personally.

# Owner principles & profile
${readAll(P("memory"))}

# Fleet policy
${readAll(P("policies"))}

# Corrections the owner made to past judge rulings (highest priority)
${readIf(P("memory", "judge-feedback.md"), 6000) || "(none)"}

# Past decisions
${precedents(60) || "(none)"}

# Question ${id} from agent ${meta.agent} (task ${meta.task})
${meta.question}
Recommendation: ${meta.recommendation}
${body}

Always fill "answer" with the option/answer you would pick yourself, even when the verdict is "hold" (it is recorded to measure your accuracy; the owner still decides).
Reply with only a \`\`\`json block: {"verdict": "...", "answer": "...", "reason": "...", "cite": "D-xxxx or principle"}`;
  return ask(prompt, cfg, P("logs", "runs", `${id}-judge.log`));
}

/** Leading option key of an answer — the scorer's normalizer, living in reply-parse with the rest of the parsing. */
export { choice };

/** Owner answered: score the judge's shadow answer and, when the owner overrode the agent's recommendation, keep a lesson. */
function learn(meta: Record<string, string>, answer: string, by: string): Record<string, string | undefined> {
  if (!/^owner/.test(by)) return {};
  const extra: Record<string, string | undefined> = {};
  if (meta.shadow_verdict && meta.shadow_answer) extra.shadow_agree = choice(meta.shadow_answer) === choice(answer) ? "yes" : "no";
  if (meta.recommendation && meta.kind !== "proposals" && choice(meta.recommendation) !== choice(answer)) {
    extra.overrode_recommendation = "yes";
    const f = P("memory", "lessons.md");
    if (!existsSync(f)) writeFileSync(f, "# Lessons learned (auto-appended by agents)\n\n");
    appendFileSync(f, `- ${today()} ${meta.id} [${meta.agent}] Q「${meta.question}」: agent recommended「${meta.recommendation}」, owner chose **${answer}**` +
      `${meta.shadow_answer ? ` (judge would have said「${meta.shadow_answer}」)` : ""}\n`);
  }
  return extra;
}

/** Tasks a card resumes: a supervisor card covers several tasks that share one cause. */
const cardTasks = (meta: Record<string, string>) => (meta.tasks || meta.task || "").split(",").filter(Boolean);

/** One feed event per card ending (answered / ignored / overridden / superseded / snoozed): the app folds the card,
 *  every channel's UI sees the closure, and push payloads can stop offering stale buttons. */
function resolved(state: string, id: string, by: string, note = "") {
  appendEvent({ from: "hub", kind: "resolved", ref: id, state, by, text: note || `${id} ${state}（${by}）` });
}

/** Close a decision and put its task back in the inbox with the answer appended. */
export function closeDecision(id: string, answer: string, by: string, note = "", via?: string): boolean {
  const src = P("decisions", "open", `${id}.md`);
  if (!existsSync(src)) return false;
  const { meta, body } = readDoc(src);
  writeDoc(P("decisions", "closed", `${id}.md`), { ...meta, answer, answered_by: by, answered: now(), ...answeredMeta(meta, via), ...learn(meta, answer, by) },
    `${body}\n## Answer (${by})\n${answer}\n${note}`);
  unlinkSync(src);
  resolved("answered", id, by, `${id} 已答：${answer}（${by}）`);
  for (const task of cardTasks(meta)) {
  const t = P("tasks", "blocked", `${task}.md`);
  if (existsSync(t)) {
    const { meta: tm, body: tb } = readDoc(t);
    // the owner answered the question the gate raised: unlock it for that run; the agent reads the answer and
    // only acts if the answer says so (no keyword matching on the owner's words). Supervisor cards never open a gate.
    const gated = /^owner/.test(by) && !meta.supervisor_cause;
    writeDoc(P("tasks", "inbox", `${task}.md`),
      { ...tm, claimed_by: undefined, status: undefined, resumes: id, gate_override: gated ? id : undefined },
      `${tb}\n\n## Decision ${id} (${by})\nQ: ${meta.question}\nA: **${answer}**\nContinue the task accordingly.\n`);
    unlinkSync(t);
  }
  }
  return true;
}

/** The answer that sets a card aside: the owner skipped it (often just forgot to pick); it is not a rejection. */
export const IGNORE = "忽略";

/** Owner set the card aside: close it (no lesson: not a choice between the options) and hand the call back to the agent.
 * Ignoring never abandons the task (T-0575): the owner often ignores a card because they answered in chat instead. */
export function ignoreDecision(id: string, by: string, via?: string): boolean {
  const src = P("decisions", "open", `${id}.md`);
  if (!existsSync(src)) return false;
  const { meta, body } = readDoc(src);
  writeDoc(P("decisions", "closed", `${id}.md`), { ...meta, answer: IGNORE, answered_by: by, answered: now(), ...answeredMeta(meta, via), ignored: "yes" },
    `${body}\n## Answer (${by})\n${IGNORE}: the owner skipped this card without choosing. Not a rejection; the agent decides. Do not ask it again.\n`);
  unlinkSync(src);
  resolved("ignored", id, by, `${id} 已忽略：不算拒绝，agent 自行决定`);
  for (const task of cardTasks(meta)) {
  const t = P("tasks", "blocked", `${task}.md`);
  if (existsSync(t)) {
    const { meta: tm, body: tb } = readDoc(t);
    // no gate_override: skipping a card never authorises a gated action (merge, release, external message)
    writeDoc(P("tasks", "inbox", `${task}.md`), { ...tm, claimed_by: undefined, status: undefined, resumes: id },
      `${tb}\n\n## Decision ${id} (${by})\nQ: ${meta.question}\nA: **${IGNORE}** — the owner skipped this card without choosing; it is NOT a rejection and NOT a reason to stop. ` +
      `First check the chat after the card: the owner may have answered there in their own words; follow that. Otherwise decide yourself ` +
      `(usually the recommendation) within the autonomy policy. A gated step (merge, release, public API, external message) stays undone: ` +
      `finish everything else and report it as pending, without sending the same card again.\n`);
    unlinkSync(t);
  }
  }
  return true;
}

/** Owner corrected an answer they just gave: put the task back in the queue with the correction on top. */
export function amendDecision(id: string, text: string, by: string): string | null {
  const d = P("decisions", "closed", `${id}.md`);
  if (!existsSync(d)) return null;
  const tid = readDoc(d).meta.task;
  if (!tid) return null;
  const { meta, body: card } = readDoc(d);
  // a polled channel message re-arrives every tick: the amended stamp lets handleReplies keep it to one correction
  writeDoc(d, { ...meta, amended: now() }, card);
  for (const dir of ["inbox", "active", "blocked", "done"]) {
    const t = P("tasks", dir, `${tid}.md`);
    if (!existsSync(t)) continue;
    const { meta, body } = readDoc(t);
    const note = `\n\n## Owner correction to ${id} (${by}) — overrides the answer above\n${text}\nDo not act on the earlier answer where this contradicts it.\n`;
    if (dir === "active") { writeDoc(t, meta, body + note); return tid; }
    writeDoc(P("tasks", "inbox", `${tid}.md`), { ...meta, claimed_by: undefined, status: undefined, gate_override: undefined }, body + note);
    if (dir !== "inbox") unlinkSync(t);
    return tid;
  }
  return null;
}

/** Send a decided-by-judge question back to the agent. */
export function sendBack(id: string, reason: string) {
  closeDecision(id, `SENT BACK by judge: ${reason}`, "judge");
}

/** The owner answered an open card in their own words ("先别合，等 CI"): the brain maps the words onto exactly one
 *  option — or admits it cannot, and the owner gets a receipt, never a guess. A mapping onto a high-risk option is
 *  refused (those need the deliberate tap or the bare key); the card stays open in every ambiguous case. The same
 *  words within one renotify window are answered once: polling channels re-deliver a channel message every tick,
 *  and without the marker each tick would re-run the brain and re-notify (a notification bombardment). */
export async function arbitrateReply(id: string, text: string, cfg: Cfg, host: string, source: string, via?: string): Promise<void> {
  const f = P("decisions", "open", `${id}.md`);
  if (!existsSync(f)) return;
  const { meta, body } = readDoc(f);
  const words = asciiFold(text).slice(0, 120);
  const window = (cfg.autonomy?.renotify_hours ?? 3) * 3600_000;
  if (meta.arbitrated && meta.arbitrated_text === words && Date.now() - Date.parse(meta.arbitrated) < window) {
    journal(host, `🔇 ${id} 同一句自由文本刚仲裁过（${meta.arbitrated}），窗口内不重复打扰`);
    return; // before the brain call: the re-poll must not re-cost a judge run either
  }
  const choices = parseOptions(meta);
  const context = body.match(/## Context\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim() ?? "";
  const prompt = [
    `The owner answered the card ${id} in their own words. Map their words onto exactly ONE option, or "unclear" when nothing matches clearly. Never guess: between two plausible options, answer "unclear".`,
    `Question: ${meta.question}`,
    ...choices.map((o) => `- ${o.key}: ${o.label}${o.risk === "high" ? " (high-risk: the owner must confirm this one explicitly — answer unclear even if the words seem to point here)" : ""}`),
    context ? `Context: ${context.slice(0, 800)}` : "",
    `Owner's words: ${text.slice(0, 1000)}`,
    "Reply with only a ```json block: {\"key\": \"option key or unclear\", \"why\": \"one short sentence\"}",
  ].filter(Boolean).join("\n");
  let v: { key?: string; why?: string } | null = null;
  try { v = await ask(prompt, cfg, P("logs", "runs", `${id}-arbitrate.log`)); } catch { /* brain unavailable: handled below */ }
  const key = String(v?.key ?? "").trim().toUpperCase();
  const opt = choices.find((o) => o.key.toUpperCase() === key);
  if (!v || !key || key === "UNCLEAR" || !opt) {
    // no brain, a malformed answer (missing key), or truly ambiguous words: say so and put the options right back
    // in front of the owner — an empty key must never fall through to `find`, or the first keyless option would win
    stampArbitrated(id, text);
    journal(host, `🤔 ${id} 自由文本未映射（${v ? v.why ?? "unclear" : "brain 不可用"}）：${text}`);
    await notify([`没听懂你对 *${id}* 的回复：「${text.slice(0, 120)}」${v?.why ? `（${v.why}）` : ""}`,
      choices.length ? `直接选一个：${choices.map((o) => o.label).join(" / ")}` : `或回复 ${id} 加上你的答案`,
    ].filter(Boolean).join("\n"), cfg, { kind: "decision", ref: id, choices });
    return;
  }
  if (opt.risk === "high") return refuseHighRiskWords(id, opt, text, cfg, host);
  const answer = opt.label;
  if (!closeDecision(id, answer, `owner(${source}-words)`, `Owner's words: ${text}\n(mapped to ${key} by the brain: ${v.why ?? "-"})`, via ?? `text:${source}`)) {
    journal(host, `↩️ ${id} 仲裁期间卡已被处理，结果丢弃：${text.slice(0, 60)}`);
    return;
  }
  journal(host, `💬 ${id} owner said "${text.slice(0, 80)}" → ${key}（${v.why ?? "-"}）`);
  await notify(`按 *${key}* 处理：${opt.label} — ${v.why ?? "已按你的话落卡"}`, cfg);
  void resolveReceipt(id, cfg, opt.label, `owner(${source}-words)`);
}

/** Words that only look like a high-risk option never unlock it — the explicit tap or the bare key is the deliberate
 *  second step. The card stays open, the same words are answered once per renotify window (polling channels
 *  re-deliver them every tick), and the owner is told how to confirm. Shared by the brain path and the direct
 *  fragment match in handleReplies. */
export async function refuseHighRiskWords(id: string, opt: CardOption, text: string, cfg: Cfg, host: string): Promise<void> {
  const f = P("decisions", "open", `${id}.md`);
  if (!existsSync(f)) return;
  const words = asciiFold(text).slice(0, 120);
  const { meta } = readDoc(f);
  if (meta.arbitrated && meta.arbitrated_text === words && Date.now() - Date.parse(meta.arbitrated) < (cfg.autonomy?.renotify_hours ?? 3) * 3600_000) {
    journal(host, `🔇 ${id} 高风险确认已在窗口内提示过，不重复打扰`);
    return;
  }
  stampArbitrated(id, text);
  journal(host, `⚠️ ${id} 自由文本疑似高风险选项 ${opt.key}，不改卡，等确认：${text.slice(0, 80)}`);
  await notify([`你说的像是在选 *${opt.label}*（高风险操作）`,
    `确认执行请回复 ${id} ${opt.key}，或直接点卡片按钮；不是的话请再说清楚一点`].join("\n"), cfg);
}

/** Stamp an open card with the arbitrated words so the same message re-delivered by a polling channel is answered
 *  once per renotify window, not every tick. */
function stampArbitrated(id: string, text: string) {
  const f = P("decisions", "open", `${id}.md`);
  if (!existsSync(f)) return;
  const { meta, body } = readDoc(f);
  writeDoc(f, { ...meta, arbitrated: now(), arbitrated_text: asciiFold(text).slice(0, 120) }, body);
}

export async function routeDecision(id: string, cfg: Cfg, host: string) {
  let v = await judge(id, cfg);
  const f = P("decisions", "open", `${id}.md`);
  let { meta, body } = readDoc(f);
  // Every judge run is recorded (hold included) so closeDecision can score it against the owner's answer.
  if (meta.kind !== "menu" && cfg.judge?.enabled !== false) {
    meta = { ...meta, shadow_verdict: v?.verdict ?? "error", shadow_answer: v?.answer ?? (v?.verdict === "sent_back" ? `SENT BACK: ${v.reason}` : "") };
    writeDoc(f, meta, body); // persisted before any close below reads it back
  }
  if (v && !judgeMayDecide(cfg, meta.agent) && v.verdict !== "hold") { // shadow mode: record, but ask the owner
    journal(host, `👤 shadow-judge on ${id}: would ${v.verdict} "${v.answer ?? v.reason}"`);
    v = { verdict: "hold", reason: `学习期，judge 认为：${v.verdict === "decided" ? v.answer : "应退回: " + v.reason}` };
  }
  if (v && v.verdict !== "hold" && isMergeCard(meta)) { // the judge's answer cannot click merge: hold for the owner
    journal(host, `👤 ${id} 是合并卡，judge 不代答（judge 认为：${v.answer ?? v.reason}）`);
    v = { verdict: "hold", reason: "merge card" };
  }
  if (v?.verdict === "decided" && v.answer) {
    closeDecision(id, v.answer, "judge", `Reason: ${v.reason} (cite: ${v.cite ?? "-"})`);
    journal(host, `⚖️ judge decided ${id}: ${v.answer} (${v.cite ?? v.reason})`);
    // receipt card in the feed (quiet: no push — the answer itself is the news, not the asking): shows what the judge
    // did and why, with the one-tap veto that runs overrideJudge when the owner disagrees
    await notify([`⚖️ *${id}* judge 已代答：*${v.answer}*`, meta.question ?? "", `理由：${v.reason}${v.cite ? `（先例：${v.cite}）` : ""}`,
      `不同意？回复 \`${id} override <你的答案>\`，或点下面否决`].filter(Boolean).join("\n"), cfg,
      { kind: "decision", ref: id, quiet: true, choices: [{ key: "override", label: "否决，重新决定", risk: "high" }],
        from: `judge@${meta.host ?? host}` });
    return;
  }
  if (v?.verdict === "sent_back") {
    sendBack(id, v.reason);
    journal(host, `↩️ judge sent back ${id}: ${v.reason}`);
    return;
  }
  await holdNotify(id, cfg, host);
}

/** Present an open card to the owner: the question, the agent's account, options as buttons; held/notified bookkeeping.
 *  Called by routeDecision (judge hold) and by the snooze wake-up in the tick — also clears a due wake_at. */
export async function holdNotify(id: string, cfg: Cfg, host: string) {
  const f = P("decisions", "open", `${id}.md`);
  if (!existsSync(f)) return;
  const { meta, body } = readDoc(f);
  const choices = parseOptions(meta);
  const opts = choices.map((o) => o.label); // one parse: the legacy string stays derived, never an independent source
  const menu = meta.kind === "menu";
  const context = body.match(/## Context\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim() ?? "";
  const text = menu ? [
    `*${id}* · ${agentName(meta.agent)}：团队空闲了，下一步做哪些？`,
    ...opts.map((o) => `${o}`),
    `建议：*${meta.recommendation || "-"}*`,
    `回复 \`${id} 1,3\`（可多选）或 \`${id} <其他指示>\``,
  ].join("\n") : [
    // the card already shows the id, the agent and the options as buttons: the question, then the agent's account of
    // what is at stake (what the PR changes, what each choice means). The judge's reason for asking is not news to the owner.
    isMergeCard(meta) ? mergeHeadline([meta.question ?? "", context, ...opts].join("\n")) : "",
    linkRefs(meta.question ?? "", meta.task, [context, ...opts].join("\n")),
    context ? `\n${linkRefs(context, meta.task, [meta.question ?? "", ...opts].join("\n"))}` : "",
    // the app marks this option 推荐 (and drops the line); chat channels show it as written
    meta.recommendation ? `\n建议：*${meta.recommendation}*` : "",
  ].filter(Boolean).join("\n");
  const ids = await notify(text, cfg, { kind: menu ? "menu" : "decision", ref: id, options: opts, choices,
    attachments: (meta.attachments ?? "").split(" | ").filter(Boolean), from: `${agentName(meta.agent)}@${meta.host}` });
  writeDoc(f, { ...meta, held: now(), notified: ids.join(","), wake_at: undefined }, body);
  journal(host, `📨 ${id} held for owner: ${meta.question}`);
}

/** Owner overrides a judge ruling: `D-0007 override <new answer>` → feedback memory + redo task. */
export function overrideJudge(id: string, answer: string, src: string, host: string, via?: string): boolean {
  const f = P("decisions", "closed", `${id}.md`);
  if (!existsSync(f)) return false;
  const { meta, body } = readDoc(f);
  if (meta.answered_by !== "judge") return false;
  writeDoc(f, { ...meta, answer, answered_by: `owner-override(${src})`, overridden_judge: meta.answer, ...answeredMeta(meta, via) }, body + `\n## Owner override\n${answer}\n`);
  resolved("overridden", id, src, `${id} owner 否决了 judge 的代答「${meta.answer}」→ ${answer}`);
  const fb = P("memory", "judge-feedback.md");
  if (!existsSync(fb)) writeFileSync(fb, "# Owner corrections to judge rulings\n\n");
  appendFileSync(fb, `- ${today()} ${id}: Q「${meta.question}」judge said「${meta.answer}」→ owner: **${answer}**\n`);
  newTask(`Redo per owner override of ${id}`, `Judge answered "${meta.answer}" but the owner overrode it:\n\n**${answer}**\n\nOriginal question: ${meta.question}\nRelated task: ${meta.task}. Adjust/revert the earlier work accordingly.`,
    { agent: meta.agent, priority: "high", source: `override:${id}` });
  journal(host, `🔁 owner overrode judge on ${id}: ${answer}`);
  return true;
}

export const recentJudgeIds = () =>
  new Set(list(P("decisions", "closed")).slice(-30).map((p) => readDoc(p).meta)
    .filter((m) => m.answered_by === "judge").map((m) => m.id));

/** Owner postponed a card: it stays open (its task stays blocked) and the tick re-presents it when wake_at is due.
 *  Not an answer and not an ignore: nothing is scored, no lesson is written. */
export function snoozeDecision(id: string, minutes: number, by: string): boolean {
  const f = P("decisions", "open", `${id}.md`);
  if (!existsSync(f)) return false;
  const { meta, body } = readDoc(f);
  writeDoc(f, { ...meta, wake_at: new Date(Date.now() + Math.max(5, minutes) * 60_000).toISOString() }, body);
  const h = Math.floor(minutes / 60), m = minutes % 60;
  const dur = h && m ? `${h} 小时 ${m} 分钟` : h ? `${h} 小时` : `${m} 分钟`;
  resolved("snoozed", id, by, `${id} 已推迟 ${dur}，到点会再提醒`);
  return true;
}

/** Open cards whose snooze ran out, oldest first. */
export function wakeDue(): string[] {
  return list(P("decisions", "open"))
    .map((p) => ({ p, m: readDoc(p).meta }))
    .filter((x) => x.m.wake_at && Date.parse(x.m.wake_at) <= Date.now())
    .sort((a, b) => Date.parse(a.m.wake_at!) - Date.parse(b.m.wake_at!))
    .map((x) => x.m.id);
}

/** The morning digest: shortly after quiet hours end, one summary of every card still waiting (each with its
 *  /card/<id> link), at most once per renotify interval. No quiet hours → no digest (the trigger is the quiet end);
 *  no open cards → nothing. Returns whether a digest went out. */
export async function summarizeOpenCards(cfg: Cfg, host: string): Promise<boolean> {
  const q = cfg.idle?.quiet_hours as string | undefined; // "23:30-08:30"
  if (!q || !q.includes("-")) return false;
  const mins = (s: string) => { const [h, m] = s.split(":").map(Number); return (h || 0) * 60 + (m || 0); };
  const cur = new Date().toTimeString().slice(0, 5);
  const sinceEnd = (mins(cur) - mins(q.split("-")[1]) + 1440) % 1440; // minutes since quiet ended (wraps midnight)
  if (sinceEnd > 60) return false;
  const cards = list(P("decisions", "open")).map((p) => readDoc(p).meta);
  if (!cards.length) return false;
  const stateFile = P("logs", "summary-state.json");
  const last = existsSync(stateFile) ? Date.parse(readFileSync(stateFile, "utf8").trim() || "1970-01-01T00:00:00Z") : 0;
  if (Number.isFinite(last) && Date.now() - last < (cfg.autonomy?.renotify_hours ?? 3) * 3600_000) return false;
  const base = cfg.cloud?.url ? String(cfg.cloud.url).replace(/\/$/, "") : "";
  const lines = cards.slice(0, 9).map((m) => `${m.id} ${m.question || (m.kind === "proposals" ? "要做哪几件事？" : "")}${base ? ` · ${base}/card/${m.id}` : ""}`);
  await notify([`☀️ 静音时段结束了，还有 ${cards.length} 张卡等你处理：`, ...lines, cards.length > 9 ? `…以及另外 ${cards.length - 9} 张` : ""]
    .filter(Boolean).join("\n"), cfg, { kind: "notice", from: `hub@${host}` });
  // atomic write (temp + rename): a partial state file would parse as NaN and double-fire the digest next tick
  mkdirSync(P("logs"), { recursive: true });
  const tmp = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(tmp, new Date().toISOString());
  renameSync(tmp, stateFile);
  journal(host, `📊 静音结束 → 摘要 ${cards.length} 张未答卡`);
  return true;
}

/**
 * "#747" / "nsh #747" → a Markdown link to that PR/issue, so every reference is clickable.
 * The repository comes from GitHub links in the text or `context` (the decision's other text and options),
 * matched by name, else from the task's checkout.
 */
export function linkRefs(text: string, taskId?: string, context = ""): string {
  const seen = new Map<string, string>(); // repo name → owner/repo
  for (const m of `${text}\n${context}`.matchAll(/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/\d+/g))
    seen.set(m[2].toLowerCase(), `${m[1]}/${m[2]}`);
  let fallback: string | null | undefined;
  const slugOf = (name?: string) => (name && seen.get(name.toLowerCase()))
    || (fallback === undefined ? (fallback = repoSlug(taskId) ?? (seen.size === 1 ? [...seen.values()][0] : null)) : fallback);
  return text
    // "owner/repo#12" names its repository outright
    .replace(/(^|[^\w\/\[#])([\w.-]+\/[\w.-]+)#(\d+)\b/g, (_, pre: string, slug: string, n: string) => `${pre}[${slug}#${n}](https://github.com/${slug}/pull/${n})`)
    .replace(/(^|[^\w\/\[#])(?:([\w.-]+)( ?))?#(\d+)\b/g, (all, pre: string, name: string | undefined, sp: string, n: string) => {
      const named = !!name && seen.has(name.toLowerCase());
      // "other-repo#3" for a repository not seen here: unknown, left as is ("PR#3" is not a repository)
      if (name && !named && !sp && !/^(pr|issue)s?$/i.test(name)) return all;
      const slug = slugOf(named ? name : undefined);
      if (!slug) return all;
      return `${pre}${name && !named ? name + sp : ""}[${named ? `${name}#${n}` : `#${n}`}](https://github.com/${slug}/pull/${n})`;
    });
}

function repoSlug(taskId?: string): string | null {
  if (!taskId) return null;
  for (const st of ["active", "waiting", "inbox", "done", "blocked"]) {
    const f = P("tasks", st, `${taskId}.md`);
    if (!existsSync(f)) continue;
    const repo = (readDoc(f).meta.repo ?? "").replace(/^~/, process.env.HOME ?? "");
    if (!repo || !existsSync(repo)) return null;
    const r = Bun.spawnSync(["git", "-C", repo, "remote", "get-url", "origin"], { stdout: "pipe" });
    return r.stdout.toString().trim().match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(\.git)?$/)?.[1] ?? null;
  }
  return null;
}
