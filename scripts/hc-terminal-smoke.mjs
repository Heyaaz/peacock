/**
 * Opens a terminal session in the app, quits, starts the app again, and checks the shell is the
 * same process with its output kept: herdr-core holds terminal sessions across app restarts.
 * Both runs share one throwaway userData and one hc session of their own, which is stopped at
 * the end whatever happened, so the user's own core is never touched.
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
const userData = mkdtempSync(path.join(tmpdir(), "gajae-hc-smoke-"));
// hc refuses a session whose holder socket path would pass 103 bytes; the name appears in it twice
const fits = (name) =>
  Buffer.byteLength(path.join(process.env.HOME ?? "", ".local", "state", "herdr-core", name, `${name}.holder.00000000.sock`)) <= 103;
const session = fits(`gajae-smoke-${process.pid}`) ? `gajae-smoke-${process.pid}` : `gs-${process.pid}`;
const hc = process.env.GAJAE_HC_BIN || herdrCoreBinary(root);

function run(phase) {
  return new Promise((resolve) => {
    const child = spawn(electron, [".", "--terminal-smoke", `--hc-terminal-smoke=${phase}`], {
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
  for (const phase of ["1", "2"]) {
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
  // the throwaway session's state folder, which hc keeps after its core stops
  rmSync(path.join(process.env.HOME ?? "", ".local", "state", "herdr-core", session), { recursive: true, force: true });
}
if (failed) process.exit(1);
console.log("herdr-core terminal smoke passed");
