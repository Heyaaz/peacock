import { describe, expect, it, vi } from "vitest";
import { encodeFrame, FRAME_DATA, makeFrameReader, type Frame, type HcTransport } from "./connection.js";
import { HcCore, coreSocketPath, hcFailureText, hcSessionName, sessionFitsSocket } from "./core.js";

/** A core of `version` whose `machine.exec env -0` prints `env`. */
class FakeCore implements HcTransport {
  readonly readable: AsyncIterable<Uint8Array>;
  readonly exited = new Promise<unknown>(() => {});
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private plain = true;
  private readonly frames = makeFrameReader((frame) => this.onFrame(frame), () => {});

  constructor(
    private readonly version: string,
    private readonly env: Record<string, string>,
  ) {
    this.readable = new ReadableStream<Uint8Array>({ start: (controller) => { this.controller = controller; } }) as unknown as AsyncIterable<Uint8Array>;
  }

  write(bytes: Uint8Array): void {
    if (this.plain) {
      this.plain = false;
      const result = { generation: 1, framed: true, version: this.version, core: { id: "core-1", name: "mac" }, methods: [], features: [] };
      this.controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ id: 0, jsonrpc: "2.0", result })}\n`));
      return;
    }
    this.frames(bytes);
  }

  kill(): void {}

  private onFrame(frame: Frame): void {
    const message = JSON.parse(new TextDecoder().decode(frame.payload)) as { id: number; method: string };
    if (message.method !== "machine.exec") return;
    const stdout = Buffer.from(Object.entries(this.env).map(([name, value]) => `${name}=${value}\0`).join("")).toString("base64");
    this.controller.enqueue(encodeFrame(0, FRAME_DATA, JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { code: 0, ms: 1, stdout, stderr: "", timed_out: false, truncated: false } })));
  }
}

const CLEAN = { HOME: "/Users/me", PATH: "/usr/bin", HC_SESSION: "gajae" };

function core(cores: FakeCore[], run = vi.fn(async () => ({ code: 0, stdout: "{}" }))) {
  let made = 0;
  const hc = new HcCore({
    session: "gajae",
    locate: async () => ({ binary: "/app/hc", version: [0, 1, 18] }),
    environment: async () => ({ HOME: "/Users/me", HC_SESSION: "gajae" }),
    connect: () => cores[Math.min(made++, cores.length - 1)]!,
    run,
    log: () => {},
  });
  return { hc, run };
}

describe("hcSessionName", () => {
  it("gives the installed app, a development build and a smoke run sessions of their own", () => {
    expect(hcSessionName("packaged", 1, undefined, "/Users/me")).toBe("gajae");
    expect(hcSessionName("development", 1, undefined, "/Users/me")).toBe("gajae-dev");
    expect(hcSessionName("smoke", 4242, undefined, "/Users/me")).toBe("gajae-smoke-4242");
  });

  it("takes a session the caller named, never the user's default", () => {
    expect(hcSessionName("smoke", 1, " gjs-run ", "/Users/me")).toBe("gjs-run");
    expect(hcSessionName("packaged", 1, "default", "/Users/me")).toBe("gajae");
    expect(hcSessionName("packaged", 1, "../escape", "/Users/me")).toBe("gajae");
  });

  it("shortens a smoke session that would make hc's holder socket path too long", () => {
    const home = `/Users/${"x".repeat(30)}`;
    expect(sessionFitsSocket("gajae-smoke-12345", home)).toBe(false);
    expect(hcSessionName("smoke", 12345, undefined, home)).toBe("gs-12345");
    expect(sessionFitsSocket("gajae-smoke-12345", "/Users/me")).toBe(true);
  });

  it("finds the socket where hc keeps it on macOS", () => {
    expect(coreSocketPath("gajae", "/Users/me", {})).toBe("/Users/me/.local/state/herdr-core/gajae/gajae.sock");
    expect(coreSocketPath("gajae", "/Users/me", { XDG_STATE_HOME: "/s" })).toBe("/s/herdr-core/gajae/gajae.sock");
  });
});

describe("hcFailureText", () => {
  it("reads hc's JSON error and its hint", () => {
    expect(
      hcFailureText('{"error":{"hint":"use a shorter HC_SESSION","kind":"usage","message":"the socket path is too long"}}\n'),
    ).toBe("the socket path is too long (use a shorter HC_SESSION)");
    expect(hcFailureText("plain failure")).toBe("plain failure");
    expect(hcFailureText("")).toBe("");
  });
});

describe("HcCore", () => {
  it("connects once and remembers which core it reached", async () => {
    const { hc, run } = core([new FakeCore("0.1.18", CLEAN)]);
    const first = await hc.connection();
    expect(await hc.connection()).toBe(first);
    expect(hc.core?.core.id).toBe("core-1");
    expect(run).not.toHaveBeenCalled();
    hc.dispose();
  });

  it("restarts an older running core on this app's newer hc", async () => {
    const { hc, run } = core([new FakeCore("0.1.17", CLEAN), new FakeCore("0.1.18", CLEAN)]);
    await hc.connection();
    expect(run).toHaveBeenCalledWith("/app/hc", ["server", "restart", "--json"], { HOME: "/Users/me", HC_SESSION: "gajae" });
    expect(hc.core?.version).toBe("0.1.18");
    hc.dispose();
  });

  it("never restarts a newer core onto an older hc", async () => {
    const { hc, run } = core([new FakeCore("0.1.20", CLEAN)]);
    await hc.connection();
    expect(run).not.toHaveBeenCalled();
    hc.dispose();
  });

  it("restarts a core another launch left with a polluted environment", async () => {
    const { hc, run } = core([new FakeCore("0.1.18", { ...CLEAN, CLAUDECODE: "1" }), new FakeCore("0.1.18", CLEAN)]);
    await hc.connection();
    expect(run).toHaveBeenCalledTimes(1);
    hc.dispose();
  });

  it("says why when hc stops before it answers", async () => {
    const failing: HcTransport & { stderr: () => string } = {
      readable: (async function* () {})(),
      write: () => {},
      exited: Promise.resolve(1),
      kill: () => {},
      stderr: () => '{"error":{"hint":"use a shorter HC_SESSION","kind":"usage","message":"socket path too long"}}',
    };
    const hc = new HcCore({
      session: "gajae",
      locate: async () => ({ binary: "/app/hc", version: [0, 1, 18] }),
      environment: async () => ({}),
      connect: () => failing,
      log: () => {},
    });
    await expect(hc.connection()).rejects.toThrow(/socket path too long \(use a shorter HC_SESSION\)/u);
  });
});
