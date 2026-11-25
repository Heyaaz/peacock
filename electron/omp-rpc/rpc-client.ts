/**
 * One `omp --mode rpc-ui` process, spoken to over its stdio (design §10).
 *
 * omp writes one JSON object per line on stdout: a `ready` frame first, then responses to the
 * commands written on stdin (matched by `id`), session events, UI requests and
 * `prompt_result` frames. Under protocol 2 a frame over 1 MiB comes as `rpc_chunk` lines that
 * are put back together here (P0: a 1.4 MB `get_messages` arrived as six chunks). A line that is
 * not JSON (a login shell's banner) is passed over.
 */

/** The process the client talks to: a child process, or a fake in tests. */
export interface RpcProcess {
  readonly pid?: number | undefined;
  readonly stdin: {
    write(chunk: string): boolean;
    end(): void;
    on(event: "error", listener: (error: Error) => void): unknown;
  } | null;
  readonly stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  readonly stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

/** An RPC frame as decoded: an object with a `type`. */
export type RpcFrame = Record<string, unknown> & { type: string };

/** The `ready` frame omp writes once it listens. */
export interface RpcReadyFrame {
  type: "ready";
  protocolVersion: number;
  supportedProtocolVersions?: number[];
  maxFrameBytes?: number;
  maxReassembledFrameBytes?: number;
}

/** The frame that ends one accepted prompt, after all the work it caused. */
export interface RpcPromptResult {
  type: "prompt_result";
  id?: string;
  agentInvoked: boolean;
  status: "completed" | "aborted" | "error";
  error?: { message: string; provider?: string; model?: string; httpStatus?: number; retryable?: boolean; code?: string };
  sessionSettled: boolean;
}

/** A command omp refused (`success: false`), with its machine-readable reason when it gave one. */
export class OmpRpcError extends Error {
  constructor(
    readonly command: string,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "OmpRpcError";
  }
}

/** The process ended (or never started) while something waited on it. */
export class OmpRpcExitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OmpRpcExitError";
  }
}

/** The longest line kept while waiting for its end; omp's own reassembly ceiling is 64 MiB. */
const MAX_LINE_BYTES = 80 * 1024 * 1024;
/** How long a command waits for its response unless the caller says otherwise. */
export const DEFAULT_CALL_TIMEOUT_MS = 30_000;
/** How much of stderr is kept to explain an exit. */
const STDERR_TAIL = 4000;

interface PendingChunks {
  chunkId: string;
  count: number;
  byteLength: number;
  next: number;
  parts: Buffer[];
}

/**
 * Puts protocol-2 `rpc_chunk` lines back into the frame they carry. A sequence that breaks off
 * (another frame in the middle, a gap, a length that does not add up) is dropped with a reason
 * instead of failing the connection.
 */
export class RpcChunkAssembler {
  private pending: PendingChunks | undefined;

  constructor(private readonly onDrop: (reason: string) => void = () => undefined) {}

  /** The frame a parsed line stands for, or undefined while a chunked one is still arriving. */
  push(value: Record<string, unknown>): Record<string, unknown> | undefined {
    if (value.type !== "rpc_chunk") {
      if (this.pending) {
        this.onDrop(`chunk sequence ${this.pending.chunkId} interrupted`);
        this.pending = undefined;
      }
      return value;
    }
    const { chunkId, index, count, byteLength, data } = value;
    if (
      typeof chunkId !== "string" ||
      typeof index !== "number" ||
      typeof count !== "number" ||
      typeof byteLength !== "number" ||
      typeof data !== "string" ||
      !Number.isSafeInteger(index) ||
      !Number.isSafeInteger(count) ||
      index < 0 ||
      count < 1 ||
      index >= count ||
      byteLength < 0 ||
      byteLength > MAX_LINE_BYTES
    ) {
      this.onDrop("invalid chunk metadata");
      this.pending = undefined;
      return undefined;
    }
    if (index === 0) {
      if (this.pending) this.onDrop(`chunk sequence ${this.pending.chunkId} restarted`);
      this.pending = { chunkId, count, byteLength, next: 0, parts: [] };
    }
    const pending = this.pending;
    if (!pending || pending.chunkId !== chunkId || pending.count !== count || pending.byteLength !== byteLength || pending.next !== index) {
      this.onDrop(`chunk ${index} of ${chunkId} out of sequence`);
      this.pending = undefined;
      return undefined;
    }
    pending.parts.push(Buffer.from(data, "base64"));
    pending.next += 1;
    if (pending.next < pending.count) return undefined;
    this.pending = undefined;
    const bytes = Buffer.concat(pending.parts);
    if (bytes.byteLength !== pending.byteLength) {
      this.onDrop(`chunk sequence ${chunkId} is ${bytes.byteLength} bytes, not ${pending.byteLength}`);
      return undefined;
    }
    try {
      const frame: unknown = JSON.parse(bytes.toString("utf8"));
      if (frame && typeof frame === "object" && !Array.isArray(frame)) return frame as Record<string, unknown>;
    } catch {
      // reported below
    }
    this.onDrop(`chunk sequence ${chunkId} is not a JSON object`);
    return undefined;
  }
}

interface PendingCall {
  command: string;
  resolve(data: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface PendingPrompt {
  resolve(result: RpcPromptResult): void;
  reject(error: Error): void;
}

export interface OmpRpcClientOptions {
  log?(message: string): void;
}

/**
 * The client side of one omp RPC process: writes commands, matches responses to them by id,
 * waits for `ready` and for each prompt's `prompt_result`, and hands every other frame to its
 * listeners in order. Everything waiting is refused once the process ends.
 */
export class OmpRpcClient {
  private buffer = "";
  private readonly assembler: RpcChunkAssembler;
  private readonly listeners = new Set<(frame: RpcFrame) => void>();
  private readonly exitListeners = new Set<(info: { code: number | null; signal: string | null; stderr: string }) => void>();
  private readonly calls = new Map<string, PendingCall>();
  private readonly prompts = new Map<string, PendingPrompt>();
  private sequence = 0;
  private stderrTail = "";
  private exitInfo: { code: number | null; signal: string | null; stderr: string } | undefined;
  private readyFrame: RpcReadyFrame | undefined;
  private readonly readyWaiters: { resolve(frame: RpcReadyFrame): void; reject(error: Error): void }[] = [];
  private closing = false;

  constructor(
    private readonly child: RpcProcess,
    private readonly options: OmpRpcClientOptions = {},
  ) {
    this.assembler = new RpcChunkAssembler((reason) => this.log(`dropped a chunked frame: ${reason}`));
    child.stdout?.on("data", (chunk) => this.receive(typeof chunk === "string" ? chunk : chunk.toString("utf8")));
    child.stderr?.on("data", (chunk) => {
      this.stderrTail = (this.stderrTail + (typeof chunk === "string" ? chunk : chunk.toString("utf8"))).slice(-STDERR_TAIL);
    });
    child.stdin?.on("error", (error) => this.log(`stdin: ${error.message}`));
    child.on("error", (error) => this.ended(null, null, error.message));
    child.on("exit", (code, signal) => this.ended(code, signal));
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Whether the process has ended. */
  get exited(): boolean {
    return this.exitInfo !== undefined;
  }

  /** The `ready` frame, once it came. */
  get ready(): RpcReadyFrame | undefined {
    return this.readyFrame;
  }

  /** Resolves with the `ready` frame; refuses if the process ends first or `timeoutMs` passes. */
  waitReady(timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<RpcReadyFrame> {
    if (this.readyFrame) return Promise.resolve(this.readyFrame);
    if (this.exitInfo) return Promise.reject(this.exitError("before it was ready"));
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (frame: RpcReadyFrame) => {
          clearTimeout(timer);
          resolve(frame);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        const at = this.readyWaiters.indexOf(waiter);
        if (at >= 0) this.readyWaiters.splice(at, 1);
        reject(new OmpRpcExitError(`omp did not report ready within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.readyWaiters.push(waiter);
    });
  }

  /** Every frame that is not the response to a command, in the order omp wrote them. */
  onFrame(listener: (frame: RpcFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onExit(listener: (info: { code: number | null; signal: string | null; stderr: string }) => void): () => void {
    if (this.exitInfo) {
      listener(this.exitInfo);
      return () => undefined;
    }
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /**
   * Sends a command and resolves with its response's `data`. A refusal rejects with
   * {@link OmpRpcError}; no answer within `timeoutMs` (0: wait for ever) or an exit rejects too.
   */
  call<T = unknown>(command: Record<string, unknown> & { type: string }, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<T> {
    if (this.exitInfo || this.closing) return Promise.reject(this.exitError(`before ${command.type}`));
    const id = this.nextId();
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.calls.delete(id);
              reject(new OmpRpcError(command.type, `omp did not answer ${command.type} within ${Math.round(timeoutMs / 1000)}s`, "timeout"));
            }, timeoutMs)
          : undefined;
      this.calls.set(id, { command: command.type, resolve: resolve as (data: unknown) => void, reject, timer });
      this.write({ ...command, id });
    });
  }

  /**
   * Sends a prompt-like command (`prompt`, `abort_and_prompt`): `accepted` settles with its
   * response, `result` with the `prompt_result` that ends the work it caused. A refused
   * command rejects both.
   */
  prompt(command: Record<string, unknown> & { type: string }): { id: string; accepted: Promise<unknown>; result: Promise<RpcPromptResult> } {
    if (this.exitInfo || this.closing) {
      const error = this.exitError(`before ${command.type}`);
      const refused = Promise.reject(error);
      refused.catch(() => undefined);
      return { id: "", accepted: refused, result: refused as Promise<RpcPromptResult> };
    }
    const id = this.nextId();
    let rejectResult: (error: Error) => void = () => undefined;
    const result = new Promise<RpcPromptResult>((resolve, reject) => {
      rejectResult = reject;
      this.prompts.set(id, { resolve, reject });
    });
    // nobody may be listening yet; the exit or refusal still reaches whoever awaits it
    result.catch(() => undefined);
    const accepted = new Promise<unknown>((resolve, reject) => {
      this.calls.set(id, {
        command: command.type,
        resolve,
        reject: (error) => {
          this.prompts.delete(id);
          rejectResult(error);
          reject(error);
        },
        timer: undefined,
      });
    });
    accepted.catch(() => undefined);
    this.write({ ...command, id });
    return { id, accepted, result };
  }

  /** Writes a frame that expects no response (`extension_ui_response`). */
  send(frame: Record<string, unknown> & { type: string }): void {
    if (this.exitInfo || this.closing) return;
    this.write(frame);
  }

  /** Ends stdin (omp exits when its input ends), then terminates what is still running. */
  close(graceMs = 2000): void {
    if (this.exitInfo) return;
    this.closing = true;
    try {
      this.child.stdin?.end();
    } catch {
      // already closed
    }
    const term = setTimeout(() => {
      if (this.exitInfo) return;
      this.child.kill("SIGTERM");
      const kill = setTimeout(() => {
        if (!this.exitInfo) this.child.kill("SIGKILL");
      }, graceMs);
      kill.unref?.();
    }, graceMs);
    term.unref?.();
  }

  private nextId(): string {
    this.sequence += 1;
    return `g${this.sequence}`;
  }

  private write(frame: Record<string, unknown>): void {
    try {
      this.child.stdin?.write(`${JSON.stringify(frame)}\n`);
    } catch (error) {
      this.log(`write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private receive(text: string): void {
    this.buffer += text;
    let end = this.buffer.indexOf("\n");
    while (end !== -1) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      this.line(line);
      end = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.log("dropped an over-long line");
      this.buffer = "";
    }
  }

  private line(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      this.log(`passed over a non-JSON line (${trimmed.length} chars)`);
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const frame = this.assembler.push(value as Record<string, unknown>);
    if (!frame || typeof frame.type !== "string") return;
    this.dispatch(frame as RpcFrame);
  }

  private dispatch(frame: RpcFrame): void {
    if (frame.type === "ready" && !this.readyFrame) {
      this.readyFrame = frame as unknown as RpcReadyFrame;
      for (const waiter of this.readyWaiters.splice(0)) waiter.resolve(this.readyFrame);
    }
    if (frame.type === "response" && typeof frame.id === "string") {
      const pending = this.calls.get(frame.id);
      if (pending) {
        this.calls.delete(frame.id);
        clearTimeout(pending.timer);
        if (frame.success === false)
          pending.reject(
            new OmpRpcError(
              pending.command,
              typeof frame.error === "string" ? frame.error : `${pending.command} failed`,
              typeof frame.code === "string" ? frame.code : undefined,
            ),
          );
        else pending.resolve(frame.data);
        return;
      }
    }
    if (frame.type === "prompt_result" && typeof frame.id === "string") {
      const prompt = this.prompts.get(frame.id);
      if (prompt) {
        this.prompts.delete(frame.id);
        prompt.resolve(frame as unknown as RpcPromptResult);
      }
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(frame);
      } catch (error) {
        this.log(`frame listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private ended(code: number | null, signal: string | null, reason?: string): void {
    if (this.exitInfo) return;
    if (this.buffer.trim()) this.line(this.buffer);
    this.buffer = "";
    this.exitInfo = { code, signal, stderr: reason ? `${this.stderrTail}\n${reason}`.trim() : this.stderrTail };
    const error = this.exitError("");
    for (const waiter of this.readyWaiters.splice(0)) waiter.reject(error);
    for (const [, call] of this.calls) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.calls.clear();
    for (const [, prompt] of this.prompts) prompt.reject(error);
    this.prompts.clear();
    for (const listener of [...this.exitListeners]) listener(this.exitInfo);
    this.exitListeners.clear();
  }

  private exitError(when: string): OmpRpcExitError {
    const info = this.exitInfo;
    const how = info ? (info.signal ? `signal ${info.signal}` : `code ${info.code ?? "?"}`) : this.closing ? "closing" : "not running";
    const last = info?.stderr.trim().split("\n").at(-1);
    return new OmpRpcExitError(`omp ended (${how})${when ? ` ${when}` : ""}${last ? `: ${last}` : ""}`);
  }

  private log(message: string): void {
    this.options.log?.(message);
  }
}
