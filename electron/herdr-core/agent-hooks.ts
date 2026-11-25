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

/**
 * The hooks Claude Code reports through the relay: its session and turns (P2), and its tool calls
 * and approvals (P4). PermissionRequest is the one that waits for an answer.
 */
export const CLAUDE_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "SessionEnd",
  "Notification",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
] as const;

/** The hook that waits for Gajae's decision on an approval and prints it. */
export const APPROVAL_HOOK_EVENT = "PermissionRequest";
/**
 * How long Gajae holds an approval request open (seconds). Claude Code draws its own dialog while
 * the hook waits (measured, design §5.6), so the agent is never held by it: this is only how long a
 * card can still answer. The hook's own timeout is a little longer, so Gajae lets go first.
 */
export const APPROVAL_WAIT_SECONDS = 600;
const APPROVAL_HOOK_TIMEOUT_SECONDS = APPROVAL_WAIT_SECONDS + 20;

/** What a hook that waits is answered with, and told when the agent lets go of it. */
export interface HookChannel {
  /** Answers the hook (one line) and closes it; an empty answer is no decision. */
  reply(answer: string): void;
  /** True once the hook went away (answered, timed out, or killed). */
  readonly closed: boolean;
  onClose(listener: () => void): void;
}

/** Leaves room under macOS's 104-byte sun_path for the NUL and a margin. */
const SOCKET_PATH_LIMIT = 100;
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
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
 *
 * An approval (`PermissionRequest`) waits for Gajae's answer and prints it. macOS's nc closes the
 * connection as soon as its input ends, so the input stays open, a newline every 0.2s (which Gajae
 * ignores), until Gajae answers and closes; then the next newline ends the loop, and the hook. Only a decision in
 * Claude Code's hook format is printed: anything else, no app, or a closed socket is no decision,
 * and the agent's own dialog stands.
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
    "LINE=$(printf '{\"token\":\"%s\",\"event\":\"%s\",\"session\":\"%s\",\"payload\":%s}' \"$TOKEN\" \"$1\" \"$GAJAE_SESSION_ID\" \"$PAYLOAD\")",
    `if [ "$1" = "${APPROVAL_HOOK_EVENT}" ]; then`,
    `  ANSWER=$( { printf '%s\\n' "$LINE"; i=0; while [ $i -lt ${APPROVAL_HOOK_TIMEOUT_SECONDS * 5} ] && sleep 0.2; do echo; i=$((i+1)); done; } | /usr/bin/nc -U "$SOCK" 2>/dev/null )`,
    "  case \"$ANSWER\" in '{\"hookSpecificOutput\":'*) printf '%s\\n' \"$ANSWER\" ;; esac",
    "  exit 0",
    "fi",
    "printf '%s\\n' \"$LINE\" | /usr/bin/nc -U -w 2 \"$SOCK\" >/dev/null 2>&1",
    "exit 0",
    "",
  ].join("\n");
}

/**
 * `--settings` for Claude Code: each reported hook runs the relay with its own name, for every
 * tool (no matcher). The approval hook gets a timeout past Gajae's own wait.
 */
export function claudeHookSettings(relayPath: string): Record<string, unknown> {
  const hook = (event: string) => [
    {
      hooks: [
        {
          type: "command",
          command: `/bin/sh ${shellQuote(relayPath)} ${event}`,
          ...(event === APPROVAL_HOOK_EVENT ? { timeout: APPROVAL_HOOK_TIMEOUT_SECONDS } : {}),
        },
      ],
    },
  ];
  return { hooks: Object.fromEntries(CLAUDE_HOOK_EVENTS.map((event) => [event, hook(event)])) };
}

/**
 * omp's approval hook: an extension loaded with `-e <file>` for the runs Gajae starts (adapted
 * from Ovis's server/approvals/extension.ts and omp.ts, MIT License, Copyright (c) 2026 devswha;
 * see THIRD_PARTY_NOTICES.md). omp asks a tool approval through its UI context's `approve` in a
 * dialog of its own; the extension wraps it and, for a call it can name (omp 19's
 * `tool_approval_requested` gives the call id, `tool_call` its input), asks Gajae through the same
 * relay as Claude Code's hook while omp's dialog stays on screen. Whichever answers first wins and
 * the other is let go (the relay is killed, which closes Gajae's request). No answer from Gajae
 * leaves omp's dialog as the only one. A prompt offering grants to remember is left to omp alone.
 */
export function ompApprovalExtension(relayPath: string): string {
  const relay = { command: "/bin/sh", args: [relayPath, APPROVAL_HOOK_EVENT] };
  return `// Gajae's approval hook for omp. Written by Gajae, read once when omp starts.
import { spawn } from "node:child_process";
const RELAY = ${JSON.stringify(relay)};
const REMEMBERED = 64;

function askGajae(request, signal) {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    let child;
    const stop = () => { try { child?.kill(); } catch {} };
    const finish = (decision) => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", stop);
      resolve(decision);
    };
    try {
      child = spawn(RELAY.command, RELAY.args, { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      finish(null);
      return;
    }
    signal.addEventListener("abort", stop, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stdin.on("error", () => {});
    child.on("error", () => finish(null));
    child.on("close", () => {
      let behavior;
      try { behavior = JSON.parse(out)?.hookSpecificOutput?.decision?.behavior; } catch {}
      finish(behavior === "allow" || behavior === "deny" ? behavior : null);
    });
    child.stdin.end(JSON.stringify(request));
  });
}

/** Gajae's decision, or a promise that never settles where it gives none: omp's dialog answers then. */
const gajaeDecision = (request, signal) => askGajae(request, signal).then((decision) => decision ?? new Promise(() => {}));

export default function gajaeApprovals(pi) {
  const calls = new Map();
  const requested = [];
  const wrapped = new WeakSet();
  pi.on("tool_call", (event) => {
    if (typeof event?.toolCallId !== "string") return undefined;
    calls.set(event.toolCallId, { toolName: event.toolName, input: event.input });
    if (calls.size > REMEMBERED) calls.delete(calls.keys().next().value);
    return undefined;
  });
  pi.on("tool_approval_requested", (event) => {
    if (typeof event?.toolCallId !== "string" || typeof event?.toolName !== "string") return undefined;
    requested.push({ toolCallId: event.toolCallId, toolName: event.toolName, reason: event.reason });
    if (requested.length > REMEMBERED) requested.shift();
    return undefined;
  });
  pi.on("tool_result", (event) => { calls.delete(event?.toolCallId); });
  pi.on("session_start", (_event, ctx) => {
    const ui = ctx?.ui;
    // omp's terminal UI only: in its RPC mode the dialogs are the RPC client's
    if (ctx?.mode !== "tui" || !ctx.hasUI || typeof ui?.approve !== "function" || wrapped.has(ui)) return;
    wrapped.add(ui);
    const approve = ui.approve.bind(ui);
    // omp shows one dialog at a time: Gajae holds only the one on screen, never one queued behind it
    let asked = Promise.resolve();
    ui.approve = async (prompt, opts) => {
      const head = requested[0];
      const named = head !== undefined && typeof prompt?.full === "string" && prompt.full.includes(head.toolName);
      if (named) requested.shift();
      const request = named && !prompt.grants?.length
        ? {
            hook_event_name: "PermissionRequest",
            agent: "omp",
            tool_use_id: head.toolCallId,
            tool_name: head.toolName,
            tool_input: calls.get(head.toolCallId)?.input ?? {},
            reason: typeof head.reason === "string" ? head.reason : null,
            prompt: prompt.full,
          }
        : null;
      const before = asked;
      let answered;
      const mine = new Promise((resolve) => { answered = resolve; });
      asked = before.then(() => mine);
      if (request === null) return approve(prompt, opts).finally(answered);
      const closing = new AbortController();
      const signal = opts?.signal ? AbortSignal.any([closing.signal, opts.signal]) : closing.signal;
      try {
        return await Promise.race([
          approve(prompt, { ...opts, signal }),
          before.then(() => gajaeDecision(request, signal)).then((decision) => (decision === "allow" ? "once" : "deny")),
        ]);
      } finally {
        closing.abort();
        answered();
      }
    };
  });
}
`;
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

/** A waiting hook's connection as a channel: one answer, then closed. */
function socketChannel(socket: net.Socket): HookChannel {
  const listeners: (() => void)[] = [];
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const listener of listeners.splice(0)) listener();
  };
  socket.on("close", close);
  // the relay ends its input only when it gives up (its loop ran out): nothing will read an answer
  socket.on("end", () => socket.destroy());
  return {
    reply(answer: string) {
      if (closed || socket.destroyed) return;
      if (answer) socket.end(`${answer}\n`);
      else socket.end();
    },
    get closed() {
      return closed || socket.destroyed;
    },
    onClose(listener: () => void) {
      if (closed || socket.destroyed) listener();
      else listeners.push(listener);
    },
  };
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
  /** omp's approval extension (`-e <file>`). */
  readonly ompExtensionPath: string;
  private readonly tokenPath: string;
  private token = "";
  private server: net.Server | undefined;

  constructor(
    directory: string,
    private readonly onMessage: (message: HookMessage, channel?: HookChannel) => void,
    socketPath?: string,
  ) {
    this.directory = directory;
    this.socketPath = socketPath ?? pickSocketPath(directory);
    this.relayPath = path.join(directory, "relay.sh");
    this.claudeSettingsPath = path.join(directory, "claude-settings.json");
    this.ompExtensionPath = path.join(directory, "omp-approvals.js");
    this.tokenPath = path.join(directory, "token");
  }

  /**
   * Points a relay left in another data folder (the one before the rename, design §11) at this
   * socket, so agents started with that folder's hooks, still running in herdr-core, keep reaching
   * this app. Only a relay that is there is rewritten; call it after `start`.
   */
  redirectRelay(relayPath: string): boolean {
    if (!existsSync(relayPath)) return false;
    writePrivate(relayPath, relayScript(this.socketPath, this.tokenPath), 0o700);
    return true;
  }

  /** Whether the app is listening: hooks reach it and an approval can be answered. */
  get listening(): boolean {
    return this.server?.listening === true;
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
    writePrivate(this.ompExtensionPath, ompApprovalExtension(this.relayPath), 0o600);
    mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    // a socket left by an app that did not get to close it would refuse the bind
    try {
      unlinkSync(this.socketPath);
    } catch {
      // nothing there
    }
    const server = net.createServer((socket) => {
      let buffered = Buffer.alloc(0);
      const onData = (chunk: Buffer): void => {
        buffered = Buffer.concat([buffered, chunk]);
        const end = buffered.indexOf(0x0a);
        if (end === -1 && buffered.length <= MAX_MESSAGE_BYTES) return;
        socket.off("data", onData);
        const message = end === -1 ? null : parseHookLine(buffered.subarray(0, end).toString("utf8"), this.token);
        buffered = Buffer.alloc(0);
        // an approval waits on this connection for its answer; every other hook is done
        if (!message || message.event !== APPROVAL_HOOK_EVENT) socket.end();
        if (!message) return;
        // what the relay sends after its line (a newline a second) only keeps the line open
        if (message.event === APPROVAL_HOOK_EVENT) socket.resume();
        try {
          this.onMessage(message, message.event === APPROVAL_HOOK_EVENT ? socketChannel(socket) : undefined);
        } catch (error) {
          console.error("Agent hook handling failed", error);
          socket.end();
        }
      };
      socket.on("data", onData);
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
