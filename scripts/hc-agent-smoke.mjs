/**
 * Runs a real Claude Code (haiku, one short prompt) in a terminal session across an app restart:
 * statuses, notifications, hooks, and the chat reading its transcript across `/clear` (scripts
 * its electron side: electron/hc-agent-smoke.ts). `GAJAE_AGENT_SMOKE_PHASES=3,4` runs the chat
 * phases instead: a message sent from the chat composer to Claude Code (3) and to omp (4), one
 * short prompt each to a small model. The runs share one throwaway userData and one hc session,
 * stopped at the end whatever happened.
 */
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { herdrCoreBinary } from "./herdr-core-pin.mjs";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const electron = path.join(root, "node_modules", ".bin", "electron");
const userData = mkdtempSync(path.join(tmpdir(), "gajae-agent-smoke-"));
const fits = (name) =>
  Buffer.byteLength(path.join(process.env.HOME ?? "", ".local", "state", "herdr-core", name, `${name}.holder.00000000.sock`)) <= 103;
const session = fits(`gajae-smoke-${process.pid}`) ? `gajae-smoke-${process.pid}` : `gs-${process.pid}`;
const hc = process.env.GAJAE_HC_BIN || herdrCoreBinary(root);

function run(phase) {
  return new Promise((resolve) => {
    const child = spawn(electron, [".", "--terminal-smoke", `--hc-agent-smoke=${phase}`], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, GAJAE_USER_DATA_DIR: userData, GAJAE_HC_SESSION: session },
    });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

let failed = false;
try {
  for (const phase of process.env.GAJAE_AGENT_SMOKE_PHASES ? process.env.GAJAE_AGENT_SMOKE_PHASES.split(",") : ["1", "2"]) {
    const code = await run(phase);
    if (code !== 0) {
      console.error(`FAIL: phase ${phase} exited ${code}`);
      failed = true;
      break;
    }
  }
} finally {
  await execFileAsync(hc, ["server", "stop", "--json"], {
    env: { HOME: process.env.HOME ?? "", PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HC_SESSION: session },
  })
    .then(({ stdout }) => console.log(`hc server stop (${session}): ${stdout.trim()}`))
    .catch((error) => console.error(`hc server stop (${session}) failed`, error));
  rmSync(userData, { recursive: true, force: true });
  rmSync(path.join(process.env.HOME ?? "", ".local", "state", "herdr-core", session), { recursive: true, force: true });
}
if (failed) process.exit(1);
console.log("herdr agent smoke passed");
