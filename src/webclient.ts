// The web client the primary and the Worker serve comes from the latest release, not from git: machines
// have no nsh to build it. It lands in app/dist/web/noop, which `app/build-web.sh` writes in development.
import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const ASSET = "noop-web.tar.gz";
const WEB_DIR = join(import.meta.dir, "..", "app", "dist", "web");
const LATEST = "https://github.com/huacnlee/noop/releases/latest/download";

const fetched = async (url: string, seconds: number) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(seconds * 1000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
};

/**
 * Brings the web client up to the latest release's, verified against its sha256sums. A client built locally
 * (one with no record of a release) stays. Returns whether a client is in place: a failed download keeps the
 * one there, so this never throws or leaves less than it found.
 */
export async function ensureWebClient(dir = WEB_DIR, base = process.env.NOOP_CLIENT_BASE_URL ?? LATEST): Promise<boolean> {
  const client = join(dir, "noop");
  const record = join(dir, ".release"); // beside the client: the Worker uploads everything inside it
  const present = () => existsSync(join(client, "index.html"));
  if (present() && !existsSync(record)) return true;
  const work = join(dir, `.download-${process.pid}`);
  try {
    const sums = await (await fetched(`${base}/sha256sums`, 15)).text();
    const expected = sums.split("\n").map((l) => l.trim().split(/\s+\*?/)).find(([, name]) => name === ASSET)?.[0];
    if (!expected) throw new Error(`${ASSET} is not in the release`);
    if (present() && readFileSync(record, "utf8").trim() === expected) return true;
    const bytes = await (await fetched(`${base}/${ASSET}`, 180)).arrayBuffer();
    const actual = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    if (actual !== expected) throw new Error(`${ASSET}: checksum ${actual}, expected ${expected}`);
    const out = join(work, "noop");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(work, ASSET), new Uint8Array(bytes));
    // Run inside work with relative names: tar on Windows reads an absolute "C:\..." path as a remote host.
    const tar = await $`tar -xzf ${ASSET} -C noop`.cwd(work).quiet().nothrow();
    if (tar.exitCode !== 0 || !existsSync(join(out, "index.html"))) throw new Error(`${ASSET}: not a web client`);
    rmSync(client, { recursive: true, force: true });
    renameSync(out, client);
    writeFileSync(record, `${expected}\n`);
    console.log(`web client updated (${expected.slice(0, 7)})`);
    return true;
  } catch (e) {
    console.error(`web client not updated: ${(e as Error).message}`);
    return present();
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
