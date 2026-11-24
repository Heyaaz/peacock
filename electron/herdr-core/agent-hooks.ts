import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

/** One hook call an agent made, as the relay delivered it. */
export interface HookMessage {
  /** The hook (`SessionStart`, `UserPromptSubmit`, `Stop`, …). */
  event: string;
  /** The Gajae session the agent runs in (`GAJAE_SESSION_ID` in its terminal). */
  session?: string;
  payload: Record<string, unknown>;
}

/** The hooks Claude Code reports through the relay (P2: session and turn). */
export const CLAUDE_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd", "Notification"] as const;

/** Leaves room under macOS's 104-byte sun_path for the NUL and a margin. */
const SOCKET_PATH_LIMIT = 100;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const EVENT_NAME = /^[A-Za-z]{1,64}$/u;

/** The first socket path that fits: the app's data folder, else a short per-user one in TMPDIR. */
export function pickSocketPath(directory: string, temporary: string = tmpdir()): string {
  const candidates = [
    path.join(directory, "h.sock"),
    path.join(temporary, `gajae-hooks-${createHash("sha256").update(directory).digest("hex").slice(0, 10)}`, "h.sock"),
  ];
  const fits = candidates.find((candidate) => Buffer.byteLength(candidate) <= SOCKET_PATH_LIMIT);
  if (!fits) throw new Error("No hook socket path is short enough on this machine");
  return fits;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The relay every hook runs: `/bin/sh` and `/usr/bin/nc -U`, both always on macOS. It sends one
 * line (token, hook, Gajae session, the hook's JSON with its line breaks removed) and always exits 0,
 * so an app that is not listening never holds the agent up (P0.5 spike). JSON strings escape their
 * own line breaks, so removing raw ones leaves the payload intact.
 */
export function relayScript(socketPath: string, tokenFile: string): string {
  return [
    "#!/bin/sh",
    "# Gajae's hook relay: hook JSON on stdin -> one line on Gajae's socket. Never blocks the agent.",
    `SOCK=${shellQuote(socketPath)}`,
    `TOKEN=$(cat ${shellQuote(tokenFile)} 2>/dev/null)`,
    "PAYLOAD=$(tr -d '\\n\\r')",
    "[ -n \"$PAYLOAD\" ] || PAYLOAD='{}'",
    "case \"$GAJAE_SESSION_ID\" in *[!A-Za-z0-9_-]*) GAJAE_SESSION_ID= ;; esac",
    "printf '{\"token\":\"%s\",\"event\":\"%s\",\"session\":\"%s\",\"payload\":%s}\\n' \"$TOKEN\" \"$1\" \"$GAJAE_SESSION_ID\" \"$PAYLOAD\" | /usr/bin/nc -U -w 2 \"$SOCK\" >/dev/null 2>&1",
    "exit 0",
    "",
  ].join("\n");
}

/** `--settings` for Claude Code: each reported hook runs the relay with its own name. */
export function claudeHookSettings(relayPath: string): Record<string, unknown> {
  const hook = (event: string) => [
    { hooks: [{ type: "command", command: `/bin/sh ${shellQuote(relayPath)} ${event}` }] },
  ];
  return { hooks: Object.fromEntries(CLAUDE_HOOK_EVENTS.map((event) => [event, hook(event)])) };
}

/** A relay line, if it carries this app's token and a well-formed hook; null otherwise. */
export function parseHookLine(line: string, token: string): HookMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.token !== "string" || !sameToken(record.token, token)) return null;
  if (typeof record.event !== "string" || !EVENT_NAME.test(record.event)) return null;
  const payload =
    record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
      ? (record.payload as Record<string, unknown>)
      : {};
  const session = typeof record.session === "string" && SESSION_ID.test(record.session) ? record.session : undefined;
  return { event: record.event, ...(session ? { session } : {}), payload };
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function writePrivate(file: string, content: string, mode: number): void {
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, content, { mode });
  chmodSync(temporary, mode);
  renameSync(temporary, file);
}

/**
 * The hook channel: a relay script, Claude Code settings and a token kept in the app's data folder
 * (0700 folder, 0600 files) so agents started before a restart keep reporting after it, and a
 * unix socket at a fixed short path the app listens on while it runs.
 */
export class AgentHooks {
  readonly directory: string;
  readonly socketPath: string;
  readonly relayPath: string;
  readonly claudeSettingsPath: string;
  private readonly tokenPath: string;
  private token = "";
  private server: net.Server | undefined;

  constructor(
    directory: string,
    private readonly onMessage: (message: HookMessage) => void,
    socketPath?: string,
  ) {
    this.directory = directory;
    this.socketPath = socketPath ?? pickSocketPath(directory);
    this.relayPath = path.join(directory, "relay.sh");
    this.claudeSettingsPath = path.join(directory, "claude-settings.json");
    this.tokenPath = path.join(directory, "token");
  }

  /** Writes the relay and settings (keeping the token), then listens. */
  async start(): Promise<void> {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    this.token = existsSync(this.tokenPath) ? readFileSync(this.tokenPath, "utf8").trim() : "";
    if (!/^[0-9a-f]{64}$/u.test(this.token)) {
      this.token = randomBytes(32).toString("hex");
      writePrivate(this.tokenPath, `${this.token}\n`, 0o600);
    }
    writePrivate(this.relayPath, relayScript(this.socketPath, this.tokenPath), 0o700);
    writePrivate(this.claudeSettingsPath, `${JSON.stringify(claudeHookSettings(this.relayPath), null, 2)}\n`, 0o600);
    mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    // a socket left by an app that did not get to close it would refuse the bind
    try {
      unlinkSync(this.socketPath);
    } catch {
      // nothing there
    }
    const server = net.createServer((socket) => {
      let buffered = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        const end = buffered.indexOf(0x0a);
        if (end === -1 && buffered.length <= MAX_MESSAGE_BYTES) return;
        socket.end();
        socket.removeAllListeners("data");
        if (end === -1) return;
        const message = parseHookLine(buffered.subarray(0, end).toString("utf8"), this.token);
        if (message) {
          try {
            this.onMessage(message);
          } catch (error) {
            console.error("Agent hook handling failed", error);
          }
        }
      });
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    chmodSync(this.socketPath, 0o600);
    this.server = server;
  }

  stop(): void {
    this.server?.close();
    this.server = undefined;
    try {
      unlinkSync(this.socketPath);
    } catch {
      // already gone
    }
  }
}
