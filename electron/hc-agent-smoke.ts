import type { BrowserWindow } from "electron";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TerminalSessionStore } from "./terminal-session-store.js";
import type { OmpRpcSessionStore } from "./omp-rpc/session-store.js";
import { DeviceStore } from "./remote/devices.js";
import type { RemoteOperationsHost } from "./remote/operations.js";
import { RemoteAccessService } from "./remote/service.js";
import { TailscaleClient } from "./remote/tailscale.js";

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
 * Phase 3 was Claude Code's chat; Claude Code has no chat screen in the window any more (2dd1f3b),
 * so it is gone and phase 4 is the transcript chat (design §5.5): an omp terminal session opened in
 * the window, switched to its chat, a message sent from the chat composer that must reach the
 * terminal, and the answer that must appear in the chat (one short prompt to a small model), with
 * whether omp reports its state to herdr-core. Phase 5 is a tool approval (design §5.6): a
 * Claude Code in its default permission mode asks to run one Bash command, the card in the window
 * answers it. Phase 6 is a fresh app: the same agent asks again, a paired phone answers through the
 * remote protocol, and a third request answered at the terminal must close its card. Phase 8 is a
 * parallel run (P6): two Claude Code attempts (haiku) in their own worktrees of a throwaway
 * repository, started with no window showing them; their folder-trust dialogs are answered at the
 * terminal as a user would, and each attempt's request must be typed in once and answered.
 * Phase 9 is omp's RPC chat (design §10): a chat created as the new-session dialog makes one, opened
 * in the window with GJC's composer, a reply streamed into it, and one bash `echo` approved from
 * its card. Phase 10 is a fresh app: the same chat lists, opens and reads back with the same item
 * ids, and its omp starts again on the session file. No model call in phase 10.
 */
export function attachHcAgentSmoke(
  window: BrowserWindow,
  options: {
    phase: string;
    resultPath: string;
    store: TerminalSessionStore;
    notifications: () => readonly ShownNotification[];
    /** The text on a session's terminal screen now, read from herdr-core. */
    readScreen?: (sessionId: string) => Promise<string>;
    /** Presses keys in a session's terminal through herdr-core (`terminal.keys`). */
    pressKeys?: (sessionId: string, keys: string[]) => Promise<void>;
    /** What a phone talks to: the app's router, served by a smoke-only remote server. */
    remote?: { host: RemoteOperationsHost; webRoot: string; version: string };
    /** omp RPC chats (phases 9 and 10). */
    ompStore?: OmpRpcSessionStore;
    exit: (code: number) => void;
  },
): void {
  // the chat phases wait for an agent to start, a paste, and an answer
  const timeout = setTimeout(() => {
    console.error("herdr agent smoke timed out");
    options.exit(1);
  }, ["4", "5", "6", "7", "8", "9"].includes(options.phase) ? 300_000 : 150_000);
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
        else if (options.phase === "3")
          await finish({ phase: 3, error: "phase 3 was dropped: Claude Code has no chat screen in the window; phase 4 is omp's transcript chat" }, false);
        else if (options.phase === "4") await phaseChat("omp");
        else if (options.phase === "9") await phaseOmpRpcChat();
        else if (options.phase === "10") await phaseOmpRpcRestart();
        else if (options.phase === "5") await phaseApproval();
        else if (options.phase === "6") await phaseRemoteApproval();
        else if (options.phase === "7") await phaseOmpApproval();
        else if (options.phase === "8") await phaseParallel();
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

  /**
   * The chat beside an agent's terminal: open the session in the window, switch to the chat, send
   * one short prompt from the chat composer, and see it on the terminal and its answer in the chat.
   */
  async function phaseChat(agent: "claude" | "omp"): Promise<void> {
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), `gajae-${agent}-chat-smoke-`)));
    const title = `${agent} chat smoke`;
    // a small model for the one prompt: Claude Code's haiku, and the cheapest model this omp has set up
    const launch = agent === "claude" ? { model: "haiku" } : { model: process.env.GAJAE_SMOKE_OMP_MODEL || "opencodex/opengateway/deepseek/deepseek-v4.1-flash-eco" };
    const report = (await window.webContents.executeJavaScript(`(async () => {
      const desktop = window.agentControlDesktop;
      const agent = ${JSON.stringify(agent)};
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const until = async (check, ms) => { const end = Date.now() + ms; while (Date.now() < end && !check()) await wait(150); return Boolean(check()); };
      const updates = [];
      const sendable = [];
      const transcriptEvents = [];
      let sessionId = "";
      const offEvents = desktop.gjc.onEvent((event) => {
        if (event.type === "session.updated" && event.session.id === sessionId) {
          if (updates.at(-1) !== event.session.status) updates.push(event.session.status);
          const send = event.session.capabilities?.send ?? null;
          if (sendable.at(-1) !== send) sendable.push(send);
        }
        if (event.type.startsWith("transcript.") && (event.sessionId ?? event.item?.sessionId) === sessionId) transcriptEvents.push(event.type);
      });
      const agents = await desktop.terminal.listAgents();
      const found = agents.find((candidate) => candidate.id === agent);
      if (!found?.installed) { offEvents(); return { skipped: found?.reason ?? "not installed" }; }
      const created = await desktop.terminal.createSession({ title: ${JSON.stringify(title)}, workspace: ${JSON.stringify(workspace)}, agentKind: agent, launch: ${JSON.stringify(launch)} });
      sessionId = created.id;
      let output = "";
      const offOutput = desktop.terminal.onOutput((event) => { output += event.data; });
      const plain = () => output.replace(/\\x1b\\[[0-9;?<>=]*[A-Za-z~]/g, "").replace(/\\x1b\\][^\\x07\\x1b]*(\\x07|\\x1b\\\\)/g, "");
      const started = await desktop.terminal.start({ token: 930301, session: created.id, cols: 120, rows: 40 });
      let trusted = false;
      let ready = false;
      if (agent === "claude") {
        trusted = await until(() => updates.includes("waiting"), 40000);
        if (trusted) {
          const flat = () => plain().replace(/\\s+/g, "");
          await wait(2500);
          for (let attempt = 0; attempt < 3 && !/❯Yes,Itrust/.test(flat().slice(-600)); attempt += 1) {
            desktop.terminal.write(started.id, "\\x1b[B");
            await until(() => /❯Yes,Itrust/.test(flat().slice(-600)), 2000);
          }
          desktop.terminal.write(started.id, "\\r");
        }
        ready = await until(() => updates.lastIndexOf("idle") > updates.indexOf("waiting"), 30000);
      } else {
        // omp draws its prompt and then stays quiet until spoken to
        let last = -1;
        let quietSince = Date.now();
        const end = Date.now() + 40000;
        while (Date.now() < end) {
          if (output.length !== last) { last = output.length; quietSince = Date.now(); }
          if (output.length > 0 && Date.now() - quietSince > 4000) { ready = true; break; }
          await wait(250);
        }
      }
      const screenAtReady = plain().slice(-1200);
      if (!ready) {
        offEvents(); offOutput();
        return { sessionId, ready, trusted, updates, sendable, screenAtReady };
      }
      await wait(1500);
      const reported = sendable.at(-1) === true;
      const prompt = "Reply with exactly the word PONG and nothing else.";
      // an agent that does not report gets its prompt typed in the terminal; the chat only reads then
      if (!reported) {
        desktop.terminal.write(started.id, prompt);
        await wait(800);
        desktop.terminal.write(started.id, "\\r");
      }
      await desktop.terminal.dispose(930301);
      // open the session in the window: its terminal first, the chat a toggle away
      const row = await until(() => [...document.querySelectorAll(".session-row")].some((node) => node.textContent?.includes(${JSON.stringify(title)})), 10000)
        ? [...document.querySelectorAll(".session-row")].find((node) => node.textContent?.includes(${JSON.stringify(title)}))
        : null;
      row?.click();
      const surface = () => document.querySelector("main.workspace")?.getAttribute("data-surface") ?? null;
      await until(() => document.querySelector(".surface-mode-toggle"), 10000);
      const surfaceAtOpen = surface();
      const toggles = () => [...document.querySelectorAll(".surface-mode-toggle button")];
      toggles()[0]?.click();
      const chatShown = await until(() => surface() === "chat", 5000);
      const textarea = () => document.querySelector(".composer--terminal-agent textarea");
      const composerEnabled = await until(() => textarea() && !textarea().disabled, reported ? 15000 : 1000);
      let sentFromChat = false;
      let delivery = null;
      const sentAt = Date.now();
      if (reported && composerEnabled) {
        const field = textarea();
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, prompt);
        field.dispatchEvent(new Event("input", { bubbles: true }));
        await wait(200);
        document.querySelector(".composer--terminal-agent button[type=submit]")?.click();
        sentFromChat = true;
        // the composer clears the draft once herdr-core has typed it in
        delivery = (await until(() => textarea()?.value === "", 35000)) ? "typed" : (document.querySelector(".composer--terminal-agent .composer-error")?.textContent ?? "pending");
      }
      const userRow = () => [...document.querySelectorAll(".conversation .message--user")].find((node) => node.textContent?.includes("PONG and nothing else"));
      const answerRow = () => [...document.querySelectorAll(".conversation .message--assistant")].find((node) => /PONG/.test(node.textContent ?? ""));
      const userShown = await until(userRow, 40000);
      const msToUserRow = Date.now() - sentAt;
      const answered = await until(answerRow, 120000);
      const msToAnswer = Date.now() - sentAt;
      const page = await desktop.gjc.getTranscriptPage(sessionId);
      // back to the terminal and to the chat again: the same rows, by the same ids
      toggles()[1]?.click();
      const terminalShown = await until(() => surface() === "terminal" && document.querySelector(".workspace-body .terminal-pane, .workspace-body .xterm"), 5000);
      toggles()[0]?.click();
      await until(() => surface() === "chat", 5000);
      const again = await desktop.gjc.getTranscriptPage(sessionId);
      const ids = page.items.map((item) => item.id);
      const idsStable = JSON.stringify(ids) === JSON.stringify(again.items.map((item) => item.id));
      const shownAfterToggle = Boolean(userRow()) && Boolean(answerRow());
      offEvents(); offOutput();
      return {
        sessionId, ready, trusted, reported, updates, sendable, surfaceAtOpen, chatShown, composerEnabled, sentFromChat, delivery,
        userShown, msToUserRow, answered, msToAnswer, terminalShown, shownAfterToggle, idsStable,
        rows: page.items.map((item) => item.kind + (item.role ? ":" + item.role : "") + ":" + String(item.content ?? item.name ?? "").slice(0, 40)),
        ids, transcriptEvents: [...new Set(transcriptEvents)], screenAtReady: screenAtReady.slice(-300),
      };
    })()`)) as Record<string, unknown> & { sessionId?: string; skipped?: string };
    if (report.skipped) {
      await finish({ phase: options.phase, agent, skipped: report.skipped }, false);
      return;
    }
    const sessionId = report.sessionId!;
    const screen = (await options.readScreen?.(sessionId).catch((error: unknown) => `read failed: ${String(error)}`)) ?? "";
    const record = options.store.get(sessionId);
    const result = {
      phase: options.phase,
      agent,
      ...report,
      screenAtReady: report.ready ? undefined : report.screenAtReady,
      promptOnTerminal: screen.includes("PONG and nothing else"),
      answerOnTerminal: /PONG(?! and)/.test(screen),
      transcriptPath: record?.transcriptPath ?? null,
      agentSessionRef: record?.agentSessionRef ?? null,
    };
    await window.webContents.executeJavaScript(`window.agentControlDesktop.terminal.deleteSession(${JSON.stringify(sessionId)})`);
    await wait(1000);
    const ok =
      report.ready === true &&
      report.surfaceAtOpen === "terminal" &&
      report.chatShown === true &&
      report.userShown === true &&
      report.answered === true &&
      report.terminalShown !== false &&
      report.shownAfterToggle === true &&
      report.idsStable === true &&
      result.promptOnTerminal &&
      // Claude Code reports its state, so its prompt goes from the chat; omp's goes wherever it can
      (agent === "omp" || (report.reported === true && report.sentFromChat === true && report.delivery === "typed"));
    if (!ok) console.error("terminal screen:", JSON.stringify(screen.slice(-1500)));
    await finish(result, ok);
  }

  /**
   * Creates an agent session, starts its terminal (answering Claude Code's folder-trust dialog), waits
   * until the agent is ready, then opens it in the window on its chat. No model call.
   */
  async function openAgent(
    agent: "claude" | "omp",
    title: string,
    workspace: string,
    launch: Record<string, string>,
    token: number,
  ): Promise<{ sessionId?: string; ready?: boolean; skipped?: string; chatShown?: boolean; screen?: string }> {
    return (await window.webContents.executeJavaScript(`(async () => {
      const desktop = window.agentControlDesktop;
      const agent = ${JSON.stringify(agent)};
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const until = async (check, ms) => { const end = Date.now() + ms; while (Date.now() < end && !check()) await wait(150); return Boolean(check()); };
      const updates = [];
      let sessionId = "";
      const offEvents = desktop.gjc.onEvent((event) => {
        if (event.type === "session.updated" && event.session.id === sessionId && updates.at(-1) !== event.session.status) updates.push(event.session.status);
      });
      const found = (await desktop.terminal.listAgents()).find((candidate) => candidate.id === agent);
      if (!found?.installed) { offEvents(); return { skipped: found?.reason ?? "not installed" }; }
      const created = await desktop.terminal.createSession({ title: ${JSON.stringify(title)}, workspace: ${JSON.stringify(workspace)}, agentKind: agent, launch: ${JSON.stringify(launch)} });
      sessionId = created.id;
      let output = "";
      const offOutput = desktop.terminal.onOutput((event) => { output += event.data; });
      const plain = () => output.replace(/\\x1b\\[[0-9;?<>=]*[A-Za-z~]/g, "").replace(/\\x1b\\][^\\x07\\x1b]*(\\x07|\\x1b\\\\)/g, "");
      const started = await desktop.terminal.start({ token: ${token}, session: created.id, cols: 120, rows: 40 });
      let ready = false;
      if (agent === "claude") {
        if (await until(() => updates.includes("waiting"), 40000)) {
          const flat = () => plain().replace(/\\s+/g, "");
          await wait(2500);
          for (let attempt = 0; attempt < 3 && !/❯Yes,Itrust/.test(flat().slice(-600)); attempt += 1) {
            desktop.terminal.write(started.id, "\\x1b[B");
            await until(() => /❯Yes,Itrust/.test(flat().slice(-600)), 2000);
          }
          desktop.terminal.write(started.id, "\\r");
        }
        ready = await until(() => updates.lastIndexOf("idle") > updates.indexOf("waiting"), 30000);
      } else {
        ready = await until(() => updates.includes("idle"), 40000);
      }
      const screen = plain().slice(-800);
      await desktop.terminal.dispose(${token});
      offOutput();
      offEvents();
      if (!ready) return { sessionId, ready, screen };
      await wait(1500);
      const row = await until(() => [...document.querySelectorAll(".session-row")].some((node) => node.textContent?.includes(${JSON.stringify(title)})), 10000)
        ? [...document.querySelectorAll(".session-row")].find((node) => node.textContent?.includes(${JSON.stringify(title)}))
        : null;
      row?.click();
      await until(() => document.querySelector(".surface-mode-toggle"), 10000);
      document.querySelectorAll(".surface-mode-toggle button")[0]?.click();
      const chatShown = await until(() => document.querySelector("main.workspace")?.getAttribute("data-surface") === "chat", 5000);
      await until(() => { const field = document.querySelector(".composer--terminal-agent textarea"); return field && !field.disabled; }, 15000);
      return { sessionId, ready, chatShown };
    })()`)) as { sessionId?: string; ready?: boolean; skipped?: string; chatShown?: boolean; screen?: string };
  }

  /** Types a prompt into the agent chat's composer and sends it. */
  async function sendFromChat(text: string): Promise<boolean> {
    return (await window.webContents.executeJavaScript(`(async () => {
      const field = document.querySelector(".composer--terminal-agent textarea");
      if (!field || field.disabled) return false;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, ${JSON.stringify(text)});
      field.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 200));
      document.querySelector(".composer--terminal-agent button[type=submit]")?.click();
      for (let i = 0; i < 200 && field.value !== ""; i += 1) await new Promise((resolve) => setTimeout(resolve, 200));
      return field.value === "";
    })()`)) as boolean;
  }

  /** Waits for an approval card in the window, up to `ms`. */
  async function cardInWindow(ms: number): Promise<{ shown: boolean; text: string | null; banner: boolean }> {
    return (await window.webContents.executeJavaScript(`(async () => {
      const card = () => document.querySelector(".tool-card--approval");
      const end = Date.now() + ${ms};
      while (Date.now() < end && !card()) await new Promise((resolve) => setTimeout(resolve, 200));
      return { shown: Boolean(card()), text: card()?.textContent?.slice(0, 240) ?? null, banner: Boolean(document.querySelector(".approval-banner")) };
    })()`)) as { shown: boolean; text: string | null; banner: boolean };
  }

  /** The session's transcript rows, as the window reads them. */
  async function rows(sessionId: string): Promise<{ id: string; kind: string; name?: string; status?: string; command?: string; output?: string }[]> {
    return (await window.webContents.executeJavaScript(
      `window.agentControlDesktop.gjc.getTranscriptPage(${JSON.stringify(sessionId)}).then((page) => page.items)`,
    )) as { id: string; kind: string; name?: string; status?: string; command?: string; output?: string }[];
  }

  /** A tool row that ran `marker`'s command and finished, within `ms`. */
  async function ranTool(
    read: () => Promise<{ id: string; kind: string; name?: string; status?: string; command?: string; output?: string }[]>,
    marker: string,
    ms: number,
  ) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const done = (await read()).find(
        (row) => row.kind === "tool" && row.status === "completed" && `${row.command ?? ""}${row.output ?? ""}`.includes(marker),
      );
      if (done) return done;
      await wait(500);
    }
    return undefined;
  }

  /** The state a session's row shows now. */
  async function statusOf(sessionId: string): Promise<string | null> {
    return (await window.webContents.executeJavaScript(
      `window.agentControlDesktop.terminal.listSessions().then((rows) => rows.find((row) => row.id === ${JSON.stringify(sessionId)})?.status ?? null)`,
    )) as string | null;
  }

  async function phaseParallel(): Promise<void> {
    // a throwaway repository with one commit: each attempt's worktree and branch come from it
    const repo = realpathSync(mkdtempSync(path.join(tmpdir(), "gajae-parallel-smoke-")));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    git("init", "-q", "-b", "main");
    writeFileSync(path.join(repo, "README.md"), "# parallel smoke\n");
    git("add", "README.md");
    git("-c", "user.name=Gajae Smoke", "-c", "user.email=smoke@gajae.invalid", "commit", "-q", "-m", "init");
    const prompt = "Reply with exactly the word OK and nothing else.";
    const begun = (await window.webContents.executeJavaScript(`(async () => {
      const desktop = window.agentControlDesktop;
      const agents = await desktop.parallel.agents();
      const claude = agents.find((agent) => agent.id === "claude");
      if (!claude?.supported) return { agents, skipped: claude?.reason ?? "no Claude Code" };
      // an agent that cannot drive a run is refused with its reason
      const refused = await desktop.parallel.start({ title: "refused", workspace: ${JSON.stringify(repo)}, prompt: "x", presets: ["default", "default"], agentKind: "shell" }).then(() => null, (error) => String(error.message ?? error));
      const group = await desktop.parallel.start({ title: "parallel smoke", workspace: ${JSON.stringify(repo)}, prompt: ${JSON.stringify(prompt)}, presets: ["haiku", "haiku"], agentKind: "claude" });
      return { agents, refused, groupId: group.id };
    })()`)) as { agents: { id: string; supported: boolean; reason?: string }[]; skipped?: string; refused?: string | null; groupId?: string };
    if (begun.skipped || !begun.groupId) {
      await finish({ phase: 8, ...begun }, false);
      return;
    }
    type Group = { state: { kind: string }; attempts: { id: string; branch: string; state: { kind: string; sessionId?: string; worktreePath?: string; reason?: string } }[] };
    const groupNow = async () =>
      (await window.webContents.executeJavaScript(
        `window.agentControlDesktop.parallel.list().then((groups) => groups.find((group) => group.id === ${JSON.stringify(begun.groupId)}))`,
      )) as Group;
    const deadline = Date.now() + 60_000;
    let group = await groupNow();
    while (Date.now() < deadline && group.state.kind === "draft") {
      await wait(300);
      group = await groupNow();
    }
    const sessions = group.attempts.flatMap((attempt) => (attempt.state.sessionId ? [attempt.state.sessionId] : []));
    // each attempt's agent starts in a folder it has never seen: answer its trust dialog at the terminal
    const trusted: Record<string, boolean> = {};
    const answered = new Set<string>();
    const trustDeadline = Date.now() + 90_000;
    while (Date.now() < trustDeadline && answered.size < sessions.length) {
      for (const sessionId of sessions) {
        if (answered.has(sessionId)) continue;
        const screen = ((await options.readScreen?.(sessionId)) ?? "").replace(/\s+/g, "");
        if (/Yes,Itrust/.test(screen)) {
          await wait(1500);
          for (let attempt = 0; attempt < 3 && !/❯\d?\.?Yes,Itrust/.test(((await options.readScreen?.(sessionId)) ?? "").replace(/\s+/g, "")); attempt += 1) {
            await options.pressKeys?.(sessionId, ["down"]);
            await wait(500);
          }
          await options.pressKeys?.(sessionId, ["enter"]);
          trusted[sessionId] = true;
          answered.add(sessionId);
        } else if ((await statusOf(sessionId)) === "running" || /OK/.test(screen.slice(-200))) {
          // no dialog (the folder was trusted already): the request went straight in
          trusted[sessionId] = false;
          answered.add(sessionId);
        }
      }
      await wait(700);
    }
    // each request typed in once and answered: the transcript holds the prompt and a reply
    const answers: Record<string, { prompt: boolean; reply: string | null }> = {};
    const answerDeadline = Date.now() + 150_000;
    while (Date.now() < answerDeadline && Object.values(answers).filter((answer) => answer.reply).length < sessions.length) {
      for (const sessionId of sessions) {
        const items = (await rows(sessionId)) as { kind: string; role?: string; content?: string }[];
        const prompts = items.filter((item) => item.kind === "message" && item.role === "user" && item.content?.includes("exactly the word OK"));
        const reply = items.find((item) => item.kind === "message" && item.role === "assistant" && item.content?.trim());
        answers[sessionId] = { prompt: prompts.length === 1, reply: reply?.content?.trim().slice(0, 40) ?? null };
      }
      await wait(1000);
    }
    // global search (⌘K) reads the attempts' transcripts too (P6)
    const hits = (await window.webContents.executeJavaScript(
      `window.agentControlDesktop.productivity.searchTranscripts("exactly the word OK", 40)`,
    )) as { sessionId: string; kind: string }[];
    const found = sessions.filter((sessionId) => hits.some((hit) => hit.sessionId === sessionId));
    group = await groupNow();
    const worktrees = git("worktree", "list", "--porcelain")
      .split("\n")
      .filter((line) => line.startsWith("branch "))
      .map((line) => line.slice("branch refs/heads/".length));
    const result = {
      phase: 8,
      agents: begun.agents.map((agent) => `${agent.id}:${agent.supported ? "yes" : `no (${agent.reason})`}`),
      refused: begun.refused,
      group: group.state.kind,
      attempts: group.attempts.map((attempt) => ({ id: attempt.id, branch: attempt.branch, state: attempt.state.kind, reason: attempt.state.reason, worktree: attempt.state.worktreePath ? path.basename(attempt.state.worktreePath) : null })),
      worktreeBranches: worktrees,
      trusted,
      answers,
      searchFound: found.length,
    };
    // the run's sessions go; the repository and its worktrees are this phase's own throwaway folders
    for (const sessionId of sessions)
      await window.webContents.executeJavaScript(`window.agentControlDesktop.terminal.deleteSession(${JSON.stringify(sessionId)}).catch(() => undefined)`);
    for (const attempt of group.attempts) if (attempt.state.worktreePath) execFileSync("git", ["-C", repo, "worktree", "remove", "--force", attempt.state.worktreePath]);
    const ok =
      typeof begun.refused === "string" &&
      sessions.length === 2 &&
      group.attempts.every((attempt) => attempt.state.kind === "started") &&
      sessions.every((sessionId) => answers[sessionId]?.prompt && answers[sessionId]?.reply) &&
      found.length === sessions.length;
    await finish(result, ok);
  }

  /** omp's RPC chat (design §10): streamed reply, an approved bash call, rows read back by file id. */
  async function phaseOmpRpcChat(): Promise<void> {
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), "gajae-omp-rpc-smoke-")));
    const title = "omp rpc smoke";
    const model = process.env.GAJAE_SMOKE_OMP_MODEL || "opencodex/opengateway/deepseek/deepseek-v4.1-flash-eco";
    const report = (await window.webContents.executeJavaScript(`(async () => {
      const desktop = window.agentControlDesktop;
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const until = async (check, ms) => { const end = Date.now() + ms; while (Date.now() < end && !check()) await wait(150); return Boolean(check()); };
      const agents = await desktop.terminal.listAgents();
      const omp = agents.find((agent) => agent.id === "omp");
      if (!omp?.installed) return { skipped: omp?.reason ?? "omp not installed" };
      let sessionId = "";
      const updates = [];
      const kinds = {};
      const offEvents = desktop.gjc.onEvent((event) => {
        const id = event.session?.id ?? event.sessionId ?? event.item?.sessionId ?? event.tool?.sessionId ?? event.message?.sessionId;
        if (id !== sessionId) return;
        kinds[event.type] = (kinds[event.type] ?? 0) + 1;
        if (event.type === "session.updated" && updates.at(-1) !== event.session.status) updates.push(event.session.status);
      });
      // what the new-session dialog sends for omp on its chat screen
      const created = await desktop.gjc.createSession({ runtime: "omp-rpc", title: ${JSON.stringify(title)}, workspace: ${JSON.stringify(workspace)}, isolation: "workspace", agentKind: "omp", launch: { model: ${JSON.stringify(model)} } });
      sessionId = created.id;
      const rowNode = () => [...document.querySelectorAll(".session-row")].find((node) => node.textContent?.includes(${JSON.stringify(title)}));
      await until(rowNode, 10000);
      rowNode()?.click();
      const surface = () => document.querySelector("main.workspace")?.getAttribute("data-surface") ?? null;
      const textarea = () => document.querySelector(".composer:not(.composer--terminal-agent) textarea");
      const errors = [];
      window.addEventListener("error", (event) => errors.push(String(event.error?.stack ?? event.message).slice(0, 600)));
      window.addEventListener("unhandledrejection", (event) => errors.push("rejection: " + String(event.reason?.stack ?? event.reason).slice(0, 600)));
      const originalError = console.error;
      console.error = (...args) => { errors.push("console: " + args.map((arg) => String(arg?.stack ?? arg)).join(" ").slice(0, 600)); originalError(...args); };
      const composerShown = await until(() => surface() === "chat" && textarea(), 15000);
      // omp starts as the chat opens: its model and commands arrive; the chat must still be there after
      await until(() => (kinds["session.config"] ?? 0) > 0, 15000);
      await wait(2000);
      const headerAfterOpen = Boolean(document.querySelector(".chat-header strong"));
      if (!headerAfterOpen) {
        offEvents();
        return { sessionId, composerShown, headerAfterOpen, errors, kinds, body: document.body.textContent?.slice(0, 400) };
      }
      const toggleShown = Boolean(document.querySelector(".surface-mode-toggle"));
      const terminalComposer = Boolean(document.querySelector(".composer--terminal-agent"));
      const send = async (text) => {
        const field = textarea();
        if (!field) return false;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, text);
        field.dispatchEvent(new Event("input", { bubbles: true }));
        await wait(300);
        const button = document.querySelector(".composer:not(.composer--terminal-agent) .composer-submit-actions button[type=submit]");
        if (!button || button.disabled) return false;
        button.click();
        return true;
      };
      const assistant = (pattern) => [...document.querySelectorAll(".conversation .message--assistant")].find((node) => pattern.test(node.textContent ?? ""));
      const sentOk = composerShown ? await send("Reply with exactly the word OK and nothing else.") : false;
      const startedAt = Date.now();
      const okShown = sentOk ? await until(() => assistant(/(^|[^A-Za-z])OK([^A-Za-z]|$)/), 120000) : false;
      const msToOk = Date.now() - startedAt;
      const domAfterOk = {
        messages: document.querySelectorAll(".conversation .message").length,
        selected: document.querySelector(".chat-header strong")?.textContent ?? null,
        text: (document.querySelector(".conversation")?.textContent ?? "").slice(-300),
      };
      await until(() => updates.at(-1) === "idle", 30000);
      await wait(1500);
      const sentEcho = okShown ? await send("Use the bash tool to run exactly this command and nothing else: echo gajae-rpc-smoke. Then reply with exactly the word DONE.") : false;
      const cardShown = sentEcho ? await until(() => document.querySelector(".tool-card--approval .permission-options .button-primary"), 120000) : false;
      const statusAtCard = updates.at(-1);
      let approved = false;
      if (cardShown) {
        document.querySelector(".tool-card--approval .permission-options .button-primary")?.click();
        approved = await until(() => !document.querySelector(".tool-card--approval"), 30000);
      }
      const doneShown = approved ? await until(() => assistant(/(^|[^A-Za-z])DONE([^A-Za-z]|$)/), 120000) : false;
      await until(() => updates.at(-1) === "idle", 30000);
      // the turn read back from omp's session file: the file's ids
      await until(() => (kinds["transcript.synced"] ?? 0) >= 2, 15000);
      await wait(1000);
      const page = await desktop.gjc.getTranscriptPage(sessionId);
      offEvents();
      return {
        sessionId, composerShown, headerAfterOpen, errors, toggleShown, terminalComposer, sentOk, okShown, msToOk, domAfterOk, sentEcho, cardShown, statusAtCard, approved, doneShown, updates, kinds,
        ids: page.items.map((item) => item.id),
        rows: page.items.map((item) => item.kind + (item.role ? ":" + item.role : "") + ":" + (item.status ? item.status + ":" : "") + String(item.content ?? item.output ?? item.name ?? "").slice(0, 40)),
      };
    })()`)) as Record<string, unknown> & { sessionId?: string; skipped?: string; ids?: string[]; rows?: string[] };
    if (report.skipped) {
      await finish({ phase: 9, skipped: report.skipped }, false);
      return;
    }
    const record = report.sessionId ? options.ompStore?.get(report.sessionId) : undefined;
    const rows = report.rows ?? [];
    const result = {
      phase: 9,
      ...report,
      sessionFile: record?.sessionFile ?? null,
      sessionFileExists: record?.sessionFile ? existsSync(record.sessionFile) : false,
      liveIdsLeft: (report.ids ?? []).filter((id) => id.includes(":live:")),
      echoRan: rows.some((row) => /^tool:completed:gajae-rpc-smoke/u.test(row)),
    };
    const kinds = (report.kinds ?? {}) as Record<string, number>;
    const ok =
      report.composerShown === true &&
      report.toggleShown === false &&
      report.terminalComposer === false &&
      report.okShown === true &&
      (kinds["message.delta"] ?? 0) > 0 &&
      report.cardShown === true &&
      report.statusAtCard === "waiting" &&
      report.approved === true &&
      report.doneShown === true &&
      result.echoRan &&
      result.sessionFileExists &&
      result.liveIdsLeft.length === 0;
    await finish(result, ok);
  }

  /** A fresh app: the omp chat of phase 9 lists, opens and reads back with the same ids. */
  async function phaseOmpRpcRestart(): Promise<void> {
    const first = JSON.parse(await readFile(options.resultPath, "utf8")) as { sessionId?: string; ids?: string[] };
    if (!first.sessionId) throw new Error("phase 9 left no session");
    const sessionFile = options.ompStore?.get(first.sessionId)?.sessionFile ?? null;
    const report = (await window.webContents.executeJavaScript(`(async () => {
      const desktop = window.agentControlDesktop;
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const until = async (check, ms) => { const end = Date.now() + ms; while (Date.now() < end && !check()) await wait(150); return Boolean(check()); };
      const sessionId = ${JSON.stringify(first.sessionId)};
      const listed = (await desktop.gjc.listSessions()).find((session) => session.id === sessionId);
      const rowNode = () => [...document.querySelectorAll(".session-row")].find((node) => node.textContent?.includes("omp rpc smoke"));
      await until(rowNode, 10000);
      rowNode()?.click();
      const shown = await until(() => [...document.querySelectorAll(".conversation .message--assistant")].some((node) => /(^|[^A-Za-z])DONE([^A-Za-z]|$)/.test(node.textContent ?? "")), 15000);
      const page = await desktop.gjc.getTranscriptPage(sessionId);
      // opening started omp again on the session file: its model reaches the row
      let restarted = false;
      for (const end = Date.now() + 20000; !restarted && Date.now() < end; await wait(500))
        restarted = Boolean((await desktop.gjc.listSessions()).find((session) => session.id === sessionId)?.model);
      return { listed: Boolean(listed), runtime: listed?.runtime ?? null, shown, restarted, ids: page.items.map((item) => item.id) };
    })()`)) as { listed: boolean; runtime: string | null; shown: boolean; restarted: boolean; ids: string[] };
    const sameIds = JSON.stringify(report.ids) === JSON.stringify(first.ids);
    const result = {
      phase: 10,
      sessionId: first.sessionId,
      ...report,
      sameIds,
      sessionFileKept: (options.ompStore?.get(first.sessionId)?.sessionFile ?? null) === sessionFile,
      firstIds: first.ids,
    };
    await finish(result, report.listed && report.runtime === "omp-rpc" && report.shown && report.restarted && sameIds && result.sessionFileKept);
  }

  async function phaseApproval(): Promise<void> {
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), "gajae-approval-smoke-")));
    const opened = await openAgent("claude", "claude approval smoke", workspace, { model: "haiku", permissionMode: "default" }, 930501);
    if (opened.skipped || !opened.ready || !opened.sessionId) {
      await finish({ phase: 5, ...opened }, false);
      return;
    }
    const sessionId = opened.sessionId;
    // a command that writes: Claude Code runs a read-only one (echo) without asking
    const sent = await sendFromChat("Use the Bash tool to run exactly this command and nothing else: touch gajae-approval-one.txt");
    const card = await cardInWindow(90_000);
    // while the card waits, the agent shows its own dialog too: the hook does not hold it
    const screenWhileWaiting = card.shown ? ((await options.readScreen?.(sessionId)) ?? "") : "";
    const statusWhileWaiting = card.shown ? await statusOf(sessionId) : null;
    const approved = card.shown
      ? ((await window.webContents.executeJavaScript(`(async () => {
          document.querySelector(".tool-card--approval .permission-options .button-primary")?.click();
          const end = Date.now() + 30000;
          while (Date.now() < end && document.querySelector(".tool-card--approval")) await new Promise((resolve) => setTimeout(resolve, 200));
          return !document.querySelector(".tool-card--approval");
        })()`)) as boolean)
      : false;
    const ran = approved ? await ranTool(() => rows(sessionId), "gajae-approval-one", 90_000) : undefined;
    const record = options.store.get(sessionId);
    const result = {
      phase: 5,
      sessionId,
      chatShown: opened.chatShown,
      sent,
      cardShown: card.shown,
      card: card.text,
      banner: card.banner,
      dialogOnScreen: /Do you want to proceed|Yes, and don|❯ 1\. Yes/u.test(screenWhileWaiting),
      statusWhileWaiting,
      approvedFromCard: approved,
      ran: ran ? { id: ran.id, name: ran.name, status: ran.status, output: ran.output?.slice(0, 80) } : null,
      transcriptPath: record?.transcriptPath ?? null,
    };
    if (!result.dialogOnScreen) console.error("screen while the card waited:", JSON.stringify(screenWhileWaiting.slice(-1200)));
    await finish(result, Boolean(sent && card.shown && approved && ran));
  }

  async function phaseRemoteApproval(): Promise<void> {
    const first = JSON.parse(await readFile(options.resultPath, "utf8")) as { sessionId: string };
    const sessionId = first.sessionId;
    if (!options.remote) throw new Error("no remote host");
    const free = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => resolve(port));
      });
    });
    const directory = path.join(path.dirname(options.resultPath), "remote-smoke");
    const service = new RemoteAccessService({
      userDataDirectory: directory,
      webRoot: options.remote.webRoot,
      version: options.remote.version,
      workspace: () => "",
      host: options.remote.host,
      devices: new DeviceStore(path.join(directory, "remote-devices.json")),
      // never the real Tailscale: this smoke must not touch the owner's Serve config
      tailscale: new TailscaleClient({ binary: path.join(directory, "missing-tailscale") }),
      log: () => undefined,
    });
    let operation = 0;
    try {
      await service.setPort(free);
      const enabled = await service.setEnabled(true);
      const origin = `http://127.0.0.1:${enabled.port}`;
      const code = (await service.issuePairingCode("control")).pairing?.code;
      const paired = (await (await fetch(`${origin}/api/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ code, deviceName: "Smoke phone" }),
      })).json()) as { token?: string };
      const headers = { Authorization: `Bearer ${paired.token}`, Origin: origin, "Content-Type": "application/json" };
      const get = async (route: string) => (await fetch(`${origin}${route}`, { headers })).json() as Promise<Record<string, unknown>>;
      const post = async (route: string, body: Record<string, unknown>) => {
        operation += 1;
        const response = await fetch(`${origin}${route}`, { method: "POST", headers, body: JSON.stringify({ ...body, operationId: `op-smoke-approval-${operation}` }) });
        return { status: response.status, body: (await response.json()) as Record<string, unknown> };
      };
      // a read answers `{ result }`
      const phoneRows = async () =>
        (((await get(`/api/sessions/${encodeURIComponent(sessionId)}/transcript-page`)).result as { items?: unknown[] } | undefined)?.items ?? []) as {
          id: string;
          kind: string;
          status?: string;
          command?: string;
          output?: string;
          permissionOptions?: unknown[];
        }[];
      const waitingCard = async (ms: number, not?: string) => {
        const end = Date.now() + ms;
        let polls = 0;
        while (Date.now() < end) {
          const seen = await phoneRows();
          const card = seen.find((row) => row.kind === "tool" && row.status === "approval-required" && row.id !== not);
          if (card) return card;
          if (polls++ % 20 === 0 && process.env.GAJAE_DEBUG_HERDR)
            console.log(`[phone] ${new Date().toISOString().slice(11, 23)} ${seen.length} rows; tools: ${seen.filter((row) => row.kind === "tool").map((row) => `${row.id.slice(-12)}=${row.status}`).join(",")}`);
          await wait(250);
        }
        return undefined;
      };
      const listed = ((await get("/api/state")).sessions as { id: string }[] | undefined)?.some((session) => session.id === sessionId) ?? false;
      const asked = await post(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
        input: { text: "Use the Bash tool to run exactly this command and nothing else: mkdir gajae-approval-two", images: [], files: [] },
      });
      const card = await waitingCard(90_000);
      const decided = card
        ? await post(`/api/tool-calls/${encodeURIComponent(card.id)}/decision`, { decision: { optionId: "allow_once" } })
        : null;
      const ran = card ? await ranTool(phoneRows, "gajae-approval-two", 90_000) : undefined;
      // a third request answered at the terminal: its card must not stay behind (each request is a
      // different command: Claude Code may not ask again for a kind it was allowed in the session)
      await wait(2000);
      const third = await post(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
        input: { text: "Use the Bash tool to run exactly this command and nothing else: rm gajae-approval-one.txt", images: [], files: [] },
      });
      const thirdCard = await waitingCard(90_000, card?.id);
      if (thirdCard) {
        await wait(1500);
        await options.pressKeys?.(sessionId, ["enter"]);
      }
      let thirdClosed = false;
      for (let attempt = 0; thirdCard && attempt < 60 && !thirdClosed; attempt += 1) {
        await wait(500);
        thirdClosed = !(await phoneRows()).some((row) => row.id === thirdCard.id && row.status === "approval-required");
      }
      const thirdRan = thirdCard ? await ranTool(phoneRows, "rm gajae-approval-one", 60_000) : undefined;
      const result = {
        phase: 6,
        listedOnPhone: listed,
        askedFromPhone: asked.status,
        askedOutcome: JSON.stringify(asked.body).slice(0, 200),
        phoneCard: card ? { id: card.id, options: card.permissionOptions?.length ?? 0 } : null,
        decidedFromPhone: decided?.status ?? null,
        ran: ran ? { id: ran.id, status: ran.status, output: ran.output?.slice(0, 80) } : null,
        thirdAsked: third.status,
        thirdCard: thirdCard?.id ?? null,
        thirdClosedByTerminalAnswer: thirdClosed,
        thirdRan: thirdRan ? { id: thirdRan.id, status: thirdRan.status } : null,
      };
      await window.webContents.executeJavaScript(`window.agentControlDesktop.terminal.deleteSession(${JSON.stringify(sessionId)})`);
      await wait(1000);
      await finish(result, Boolean(listed && card && decided?.status === 200 && ran && thirdCard && thirdClosed));
    } finally {
      await service.dispose();
    }
  }

  async function phaseOmpApproval(): Promise<void> {
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), "gajae-omp-approval-smoke-")));
    const model = process.env.GAJAE_SMOKE_OMP_MODEL || "opencodex/opengateway/deepseek/deepseek-v4.1-flash-eco";
    const opened = await openAgent("omp", "omp approval smoke", workspace, { model, permissionMode: "always-ask" }, 930701);
    if (opened.skipped || !opened.ready || !opened.sessionId) {
      await finish({ phase: 7, ...opened }, false);
      return;
    }
    const sessionId = opened.sessionId;
    const sent = await sendFromChat("Run this shell command with your bash tool, exactly as written: touch gajae-omp-approval.txt");
    const card = await cardInWindow(90_000);
    const screenWhileWaiting = (await options.readScreen?.(sessionId)) ?? "";
    const approved = card.shown
      ? ((await window.webContents.executeJavaScript(`(async () => {
          document.querySelector(".tool-card--approval .permission-options .button-primary")?.click();
          const end = Date.now() + 30000;
          while (Date.now() < end && document.querySelector(".tool-card--approval")) await new Promise((resolve) => setTimeout(resolve, 200));
          return !document.querySelector(".tool-card--approval");
        })()`)) as boolean)
      : false;
    const ran = approved ? await ranTool(() => rows(sessionId), "gajae-omp-approval", 90_000) : undefined;
    const result = {
      phase: 7,
      sessionId,
      sent,
      cardShown: card.shown,
      card: card.text,
      ompDialogOnScreen: /Approve|Deny|Allow tool/u.test(screenWhileWaiting),
      approvedFromCard: approved,
      ran: ran ? { id: ran.id, name: ran.name, status: ran.status, output: ran.output?.slice(0, 80) } : null,
    };
    if (!card.shown || !ran) console.error("omp screen:", JSON.stringify(screenWhileWaiting.slice(-1500)));
    await window.webContents.executeJavaScript(`window.agentControlDesktop.terminal.deleteSession(${JSON.stringify(sessionId)})`);
    await wait(1000);
    await finish(result, Boolean(sent && card.shown && approved && ran));
  }

  async function phaseTwo(): Promise<void> {
    const first = JSON.parse(await readFile(options.resultPath, "utf8")) as PhaseOne & { agentSessionRef: string };
    const before = options.store.get(first.sessionId)?.agentSessionRef;
    const listed = (await window.webContents.executeJavaScript(
      `window.agentControlDesktop.terminal.listSessions().then((rows) => rows.find((row) => row.id === ${JSON.stringify(first.sessionId)}) ?? null)`,
    )) as { status: string } | null;
    // the chat of a fresh app reads the transcript the agent kept writing: phase one's turn
    const rows = async (): Promise<{ id: string; kind: string; role?: string; content?: string }[]> =>
      ((await window.webContents.executeJavaScript(
        `window.agentControlDesktop.gjc.getTranscriptPage(${JSON.stringify(first.sessionId)}).then((page) => page.items)`,
      )) as { id: string; kind: string; role?: string; content?: string }[]);
    const beforeClear = await rows();
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
    // /clear moved the agent to another transcript: the chat follows it and leaves the old turn
    const oldIds = new Set(beforeClear.map((row) => row.id));
    let afterClear = await rows();
    for (let attempt = 0; attempt < 25 && afterClear.some((row) => oldIds.has(row.id)); attempt += 1) {
      await wait(200);
      afterClear = await rows();
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
      chatBeforeClear: beforeClear.map((row) => `${row.kind}:${row.role ?? ""}:${String(row.content ?? "").slice(0, 30)}`),
      chatAfterClear: afterClear.map((row) => `${row.kind}:${row.role ?? ""}:${String(row.content ?? "").slice(0, 30)}`),
      chatFollowedClear: beforeClear.length > 0 && !afterClear.some((row) => oldIds.has(row.id)),
      gone: options.store.get(first.sessionId) === undefined,
      failedAnnounced: failed,
    };
    const answeredBefore = beforeClear.some((row) => row.kind === "message" && row.role === "assistant" && /OK/u.test(row.content ?? ""));
    await finish(
      result,
      result.hookAfterRestart && result.gone && !failed && result.listedStatus !== null && answeredBefore && result.chatFollowedClear,
    );
  }
}
