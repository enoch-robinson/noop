import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startModel } from "../src/runner";

test("startModel reads the explicit flag, else Codex's config default", () => {
  expect(startModel("claude", ["claude", "-p", "--model", "claude-opus-5-5"])).toBe("claude-opus-5-5");
  expect(startModel("codex", ["codex", "exec", "-m", "gpt-x", "-"])).toBe("gpt-x");
  const home = mkdtempSync(join(tmpdir(), "codex-"));
  writeFileSync(join(home, "config.toml"), 'model = "gpt-6"\n');
  expect(startModel("codex", ["codex", "exec", "-"], home)).toBe("gpt-6");
  expect(startModel("claude", ["claude", "-p"])).toBeUndefined();
});
