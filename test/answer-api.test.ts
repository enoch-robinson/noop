// /api/answer body validation (cloud/src/answer.ts): the one endpoint every owner channel's buttons post to.
import { expect, test } from "bun:test";
import { choiceKey, needsConfirm, parseAnswer } from "../cloud/src/answer";

test("parseAnswer normalizes the card id and keeps free-text choices", () => {
  expect(parseAnswer({ card: "d-0012", choice: "A" })).toEqual({ text: "D-0012 A", ref: "D-0012" });
  expect(parseAnswer({ card: "P-0007", choice: "1,3" })).toEqual({ text: "P-0007 1,3", ref: "P-0007" });
  expect(parseAnswer({ card: "D-0012", choice: "override 合并太小了" })).toEqual({ text: "D-0012 override 合并太小了", ref: "D-0012" });
});

test("parseAnswer rejects malformed bodies, including non-string fields", () => {
  for (const bad of [null, {}, { card: "X-1", choice: "A" }, { card: "D-1", choice: "A" },
    { card: "D-0012", choice: "" }, { card: "D-0012", choice: "x".repeat(501) },
    { card: "D-0012", choice: {} }, { card: "D-0012", choice: 123 },
    { card: {}, choice: "A" }, { card: "x".repeat(13), choice: "A" }])
    expect("error" in parseAnswer(bad)).toBe(true);
  expect("error" in parseAnswer({ card: "D-0012", choice: "A" })).toBe(false);
});

const CARD = `---
id: D-0012
question: 现在合并吗？
options_json: [{"key":"A","label":"A: merge now","recommended":true,"risk":"high"},{"key":"B","label":"B: wait"}]
---
## Context
CI is green
`;

test("needsConfirm: high-risk options and free text on a gated card require the flag; legacy cards never do", () => {
  expect(needsConfirm(CARD, "A")).toBe(true);
  expect(needsConfirm(CARD, "a: merge now")).toBe(true); // key match is case-insensitive
  expect(needsConfirm(CARD, "B")).toBe(false);
  expect(needsConfirm(CARD, "override 重新决定")).toBe(true); // pure-function view: a veto is free text on a gated
  // card — the Worker skips confirmNeeded for judge-card vetoes upstream (vetoable), so this never bites there
  expect(needsConfirm(CARD, "不合并，等 CI 全绿再发")).toBe(true); // free text on a gated card confirms too —
  // otherwise "merge it now" would walk past the gate the A button is subject to
  expect(needsConfirm(CARD.replace('"risk":"high"', ""), "等下再说")).toBe(false); // no high-risk option: free text stays one-step
  expect(needsConfirm("---\nid: D-1\n---\nno structured options", "A")).toBe(false); // legacy card
  expect(needsConfirm("---\noptions_json: not json\n---\n", "A")).toBe(false); // corrupt: fail open, fleet gates hold
});

test("choiceKey reads the leading letter/number like the fleet's own keyOf", () => {
  expect(choiceKey("B: wait")).toBe("B");
  expect(choiceKey("1,3")).toBe("1");
  expect(choiceKey("override 合并")).toBe(""); // a word, not a key: no separator right after the first letter
  expect(choiceKey("继续等 CI")).toBe("");
});
