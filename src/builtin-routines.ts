// Routines every Noop deployment has, defined with the code (not in config.toml) so fixes and new safety checks reach
// every fleet with the next update. A [[routine]] of the same name in config.toml replaces one; the settings page can
// turn one off (settings.json routines.<name>.enabled) like any other routine.

/** The built-in weekly routine (every Noop deployment has it; same-name [[routine]] in config.toml overrides it,
 *  and the settings page can turn it off). Each machine checks itself; the result goes to the owner as the task's result. */
const SECURITY_ROUTINE = {
  name: "security-check",
  every: "weekly MON 09:00",
  scheduler: "each",
  agent: "ops-watcher",
  readonly: true,
  priority: "normal",
  desc: "每周一检查这台电脑的安全状况和 Noop 部署的安全配置，结果发给你",
  prompt: `Weekly security check of THIS computer and of the Noop deployment. Read-only: observe and report, change nothing.
1. Run \`noop security\` and include its output as is (Worker: 2FA, sessions, OAuth clients, owner allow-list, mail, IP allow-list; this machine's Noop files and listening address).
2. Check this computer with read-only commands that fit its OS (skip what doesn't apply, never use sudo or anything that prompts):
   - OS and package updates pending (security ones first); last reboot if a kernel update is waiting
   - firewall on; listening sockets reachable beyond localhost (ss -ltnp / lsof -iTCP -sTCP:LISTEN) and what owns them
   - SSH server: running? PasswordAuthentication / PermitRootLogin; ~/.ssh keys and authorized_keys permissions
   - disk encryption (FileVault / LUKS), screen lock / auto-login
   - recent logins (last / log show) from unexpected places; new launch agents, systemd user units or cron jobs
   - secrets readable by others: ~/.noop, ~/.claude, ~/.codex, ~/.config/gh, ~/.aws, .env files in ~/work (permissions only, never print contents)
3. Write the full report to reports/security/<YYYY-MM-DD>-<host>.md: a verdict line, then findings by risk (high / medium / low), each with the evidence and the exact fix command.
4. Result summary for the owner: one verdict line (e.g. "本机安全：2 个高风险") plus the high-risk items and the report path. If anything is high risk, use needs_decision with options to fix now (as a gated follow-up) or accept; otherwise done.`,
};

/** Weekly usage report: computed from the hub files by code (src/usage-report.ts, no AI run), saved under
 *  reports/usage/ and posted to the main chat so everyone using this Noop can follow how it is used. */
const USAGE_ROUTINE = {
  name: "usage-report",
  kind: "usage-report",
  every: "weekly MON 09:00",
  scheduler: "primary",
  desc: "每周一汇总上周的使用情况（任务、PR、Agent 时长、决策、额度），和前一周对比，发到主会话",
};

export const BUILTIN_ROUTINES: Record<string, unknown>[] = [SECURITY_ROUTINE, USAGE_ROUTINE];
