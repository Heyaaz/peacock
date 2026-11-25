/**
 * Runs a real Claude Code (haiku, one short prompt) in a terminal session across an app restart:
 * statuses, notifications, hooks, and the chat reading its transcript across `/clear` (scripts
 * its electron side: electron/hc-agent-smoke.ts). `GAJAE_AGENT_SMOKE_PHASES=4` runs omp's
 * transcript chat instead: a message sent from the chat composer to omp in its terminal, one short
 * prompt to a small model (phase 3, Claude Code's chat, was dropped with its chat screen). `5,6` are tool approvals: a card in the window, then after a
 * restart a paired phone's decision and a terminal answer closing its card (three short Bash
 * requests); `GAJAE_SMOKE_CLAUDE_ARGS="--setting-sources project,local"` keeps the user's own
 * settings (hooks, auto mode, allow rules) from answering dialogs first. `7` is omp's approval.
 * `9,10` (`npm run desktop:omp-rpc-smoke`) are omp's RPC chat (design §10): a chat that streams a
 * reply and runs one approved `echo`, then a fresh app that reads it back with the same item ids;
 * omp runs without the user's prewalk (`GAJAE_SMOKE_OMP_ARGS`, default `--no-prewalk`).
 * The runs share one throwaway userData and one hc session, stopped at the end whatever happened.
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
      env: {
        ...process.env,
        GAJAE_USER_DATA_DIR: userData,
        GAJAE_HC_SESSION: session,
        GAJAE_SMOKE_OMP_ARGS: process.env.GAJAE_SMOKE_OMP_ARGS ?? "--no-prewalk",
      },
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
