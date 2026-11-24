import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { HcConnection, HcError, type HcTransport, type HelloInfo } from "./connection.js";
import { contaminatedNames, parseEnvBlock, withoutInherited } from "./env.js";
import { compareVersions, parseHcVersion } from "./version.js";

export type HcMode = "packaged" | "development" | "smoke";

const SESSION_NAME = /^[A-Za-z0-9_.-]{1,64}$/u;
/** Sessions a smoke run names for itself; their state goes when their core stops. */
const THROWAWAY_SESSION = /^(?:gajae-smoke|gs)-\d+$/u;
/** The longest unix socket path macOS takes (sun_path is 104 bytes with its NUL). */
const SOCKET_PATH_LIMIT = 103;

/**
 * Whether hc can open every socket of `session` under `home`. The longest is a holder's,
 * `<state>/<session>/<session>.holder.<8 hex>.sock`: hc refuses a session name that would make it
 * too long ("use a shorter HC_SESSION"), and the session name appears in it twice.
 */
export function sessionFitsSocket(session: string, home: string = homedir()): boolean {
  const holder = path.join(home, ".local", "state", "herdr-core", session, `${session}.holder.00000000.sock`);
  return Buffer.byteLength(holder) <= SOCKET_PATH_LIMIT;
}

/**
 * The hc session Gajae's core runs under. hc keeps a session's state in one place for the whole
 * user (`~/.local/state/herdr-core/<session>`), so a development build, a smoke run and the
 * installed app each get their own and never touch another's terminals, nor the user's `default`.
 * A smoke run's name shortens when the user's home folder would make its sockets too long.
 */
export function hcSessionName(
  mode: HcMode,
  pid: number = process.pid,
  override?: string,
  home: string = homedir(),
): string {
  const named = override?.trim();
  if (named && SESSION_NAME.test(named) && named !== "default") return named;
  if (mode === "packaged") return "gajae";
  if (mode === "development") return "gajae-dev";
  const smoke = `gajae-smoke-${pid}`;
  return sessionFitsSocket(smoke, home) ? smoke : `gs-${pid}`;
}

/** hc's own words for why it stopped, from the JSON error it prints when piped. */
export function hcFailureText(stderr: string): string {
  const text = stderr.trim();
  if (!text) return "";
  for (const line of text.split("\n").reverse()) {
    try {
      const parsed = JSON.parse(line) as { error?: { message?: unknown; hint?: unknown } };
      const message = typeof parsed.error?.message === "string" ? parsed.error.message : "";
      const hint = typeof parsed.error?.hint === "string" && parsed.error.hint ? ` (${parsed.error.hint})` : "";
      if (message) return `${message}${hint}`;
    } catch {
      // not hc's JSON
    }
  }
  return text.split("\n").slice(-3).join(" ").slice(0, 500);
}

/** A transport that can say what hc printed before it ended. */
type DiagnosedTransport = HcTransport & { stderr?: () => string };

/** Where a macOS core of `session` listens, as hc works it out when nothing overrides it. */
export function coreSocketPath(
  session: string,
  home: string = homedir(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const state = env.XDG_STATE_HOME || path.join(home, ".local", "state");
  return path.join(state, "herdr-core", session, `${session}.sock`);
}

/** `hc connect` as a child process, its descriptors closed and in exactly `env`. */
export function spawnHcConnect(binary: string, env: Record<string, string>): DiagnosedTransport {
  const [command, args] = withoutInherited(binary, ["connect"]);
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4096);
  });
  const exited = new Promise<unknown>((resolve) => {
    child.once("exit", resolve);
    child.once("error", resolve);
  });
  // a child that exited takes no more; its end is reported through `exited`
  child.stdin.on("error", () => undefined);
  return {
    readable: child.stdout,
    write: (bytes) => {
      if (!child.stdin.destroyed) child.stdin.write(bytes);
    },
    exited,
    kill: () => {
      child.kill();
    },
    stderr: () => stderr,
  };
}

export type HcRunner = (
  binary: string,
  args: readonly string[],
  env: Record<string, string>,
) => Promise<{ code: number | null; stdout: string }>;

const runHc: HcRunner = (binary, args, env) =>
  new Promise((resolve) => {
    const [command, wrapped] = withoutInherited(binary, args);
    execFile(command, wrapped, { env, timeout: 30_000 }, (error, stdout) => {
      const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
      resolve({ code, stdout: String(stdout) });
    });
  });

export interface HcCoreOptions {
  session: string;
  /** The hc to run and its version (the installed bundle, or GAJAE_HC_BIN). */
  locate: () => Promise<{ binary: string; version: number[] | null }>;
  /** The allow-listed environment hc runs in (env.ts `coreEnvironment`). */
  environment: () => Promise<Record<string, string>>;
  /** A smoke or test core: stopped when Gajae quits instead of left running. */
  disposable?: boolean;
  connect?: (binary: string, env: Record<string, string>) => HcTransport;
  run?: HcRunner;
  log?: (message: string) => void;
}

/**
 * Gajae's herdr-core: which session, which hc, in which environment, and one connection to it.
 *
 * Every hc command except `--version` starts the core when none runs, `hc connect` included, so
 * nothing here runs hc until a terminal needs it (or `isRunning` says one already does). The core
 * runs apart from the app: quitting Gajae closes this connection and leaves the core and its
 * terminals running, unless the core is a smoke run's.
 */
export class HcCore {
  readonly session: string;
  private opening: Promise<HcConnection> | undefined;
  private connection_: HcConnection | undefined;
  private hello_: HelloInfo | undefined;
  private launched: { binary: string; env: Record<string, string> } | undefined;
  private readonly connect: (binary: string, env: Record<string, string>) => DiagnosedTransport;
  private lastTransport: DiagnosedTransport | undefined;
  private readonly run: HcRunner;
  private readonly log: (message: string) => void;

  constructor(private readonly options: HcCoreOptions) {
    this.session = options.session;
    this.connect = options.connect ?? spawnHcConnect;
    this.run = options.run ?? runHc;
    this.log = options.log ?? ((message) => console.log(`herdr-core: ${message}`));
  }

  /** The core this connection reached, once it has. */
  get core(): HelloInfo | undefined {
    return this.hello_;
  }

  /** Whether a core of this session already listens; never starts one. */
  isRunning(): boolean {
    return existsSync(coreSocketPath(this.session));
  }

  /** One connection to the core, started, current and clean before it is handed out. */
  connection(): Promise<HcConnection> {
    if (!this.opening)
      this.opening = this.open().catch((error: unknown) => {
        this.opening = undefined;
        throw error;
      });
    return this.opening;
  }

  private async open(): Promise<HcConnection> {
    const { binary, version } = await this.options.locate();
    const env = await this.options.environment();
    this.launched = { binary, env };
    let hc = this.newConnection(binary, env);
    let hello: HelloInfo;
    try {
      hello = await hc.hello();
    } catch (error) {
      hc.close();
      // hc says why on stderr (a session name too long for its socket, a refused update)
      await new Promise((resolve) => setTimeout(resolve, 50));
      const why = hcFailureText(this.lastTransport?.stderr?.() ?? "");
      if (why && error instanceof HcError) throw new HcError(error.kind, `${error.message}: ${why}`);
      throw error;
    }
    const running = parseHcVersion(hello.version);
    if (running && version && compareVersions(running, version) < 0) {
      this.log(`core ${hello.version} is older than this app's hc; restarting it on the newer one`);
      ({ hc, hello } = await this.restartAndReconnect(hc, binary, env));
    }
    const dirty = await this.contamination(hc);
    if (dirty.length > 0) {
      // names only: their values may be secrets
      this.log(`core environment has ${dirty.join(", ")}; restarting it with Gajae's environment`);
      ({ hc, hello } = await this.restartAndReconnect(hc, binary, env));
      const still = await this.contamination(hc);
      if (still.length > 0) this.log(`core environment still has ${still.join(", ")}`);
    }
    this.connection_ = hc;
    this.hello_ = hello;
    return hc;
  }

  private newConnection(binary: string, env: Record<string, string>): HcConnection {
    return new HcConnection(() => {
      const transport = this.connect(binary, env);
      this.lastTransport = transport;
      return transport;
    }, {
      onEnd: (kind, message) => {
        if (kind !== "closed") this.log(`connection ended (${kind}): ${message}`);
      },
    });
  }

  private async restartAndReconnect(
    previous: HcConnection,
    binary: string,
    env: Record<string, string>,
  ): Promise<{ hc: HcConnection; hello: HelloInfo }> {
    previous.close();
    const result = await this.run(binary, ["server", "restart", "--json"], env);
    if (result.code !== 0) throw new HcError("restart_failed", `hc server restart failed (${result.code ?? "timeout"})`);
    const hc = this.newConnection(binary, env);
    return { hc, hello: await hc.hello() };
  }

  /**
   * What the core would give a new terminal that Gajae's own launch never would. It asks the core
   * to run `env` without a terminal, which shows the environment of the client that started it.
   */
  private async contamination(hc: HcConnection): Promise<string[]> {
    try {
      const ran = await hc.call("machine.exec", { argv: ["/usr/bin/env", "-0"], timeout: 5 });
      if (ran.code !== 0 || ran.timed_out || ran.truncated) return [];
      return contaminatedNames(parseEnvBlock(Buffer.from(ran.stdout, "base64").toString("utf8")));
    } catch {
      return [];
    }
  }

  /** Stops this core and every program in it. Only for a smoke run's own core. */
  stopSync(): void {
    if (!this.launched) return;
    const [command, args] = withoutInherited(this.launched.binary, ["server", "stop", "--json"]);
    spawnSync(command, args, { env: this.launched.env, timeout: 10_000, stdio: "ignore" });
    // a smoke run's state is nobody's once its core stopped; a named session's is its owner's
    if (THROWAWAY_SESSION.test(this.session))
      rmSync(path.dirname(coreSocketPath(this.session)), { recursive: true, force: true });
  }

  /** Lets go of the core: it keeps running with its terminals unless it is disposable. */
  dispose(): void {
    this.connection_?.close();
    this.connection_ = undefined;
    this.opening = undefined;
    if (this.options.disposable) this.stopSync();
  }
}
