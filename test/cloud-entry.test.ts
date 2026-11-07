// The Worker entry (cloud/src/index.ts) is bundled only by wrangler at deploy time: it sits outside the root
// tsconfig's include (src, test) and imports Workers-only virtual modules ("cloudflare:workers"), so this suite
// can't import it. Parse it here instead — a deploy-blocking syntax error (e.g. a merge resolution that kept both
// sides of a conflicted line) fails the suite instead of surfacing at the next `noop cloud deploy`.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("the worker entry parses clean (wrangler bundles it outside this suite)", () => {
  const src = readFileSync(join(import.meta.dir, "../cloud/src/index.ts"), "utf8");
  expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(src)).not.toThrow();
});
