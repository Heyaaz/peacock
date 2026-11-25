/*
 * Parts adapted from Ovis (https://github.com/devswha/ovis), MIT License, Copyright (c) 2026 devswha:
 * the descriptor-closing launch (app/electron/src/children.ts `withoutInherited`) and the
 * `env -0` block reader (server/herdr-core/terminal-env.ts `envBlock`).
 */
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { runtimePath } from "../runtime-path.js";

type SourceEnv = Readonly<Record<string, string | undefined>>;

/**
 * What a core Gajae starts may inherit. hc hands every terminal the environment of the client
 * that started its core (P0.5 spike), so anything else in Gajae's own environment would reach
 * every shell: an Electron switch, a parent agent's CLAUDECODE and session tokens, a terminal's
 * TERMINFO. The login shell each terminal runs rebuilds the rest from the user's profile.
 */
const CORE_ENV = /^(?:HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z_]+|TZ|TMPDIR|SSH_AUTH_SOCK|__CF_USER_TEXT_ENCODING)$/u;

/**
 * Names that mean a core was started by something other than Gajae's clean launch: a parent
 * agent's markers, an Electron or Node switch, colour overrides, package-manager and editor
 * variables, and anything that carries a secret. Only names are ever reported, never values.
 */
const CONTAMINATED =
  /^(?:CLAUDECODE|CLAUDE_.*|CODEX_.*|AI_AGENT|ELECTRON_.*|NODE_OPTIONS|NO_COLOR|FORCE_COLOR|npm_.*|VSCODE_.*|TERMINFO|GAJAE_.*|.*(?:TOKEN|SECRET|PASSWORD|API_KEY).*)$/iu;

/** The environment Gajae runs hc in: the allow-listed variables, the user's PATH, and the session. */
export function coreEnvironment(
  source: SourceEnv,
  options: { session: string; path: string },
): Record<string, string> {
  return { ...agentEnvironment(source, options.path), HC_SESSION: options.session };
}

/**
 * The environment of an agent Gajae starts itself, outside herdr-core (an omp RPC chat, design
 * §10): the same allow-list a core gets, and the login shell's PATH.
 */
export function agentEnvironment(source: SourceEnv, path: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source))
    if (value !== undefined && CORE_ENV.test(name)) env[name] = value;
  env.PATH = path;
  return env;
}

/** The names in a core's environment that Gajae's own launch would never have put there. */
export function contaminatedNames(env: Readonly<Record<string, string>>): string[] {
  return Object.keys(env)
    .filter((name) => CONTAMINATED.test(name))
    .sort();
}

/** NUL-separated NAME=value entries, as `env -0` prints them. */
export function parseEnvBlock(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .split("\0")
      .filter((entry) => entry.includes("="))
      .map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]),
  );
}

/**
 * Chromium keeps descriptors open without close-on-exec. hc's own launch goes through launchd and
 * inherits none of them (P0.5 spike), but hc falls back to starting the core directly when that
 * handshake fails, so every hc Gajae runs closes everything above stderr first, then becomes hc.
 */
export const CLOSE_INHERITED =
  'for fd in $(ls /dev/fd 2>/dev/null); do if [ "$fd" -gt 2 ] 2>/dev/null; then eval "exec $fd>&-" 2>/dev/null; fi; done; exec "$@"';

export function withoutInherited(
  command: string,
  args: readonly string[],
  bash = "/bin/bash",
  platform: NodeJS.Platform = process.platform,
): [string, string[]] {
  if (platform === "win32" || !isFile(bash)) return [command, [...args]];
  return [bash, ["-c", CLOSE_INHERITED, "gajae", command, ...args]];
}

const PATH_START = "__GAJAE_PATH_START__";
const PATH_END = "__GAJAE_PATH_END__";

export function parseLoginPath(output: string): string | null {
  const lines = output.split(/\r?\n/u);
  const start = lines.lastIndexOf(PATH_START);
  if (start === -1 || lines[start + 2] !== PATH_END) return null;
  const value = lines[start + 1]!.trim();
  return value === "" ? null : value;
}

/**
 * The PATH the user's interactive login shell builds. A Finder-launched app inherits launchd's
 * `/usr/bin:/bin:/usr/sbin:/sbin`, and a core started with that would give every terminal it.
 * `GAJAE_PATH_PROBE` is set so a profile can skip what should not run here. A shell that does not
 * answer within the timeout is killed with its group, and the caller falls back.
 */
export function loginShellPath(options: {
  shell: string;
  env: Readonly<Record<string, string>>;
  timeoutMs?: number;
}): Promise<string | null> {
  const timeoutMs = options.timeoutMs ?? 3000;
  const script = `printf '\\n%s\\n%s\\n%s\\n' '${PATH_START}' "$PATH" '${PATH_END}'`;
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(options.shell, ["-l", "-i", "-c", script], {
        env: { ...options.env, GAJAE_PATH_PROBE: "1" },
        cwd: homeDirectory(options.env.HOME),
        stdio: ["ignore", "pipe", "ignore"],
        detached: true,
      });
    } catch {
      finish(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      finish(null);
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (output.length < 256 * 1024) output += chunk.toString("utf8");
    });
    child.on("error", () => finish(null));
    child.on("close", () => finish(parseLoginPath(output)));
  });
}

/** The PATH for a core: the login shell's, with the directories a Finder launch needs added. */
export async function corePath(source: SourceEnv, timeoutMs?: number): Promise<string> {
  const shell = source.SHELL && source.SHELL.startsWith("/") ? source.SHELL : "/bin/zsh";
  const base: Record<string, string> = {};
  for (const [name, value] of Object.entries(source))
    if (value !== undefined && CORE_ENV.test(name)) base[name] = value;
  base.PATH = runtimePath(source.PATH ?? "");
  const login = await loginShellPath({ shell, env: base, timeoutMs }).catch(() => null);
  return runtimePath(login ?? source.PATH ?? "");
}

function homeDirectory(home: string | undefined): string {
  try {
    if (home && statSync(home).isDirectory()) return home;
  } catch {
    // fall through
  }
  return homedir();
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
