import type { TerminalSessionRecord } from "../../shared/terminal-ipc.js";
import type { SessionTerminalProvider, SessionTerminalRequest, TerminalHandle } from "../terminal-backend.js";
import type { TerminalControlFrame } from "../terminal-session.js";
import {
  TERMINAL_MAX_INPUT_CHARS,
  clampTerminalDimension,
  loginShellPlan,
  resolveShellCwd,
} from "../terminal-shell.js";
import type { LaunchPlan } from "./agent-launch.js";
import { CoreAttachSession } from "./attach-session.js";
import type { HcConnection, HelloInfo } from "./connection.js";
import type { Terminal } from "./hc-api.generated.js";

/** Every terminal Gajae starts carries its session id here, so the next start can find it. */
export const SESSION_LABEL = "gajae.session";
/** The agent the terminal runs (`shell` for terminal sessions). */
export const AGENT_LABEL = "gajae.agent";

export interface TerminalBindingStore {
  get(sessionId: string): TerminalSessionRecord | undefined;
  list(): TerminalSessionRecord[];
  bindTerminal(
    sessionId: string,
    binding: { coreId: string; terminalAddress: string } | undefined,
  ): void;
}

/** A session's command when nobody says otherwise: the login shell. */
export async function shellLaunch(): Promise<LaunchPlan> {
  const shell = loginShellPlan()[0];
  if (!shell) throw new Error("No login shell to run");
  return { argv: [shell.file, ...shell.args] };
}

export interface HcCoreAccess {
  connection(): Promise<HcConnection>;
  readonly core: HelloInfo | undefined;
  /** Whether a core already runs; asking never starts one. */
  isRunning?(): boolean;
}

/** What a CLOSE says about how the stream ended. */
function endOf(code: number | null, reason: Record<string, unknown> | null | undefined) {
  const why = typeof reason?.reason === "string" ? reason.reason : undefined;
  const signal = typeof reason?.signal === "number" ? reason.signal : undefined;
  const finished = typeof reason?.finished_ms === "number";
  if (typeof code === "number") return { exitCode: code, ...(signal === undefined ? {} : { signal }) };
  if (finished || why === "killed" || why === "exited" || why === "server_stop")
    return { exitCode: signal === undefined ? 0 : 128 + signal, ...(signal === undefined ? {} : { signal }) };
  // exit_code null without an end: the line dropped (a reconnect, not an exit 0)
  return { exitCode: 0, disconnected: true };
}

/**
 * Terminal sessions' shells in herdr-core: one hc terminal per session, labelled with the session
 * id and recorded with the core it lives on, attached to by every view that shows it.
 */
export class HcSessionTerminals implements SessionTerminalProvider {
  constructor(
    private readonly core: HcCoreAccess,
    private readonly store: TerminalBindingStore,
    private readonly launch: (record: TerminalSessionRecord) => Promise<LaunchPlan> = shellLaunch,
  ) {}

  async open(request: SessionTerminalRequest): Promise<TerminalHandle> {
    const hc = await this.core.connection();
    const coreId = this.core.core?.core.id;
    if (!coreId) throw new Error("herdr-core did not say which core it is");
    const record = this.store.get(request.record.id) ?? request.record;
    let address = record.coreId === coreId ? record.terminalAddress : undefined;
    let terminal = address ? await this.find(hc, address, record.id) : undefined;
    if (terminal && request.restart) {
      await this.end(hc, terminal.address);
      terminal = undefined;
    }
    if (process.env.GAJAE_DEBUG_HERDR)
      console.log(`[herdr open] ${record.id} restart=${request.restart} bound=${address ?? "-"} live=${terminal ? "yes" : "no"}`);
    if (!terminal) {
      const plan = await this.launch(record);
      // hc reads a bare argv[0] as one of its templates: the program is always a path
      if (!plan.argv[0]?.startsWith("/")) throw new Error("A terminal program must be an absolute path");
      const cols = clampTerminalDimension(request.cols ?? 80);
      const rows = clampTerminalDimension(request.rows ?? 24);
      const started = await hc.call("terminal.run", {
        argv: plan.argv,
        cwd: resolveShellCwd(record.workspace),
        ...(plan.env && Object.keys(plan.env).length > 0 ? { env: plan.env } : {}),
        labels: { [SESSION_LABEL]: record.id, [AGENT_LABEL]: record.agentKind ?? "shell" },
        no_parent: true,
        no_notify: true,
        size: { cols, rows },
      });
      address = started.address;
      this.store.bindTerminal(record.id, { coreId, terminalAddress: address });
    }
    return this.attach(hc, address!, request);
  }

  async kill(record: TerminalSessionRecord): Promise<void> {
    const recorded = this.store.get(record.id) ?? record;
    // nothing to end, and connecting would start a core just to find that out
    if (!recorded.terminalAddress && this.core.isRunning?.() === false) return;
    const hc = await this.core.connection();
    const coreId = this.core.core?.core.id;
    const current = this.store.get(record.id) ?? record;
    const addresses = new Set<string>();
    if (current.terminalAddress && current.coreId === coreId) addresses.add(current.terminalAddress);
    // a start that never got recorded still carries the label
    for (const terminal of await this.labelled(hc, true))
      if (terminal.labels[SESSION_LABEL] === record.id) addresses.add(terminal.address);
    for (const address of addresses) await this.end(hc, address);
    this.store.bindTerminal(record.id, undefined);
  }

  async killAll(): Promise<number> {
    if (this.core.isRunning?.() === false) return 0;
    const hc = await this.core.connection();
    let ended = 0;
    for (const terminal of await this.labelled(hc, true)) {
      if (terminal.state !== "finished") ended += 1;
      await this.end(hc, terminal.address);
    }
    for (const record of this.store.list()) this.store.bindTerminal(record.id, undefined);
    return ended;
  }

  /**
   * Squares the store with the core at startup: a labelled terminal whose session is gone is
   * an orphan and ends; a finished one is removed; a session whose terminal is gone forgets it.
   */
  async reconcile(): Promise<{ orphans: number; forgotten: number }> {
    const hc = await this.core.connection();
    const coreId = this.core.core?.core.id;
    const sessions = new Map(this.store.list().map((record) => [record.id, record]));
    const live = new Set<string>();
    let orphans = 0;
    for (const terminal of await this.labelled(hc, true)) {
      const owner = sessions.get(terminal.labels[SESSION_LABEL]!);
      const bound = owner?.coreId === coreId && owner?.terminalAddress === terminal.address;
      if (terminal.state === "finished" || !owner || (!bound && owner.terminalAddress)) {
        if (terminal.state !== "finished") orphans += 1;
        await this.end(hc, terminal.address);
        continue;
      }
      if (!bound && coreId) this.store.bindTerminal(owner.id, { coreId, terminalAddress: terminal.address });
      live.add(terminal.address);
    }
    let forgotten = 0;
    for (const record of sessions.values()) {
      if (!record.terminalAddress || record.coreId !== coreId) continue;
      if (live.has(record.terminalAddress)) continue;
      this.store.bindTerminal(record.id, undefined);
      forgotten += 1;
    }
    return { orphans, forgotten };
  }

  private async labelled(hc: HcConnection, all: boolean): Promise<Terminal[]> {
    const listed = await hc.call("terminal.list", { all });
    return listed.terminals.filter((terminal) => typeof terminal.labels?.[SESSION_LABEL] === "string");
  }

  private async find(hc: HcConnection, address: string, sessionId: string): Promise<Terminal | undefined> {
    let terminal: Terminal;
    try {
      terminal = await hc.call("terminal.get", { terminal: address });
    } catch {
      return undefined;
    }
    if (terminal.labels?.[SESSION_LABEL] !== sessionId) return undefined;
    if (terminal.state === "finished") {
      await hc.call("terminal.rm", { terminal: address }).catch(() => undefined);
      return undefined;
    }
    return terminal;
  }

  /** Ends a terminal's program if it still runs, then removes the finished terminal. */
  private async end(hc: HcConnection, address: string): Promise<void> {
    await hc.call("terminal.kill", { terminal: address }, 15_000).catch(() => undefined);
    await hc.call("terminal.rm", { terminal: address }).catch(() => undefined);
  }

  private attach(hc: HcConnection, address: string, request: SessionTerminalRequest): TerminalHandle {
    let detached = false;
    let ending: Promise<void> | undefined;
    const session = new CoreAttachSession({
      hc,
      terminal: address,
      cols: clampTerminalDimension(request.cols ?? 80),
      rows: clampTerminalDimension(request.rows ?? 24),
      onData: (data) => {
        if (!detached) request.onData(data);
      },
      onExit: (code, reason) => {
        if (detached) return;
        detached = true;
        request.onExit(endOf(code, reason));
      },
    });
    let cols = clampTerminalDimension(request.cols ?? 80);
    let rows = clampTerminalDimension(request.rows ?? 24);
    let paused = false;
    return {
      handle: (frame: TerminalControlFrame) => {
        if (detached) return;
        if (frame.t === "i") {
          if (typeof frame.d !== "string" || !frame.d || frame.d.length > TERMINAL_MAX_INPUT_CHARS) return;
          session.write(frame.d);
        } else if (frame.t === "r") {
          const nextCols = clampTerminalDimension(frame.c);
          const nextRows = clampTerminalDimension(frame.r);
          // a same-size RESIZE would make this viewer hc's active one for nothing
          if (nextCols === cols && nextRows === rows) return;
          cols = nextCols;
          rows = nextRows;
          session.resize(cols, rows);
        } else if (frame.t === "p" && frame.paused !== paused) {
          paused = frame.paused;
          if (paused) session.pause();
          else session.resume();
        }
      },
      detach: () => {
        if (detached) return;
        detached = true;
        session.kill();
      },
      kill: () => {
        if (!detached) {
          detached = true;
          session.kill();
        }
        ending ??= this.end(hc, address).catch(() => undefined);
      },
    };
  }
}
