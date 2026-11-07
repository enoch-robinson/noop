// The /card/<id> page: parse + render (pure module — the Worker route itself needs the Workers runtime).
import { expect, test } from "bun:test";
import { cardPage, parseCard } from "../cloud/src/card";

const OPEN = `---
id: D-0001
agent: lead
question: 现在合并 x #1 吗？
options_json: [{"key":"A","label":"A: merge","recommended":true,"risk":"high"},{"key":"B","label":"B: wait"}]
---

## Context
PR #1 fixes the CI
`;

test("parseCard reads frontmatter and the Context section", () => {
  const d = parseCard(OPEN)!;
  expect(d.meta.id).toBe("D-0001");
  expect(d.meta.agent).toBe("lead");
  expect(d.context).toBe("PR #1 fixes the CI");
  expect(parseCard("no frontmatter here")).toBeNull();
});

test("open card: keyed buttons with the in-page confirm; hostile text renders as text", () => {
  const html = cardPage("D-0001", true, OPEN, "tok", "https://x.example");
  expect(html).toContain("A: merge");
  expect(html).toContain("推荐");
  expect(html).toContain("高风险");
  expect(html).toContain("confirm("); // the two-step for gated options
  // the question is untrusted: it must render as text, never as markup
  const hostile = OPEN.replace("现在合并 x #1 吗？", "<img src=x onerror=alert(1)>");
  const page = cardPage("D-0002", true, hostile, "tok", "https://x.example");
  expect(page).not.toContain("<img src=x");
  expect(page).toContain("&lt;img src=x");
  // a hostile options_json key cannot break out of the onclick attribute
  const hostileKey = OPEN.replace('"key":"A"', '"key":"A\\", alert(1), \\""');
  const page2 = cardPage("D-0003", true, hostileKey, "tok", "https://x.example");
  expect(page2).toContain("&quot;");
  expect(page2).not.toMatch(/onclick="answer\("A"/); // raw quotes would have left the attribute
});

test("closed card: read-only final state; the veto form only on judge receipts", () => {
  const judgeClosed = `---\nid: D-0004\nagent: lead\nanswered_by: judge\nanswer: A\n---\n## Context\nx\n`;
  const ownerClosed = judgeClosed.replace("answered_by: judge", "answered_by: owner(chat)");
  const j = cardPage("D-0004", false, judgeClosed, "tok", "https://x.example");
  expect(j).toContain("已处理");
  expect(j).toContain("否决");
  const o = cardPage("D-0004", false, ownerClosed, "tok", "https://x.example");
  expect(o).toContain("已处理");
  expect(o).not.toContain("否决");
});

test("inline JSON cannot smuggle a </script> into the page", () => {
  const sneaky = "</script><script>alert(1)</script>";
  const page = cardPage("D-0005", false, `---\nid: D-0005\nanswered_by: judge\nanswer: A\n---\n`, sneaky, "https://x.example");
  // the token is embedded as JS string data: every "<" escaped, so no raw "</script>" survives inside the string
  expect(page).toContain("\\u003c/script>");
  expect(page).not.toContain(`"${sneaky}"`);
});
