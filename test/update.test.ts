import { expect, test } from "bun:test";
import { compareVersions, createUpdates, type FoundUpdate, type UpdateState } from "../app/update";

function setup(found: FoundUpdate | null) {
  const states: UpdateState[] = [];
  const calls: string[] = [];
  const api = {
    check: async () => { calls.push("check"); return found; },
    download: async () => { calls.push("download"); },
    install: async () => { calls.push("install"); },
  };
  return { api, calls, states, last: () => states[states.length - 1], updates: createUpdates(api, (s) => states.push(s)) };
}
const update = { version: "1.2.0", url: "https://example.com/a.tar.gz", canInstall: true };

test("an update is downloaded before anything shows, and only a press installs it", async () => {
  const t = setup(update);
  await t.updates.check();
  expect(t.calls).toEqual(["check", "download"]);
  expect(t.states).toEqual([{ kind: "ready", version: "1.2.0" }]);
  await t.updates.install();
  expect(t.calls).toEqual(["check", "download", "install"]);
});

test("checking again does not drop a download that waits for its restart", async () => {
  const t = setup(update);
  await t.updates.check();
  await t.updates.check();
  expect(t.calls).toEqual(["check", "download", "check"]);
});

test("a newer release while one waits for its restart replaces it", async () => {
  const t = setup(update);
  await t.updates.check();
  t.api.check = async () => { t.calls.push("check"); return { ...update, version: "1.3.0" }; };
  await t.updates.check();
  expect(t.calls).toEqual(["check", "download", "check", "download"]);
  expect(t.last()).toEqual({ kind: "ready", version: "1.3.0" });
});

test("an update the app cannot install is a link, with no download", async () => {
  const t = setup({ ...update, canInstall: false });
  await t.updates.check();
  expect(t.calls).toEqual(["check"]);
  expect(t.last()).toEqual({ kind: "link", version: "1.2.0", url: update.url });
});

test("up to date shows nothing", async () => {
  const t = setup(null);
  await t.updates.check();
  expect(t.states).toEqual([]);
  await t.updates.install();
  expect(t.calls).toEqual(["check"]);
});

test("a failed check or download stays quiet, and the next check tries again", async () => {
  const t = setup(update);
  const download = t.api.download;
  t.api.download = async () => { throw new Error("offline"); };
  await t.updates.check();
  expect(t.states).toEqual([]);
  t.api.download = download;
  await t.updates.check();
  expect(t.last()).toEqual({ kind: "ready", version: "1.2.0" });
});

test("a failed install says why and can be pressed again", async () => {
  const t = setup(update);
  await t.updates.check();
  const install = t.api.install;
  t.api.install = async () => { throw new Error("no space"); };
  await t.updates.install();
  expect(t.last()).toEqual({ kind: "failed", version: "1.2.0", message: "no space" });
  t.api.install = install;
  await t.updates.install();
  expect(t.states.map((s) => s.kind)).toEqual(["ready", "installing", "failed", "installing"]);
});

function withPackages(found: { version: string; build: number } | null, restart = true) {
  const t = setup(update);
  const packages = {
    check: async () => { t.calls.push("pkg-check"); return found; },
    download: async () => { t.calls.push("pkg-download"); },
    restart: restart ? async () => { t.calls.push("pkg-restart"); } : null,
    running: (() => null) as () => { version: string; build: number } | null,
  };
  const api = { ...t.api, packages };
  const updates = createUpdates(api, (s) => t.states.push(s));
  return { ...t, packages, updates };
}
const pkg = { version: "1.2.0", build: 42 };

test("a package is preferred over the whole app, and a press restarts into it", async () => {
  const t = withPackages(pkg);
  await t.updates.check();
  expect(t.calls).toEqual(["pkg-check", "pkg-download"]);
  expect(t.last()).toEqual({ kind: "ready", version: "1.2.0", package: true });
  await t.updates.install();
  expect(t.calls).toEqual(["pkg-check", "pkg-download", "pkg-restart"]);
});

test("where the app cannot restart itself a package is staged silently for the next launch", async () => {
  const t = withPackages(pkg, false);
  await t.updates.check();
  expect(t.last()).toEqual({ kind: "staged", version: "1.2.0" });
  await t.updates.install();
  expect(t.calls).toEqual(["pkg-check", "pkg-download"]);
  await t.updates.check(); // the same package is not downloaded again
  expect(t.calls).toEqual(["pkg-check", "pkg-download", "pkg-check"]);
});

test("with no package this runtime can run, the whole app updates as before", async () => {
  const t = withPackages(null);
  await t.updates.check();
  expect(t.calls).toEqual(["pkg-check", "check", "download"]);
  expect(t.last()).toEqual({ kind: "ready", version: "1.2.0" });
  await t.updates.install();
  expect(t.calls.at(-1)).toBe("install");
});

test("a failed package download falls back to the app check, and a failed restart retries the package", async () => {
  const t = withPackages(pkg);
  t.packages.download = async () => { throw new Error("bad signature"); };
  await t.updates.check();
  expect(t.calls).toEqual(["pkg-check", "check", "download"]);
  const t2 = withPackages(pkg);
  await t2.updates.check();
  t2.packages.restart = async () => { throw new Error("busy"); };
  await t2.updates.install();
  expect(t2.last()).toEqual({ kind: "failed", version: "1.2.0", message: "busy", package: true });
});

test("running a package of the release already, the whole app is not offered again", async () => {
  // The desktop restarted into the 0.2.1 package; latest.json still says 0.2.1 while the app itself is 0.2.0.
  const t = withPackages(null);
  t.packages.running = () => pkg;
  await t.updates.check();
  expect(t.calls).toEqual(["pkg-check", "check"]);
  expect(t.states).toEqual([]);
  // A release newer than the running package (one that needs a newer runtime) still comes as the whole app.
  const t2 = withPackages(null);
  t2.packages.running = () => ({ version: "1.1.9", build: 41 });
  await t2.updates.check();
  expect(t2.last()).toEqual({ kind: "ready", version: "1.2.0" });
});

test("release numbers compare by part", () => {
  expect(compareVersions("0.2.10", "0.2.9")).toBeGreaterThan(0);
  expect(compareVersions("0.2.1", "0.2.1")).toBe(0);
  expect(compareVersions("0.2", "0.2.1")).toBeLessThan(0);
});

test("shell line: version, build and NSH; a phone shell without packages says to reinstall", async () => {
  const { shellLine } = await import("../app/update");
  const info = { version: "0.2.1", build: 35, nshVersion: "0.4.0", packages: true };
  expect(shellLine(info, "ios")).toEqual({ text: "0.2.1 (35) · NSH 0.4.0", tone: "ok" });
  expect(shellLine({ ...info, version: null, build: null, packages: false }, "linux")).toEqual({ text: "dev · NSH 0.4.0", tone: "ok" });
  // a runtime without shellInfo says nothing either way
  expect(shellLine(undefined, "ios")).toBeNull();
  expect(shellLine(undefined, "macos")).toBeNull();
  expect(shellLine({ ...info, packages: false }, "android")).toEqual({ text: "no-packages", tone: "bad" });
});
