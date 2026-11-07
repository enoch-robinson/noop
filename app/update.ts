// When the app looks for a newer version of itself. It downloads quietly and only surfaces once there is something
// to press, so nothing here interrupts; the restart stays the owner's. No UI, no I/O of its own: nsh/updater is passed in.
//
// A release ships two ways. A signed package (.nshpkg) carries only the app's TSX and reaches every installed app,
// iOS and Android included, with no store build: it is downloaded and verified in the background and runs from the
// next launch on, so on a phone the update is silent. Only a release that needs a newer NSH runtime than the
// installed app has comes as a whole app (an archive the desktop replaces itself with, a link elsewhere).

export type FoundUpdate = { version: string; url: string; canInstall: boolean };
export type FoundPackage = { version: string; build: number };

export type PackageApi = {
  /** A newer package this runtime can run, or null. */
  check: () => Promise<FoundPackage | null>;
  /** Downloads and verifies it; it runs from the next launch. */
  download: () => Promise<void>;
  /** Restarts into it now; null where the platform cannot restart an app (iOS, Android). */
  restart: (() => Promise<void>) | null;
  /** The package this run's code came from, or null when it is the app's own. */
  running?: () => FoundPackage | null;
};

export type UpdaterApi = {
  check: () => Promise<FoundUpdate | null>;
  download: () => Promise<void>;
  install: () => Promise<void>;
  packages?: PackageApi;
};

export type UpdateState =
  | { kind: "none" }
  /** Downloaded and verified: a restart applies it (a package's restart when `package`). */
  | { kind: "ready"; version: string; package?: true }
  /** A package downloaded where the app cannot restart itself: it runs from the next launch, nothing to press. */
  | { kind: "staged"; version: string }
  /** The app cannot replace itself (Android, a system package): the owner gets it from the link. */
  | { kind: "link"; version: string; url: string }
  | { kind: "installing"; version: string }
  | { kind: "failed"; version: string; message: string; package?: true };

export const CHECK_EVERY_MS = 60 * 60 * 1000;

export function createUpdates(api: UpdaterApi, onChange: (state: UpdateState) => void) {
  let state: UpdateState = { kind: "none" };
  let busy = false;
  const set = (next: UpdateState) => {
    state = next;
    onChange(next);
  };

  /** A failed check or download stays silent and the next tick tries again: a blip is not worth a banner. */
  async function check() {
    // A download waiting for its restart keeps being checked: a newer release replaces it, so the restart lands on
    // the latest instead of one version short (nsh/updater keeps the held download when the same version comes back).
    if (busy || state.kind === "installing" || state.kind === "failed") return;
    busy = true;
    let downloading = false;
    try {
      if (await checkPackage()) return;
      const found = await api.check();
      if (!found || runsAtLeast(found.version)) { if (state.kind !== "none") set({ kind: "none" }); return; }
      if (!found.canInstall) return set({ kind: "link", version: found.version, url: found.url });
      if (state.kind === "ready" && state.version === found.version) return;
      downloading = true;
      await api.download();
      set({ kind: "ready", version: found.version });
    } catch (e) {
      console.warn("update check failed:", String(e));
      // A newer download that failed has already replaced the held one, so there is nothing left to restart into.
      if (downloading && state.kind === "ready") set({ kind: "none" });
    } finally {
      busy = false;
    }
  }

  /** True when a package is the update (downloaded now, or already held). A failure falls through to the app check. */
  async function checkPackage(): Promise<boolean> {
    const p = api.packages;
    if (!p) return false;
    try {
      const found = await p.check();
      if (!found) return false;
      const held = state.kind === "staged" || (state.kind === "ready" && state.package) ? state.version : null;
      if (held === found.version) return true;
      await p.download();
      set(p.restart ? { kind: "ready", version: found.version, package: true } : { kind: "staged", version: found.version });
      return true;
    } catch (e) {
      console.warn("package update failed:", String(e));
      return false;
    }
  }

  /** The whole app's version is the one it was built for, so a run on a package of that release or later is current. */
  function runsAtLeast(version: string): boolean {
    const running = api.packages?.running?.();
    return !!running && compareVersions(running.version, version) >= 0;
  }

  /** Exits this run when it works; a failure leaves the app as it was, and the same download can be tried again. */
  async function install() {
    if (state.kind !== "ready" && state.kind !== "failed") return;
    const { version } = state;
    const restart = state.package ? api.packages?.restart : null;
    set({ kind: "installing", version });
    try {
      await (restart ? restart() : api.install());
    } catch (e) {
      set({ kind: "failed", version, message: e instanceof Error ? e.message : String(e), ...(restart ? { package: true as const } : {}) });
    }
  }

  return { check, install };
}

/** Compares dotted release numbers (`0.2.10` > `0.2.9`); a missing part counts as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0), pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** `nsh/updater`'s `shellInfo()`: the installed app (its shell) and the NSH runtime built into it. */
export type ShellInfo = { version: string | null; build: number | null; nshVersion: string; packages: boolean };

/**
 * The shell's line in the version list. `info` undefined: the runtime predates `shellInfo`, which says nothing about
 * whether it takes packages (shells from 0.2.1 do), so there is no line.
 */
export function shellLine(info: ShellInfo | undefined, os: string): { text: string; tone: "ok" | "bad" } | null {
  const phone = os === "ios" || os === "android";
  if (!info) return null;
  if (phone && !info.packages) return { text: "no-packages", tone: "bad" };
  return { text: `${info.version ?? "dev"}${info.build != null ? ` (${info.build})` : ""} · NSH ${info.nshVersion}`, tone: "ok" };
}
