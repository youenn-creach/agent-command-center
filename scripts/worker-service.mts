import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Installs or removes the scheduler worker as a systemd *user* service (no root needed).
 * It starts with your login session, restarts on failure, runs at low CPU priority and with a
 * memory ceiling. Usage: npm run worker:install | npm run worker:uninstall | npm run worker:status
 */

const UNIT = "agent-command-center-worker.service";
const unitDir = path.join(homedir(), ".config", "systemd", "user");
const unitPath = path.join(unitDir, UNIT);
const project = process.cwd();
const tsxCli = path.join(project, "node_modules", "tsx", "dist", "cli.mjs");
const mode = process.argv[2];

const systemctl = (...args: string[]) => execFileSync("systemctl", ["--user", ...args], { stdio: "inherit" });

if (mode === "install") {
  if (!existsSync(tsxCli)) throw new Error("Run npm install first (tsx not found).");
  const unit = `[Unit]
Description=Agent Command Center scheduler worker
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${project}
ExecStart=${process.execPath} ${tsxCli} ${path.join(project, "scripts", "worker.mts")}
Restart=on-failure
RestartSec=30
Nice=10
MemoryMax=600M
NoNewPrivileges=true
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`;
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(unitPath, unit);
  systemctl("daemon-reload");
  systemctl("enable", "--now", UNIT);
  console.log(`\nInstalled and started ${UNIT}.`);
  console.log("It runs while you are logged in. Logs: journalctl --user -u agent-command-center-worker -f");
  console.log("Node path is pinned to the current nvm version; re-run this command after changing Node versions.");
} else if (mode === "uninstall") {
  try {
    systemctl("disable", "--now", UNIT);
  } catch {
    // not installed or already stopped
  }
  rmSync(unitPath, { force: true });
  systemctl("daemon-reload");
  console.log(`Removed ${UNIT}.`);
} else if (mode === "status") {
  try {
    systemctl("status", "--no-pager", UNIT);
  } catch {
    // systemctl exits non-zero when the unit is inactive; its output already says so
  }
} else {
  console.log("Usage: tsx scripts/worker-service.mts install|uninstall|status");
  process.exit(1);
}
