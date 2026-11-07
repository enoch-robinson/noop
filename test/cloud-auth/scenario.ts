// End-to-end auth scenario against `wrangler dev` + fake-smtp.ts. See README at top of fake-smtp.ts.
// Usage: BASE=http://localhost:8799 TOKEN=<HUB_TOKEN var> OUT=<fake smtp dir> bun test/cloud-auth/scenario.ts
import { readdirSync, readFileSync } from "node:fs";
const BASE = process.env.BASE ?? "http://localhost:8799", TOKEN = process.env.TOKEN ?? "machinetok", OUT = process.env.OUT!;
const OWNER = "Owner@Example.com";
let fail = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) fail++; };
const post = (p: string, b: unknown, h: Record<string, string> = {}) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(b) });
const mails = () => readdirSync(OUT).filter((f) => f.endsWith(".eml")).sort((a, b) => parseInt(a) - parseInt(b));
const lastCode = () => {
  const m = readFileSync(`${OUT}/${mails().at(-1)}`, "utf8");
  const subj = Buffer.from(m.match(/Subject: =\?UTF-8\?B\?(\S+)\?=/)![1], "base64").toString();
  const body = Buffer.from(m.split("\r\n\r\n")[1].replace(/\s/g, ""), "base64").toString();
  return { m, subj, body, code: subj.match(/(\d{6})/)![1] };
};
const wait = () => new Promise((r) => setTimeout(r, 300));

ok((await fetch(BASE + "/api/status")).status === 401, "no credential → 401");
ok((await fetch(BASE + "/api/status", { headers: { authorization: `Bearer ${TOKEN}` } })).status === 200, "HUB_TOKEN bearer works");
ok((await post("/api/auth/start", { email: "nope" })).status === 400, "malformed email → 400");

let n0 = mails().length;
let r = await post("/api/auth/start", { email: OWNER });
ok(r.status === 200, `start (owner) → ${r.status}`); await wait();
ok(mails().length === n0 + 1, "one mail captured");
let mail = lastCode();
ok(mail.subj === `Agent Hub 登录验证码：${mail.code}`, `subject: ${mail.subj}`);
ok(mail.body.includes(mail.code) && mail.body.includes("10 分钟内有效") && mail.body.includes("如果不是你本人操作，请忽略这封邮件。"), "body has code + validity + ignore line");
ok(/^Date: /m.test(mail.m) && /^Message-ID: <.+@example\.com>/m.test(mail.m) && /^To: owner@example\.com/m.test(mail.m), "Date / Message-ID / To headers");

const wrong = mail.code === "000000" ? "111111" : "000000";
for (let i = 0; i < 5; i++) ok((await post("/api/auth/verify", { email: OWNER, code: wrong })).status === 401, `wrong code #${i + 1} → 401`);
r = await post("/api/auth/verify", { email: OWNER, code: mail.code });
ok(r.status === 401, `correct code after 5 failures → 401 locked (${JSON.stringify(await r.json())})`);

r = await post("/api/auth/start", { email: OWNER });
ok(r.status === 429, `resend within 60s → 429 (${JSON.stringify(await r.json())})`);

// second owner address: fresh per-email window
n0 = mails().length;
ok((await post("/api/auth/start", { email: "second@example.com" })).status === 200, "start (second owner) → 200"); await wait();
ok(mails().length === n0 + 1, "new mail captured");
mail = lastCode();
r = await post("/api/auth/verify", { email: "second@example.com", code: mail.code }, { "user-agent": "scenario/1" });
const { session } = (await r.json()) as { session: string };
ok(r.status === 200 && /^[0-9a-f]{64}$/.test(session), "verify OK → session (64 hex)");
ok((await post("/api/auth/verify", { email: "second@example.com", code: mail.code })).status === 401, "code is single-use");
const auth = { authorization: `Bearer ${session}` };
ok((await fetch(BASE + "/api/status", { headers: auth })).status === 200, "session works on /api/status");
ok((await fetch(BASE + `/api/status?token=${session}`)).status === 200, "session works as ?token=");
const ws = await new Promise<boolean>((res) => {
  const w = new WebSocket(BASE.replace("http", "ws") + `/api/stream?token=${session}`);
  w.onopen = () => { w.close(); res(true); }; w.onerror = () => res(false); setTimeout(() => res(false), 5000);
});
ok(ws, "WebSocket ?token=<session> opens");
const wsBad = await new Promise<boolean>((res) => {
  const w = new WebSocket(BASE.replace("http", "ws") + `/api/stream?token=${"a".repeat(64)}`);
  w.onopen = () => { w.close(); res(true); }; w.onerror = () => res(false); setTimeout(() => res(false), 5000);
});
ok(!wsBad, "WebSocket with bogus token refused");
// /api/answer: the one endpoint every channel's buttons post to (owner session; machines never answer)
ok((await post("/api/answer", { card: "D-0012", choice: "A" })).status === 401, "answer without credential → 401");
ok((await post("/api/answer", { card: "D-0012", choice: "A" }, { authorization: `Bearer ${TOKEN}` })).status === 403, "machine token cannot answer");
ok((await post("/api/answer", { card: "X-1", choice: "A" }, auth)).status === 400, "bad card id → 400");
ok((await post("/api/answer", { card: "D-0012", choice: "" }, auth)).status === 400, "empty choice → 400");
ok((await post("/api/answer", { card: "d-0012", choice: "A" }, auth)).status === 200, "answer (owner session, lowercase card normalized) → 200");
ok((await post("/api/answer", { card: "D-0012", choice: "A" }, auth)).status === 200, "duplicate click accepted: idempotency is decided by the fleet (inbox dedupe + closed card), not the API");
ok((await post("/api/host/revoke-sessions", {}, auth)).status === 403, "session cannot revoke-sessions");
// channel button callbacks: their own signature auth outside the Bearer gate; unconfigured → 503, configured → 403 on garbage
ok([503, 403].includes((await post("/api/slack/interactive", {})).status), "slack interactive: unconfigured → 503, else invalid signature → 403");
ok([503, 403].includes((await post("/api/discord/interactive", { type: 1 })).status), "discord interactive: unconfigured → 503, else invalid signature → 403");
ok((await post("/api/answer", { card: "D-0012", choice: "A" }, { authorization: "Bearer not-a-real-token" })).status === 401,
  "answer-token gate: an unknown bearer never reaches /api/answer");
ok((await post("/api/host/join", {}, { authorization: `Bearer ${"b".repeat(40)}` })).status === 401,
  "unknown bearer cannot reach /api/host/join (which returns HUB_TOKEN)");
// the full answer-token contract (POST /api/answer only, nothing else) needs the real token: pass ANSWER_TOKEN=<hex>
const ANSWER = process.env.ANSWER_TOKEN;
if (ANSWER) {
  ok((await post("/api/answer", { card: "D-0012", choice: "A" }, { authorization: `Bearer ${ANSWER}` })).status === 200, "answer token answers /api/answer");
  ok((await post("/api/host/join", {}, { authorization: `Bearer ${ANSWER}` })).status === 401, "answer token CANNOT reach /api/host/join");
  ok((await fetch(BASE + "/api/files/read?path=memory/lessons.md", { headers: { authorization: `Bearer ${ANSWER}` } })).status === 401, "answer token cannot read files");
  ok((await fetch(BASE + "/api/status", { headers: { authorization: `Bearer ${ANSWER}` } })).status === 401, "answer token cannot read status/feed");
  ok((await post("/api/messages", { text: "x" }, { authorization: `Bearer ${ANSWER}` })).status === 401, "answer token cannot post owner messages");
}
ok((await post("/api/auth/logout", {}, auth)).status === 200, "logout → 200");
ok((await fetch(BASE + "/api/status", { headers: auth })).status === 401, "after logout → 401");

// non-owner: refused outright, no mail
n0 = mails().length;
ok((await post("/api/auth/start", { email: "stranger@example.com" })).status === 403, "non-owner → 403"); await wait();
ok(mails().length === n0, "non-owner gets no mail");

// revoke-sessions with HUB_TOKEN
r = await post("/api/host/revoke-sessions", {}, { authorization: `Bearer ${TOKEN}` });
ok(r.status === 200, `revoke-sessions (machine) → ${JSON.stringify(await r.json())}`);
ok((await fetch(BASE + "/api/status", { headers: { authorization: `Bearer ${TOKEN}` } })).status === 200, "HUB_TOKEN still works");

if (process.env.WAIT) { // same owner after the 60s window: new code replaces the locked one
  await new Promise((r) => setTimeout(r, 61_000));
  n0 = mails().length;
  ok((await post("/api/auth/start", { email: OWNER })).status === 200, "owner re-requests after 60s → 200"); await wait();
  ok(mails().length === n0 + 1, "new mail captured");
  r = await post("/api/auth/verify", { email: OWNER, code: lastCode().code });
  const s2 = ((await r.json()) as any).session;
  ok(r.status === 200 && !!s2, "new code verifies → session");
  ok((await fetch(BASE + "/api/status", { headers: { authorization: `Bearer ${s2}` } })).status === 200, "new session works");
}

// hourly cap: 10 real sends/hour overall (2 used above) — use distinct owner-case aliases isn't possible, so hit the
// cap with owner addresses only via the per-email window: here we just confirm the per-email 429 path above and
// exercise the overall cap by listing more owners in HUB_OWNER_EMAIL if configured.
const extra = (process.env.EXTRA_OWNERS ?? "").split(",").filter(Boolean);
if (extra.length) {
  const codes: number[] = [];
  for (const e of extra) codes.push((await post("/api/auth/start", { email: e })).status);
  ok(codes.includes(429) && codes.indexOf(429) === 10 - (process.env.WAIT ? 3 : 2), `overall cap: statuses ${codes.join(",")}`);
}
console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
