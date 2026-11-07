// Channel card builders (src/cards.ts) + interactive-callback auth (cloud/src/slack.ts, cloud/src/discord.ts):
// pure functions, no I/O — the Worker routes that call them stay covered by test/cloud-auth/scenario.ts.
import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { buttonLabel, buttonOptions, discordComponents, ntfyActions, rfc2047, slackBody } from "../src/cards";
import { parseSlackPayload, verifySlack } from "../cloud/src/slack";
import { parseDiscordClick, verifyDiscord } from "../cloud/src/discord";
import type { CardOption } from "../src/server";

const opt = (key: string, label?: string, extra: Partial<CardOption> = {}): CardOption =>
  ({ key, label: label ?? key, ...extra });
const DECISION = [opt("A", "A: merge now", { recommended: true }), opt("B", "B: wait", { risk: "high" as const }),
  opt("", "直接关掉，不用问了")]; // free-form label: no button, typed replies only

test("buttonOptions keeps keyed options and drops free-form ones", () => {
  expect(buttonOptions("decision", DECISION).map((o) => o.key)).toEqual(["A", "B"]);
  expect(buttonOptions(undefined, DECISION)).toEqual(buttonOptions("decision", DECISION));
  expect(buttonOptions("decision", [])).toEqual([]);
  expect(buttonOptions("decision", undefined as any)).toEqual([]);
  expect(buttonOptions("decision", [opt("a b", "weird")]).map((o) => o.key)).toEqual([]); // key must be a plain word
});

test("proposals cards get all/none buttons only: a numbered tap would reject every unpicked item", () => {
  const batch = [opt("1", "1. 修 bug"), opt("2", "2. 升级依赖"), opt("all", "all（全做）"), opt("none", "none（都不做）")];
  expect(buttonOptions("proposals", batch).map((o) => o.key)).toEqual(["all", "none"]);
  expect(buttonOptions("decision", batch).map((o) => o.key)).toEqual(["1", "2", "all", "none"]);
  expect(buttonOptions("proposals", [opt("All", "All（全做）"), opt("NONE", "none")]).map((o) => o.key)).toEqual(["All", "NONE"]); // case-insensitive
});

test("buttonLabel strips the key prefix, keeps unprefixed labels whole, and caps with an ellipsis", () => {
  expect(buttonLabel(DECISION[0], 75)).toBe("merge now");
  expect(buttonLabel(opt("1", "1. 修 bug"), 75)).toBe("修 bug");
  expect(buttonLabel(opt("B", "b: wait"), 75)).toBe("wait"); // case-insensitive prefix
  expect(buttonLabel(opt("all", "all（全做）"), 75)).toBe("all（全做）"); // no separator: nothing stripped
  expect(buttonLabel(DECISION[2], 75)).toBe("直接关掉，不用问了");
  expect(buttonLabel(DECISION[0], 8)).toBe("merge n…");
  expect(buttonLabel(opt("", "no key"), 75)).toBe("no key");
});

test("slackBody keeps the fallback text and renders one button per keyed option", () => {
  const body = slackBody("合并吗？", "D-0012", "decision", DECISION);
  expect(body.text).toBe("合并吗？");
  const blocks = body.blocks as any[];
  expect(blocks[0].type).toBe("section");
  const els = blocks[1].elements;
  expect(els.map((e: any) => e.action_id)).toEqual(["answer:D-0012:A", "answer:D-0012:B"]);
  expect(els[0].style).toBe("primary"); // recommended
  expect(els[0].confirm).toBeUndefined();
  expect(els[1].style).toBe("danger"); // risky
  expect(els[1].confirm.title.text).toBe("高风险操作");
  expect(els.map((e: any) => e.text.text)).toEqual(["merge now", "wait"]); // prefix stripped, key rides the action_id
});

test("slackBody without a ref or buttons stays a plain message; the section never exceeds Slack's cap", () => {
  expect(slackBody("hi", undefined, "decision", DECISION)).toEqual({ text: "hi" });
  expect(slackBody("hi", "D-0012", "decision", [opt("", "自由文本")])).toEqual({ text: "hi" });
  const long = "x".repeat(4000);
  expect((slackBody(long, "D-0012", "decision", DECISION).blocks as any[])[0].text.text.length).toBe(2900);
  const many = Array.from({ length: 30 }, (_, i) => opt(String(i + 1)));
  expect(((slackBody("q", "D-0012", "decision", many).blocks as any[])[1].elements)).toHaveLength(25); // actions block cap
});

test("discordComponents chunk into rows of five with the right styles", () => {
  const rows = discordComponents("P-0007", [opt("A", "A: ship it", { recommended: true }), opt("B", "B: hold", { risk: "high" as const }),
    ...Array.from({ length: 5 }, (_, i) => opt(String(i + 1), `${i + 1}. item`))]);
  expect(rows).toHaveLength(2); // 7 buttons → a full row of five, then the remainder
  expect((rows[0] as any).components.map((c: any) => [c.style, c.custom_id, c.label])).toEqual([
    [1, "answer:P-0007:A", "ship it"], [4, "answer:P-0007:B", "hold"],
    ...Array.from({ length: 3 }, (_, i) => [2, `answer:P-0007:${i + 1}`, "item"])]); // prefix stripped on the button
  expect((rows[1] as any).components.map((c: any) => c.custom_id)).toEqual(["answer:P-0007:4", "answer:P-0007:5"]);
  expect(discordComponents("P-0007", Array.from({ length: 30 }, (_, i) => opt(String(i + 1))))
    .flatMap((r) => (r as any).components)).toHaveLength(25); // API max: 5 rows × 5 buttons
});

test("ntfyActions: safe options POST with confirm, risky ones open the card page; at most three actions", () => {
  // production always passes buttonOptions() output; here too
  const acts = ntfyActions("D-0012", buttonOptions("decision", DECISION), "https://hub.example.com/", "a".repeat(64));
  const parts = acts.split("; ");
  expect(parts).toHaveLength(2); // A + B; the free-form option has no button (ntfy's cap is 3)
  expect(parts[0]).toContain("https://hub.example.com/api/answer");
  expect(parts[0]).toContain("headers.Authorization=Bearer " + "a".repeat(64));
  expect(parts[0]).toContain(`body='{"card":"D-0012","choice":"A","confirm":true}'`); // one tap for safe options
  expect(parts[1]).toContain(`view, wait, https://hub.example.com/card/D-0012, clear=true`); // risky → card page
  expect(acts).toContain("merge now"); // label without comma stays bare
  for (const empty of [["", DECISION, "https://x", "tok"], ["D-0012", [], "https://x", "tok"],
    ["D-0012", DECISION, "", "tok"], ["D-0012", DECISION, "https://x", ""]] as any[][])
    expect(ntfyActions(empty[0] as string, empty[1] as any, empty[2] as string, empty[3] as string)).toBe("");
});

test("ntfyActions quotes labels that carry a comma and strips quotes from them", () => {
  const acts = ntfyActions("D-0012", [opt("A", "A: 等CI, 之后再合并"), opt("B", `B: 说"不"`), opt("C", "C: 并发=10 全量")], "https://x", "t");
  expect(acts.split("; ")[0]).toBe(`http, "等CI, 之后再合并", https://x/api/answer, method=POST, headers.Authorization=Bearer t, body='{"card":"D-0012","choice":"A","confirm":true}', clear=true`);
  expect(acts.split("; ")[1]).toContain("说 不"); // quotes stripped (they would break ntfy's param parsing), meaning kept
  expect(acts.split("; ")[2]).toContain('"并发=10 全量"'); // = would parse as a key=value param: quoted like , and ;
});

test("rfc2047 wraps non-ASCII header values so Bun's fetch cannot throw on a UTF-8 label", () => {
  expect(rfc2047("plain ascii")).toBe("plain ascii");
  const enc = rfc2047("http, 修 bug, https://x.example/api/answer, clear=true");
  expect(enc).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
  expect(Buffer.from(enc.match(/B\?([A-Za-z0-9+/=]+)\?=/)![1], "base64").toString("utf8")).toContain("修 bug");
});

// ---- Slack callback auth
const SLACK_SECRET = "feedface".repeat(8);
const slackSig = (ts: number, body: string) => `v0=${createHmac("sha256", SLACK_SECRET).update(`v0:${ts}:${body}`).digest("hex")}`;

test("verifySlack accepts Slack's own v0 signature and refuses replays and tampering", async () => {
  const body = `payload=${encodeURIComponent(JSON.stringify({ type: "block_actions" }))}`;
  const ts = Math.floor(Date.now() / 1000);
  expect(await verifySlack(SLACK_SECRET, slackSig(ts, body), String(ts), body)).toBe(true);
  expect(await verifySlack(SLACK_SECRET, slackSig(ts, body + "x"), String(ts), body)).toBe(false); // tampered body
  expect(await verifySlack(SLACK_SECRET, slackSig(ts - 301, body), String(ts - 301), body)).toBe(false); // replay
  expect(await verifySlack(SLACK_SECRET, slackSig(ts, body), String(ts + 400), body)).toBe(false); // skewed timestamp
  expect(await verifySlack(SLACK_SECRET, "v0=deadbeef", String(ts), body)).toBe(false);
  expect(await verifySlack("wrong secret", slackSig(ts, body), String(ts), body)).toBe(false);
});

test("parseSlackPayload extracts our answer buttons and ignores the rest", () => {
  const payload = { actions: [{ action_id: "answer:D-0012:A" }, { action_id: "other_thing" }],
    response_url: "https://hooks.slack.com/actions/T1/2/3" };
  const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  expect(parseSlackPayload(body)).toEqual({ clicks: [{ card: "D-0012", choice: "A" }], responseUrl: payload.response_url });
  for (const bad of ["", "payload=not json", `payload=${encodeURIComponent('{"actions":"x"}')}`])
    expect(parseSlackPayload(bad).clicks).toEqual([]);
});

// ---- Discord callback auth
test("discordComponents: risky options become card-page links when a base URL is known, else danger-styled", () => {
  const opts = [opt("A", "A: ship it", { recommended: true }), opt("B", "B: hold", { risk: "high" as const }), opt("C", "C: wait")];
  expect((discordComponents("D-0012", opts)[0] as any).components.map((c: any) => [c.style, c.custom_id ?? c.url])).toEqual([
    [1, "answer:D-0012:A"], [4, "answer:D-0012:B"], [2, "answer:D-0012:C"]]); // no base: danger stays, Worker gate catches it
  const linked = (discordComponents("D-0012", opts, "https://hub.test/")[0] as any).components;
  expect(linked[1]).toEqual({ type: 2, style: 5, url: "https://hub.test/card/D-0012", label: "hold" });
  expect(linked[0].custom_id).toBe("answer:D-0012:A"); // safe options keep posting
});

test("risk beats recommendation in button style on both channels; the Slack confirm still fires", () => {
  const both = opt("A", "A: 合并", { recommended: true, risk: "high" as const });
  const els = ((slackBody("q", "D-0012", "decision", [both]).blocks as any[])[1].elements);
  expect(els[0].style).toBe("danger");
  expect(els[0].confirm).toBeDefined();
  expect((discordComponents("D-0012", [both])[0] as any).components[0].style).toBe(4);
});

let ed = true;
try { await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]); } catch { ed = false; }

const hexOf = (u: Uint8Array) => [...u].map((x) => x.toString(16).padStart(2, "0")).join("");
const rawPubHex = async (k: CryptoKey) => {
  try { return hexOf(new Uint8Array(await crypto.subtle.exportKey("raw", k))); }
  catch { return hexOf(new Uint8Array(await crypto.subtle.exportKey("spki", k)).slice(-32)); } // spki ends with the raw point
};

test.skipIf(!ed)("verifyDiscord accepts its own Ed25519 signature, refuses tampering and malformed input", async () => {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as unknown as CryptoKeyPair;
  const pub = await rawPubHex(kp.publicKey);
  const body = JSON.stringify({ type: 3, data: { custom_id: "answer:D-0012:A" } });
  const ts = Math.floor(Date.now() / 1000), te = new TextEncoder();
  const sig = hexOf(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, te.encode(`${ts}${body}`))));
  expect(await verifyDiscord(pub, sig, String(ts), body)).toBe("ok");
  expect(await verifyDiscord(pub, sig, String(ts), body + " ")).toBe("bad");
  expect(await verifyDiscord(pub, sig, String(ts - 400), body)).toBe("bad"); // stale timestamp
  expect(await verifyDiscord(pub, "zz", String(ts), body)).toBe("bad"); // not hex
  expect(await verifyDiscord(pub, sig.slice(0, -2), String(ts), body)).toBe("bad"); // wrong length
  expect(await verifyDiscord("ab".repeat(16), sig, String(ts), body)).not.toBe("ok"); // wrong key
});

test("parseDiscordClick reads only our component clicks", () => {
  expect(parseDiscordClick({ type: 3, data: { custom_id: "answer:d-0009:none" } })).toEqual({ card: "D-0009", choice: "none" });
  expect(parseDiscordClick({ type: 1 })).toBe(null); // PING
  expect(parseDiscordClick({ type: 3, data: { custom_id: "someone_elses" } })).toBe(null);
  expect(parseDiscordClick({})).toBe(null);
});
