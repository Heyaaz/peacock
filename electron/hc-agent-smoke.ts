import type { BrowserWindow } from "electron";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TerminalSessionStore } from "./terminal-session-store.js";

export interface ShownNotification {
  sessionId: string;
  category: string;
  body: string;
  /** What macOS did with it: displayed it, or refused (no permission for this app). */
  outcome?: "shown" | "failed";
}

interface PhaseOne {
  sessionId: string;
  skipped?: string;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One phase of scripts/hc-agent-smoke.mjs: a real Claude Code (haiku, one short prompt) in a
 * terminal session. Phase 1 creates it, answers the folder-trust prompt, sends one prompt, and
 * checks the session went waiting → idle → running → idle with the wait and the finished turn
 * announced, and that SessionStart recorded the agent's session. Phase 2 is a fresh app: the
 * still-running agent's `/clear` must reach it through the hook relay, then the session is deleted.
 */
export function attachHcAgentSmoke(
  window: BrowserWindow,
  options: {
    phase: string;
    resultPath: string;
    store: TerminalSessionStore;
    notifications: () => readonly ShownNotification[];
    exit: (code: number) => void;
  },
): void {
  const timeout = setTimeout(() => {
    console.error("herdr agent smoke timed out");
    options.exit(1);
  }, 150_000);
  const finish = async (result: Record<string, unknown>, ok: boolean): Promise<void> => {
    clearTimeout(timeout);
    await writeFile(options.resultPath, `${JSON.stringify(result, null, 2)}\n`).catch(() => undefined);
    console.log(JSON.stringify(result));
    options.exit(ok ? 0 : 1);
  };
  window.webContents.once("did-finish-load", () => {
    void (async () => {
      try {
        if (options.phase === "0") await phaseProbe();
        else if (options.phase === "1") await phaseOne();
        else await phaseTwo();
      } catch (error) {
        console.error("herdr agent smoke failed to run", error);
        await finish({ phase: options.phase, error: String(error) }, false);
      }
    })();
  });

  async function phaseOne(): Promise<void> {
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), "gajae-agent-smoke-")));
    const report = (await window.webContents.executeJavaScript(`(async () => {
      const desktop = window.agentControlDesktop;
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const updates = [];
      const activities = [];
      let sessionId = "";
      const offEvents = desktop.gjc.onEvent((event) => {
        if (event.type === "session.updated" && event.session.id === sessionId) {
          if (updates.at(-1) !== event.session.status) updates.push(event.session.status);
        }
        if (event.type === "session.activity" && event.sessionId === sessionId) activities.push(event.category);
      });
      const agents = await desktop.terminal.listAgents();
      const claude = agents.find((agent) => agent.id === "claude");
      if (!claude?.installed) return { skipped: claude?.reason ?? "no Claude Code" };
      const created = await desktop.terminal.createSession({ title: "claude smoke", workspace: ${JSON.stringify(workspace)}, agentKind: "claude", launch: { model: "haiku" } });
      sessionId = created.id;
      let output = "";
      const offOutput = desktop.terminal.onOutput((event) => { output += event.data; });
      // the rail: the row of this session and the state its dot shows
      const rail = [];
      const watchRail = setInterval(() => {
        const row = [...document.querySelectorAll(".session-row")].find((node) => node.textContent?.includes("claude smoke"));
        const dot = row?.querySelector(".session-state-dot");
        const state = dot ? [...dot.classList].find((name) => name.startsWith("session-state-dot--"))?.slice("session-state-dot--".length) : row ? "no-dot" : null;
        if (state && rail.at(-1) !== state) rail.push(state);
      }, 100);
      const started = await desktop.terminal.start({ token: 930001, session: created.id, cols: 120, rows: 40 });
      const until = async (check, ms) => { const end = Date.now() + ms; while (Date.now() < end && !check()) await wait(150); return check(); };
      const trusted = await until(() => updates.includes("waiting"), 40000);
      if (trusted) {
        // keys typed while the dialog is still being drawn can land as a bare ESC (cancel, exit 1):
        // let it settle, then move to "Yes" and confirm only once the screen shows it chosen
        const plain = () => output.replace(/\\x1b\\[[0-9;?<>=]*[A-Za-z~]/g, "").replace(/\\s+/g, "");
        await wait(2500);
        for (let attempt = 0; attempt < 3 && !/❯Yes,Itrust/.test(plain().slice(-600)); attempt += 1) {
          desktop.terminal.write(started.id, "\\x1b[B");
          await until(() => /❯Yes,Itrust/.test(plain().slice(-600)), 2000);
        }
        desktop.terminal.write(started.id, "\\r");
      }
      const ready = await until(() => updates.lastIndexOf("idle") > updates.indexOf("waiting"), 30000);
      // no prompt (and no model call) into an agent that is not where this smoke expects it
      if (!ready) {
        clearInterval(watchRail);
        offEvents();
        offOutput();
        return { sessionId, backend: started.backend ?? null, trusted, ready, finished: false, updates, activities, rail, tail: output.slice(-400) };
      }
      await wait(1500);
      desktop.terminal.write(started.id, "Reply with exactly the word OK and nothing else.");
      await wait(800);
      desktop.terminal.write(started.id, "\\r");
      const finished = await until(() => activities.includes("completed"), 90000);
      await wait(500);
      clearInterval(watchRail);
      offEvents();
      offOutput();
      return { sessionId, backend: started.backend ?? null, trusted, ready, finished, updates, activities, rail, tail: output.slice(-400) };
    })()`)) as PhaseOne & Record<string, unknown>;
    if (report.skipped) {
      await finish({ phase: 1, skipped: report.skipped }, false);
      return;
    }
    await wait(1000);
    const record = options.store.get(report.sessionId);
    const notified = options.notifications().filter((shown) => shown.sessionId === report.sessionId);
    const result = {
      phase: 1,
      ...report,
      tail: undefined,
      agentSessionRef: record?.agentSessionRef ?? null,
      transcriptPath: record?.transcriptPath ?? null,
      transcriptExists: record?.transcriptPath ? existsSync(record.transcriptPath) : false,
      notified: notified.map((shown) => shown.category),
      notificationOutcomes: notified.map((shown) => `${shown.category}:${shown.outcome ?? "pending"}`),
    };
    const updates = report.updates as string[];
    const ok =
      report.backend === "hc" &&
      updates.includes("waiting") &&
      updates.includes("running") &&
      updates.at(-1) === "idle" &&
      (report.activities as string[]).includes("permission") &&
      (report.activities as string[]).includes("completed") &&
      result.notified.includes("completed") &&
      result.transcriptExists &&
      (report.rail as string[]).includes("waiting") &&
      (report.rail as string[]).includes("running") &&
      (report.rail as string[]).at(-1) === "idle";
    if (!ok) console.error("terminal tail:", JSON.stringify(report.tail));
    await finish(result, ok);
  }

  /** No prompt, no model call: what happens around the folder-trust dialog, for diagnosis. */
  async function phaseProbe(): Promise<void> {
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), "gajae-agent-probe-")));
    const report = (await window.webContents.executeJavaScript(`(async () => {
      const desktop = window.agentControlDesktop;
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const updates = [];
      let sessionId = "";
      const seen = [];
      const offEvents = desktop.gjc.onEvent((event) => {
        const id = event.session?.id ?? event.sessionId;
        if (id === sessionId || event.type === "connection.updated") seen.push(event.type + (event.session ? ":" + event.session.status : event.category ? ":" + event.category : ""));
        if (event.type === "session.updated" && event.session.id === sessionId && updates.at(-1) !== event.session.status) updates.push(event.session.status);
      });
      const created = await desktop.terminal.createSession({ title: "claude probe", workspace: ${JSON.stringify(workspace)}, agentKind: "claude", launch: { model: "haiku" } });
      sessionId = created.id;
      let output = "";
      const offOutput = desktop.terminal.onOutput((event) => { output += event.data; });
      const rail = [];
      const watchRail = setInterval(() => {
        const rows = [...document.querySelectorAll(".session-row")].filter((node) => node.textContent?.includes("claude probe"));
        const states = rows.map((row) => {
          const dot = row.querySelector(".session-state-dot");
          const cls = dot ? [...dot.classList].find((name) => name.startsWith("session-state-dot--")) : "no-dot";
          return (row.closest("[class]")?.parentElement?.className ?? "") + ":" + cls;
        }).join(" | ");
        if (rail.at(-1) !== states) rail.push(states);
      }, 100);
      const started = await desktop.terminal.start({ token: 950001, session: created.id, cols: 120, rows: 40 });
      const until = async (check, ms) => { const end = Date.now() + ms; while (Date.now() < end && !check()) await wait(150); return check(); };
      await until(() => updates.includes("waiting"), 30000);
      await wait(3000);
      const beforeKeys = { updates: [...updates], selected: document.querySelector(".session-row.selected, .session-row[aria-current]")?.textContent ?? null, terminalPanes: document.querySelectorAll(".terminal-pane").length };
      desktop.terminal.write(started.id, "\\x1b[B");
      await wait(400);
      desktop.terminal.write(started.id, "\\r");
      await wait(6000);
      clearInterval(watchRail);
      offEvents();
      offOutput();
      const plain = output.replace(/\\x1b\\[[0-9;?<>=]*[A-Za-z]/g, "").replace(/\\x1b\\][^\\x07\\x1b]*(\\x07|\\x1b\\\\)/g, "");
      const sidebar = document.querySelector(".sidebar, aside, nav")?.innerText?.slice(0, 600) ?? null;
      const gjcList = await desktop.gjc.listSessions().then((rows) => rows.map((row) => row.id + ":" + row.runtime), (error) => "error " + error);
      const terminalList = await desktop.terminal.listSessions().then((rows) => rows.map((row) => row.id + ":" + row.status), (error) => "error " + error);
      return { sessionId, beforeKeys, updates, seen, rail, sidebar: sidebar?.slice(0, 120), gjcList, terminalList };
    })()`)) as Record<string, unknown>;
    await finish({ phase: 0, ...report }, true);
  }

  async function phaseTwo(): Promise<void> {
    const first = JSON.parse(await readFile(options.resultPath, "utf8")) as PhaseOne & { agentSessionRef: string };
    const before = options.store.get(first.sessionId)?.agentSessionRef;
    const listed = (await window.webContents.executeJavaScript(
      `window.agentControlDesktop.terminal.listSessions().then((rows) => rows.find((row) => row.id === ${JSON.stringify(first.sessionId)}) ?? null)`,
    )) as { status: string } | null;
    const shellId = (await window.webContents.executeJavaScript(`(async () => {
      const started = await window.agentControlDesktop.terminal.start({ token: 940001, session: ${JSON.stringify(first.sessionId)}, cols: 120, rows: 40 });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      window.agentControlDesktop.terminal.write(started.id, "/clear");
      await new Promise((resolve) => setTimeout(resolve, 800));
      window.agentControlDesktop.terminal.write(started.id, "\\r");
      return started.id;
    })()`)) as string;
    let after = before;
    for (let attempt = 0; attempt < 100 && after === before; attempt += 1) {
      await wait(200);
      after = options.store.get(first.sessionId)?.agentSessionRef;
    }
    await window.webContents.executeJavaScript(
      `window.agentControlDesktop.terminal.deleteSession(${JSON.stringify(first.sessionId)})`,
    );
    await wait(1500);
    const failed = options.notifications().some((shown) => shown.sessionId === first.sessionId && shown.category === "failed");
    const result = {
      phase: 2,
      listedStatus: listed?.status ?? null,
      attached: Boolean(shellId),
      refBefore: before ?? null,
      refAfterClear: after ?? null,
      hookAfterRestart: Boolean(after && after !== before),
      gone: options.store.get(first.sessionId) === undefined,
      failedAnnounced: failed,
    };
    await finish(result, result.hookAfterRestart && result.gone && !failed && result.listedStatus !== null);
  }
}
