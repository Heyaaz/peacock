import type { BrowserWindow } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

interface PhaseOneResult {
  sessionId: string;
  pid: number;
  backend: string | null;
  notice: string | null;
}

/**
 * One phase of scripts/hc-terminal-smoke.mjs, which runs the app twice on one userData and one
 * hc session. Phase 1 opens a terminal session and prints a marker with the shell's pid, then
 * quits. Phase 2 opens the same session in a fresh app: the shell must be the same process and
 * its earlier output must come back; then it deletes the session and checks the shell ended.
 */
export function attachHcTerminalSmoke(
  window: BrowserWindow,
  options: { phase: string; resultPath: string; exit: (code: number) => void },
): void {
  const timeout = setTimeout(() => {
    console.error("herdr-core terminal smoke timed out");
    options.exit(1);
  }, 60_000);
  const finish = async (result: Record<string, unknown>, ok: boolean): Promise<void> => {
    clearTimeout(timeout);
    await writeFile(options.resultPath, `${JSON.stringify(result, null, 2)}\n`).catch(() => undefined);
    console.log(JSON.stringify(result));
    options.exit(ok ? 0 : 1);
  };

  window.webContents.once("did-finish-load", () => {
    void (async () => {
      try {
        if (options.phase === "1") {
          const result = (await window.webContents.executeJavaScript(`(async () => {
            const bridge = window.agentControlDesktop.terminal;
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const output = new Map();
            const off = bridge.onOutput((event) => output.set(event.id, (output.get(event.id) ?? "") + event.data));
            const created = await bridge.createSession({ title: "hc smoke", workspace: ${JSON.stringify(tmpdir())} });
            const started = await bridge.start({ token: 910001, session: created.id, cols: 100, rows: 30 });
            const deadline = Date.now() + 20_000;
            // a login shell takes a moment; a marker written before its prompt still runs
            await wait(800);
            bridge.write(started.id, "echo gajae-hc-$$\\r");
            const pid = () => /gajae-hc-(\\d+)/.exec(output.get(started.id) ?? "")?.[1];
            while (Date.now() < deadline && !pid()) await wait(100);
            off();
            return { sessionId: created.id, pid: Number(pid()), backend: started.backend ?? null, notice: started.notice ?? null };
          })()`)) as PhaseOneResult;
          const ok = result.pid > 1 && result.backend === "hc";
          await finish({ phase: 1, ...result }, ok);
          return;
        }
        const first = JSON.parse(await readFile(options.resultPath, "utf8")) as PhaseOneResult;
        const alive = (pid: number): boolean => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        };
        const aliveBefore = alive(first.pid);
        const report = (await window.webContents.executeJavaScript(`(async () => {
          const bridge = window.agentControlDesktop.terminal;
          const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const output = new Map();
          const off = bridge.onOutput((event) => output.set(event.id, (output.get(event.id) ?? "") + event.data));
          const listed = (await bridge.listSessions()).some((session) => session.id === ${JSON.stringify(first.sessionId)});
          const started = await bridge.start({ token: 920001, session: ${JSON.stringify(first.sessionId)}, cols: 100, rows: 30 });
          const text = () => (started.replay ?? "") + (output.get(started.id) ?? "");
          const deadline = Date.now() + 20_000;
          while (Date.now() < deadline && !text().includes("gajae-hc-${first.pid}")) await wait(100);
          const replayed = text().includes("gajae-hc-${first.pid}");
          bridge.write(started.id, "echo second-$$\\r");
          const second = () => /second-(\\d+)/.exec(text())?.[1];
          while (Date.now() < deadline && !second()) await wait(100);
          off();
          return { listed, replayed, backend: started.backend ?? null, notice: started.notice ?? null, secondPid: Number(second()) };
        })()`)) as { listed: boolean; replayed: boolean; backend: string | null; notice: string | null; secondPid: number };
        await window.webContents.executeJavaScript(
          `window.agentControlDesktop.terminal.deleteSession(${JSON.stringify(first.sessionId)})`,
        );
        for (let attempt = 0; attempt < 50 && alive(first.pid); attempt += 1)
          await new Promise((resolve) => setTimeout(resolve, 100));
        const result = {
          phase: 2,
          ...report,
          firstPid: first.pid,
          aliveBefore,
          samePid: report.secondPid === first.pid,
          endedOnDelete: !alive(first.pid),
        };
        const ok =
          result.listed &&
          result.aliveBefore &&
          result.replayed &&
          result.samePid &&
          result.backend === "hc" &&
          result.endedOnDelete;
        await finish(result, ok);
      } catch (error) {
        console.error("herdr-core terminal smoke failed to run", error);
        await finish({ phase: options.phase, error: String(error) }, false);
      }
    })();
  });
}
