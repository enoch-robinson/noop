// /card/<id>: one card, one page. Owner-session only (no session → the SPA's login flow via /?ref=, the same
// target pushes already use). Renders the open card with big buttons — high-risk ones take the in-page confirm
// step, and the answer posts /api/answer with confirm:true — or the closed card's final state, with the veto
// form on judge-answered receipts. Inline HTML, no assets, no polling: answering re-renders the result inline.
import { choiceKey } from "./answer";

export type CardDoc = { meta: Record<string, string>; context: string };

/** Frontmatter + the Context section of a decision file, as synced into the files table. */
export function parseCard(content: string): CardDoc | null {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, context: m[2].match(/## Context\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim() ?? "" };
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** JSON inside an inline <script>: a raw "</script>" in the data would close the block early (and open an injection hole). */
const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

const PAGE = (body: string) => `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Noop · 卡片</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; background: #f6f6f4; color: #1a1a1a; }
  main { max-width: 560px; margin: 0 auto; padding: 20px 16px 48px; }
  .id { font: 600 13px ui-monospace, monospace; color: #8a8a8a; }
  h1 { font-size: 19px; line-height: 1.45; margin: 6px 0 14px; }
  pre { white-space: pre-wrap; font: 14px/1.6 system-ui, sans-serif; margin: 0 0 16px; color: #444; }
  button { display: block; width: 100%; box-sizing: border-box; margin: 10px 0; padding: 14px 16px; font-size: 16px;
    border-radius: 12px; border: 1px solid #d8d8d4; background: #fff; cursor: pointer; text-align: left; }
  button.rec { border-color: #2c6e49; color: #2c6e49; font-weight: 600; }
  button.risk { border-color: #b3261e; color: #b3261e; }
  .done { background: #eef4ee; border: 1px solid #cfe3cf; border-radius: 12px; padding: 14px 16px; }
  .row { display: flex; gap: 8px; } input { flex: 1; padding: 12px; font-size: 15px; border-radius: 10px; border: 1px solid #d8d8d4; }
  #msg { margin-top: 14px; font-size: 14px; color: #8a8a8a; min-height: 20px; }
</style></head><body><main>${body}</main></body></html>`;

/** The whole page. `open` cards get buttons; closed ones show the final state (plus the veto form on judge receipts). */
export function cardPage(id: string, isOpen: boolean, content: string, token: string, origin: string): string {
  const doc = parseCard(content);
  if (!doc) return PAGE(`<p class="id">${esc(id)}</p><p>卡片内容无法解析。</p>`);
  const { meta, context } = doc;
  let choices: { key: string; label: string; recommended?: boolean; risk?: string }[] = [];
  try { choices = JSON.parse(meta.options_json ?? "[]"); } catch { /* legacy card: no buttons */ }
  const head = `<p class="id">${esc(id)} · ${esc(meta.agent ?? "")}</p><h1>${esc(meta.question ?? "")}</h1>` +
    (context ? `<pre>${esc(context)}</pre>` : "");
  if (!isOpen) {
    const judge = /^judge/.test(meta.answered_by ?? "");
    const form = judge ? `<div class="row"><input id="ans" placeholder="你的答案（否决 judge 的代答）">
      <button onclick="veto()">否决</button></div>` : "";
    return PAGE(`${head}<div class="done"><b>已处理</b> · ${esc(meta.answered_by ?? "")}<br>${esc(meta.answer ?? "")}</div>${form}
<script>
const I = ${json(id)}, T = ${json(token)};
async function veto() {
  const t = document.getElementById("ans").value.trim();
  if (!t) return msg("先写出你的答案");
  await post(t.startsWith("override") ? t : "override " + t);
}
async function post(choice, confirm) {
  const r = await fetch("/api/answer", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + T },
    body: JSON.stringify({ card: I, choice, confirm }) });
  const b = await r.json().catch(() => ({}));
  msg(r.ok ? "✅ 已记录：" + (b.text ?? choice) : b.error ?? "失败 " + r.status);
  if (r.ok) setTimeout(() => location.reload(), 800);
}
function msg(t) { document.getElementById("msg").textContent = t; }
</script>
<p id="msg"></p>`);
  }
  const buttons = choices.map((c) => {
    const risk = c.risk === "high";
    // the key rides an HTML attribute: entity-escape it so a hostile options_json cannot break out of onclick
    return `<button class="${risk ? "risk" : c.recommended ? "rec" : ""}" onclick="answer(${esc(JSON.stringify(c.key))}, ${risk})">` +
      `${esc(c.label)}${c.recommended ? " · 推荐" : ""}${risk ? " · ⚠️ 高风险" : ""}</button>`;
  }).join("");
  return PAGE(`${head}<div>${buttons || "<p>这张卡没有可点的选项：直接在对话里回复。</p>"}</div>
<form class="row" onsubmit="return other()"><input id="ans" placeholder="或其他指示…"><button>发送</button></form>
<p id="msg"></p>
<script>
const I = ${json(id)}, T = ${json(token)};
function msg(t) { document.getElementById("msg").textContent = t; }
async function post(choice, confirm) {
  const r = await fetch("/api/answer", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + T },
    body: JSON.stringify({ card: I, choice, confirm }) });
  const b = await r.json().catch(() => ({}));
  if (r.status === 409 && /confirm/.test(b.error ?? "")) return msg("⚠️ 高风险操作：再点一次选项并确认");
  if (r.status === 409) { msg("这张卡已处理过"); setTimeout(() => location.reload(), 800); return; }
  msg(r.ok ? "✅ 已记录：" + (b.text ?? choice) : b.error ?? "失败 " + r.status);
  if (r.ok) setTimeout(() => location.reload(), 800);
}
async function answer(key, risk) {
  if (risk && !confirm("这是高风险操作（合并 / 发布等，可能不可撤回）。确认执行？")) return msg("已取消");
  await post(key, true);
}
function other() {
  const t = document.getElementById("ans").value.trim();
  if (t) void post(t, true); // typing + submit is the deliberate second step: free text confirms like a risky tap
  return false;
}
</script>`);
}
