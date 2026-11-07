// `hub visual …` — headless GUI sessions for agents: run apps without a monitor, screenshot, record, send input.
// Backends: sway (headless Wayland, GPU) → Xvfb (X11, always available) on Linux; native screencapture on macOS.
// State is per session name under ~/.noop/visual/<name>/ so parallel reviews never share a display.
import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HOME_DIR } from "./core";
import { CLIS } from "./clis";

const BASE = join(HOME_DIR, "visual");
type Sess = { name: string; backend: "sway" | "xvfb" | "macos"; env: Record<string, string>; pids: number[]; rec?: number; size: string };

const dir = (n: string) => join(BASE, n);
const load = (n: string): Sess => JSON.parse(readFileSync(join(dir(n), "session.json"), "utf8"));
const save = (s: Sess) => { mkdirSync(dir(s.name), { recursive: true }); writeFileSync(join(dir(s.name), "session.json"), JSON.stringify(s, null, 2)); };
const spawnBg = (cmd: string[], env: Record<string, string>, log: string) => {
  const p = Bun.spawn(cmd, { env: { ...process.env, ...env }, stdout: Bun.file(log), stderr: Bun.file(log), stdin: "ignore", detached: true });
  p.unref();
  return p.pid;
};

export function backendFor(): Sess["backend"] {
  if (process.platform === "darwin") return "macos";
  return Bun.which("sway") && Bun.which("wf-recorder") ? "sway" : "xvfb";
}

async function start(name: string, size = "1600x1000") {
  if (existsSync(join(dir(name), "session.json"))) await stop(name);
  mkdirSync(dir(name), { recursive: true });
  const backend = backendFor();
  const s: Sess = { name, backend, env: {}, pids: [], size };
  if (backend === "sway") {
    const rt = join(dir(name), "rt"); mkdirSync(rt, { recursive: true, mode: 0o700 });
    const conf = join(dir(name), "sway.conf");
    writeFileSync(conf, `output HEADLESS-1 resolution ${size}\ndefault_border none\nfocus_follows_mouse no\n`);
    const env = { WLR_BACKENDS: "headless", WLR_LIBINPUT_NO_DEVICES: "1", XDG_RUNTIME_DIR: rt, WAYLAND_DISPLAY: `wayland-hub-${name}` };
    s.pids.push(spawnBg(["sway", "-c", conf], { ...env, WAYLAND_DISPLAY: "" }, join(dir(name), "sway.log")));
    await Bun.sleep(1500);
    const sock = (await $`ls ${rt}`.quiet().nothrow()).stdout.toString().split("\n").find((f) => f.startsWith("wayland-") && !f.endsWith(".lock"));
    s.env = { XDG_RUNTIME_DIR: rt, WAYLAND_DISPLAY: sock ?? "wayland-1", XDG_SESSION_TYPE: "wayland" };
  } else if (backend === "xvfb") {
    const disp = `:${90 + Math.floor(Math.random() * 400)}`;
    s.pids.push(spawnBg(["Xvfb", disp, "-screen", "0", `${size}x24`, "-nolisten", "tcp"], {}, join(dir(name), "xvfb.log")));
    await Bun.sleep(800);
    // force X11 even if the parent shell is Wayland
    s.env = { DISPLAY: disp, WAYLAND_DISPLAY: "", XDG_SESSION_TYPE: "x11" };
  }
  save(s);
  console.log(JSON.stringify({ session: name, backend, env: s.env, hint: `hub visual run ${name} -- <cmd>` }));
}

async function run(name: string, cmd: string[]) {
  const s = load(name);
  const log = join(dir(name), `app-${Date.now()}.log`);
  const pid = spawnBg(cmd, s.env, log);
  s.pids.push(pid); save(s);
  console.log(JSON.stringify({ pid, log }));
}

async function shot(name: string, out: string) {
  const s = load(name);
  const env = { ...process.env, ...s.env };
  if (s.backend === "sway") await $`grim ${out}`.env(env);
  else if (s.backend === "xvfb") await $`ffmpeg -loglevel error -y -f x11grab -video_size ${s.size} -i ${s.env.DISPLAY} -frames:v 1 ${out}`.env(env);
  else await $`screencapture -x ${out}`;
  console.log(out);
}

async function recStart(name: string, out: string) {
  const s = load(name);
  const cmd = s.backend === "sway" ? ["wf-recorder", "-f", out]
    : s.backend === "xvfb" ? ["ffmpeg", "-loglevel", "error", "-y", "-f", "x11grab", "-framerate", "30", "-video_size", s.size, "-i", s.env.DISPLAY,
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]
    : ["screencapture", "-v", "-x", out];
  const p = Bun.spawn(cmd, { env: { ...process.env, ...s.env }, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
  p.unref();
  s.rec = p.pid; save(s);
  writeFileSync(join(dir(name), "rec.out"), out);
  console.log(JSON.stringify({ recording: out, pid: p.pid }));
}

async function recStop(name: string) {
  const s = load(name);
  if (s.rec) { try { process.kill(s.rec, "SIGINT"); } catch {} await Bun.sleep(1500); }
  s.rec = undefined; save(s);
  const out = readFileSync(join(dir(name), "rec.out"), "utf8");
  // keep recordings small enough for Slack/Discord (≤ ~20MB)
  const size = existsSync(out) ? Bun.file(out).size : 0;
  if (size > 20e6 && Bun.which("ffmpeg")) {
    const small = out.replace(/\.mp4$/, ".small.mp4");
    await $`ffmpeg -loglevel error -y -i ${out} -vf scale=1280:-2 -c:v libx264 -crf 32 -preset veryfast ${small}`.nothrow();
    console.log(small); return;
  }
  console.log(out);
}

async function input(name: string, args: string[]) {
  const s = load(name);
  const env = { ...process.env, ...s.env };
  const [kind, ...rest] = args;
  if (s.backend === "sway") {
    if (kind === "type") await $`wtype ${rest.join(" ")}`.env(env);
    else if (kind === "key") await $`wtype -k ${rest[0]}`.env(env);
    else if (kind === "click") await $`swaymsg seat - cursor set ${rest[0]} ${rest[1]}; swaymsg seat - cursor press button1; swaymsg seat - cursor release button1`.env(env).nothrow();
  } else if (s.backend === "xvfb") {
    if (!Bun.which("xdotool")) throw new Error("xdotool not installed (pacman -S xdotool)");
    if (kind === "type") await $`xdotool type --delay 30 ${rest.join(" ")}`.env(env);
    else if (kind === "key") await $`xdotool key ${rest[0]}`.env(env);
    else if (kind === "click") await $`xdotool mousemove ${rest[0]} ${rest[1]} click 1`.env(env);
  } else {
    if (kind === "type") await $`osascript -e ${`tell application "System Events" to keystroke "${rest.join(" ")}"`}`;
  }
}

export async function stop(name: string) {
  if (!existsSync(join(dir(name), "session.json"))) return;
  const s = load(name);
  for (const pid of [s.rec, ...s.pids.reverse()]) if (pid) try { process.kill(pid, "SIGTERM"); } catch {}
  rmSync(join(dir(name), "rt"), { recursive: true, force: true });
  rmSync(join(dir(name), "session.json"));
}

export async function visual(args: string[]) {
  const [sub, name = "default", ...rest] = args;
  const dd = rest.indexOf("--");
  switch (sub) {
    case "start": return start(name, rest[0]);
    case "run": return run(name, dd >= 0 ? rest.slice(dd + 1) : rest);
    case "shot": return shot(name, rest[0] ?? join(dir(name), `shot-${Date.now()}.png`));
    case "record": return recStart(name, rest[0] ?? join(dir(name), `rec-${Date.now()}.mp4`));
    case "stop-record": return recStop(name);
    case "input": return input(name, rest);
    case "stop": return stop(name);
    default:
      console.log(`hub visual start <name> [WxH]        headless display (${backendFor()})
hub visual run <name> -- <cmd...>     launch an app inside it
hub visual shot <name> [out.png]      screenshot
hub visual record <name> [out.mp4]    start recording;  hub visual stop-record <name>
hub visual input <name> type <text> | key <Return> | click <x> <y>
hub visual stop <name>`);
  }
}

/** First number of a version string ("2.2.5" → 2, "v1.3.0" → 1); NaN when there is none. */
export const versionMajor = (v: string) => Number(v.match(/(\d+)\./)?.[1]);

export async function doctor() {
  const need: [string, string][] = [["git", "core"], ["bun", "core"], ["gh", "GitHub"], ...CLIS.map((a) => [a.name, "agent"] as [string, string])];
  if (process.platform === "linux") need.push(["sway", "visual (GPU headless)"], ["wf-recorder", "visual recording (sway)"], ["grim", "visual screenshot (sway)"],
    ["wtype", "visual input (sway)"], ["Xvfb", "visual fallback"], ["ffmpeg", "visual fallback/recording"], ["xdotool", "visual input (Xvfb)"], ["script", "headless login"]);
  const missing: string[] = [];
  for (const [b, why] of need) {
    const ok = !!Bun.which(b);
    if (!ok) missing.push(b);
    console.log(`${ok ? "✔" : "✘"} ${b.padEnd(12)} ${why}`);
  }
  console.log(`visual backend: ${backendFor()}`);
  // noop's opencode integration needs v2 (--agent/--auto on runs, V2 permissions for the gate agent); v1 cannot serve gated tasks
  if (Bun.which("opencode")) {
    const r = await $`opencode --version`.quiet().nothrow();
    const v = (r.stdout.toString() + r.stderr.toString()).trim().split("\n")[0];
    if (v && !(versionMajor(v) >= 2)) console.log(`⚠ opencode ${v}: noop needs opencode v2+ (--agent/--auto, permissions V2); please upgrade`);
  }
  if (missing.length && process.platform === "linux" && Bun.which("pacman"))
    console.log(`\ninstall:  sudo pacman -S --needed ${missing.filter((m) => !["bun", ...CLIS.map((a) => a.name)].includes(m)).map((m) => m === "Xvfb" ? "xorg-server-xvfb" : m === "script" ? "util-linux" : m === "gh" ? "github-cli" : m).join(" ")}`);
}
