// Session readers must survive every message shape: pi/omp v3 stores some message content as a plain
// string (system messages), and one unreadable file must never kill the learn run (2026-11-08: a string
// content threw out of readPiStyle, killed every daemon tick and starved the task queue for ~16 h).
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect, readPiStyle } from "../src/sessions";

const W = mkdtempSync(join(tmpdir(), "hub-sessions-"));
afterAll(() => rmSync(W, { recursive: true, force: true }));

const piSession = (messages: unknown[]) => messages.map((m) => JSON.stringify(m)).join("\n") + "\n";

test("readPiStyle: array content, plain-string content and missing content all parse", () => {
  const f = join(W, "mixed.jsonl");
  writeFileSync(f, piSession([
    { type: "session", cwd: "/home/x/proj" },
    { type: "message", message: { role: "system", content: "" } }, // pi v3: string content
    { type: "message", message: { role: "user", content: [{ type: "text", text: "帮我看下这个报错" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "好的" }] } },
    { type: "message", message: { role: "user", content: "直接说结论" } }, // string content, not an array
    { type: "message", message: { role: "user" } }, // no content at all
    "not json at all {{{", // a broken line is skipped, the session continues
  ]));
  const turns = readPiStyle(f, "pi");
  expect(turns.map((t) => t.text)).toEqual(["帮我看下这个报错", "直接说结论"]);
  expect(turns[0].project).toBe("proj");
  expect(turns[1].prev).toBe("好的");
});

test("collect(): files with only junk lines yield nothing, good sessions still land in the digest", () => {
  const dir = join(W, "pi-sessions");
  mkdirSync(dir, { recursive: true });
  const old = Date.now() - 3600_000;
  const good = join(dir, "good.jsonl");
  writeFileSync(good, piSession([
    { type: "session", cwd: "/home/x/proj" },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "这个 bug 怎么修" }] } },
  ]));
  const junk = join(dir, "junk.jsonl");
  writeFileSync(junk, "not json at all {{{\nalso not json\n");
  for (const f of [good, junk]) { const s = statSync(f); utimesSync(f, s.atime, new Date(old)); } // not a live session
  const r = collect({ learn: { pi_dir: dir, claude_dir: join(W, "none"), codex_dir: join(W, "none"), omp_dir: join(W, "none") } } as never);
  expect(r.turns).toBe(1);
  expect(r.sessions).toBe(1);
  expect(r.file).toContain("digest");
});
