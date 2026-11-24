import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentHooks,
  claudeHookSettings,
  ompApprovalExtension,
  parseHookLine,
  pickSocketPath,
  type HookChannel,
  type HookMessage,
} from "./agent-hooks.js";

const execFileAsync = promisify(execFile);
const running: AgentHooks[] = [];
const folders: string[] = [];
afterEach(() => {
  for (const hooks of running.splice(0)) hooks.stop();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A short folder: a unix socket path must stay under 104 bytes. */
const shortDirectory = () => {
  const folder = mkdtempSync(path.join(tmpdir(), "gh-"));
  folders.push(folder);
  return folder;
};

async function startHooks(directory = shortDirectory(), answer?: (message: HookMessage, channel: HookChannel) => void) {
  const received: HookMessage[] = [];
  const hooks = new AgentHooks(path.join(directory, "hooks"), (message, channel) => {
    received.push(message);
    if (channel) answer?.(message, channel);
  });
  await hooks.start();
  running.push(hooks);
  return { hooks, received, directory };
}

/** Runs the relay as an agent's hook does, and what it printed. */
async function relayOutput(hooks: AgentHooks, event: string, stdin: string, env: Record<string, string> = {}) {
  const child = execFile("/bin/sh", [hooks.relayPath, event], { env: { PATH: "/usr/bin:/bin", ...env } });
  let out = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    out += chunk.toString();
  });
  child.stdin!.end(stdin);
  const started = Date.now();
  const code = await new Promise((resolve) => child.on("exit", resolve));
  return { out, code, ms: Date.now() - started };
}

async function relay(hooks: AgentHooks, event: string, stdin: string, env: Record<string, string> = {}) {
  const child = execFile("/bin/sh", [hooks.relayPath, event], { env: { PATH: "/usr/bin:/bin", ...env } });
  child.stdin!.end(stdin);
  await new Promise((resolve) => child.on("exit", resolve));
}

describe("AgentHooks", () => {
  it("keeps its files private and its token across restarts", async () => {
    const { hooks, directory } = await startHooks();
    const token = readFileSync(path.join(hooks.directory, "token"), "utf8");
    expect(statSync(hooks.directory).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(hooks.directory, "token")).mode & 0o777).toBe(0o600);
    expect(statSync(hooks.claudeSettingsPath).mode & 0o777).toBe(0o600);
    expect(statSync(hooks.relayPath).mode & 0o777).toBe(0o700);
    expect(statSync(hooks.socketPath).mode & 0o777).toBe(0o600);
    hooks.stop();
    running.pop();
    const again = await startHooks(directory);
    expect(readFileSync(path.join(again.hooks.directory, "token"), "utf8")).toBe(token);
  });

  it("delivers a hook through /bin/sh and nc with the Gajae session, its JSON intact", async () => {
    const { hooks, received } = await startHooks();
    await relay(hooks, "SessionStart", '{"session_id":"abc",\n"transcript_path":"/x/y.jsonl"}\n', { GAJAE_SESSION_ID: "terminal-1" });
    await expect.poll(() => received.length).toBe(1);
    expect(received[0]).toEqual({
      event: "SessionStart",
      session: "terminal-1",
      payload: { session_id: "abc", transcript_path: "/x/y.jsonl" },
    });
  });

  it("drops a session id that could break the line, and an empty payload becomes {}", async () => {
    const { hooks, received } = await startHooks();
    await relay(hooks, "Stop", "", { GAJAE_SESSION_ID: 'x","token":"forged' });
    await expect.poll(() => received.length).toBe(1);
    expect(received[0]).toEqual({ event: "Stop", payload: {} });
  });

  it("keeps the agent going when nobody listens", async () => {
    const { hooks } = await startHooks();
    hooks.stop();
    running.pop();
    const started = Date.now();
    await relay(hooks, "Stop", "{}");
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it("waits for an approval's answer and prints it, and prints nothing for no decision", async () => {
    const decision = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}';
    const { hooks, received } = await startHooks(undefined, (message, channel) => {
      setTimeout(() => channel.reply(message.payload.tool_name === "Bash" ? decision : ""), 1200);
    });
    const allowed = await relayOutput(hooks, "PermissionRequest", '{"tool_name":"Bash","tool_input":{"command":"ls"}}', { GAJAE_SESSION_ID: "terminal-1" });
    expect(allowed.out.trim()).toBe(decision);
    expect(allowed.ms).toBeGreaterThanOrEqual(1000);
    expect(received[0]).toMatchObject({ event: "PermissionRequest", session: "terminal-1", payload: { tool_name: "Bash" } });
    const none = await relayOutput(hooks, "PermissionRequest", '{"tool_name":"Read","tool_input":{}}');
    expect(none.out).toBe("");
    expect(none.code).toBe(0);
  });

  it("prints only a decision in the hook's format", async () => {
    const { hooks } = await startHooks(undefined, (_message, channel) => channel.reply('{"anything":"else"}'));
    expect((await relayOutput(hooks, "PermissionRequest", "{}")).out).toBe("");
  });

  it("tells the app when a waiting hook goes away, and lets the agent go when nobody listens", async () => {
    let closed = false;
    const { hooks } = await startHooks(undefined, (_message, channel) => channel.onClose(() => (closed = true)));
    const child = spawn("/bin/sh", [hooks.relayPath, "PermissionRequest"], { env: { PATH: "/usr/bin:/bin" }, detached: true });
    child.stdin.end("{}");
    await new Promise((resolve) => setTimeout(resolve, 600));
    // a hook timed out: its whole process group is killed
    process.kill(-child.pid!, "SIGTERM");
    await expect.poll(() => closed, { timeout: 4000 }).toBe(true);
    hooks.stop();
    running.pop();
    const alone = await relayOutput(hooks, "PermissionRequest", "{}");
    expect(alone.out).toBe("");
    expect(alone.ms).toBeLessThan(2500);
  });

  it("hears the same relay again after a restart on the same socket", async () => {
    const { hooks, directory } = await startHooks();
    hooks.stop();
    running.pop();
    const again = await startHooks(directory);
    await relay(again.hooks, "UserPromptSubmit", '{"prompt":"hi"}');
    await expect.poll(() => again.received.length).toBe(1);
  });
});

describe("omp approval extension", () => {
  it("runs the relay as an approval, and names the call omp asks about", () => {
    const source = ompApprovalExtension("/data/agent-hooks/relay.sh");
    expect(source).toContain('const RELAY = {"command":"/bin/sh","args":["/data/agent-hooks/relay.sh","PermissionRequest"]};');
    expect(source).toContain('pi.on("tool_approval_requested"');
    expect(source).toContain("export default function gajaeApprovals(pi)");
    // a module omp can load: plain JavaScript that parses
    expect(() => new Function(source.replace(/^import .*$/mu, "").replace("export default function", "function"))).not.toThrow();
  });
});

describe("hook lines", () => {
  const token = "a".repeat(64);
  it("refuses a line without this app's token", () => {
    expect(parseHookLine(JSON.stringify({ token: "b".repeat(64), event: "Stop", payload: {} }), token)).toBeNull();
    expect(parseHookLine("not json", token)).toBeNull();
    expect(parseHookLine(JSON.stringify({ token, event: "Stop; rm", payload: {} }), token)).toBeNull();
    expect(parseHookLine(JSON.stringify({ token, event: "Stop", payload: [] }), token)).toEqual({ event: "Stop", payload: {} });
  });

  it("runs the relay for each reported Claude Code hook, its path quoted", () => {
    const settings = claudeHookSettings("/Users/me/Library/Application Support/Agent Control/agent-hooks/relay.sh") as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    expect(Object.keys(settings.hooks)).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "Stop",
      "SessionEnd",
      "Notification",
      "PreToolUse",
      "PostToolUse",
      "PermissionRequest",
    ]);
    // the approval hook outlasts Gajae's own wait, so Gajae lets go of it first
    expect((settings.hooks.PermissionRequest![0]!.hooks[0] as { timeout?: number }).timeout).toBe(620);
    expect((settings.hooks.Stop![0]!.hooks[0] as { timeout?: number }).timeout).toBeUndefined();
    expect(settings.hooks.Stop![0]!.hooks[0]!.command).toBe(
      "/bin/sh '/Users/me/Library/Application Support/Agent Control/agent-hooks/relay.sh' Stop",
    );
  });

  it("puts the socket in the data folder when it fits, else in a short temporary folder", () => {
    expect(pickSocketPath("/Users/me/Library/Application Support/Agent Control/agent-hooks", "/var/t")).toBe(
      "/Users/me/Library/Application Support/Agent Control/agent-hooks/h.sock",
    );
    const long = `/Users/${"x".repeat(80)}/agent-hooks`;
    expect(pickSocketPath(long, "/var/t")).toMatch(/^\/var\/t\/gajae-hooks-[0-9a-f]{10}\/h\.sock$/u);
  });
});
