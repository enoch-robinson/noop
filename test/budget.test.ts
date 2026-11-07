// Hard rule: Noop runs on Cloudflare's free plan (cloud/src/budget.ts, AGENTS.md). One simulated fleet day — three
// machines ticking every minute, each writing a heartbeat and journal lines and working through tasks — must stay
// under TARGET (a fifth of the free plan) in requests and rows written. Raising a pace or adding a sync round trip
// that breaks this needs a design change, not a bigger number here.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAZY_PUSH_MS, PULL_MIN_MS, TARGET } from "../cloud/src/budget";
import * as sync from "../src/sync";

const HOSTS = ["h1", "h2", "h3"], TASKS_PER_HOST = 40, DAY_MIN = 24 * 60;
/** Cloudflare bills index rows too: files (pk + rev index) and history (pk + path index) roughly triple SQLite's count. */
const INDEX_FACTOR = 3;
/** Traffic outside the files API on the same day (src/cloud.ts, app/App.tsx): dashboard pushes on every shape change
 *  plus one every ~15 min, two inbox reads per owner message, owner sends, socket pings at 1/20 of a request, and the
 *  owner app's status fetch on each reconnect. Each costs about two rows written where it writes at all. Button
 *  answers (Slack/Discord callbacks, ntfy http actions, /api/answer) need no line here: they are owner-triggered —
 *  one request per human click, and their inbox event rows are already counted with the owner sends below. */
const CHANNEL_REQUESTS = (HOSTS.length * TASKS_PER_HOST * 2 + 1) * 3; // three owner clients, pushed membership changes only
const OTHER_REQUESTS = CHANNEL_REQUESTS + (HOSTS.length * TASKS_PER_HOST * 2 + 96) + 50 * 3 + Math.ceil(DAY_MIN / 20) + 50;
const OTHER_ROWS = (HOSTS.length * TASKS_PER_HOST * 2 + 96) * 2 + 50 * 6 + 2_000; // + events the fleet reports

let W = "", t: sync.Transport;
const saved = { ...sync.syncTiming };
beforeAll(async () => {
  W = mkdtempSync(join(tmpdir(), "noop-budget-"));
  t = await sync.fakeTransport(join(W, "worker.sqlite"), "budget");
});
afterAll(() => { Object.assign(sync.syncTiming, saved); try { rmSync(W, { recursive: true, force: true }); } catch {} });

test("a fleet day stays under the free-plan target", async () => {
  let clock = Date.parse("2026-11-07T00:00:00Z");
  Object.assign(sync.syncTiming, { now: () => clock, pullMinMs: PULL_MIN_MS, lazyPushMs: LAZY_PUSH_MS });
  const dirs = Object.fromEntries(HOSTS.map((h) => { const d = join(W, h, "data"); mkdirSync(d, { recursive: true }); return [h, d]; }));
  const as = (h: string) => { sync.setSyncData(dirs[h]); sync.setTransport(t); return dirs[h]; };
  for (const [h, d] of Object.entries(dirs)) {
    mkdirSync(join(d, "channels"), { recursive: true });
    writeFileSync(join(d, "channels", `${h}-quality.md`), `---\nname: ${h} quality\ngoal: Reliability\nstatus: active\n---\n`);
  }
  const workAt = new Set(Array.from({ length: TASKS_PER_HOST }, (_, i) => Math.floor((i + 0.5) * DAY_MIN / TASKS_PER_HOST)));

  for (let minute = 0; minute < DAY_MIN; minute++) {
    for (const [i, h] of HOSTS.entries()) {
      const d = as(h);
      await sync.pull(); // the tick
      mkdirSync(join(d, "fleet", "hosts"), { recursive: true });
      writeFileSync(join(d, "fleet", "hosts", `${h}.json`), JSON.stringify({ host: h, seen: new Date(clock).toISOString(), busy: 0 }));
      mkdirSync(join(d, "journal"), { recursive: true });
      appendFileSync(join(d, "journal", "2026-11-07.md"), `- ${minute} [${h}] tick\n`);
      if (workAt.has(minute)) { // one task: claimed, then finished a little later in the same minute, as a quick task would
        const id = `T-${i}${String(minute).padStart(4, "0")}`;
        mkdirSync(join(d, "tasks", "active"), { recursive: true }); mkdirSync(join(d, "tasks", "done"), { recursive: true });
        writeFileSync(join(d, "tasks", "active", `${id}.md`), `---\nid: ${id}\nchannels: ${h}-quality\n---\nwork\n`);
        await sync.pull(); expect(await sync.commitPush(`claim ${id}`)).toBe(true);
        appendFileSync(join(d, "journal", "2026-11-07.md"), `- ${minute} [${h}] ✅ ${id}\n`);
        renameSync(join(d, "tasks", "active", `${id}.md`), join(d, "tasks", "done", `${id}.md`));
        await sync.pull(); expect(await sync.commitPush(`done ${id}`)).toBe(true);
      }
      await sync.commitPush("tick");
    }
    clock += 60_000;
  }

  const requests = t.meter!.requests + OTHER_REQUESTS;
  const rowsWritten = t.meter!.rowsWritten * INDEX_FACTOR + OTHER_ROWS;
  console.log(`fleet day: ${requests} requests (target ${TARGET.requests}), ~${rowsWritten} rows written (target ${TARGET.rowsWritten})`);
  expect(requests).toBeLessThanOrEqual(TARGET.requests);
  expect(rowsWritten).toBeLessThanOrEqual(TARGET.rowsWritten);
}, 120_000);
