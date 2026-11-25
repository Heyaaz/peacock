import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { RpcProcess } from "./rpc-client.js";

/** A process that speaks the omp RPC protocol as a test scripts it. */
export class FakeRpcProcess extends EventEmitter implements RpcProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  /** Every frame the client wrote, parsed. */
  readonly written: Record<string, unknown>[] = [];
  killed: NodeJS.Signals | undefined;
  private input = "";
  private readonly responders: ((frame: Record<string, unknown>) => void)[] = [];

  constructor() {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => {
      this.input += chunk;
      let end = this.input.indexOf("\n");
      while (end !== -1) {
        const frame = JSON.parse(this.input.slice(0, end)) as Record<string, unknown>;
        this.input = this.input.slice(end + 1);
        this.written.push(frame);
        for (const responder of this.responders) responder(frame);
        end = this.input.indexOf("\n");
      }
    });
  }

  /** Writes frames on stdout, one line each. */
  emitFrames(...frames: unknown[]): void {
    for (const frame of frames) this.stdout.write(`${JSON.stringify(frame)}\n`);
  }

  emitLine(line: string): void {
    this.stdout.write(line);
  }

  ready(): void {
    this.emitFrames({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576 });
  }

  /** Answers each command the client writes. */
  respond(responder: (frame: Record<string, unknown>) => void): void {
    this.responders.push(responder);
  }

  /** Answers every command with success and the data `data(frame)` returns. */
  answerAll(data: (frame: Record<string, unknown>) => unknown = () => undefined): void {
    this.respond((frame) => {
      if (frame.type === "extension_ui_response" || typeof frame.id !== "string") return;
      const value = data(frame);
      queueMicrotask(() => this.emitFrames({ id: frame.id, type: "response", command: frame.type, success: true, ...(value === undefined ? {} : { data: value }) }));
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed = signal;
    queueMicrotask(() => this.exit(null, signal));
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
  }

  /** The written frames of one type. */
  sent(type: string): Record<string, unknown>[] {
    return this.written.filter((frame) => frame.type === type);
  }
}

/** Waits until the event loop has run what is queued. */
export function settle(times = 3): Promise<void> {
  let chain = Promise.resolve();
  for (let index = 0; index < times; index += 1) chain = chain.then(() => new Promise((resolve) => setImmediate(resolve)));
  return chain;
}
