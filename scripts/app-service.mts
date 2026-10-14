import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Runs the dashboard (production build) as a systemd *user* service so http://127.0.0.1:3000 is
 * always there after login. No root needed; bound to 127.0.0.1 only; restarts on failure.
 *
 *   npm run app:install     install + start (builds first if there is no build)
 *   npm run app:deploy      rebuild, then restart the app and the worker (use after updates)
 *   npm run app:uninstall   stop + remove
 *   npm run app:status
 *   npm run demo:install    a second, demo-only instance on http://127.0.0.1:3001 (own data in data/demo)
 *   npm run demo:uninstall
 *
 * For the personal app, set ACC_MODE=personal and ACC_PEER_URL=http://127.0.0.1:3001 in .env.local.
 * The demo unit sets its own ACC_MODE=demo (process env wins over .env.local), so Google stays off there.
 * Atlas and Voyage keep the .env.local settings: the demo corpus is fictional, and live mode still
 * needs its own confirmation in the demo's Under the hood page.
 */

const UNIT = "agent-command-center-web.service";
const WORKER = "agent-command-center-worker.service";
const DEMO = "agent-command-center-demo.service";
const unitDir = path.join(homedir(), ".config", "systemd", "user");
const unitPath = path.join(unitDir, UNIT);
const project = process.cwd();
const nextCli = path.join(project, "node_modules", "next", "dist", "bin", "next");
const npmCli = path.join(path.dirname(process.execPath), "npm");
const mode = process.argv[2];

const systemctl = (...args: string[]) => execFileSync("systemctl", ["--user", ...args], { stdio: "inherit" });
const build = () => execFileSync(npmCli, ["run", "build"], { cwd: project, stdio: "inherit", env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH}` } });
const isActive = (unit: string) => {
  try {
    execFileSync("systemctl", ["--user", "is-active", "--quiet", unit]);
    return true;
  } catch {
    return false;
  }
};

if (mode === "install") {
  if (!existsSync(nextCli)) throw new Error("Run npm install first (next not found).");
  if (!existsSync(path.join(project, ".next", "BUILD_ID"))) build();
  const unit = `[Unit]
Description=Agent Command Center dashboard (127.0.0.1:3000)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${project}
ExecStart=${process.execPath} ${nextCli} start -H 127.0.0.1 -p 3000
Restart=on-failure
RestartSec=10
MemoryMax=1500M
NoNewPrivileges=true
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`;
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(unitPath, unit);
  systemctl("daemon-reload");
  systemctl("enable", "--now", UNIT);
  console.log(`\nInstalled and started ${UNIT}: http://127.0.0.1:3000`);
  console.log("After code updates run: npm run app:deploy   ·   Logs: journalctl --user -u agent-command-center-web -f");
} else if (mode === "demo-install") {
  if (!existsSync(path.join(project, ".next", "BUILD_ID"))) build();
  const dataDir = path.join(project, "data", "demo");
  mkdirSync(dataDir, { recursive: true });
  const unit = `[Unit]
Description=Agent Command Center demo, fictional data only (127.0.0.1:3001)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${project}
ExecStart=${process.execPath} ${nextCli} start -H 127.0.0.1 -p 3001
Restart=on-failure
RestartSec=10
MemoryMax=1000M
NoNewPrivileges=true
Environment=NODE_ENV=production
Environment=ACC_MODE=demo
Environment=GOOGLE_CLIENT_ID=
Environment=GOOGLE_CLIENT_SECRET=
Environment=ACC_DATA_DIR=${dataDir}
Environment=ACC_PEER_URL=http://127.0.0.1:3000

[Install]
WantedBy=default.target
`;
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(path.join(unitDir, DEMO), unit);
  systemctl("daemon-reload");
  systemctl("enable", "--now", DEMO);
  console.log(`\nInstalled and started ${DEMO}: http://127.0.0.1:3001 (fictional data only; schedules run when you click "Run now").`);
} else if (mode === "demo-uninstall") {
  try {
    systemctl("disable", "--now", DEMO);
  } catch {
    // not installed
  }
  rmSync(path.join(unitDir, DEMO), { force: true });
  systemctl("daemon-reload");
  console.log(`Removed ${DEMO}. Its data stays in data/demo.`);
} else if (mode === "deploy") {
  build();
  if (isActive(UNIT) || existsSync(unitPath)) systemctl("restart", UNIT);
  if (isActive(WORKER)) systemctl("restart", WORKER);
  if (isActive(DEMO)) systemctl("restart", DEMO);
  console.log("Rebuilt and restarted.");
} else if (mode === "uninstall") {
  try {
    systemctl("disable", "--now", UNIT);
  } catch {
    // not installed
  }
  rmSync(unitPath, { force: true });
  systemctl("daemon-reload");
  console.log(`Removed ${UNIT}.`);
} else if (mode === "status") {
  try {
    systemctl("status", "--no-pager", UNIT);
  } catch {
    // inactive: systemctl already printed why
  }
} else {
  console.log("Usage: tsx scripts/app-service.mts install|deploy|uninstall|status|demo-install|demo-uninstall");
  process.exit(1);
}
