import { describe, expect, it } from "vitest";
import {
  encodeFrame,
  FRAME_CLOSE,
  FRAME_DATA,
  HcConnection,
  HcError,
  HcReplyError,
  makeFrameReader,
  parseHello,
  type Frame,
  type HcTransport,
} from "./connection.js";

const HELLO = { generation: 1, framed: true, version: "0.1.18", core: { id: "c1", name: "mac" }, methods: ["hello"], features: ["framed", "attach"] };

/** A core that answers hello, then each call with what `answer` returns for it. */
class ScriptedCore implements HcTransport {
  readonly readable: AsyncIterable<Uint8Array>;
  readonly calls: { method: string; params: unknown }[] = [];
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private plain = true;
  private readonly frames = makeFrameReader((frame) => this.onFrame(frame), () => {});
  private ended!: (value: unknown) => void;
  readonly exited = new Promise<unknown>((resolve) => {
    this.ended = resolve;
  });

  constructor(
    private readonly answer: (method: string, params: unknown) => { result?: unknown; error?: unknown } | undefined,
    private readonly hello: unknown = { id: 0, jsonrpc: "2.0", result: HELLO },
  ) {
    this.readable = new ReadableStream<Uint8Array>({ start: (controller) => { this.controller = controller; } }) as unknown as AsyncIterable<Uint8Array>;
  }

  write(bytes: Uint8Array): void {
    if (this.plain) {
      this.plain = false;
      this.controller.enqueue(new TextEncoder().encode(`${JSON.stringify(this.hello)}\n`));
      return;
    }
    this.frames(bytes);
  }

  kill(): void {
    this.end();
  }

  end(): void {
    try {
      this.controller.close();
    } catch {
      // already closed
    }
    this.ended(0);
  }

  private onFrame(frame: Frame): void {
    if (frame.channel !== 0) return;
    const message = JSON.parse(new TextDecoder().decode(frame.payload)) as { id: number; method: string; params: unknown };
    this.calls.push({ method: message.method, params: message.params });
    const reply = this.answer(message.method, message.params);
    if (reply) this.controller.enqueue(encodeFrame(0, FRAME_DATA, JSON.stringify({ jsonrpc: "2.0", id: message.id, ...reply })));
  }
}

describe("hc frames", () => {
  it("round-trips frames however the bytes are split", () => {
    const frames: Frame[] = [];
    const read = makeFrameReader((frame) => frames.push(frame), () => {});
    const bytes = new Uint8Array([
      ...encodeFrame(0, FRAME_DATA, '{"a":1}'),
      ...encodeFrame(7, FRAME_CLOSE, new Uint8Array(0)),
      ...encodeFrame(7, FRAME_DATA, "xyz"),
    ]);
    for (let at = 0; at < bytes.length; at += 3) read(bytes.subarray(at, at + 3));
    expect(frames.map((frame) => [frame.channel, frame.kind, new TextDecoder().decode(frame.payload)])).toEqual([
      [0, FRAME_DATA, '{"a":1}'],
      [7, FRAME_CLOSE, ""],
      [7, FRAME_DATA, "xyz"],
    ]);
  });

  it("writes the header as channel u32 LE, kind u8, length u32 LE", () => {
    const frame = encodeFrame(258, 4, "ab");
    expect([...frame]).toEqual([2, 1, 0, 0, 4, 2, 0, 0, 0, 97, 98]);
  });

  it("stops at a length past hc's ceiling instead of waiting for it", () => {
    const invalid: string[] = [];
    const read = makeFrameReader(() => {}, (reason) => invalid.push(reason));
    const header = new Uint8Array(9);
    new DataView(header.buffer).setUint32(5, 64 * 1024 * 1024, true);
    read(header);
    read(encodeFrame(0, FRAME_DATA, "late"));
    expect(invalid).toHaveLength(1);
  });
});

describe("hc hello", () => {
  it("reads what the core can do from methods and features", () => {
    expect(parseHello(JSON.stringify({ result: HELLO }))).toEqual({
      version: "0.1.18",
      core: { id: "c1", name: "mac" },
      methods: ["hello"],
      features: ["framed", "attach"],
    });
  });

  it("refuses another generation, an unframed answer and a missing core", () => {
    expect(parseHello(JSON.stringify({ result: { ...HELLO, generation: 2 } }))).toMatch(/generation 2/u);
    expect(parseHello(JSON.stringify({ result: { ...HELLO, framed: false } }))).toMatch(/framed/u);
    expect(parseHello(JSON.stringify({ result: { ...HELLO, core: {} } }))).toMatch(/core/u);
    expect(parseHello("not json")).toMatch(/not JSON/u);
    expect(parseHello(JSON.stringify({ error: { message: "nope" } }))).toMatch(/nope/u);
  });
});

describe("HcConnection", () => {
  it("answers calls side by side and turns hc's error into its kind", async () => {
    const core = new ScriptedCore((method) =>
      method === "terminal.get"
        ? { error: { code: -32000, message: "t9 not found", data: { kind: "not_found" } } }
        : { result: { live: 0, method } },
    );
    const hc = new HcConnection(() => core);
    const [status, missing] = await Promise.allSettled([
      hc.call("server.status", {}),
      hc.call("terminal.get", { terminal: "t9" }),
    ]);
    expect(status).toMatchObject({ status: "fulfilled", value: { method: "server.status" } });
    expect(missing).toMatchObject({ status: "rejected", reason: { kind: "not_found" } });
    expect((missing as PromiseRejectedResult).reason).toBeInstanceOf(HcReplyError);
    hc.close();
  });

  it("fails what is waiting when the line ends, and starts a new line for the next call", async () => {
    const cores: ScriptedCore[] = [];
    const hc = new HcConnection(() => {
      const core = new ScriptedCore((method) => (method === "terminal.list" ? undefined : { result: { ok: cores.length } }));
      cores.push(core);
      return core;
    });
    const waiting = hc.call("terminal.list", {});
    await hc.hello();
    cores[0]!.end();
    await expect(waiting).rejects.toBeInstanceOf(HcError);
    await expect(hc.call("server.status", {})).resolves.toEqual({ ok: 2 });
    expect(cores).toHaveLength(2);
    hc.close();
  });

  it("gives up on a hello the core never answers", async () => {
    const core = new ScriptedCore(() => undefined, undefined);
    core.write = () => {};
    const hc = new HcConnection(() => core, { timeoutMs: 50 });
    await expect(hc.hello()).rejects.toMatchObject({ kind: "timeout" });
  });
});
