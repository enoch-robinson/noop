// CLI selection (src/core.ts allowedClis/chooseCli): a planner- or owner-pinned CLI that isn't installed must not
// park a task in the queue forever — it falls through to the rest of the pool. These tests are machine-independent:
// the expected CLI is computed from the registry filtered by Bun.which, mirroring the claim path's own filter.
import { expect, test } from "bun:test";
import { allowedClis, chooseCli, which } from "../src/core";
import { CLIS } from "../src/clis";

const cfg = {} as any;
const INSTALLED = CLIS.map((a) => a.name).filter(which);
const FIRST = INSTALLED[0]; // undefined on a host with no agent CLIs at all

test("a pinned but uninstalled CLI falls through; chooseCli returns the first installed one", () => {
  const got = chooseCli({ cli: "definitely-not-a-binary" }, cfg);
  expect(got).toBe(FIRST ?? null);
  const allowed = allowedClis({ cli: "definitely-not-a-binary" }, cfg);
  expect(allowed).not.toContain("definitely-not-a-binary");
});

test("a pinned installed CLI wins and stays first in the pool", () => {
  if (!FIRST) return; // nothing installed on this host; nothing to pin
  const allowed = allowedClis({ cli: FIRST }, cfg);
  expect(allowed[0]).toBe(FIRST);
  expect(chooseCli({ cli: FIRST }, cfg)).toBe(FIRST);
});

test("per-agent clis config restricts and orders the pool, uninstalled entries skipped", () => {
  const per = { clis: { agents: { lead: ["definitely-not-a-binary", ...(INSTALLED.length ? [INSTALLED[INSTALLED.length - 1]] : [])] } } } as any;
  expect(chooseCli({ agent: "lead" }, per)).toBe(INSTALLED.length ? INSTALLED[INSTALLED.length - 1] : null);
});

test("cli: auto means no pin; the whole registry is the pool, first installed wins", () => {
  expect(allowedClis({ cli: "auto" }, cfg)).toEqual(CLIS.map((a) => a.name));
  expect(chooseCli({ cli: "auto" }, cfg)).toBe(FIRST ?? null);
});
