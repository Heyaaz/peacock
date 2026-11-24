import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLOSE_INHERITED,
  contaminatedNames,
  coreEnvironment,
  loginShellPath,
  parseEnvBlock,
  parseLoginPath,
  withoutInherited,
} from "./env.js";

describe("coreEnvironment", () => {
  const source = {
    HOME: "/Users/me",
    USER: "me",
    LOGNAME: "me",
    SHELL: "/bin/zsh",
    LANG: "ko_KR.UTF-8",
    LC_CTYPE: "UTF-8",
    TMPDIR: "/var/folders/x/T/",
    SSH_AUTH_SOCK: "/private/tmp/agent.sock",
    __CF_USER_TEXT_ENCODING: "0x1F5:0x3:0x33",
    PATH: "/usr/bin:/bin",
    CLAUDECODE: "1",
    CLAUDE_CODE_SESSION_ID: "abc",
    CLAUDE_CODE_MESSAGING_TOKEN: "secret",
    ELECTRON_RUN_AS_NODE: "1",
    NO_COLOR: "1",
    TERM: "xterm-kitty",
    TERMINFO: "/somewhere",
    MYSQL_PASSWORD: "hunter2",
    HC_SOCKET: "/tmp/other.sock",
    UNSET: undefined,
  };

  it("keeps only the allow-listed variables, the login PATH and the session", () => {
    expect(coreEnvironment(source, { session: "gajae", path: "/opt/homebrew/bin:/usr/bin" })).toEqual({
      HOME: "/Users/me",
      USER: "me",
      LOGNAME: "me",
      SHELL: "/bin/zsh",
      LANG: "ko_KR.UTF-8",
      LC_CTYPE: "UTF-8",
      TMPDIR: "/var/folders/x/T/",
      SSH_AUTH_SOCK: "/private/tmp/agent.sock",
      __CF_USER_TEXT_ENCODING: "0x1F5:0x3:0x33",
      PATH: "/opt/homebrew/bin:/usr/bin",
      HC_SESSION: "gajae",
    });
  });

  it("never names another core's socket", () => {
    expect(coreEnvironment(source, { session: "gajae", path: "/usr/bin" })).not.toHaveProperty("HC_SOCKET");
  });
});

describe("contaminatedNames", () => {
  it("names a parent agent's markers, switches and secrets, never values", () => {
    expect(
      contaminatedNames({
        HOME: "/Users/me",
        PATH: "/usr/bin",
        HC_SESSION: "gajae",
        CLAUDECODE: "1",
        ELECTRON_RUN_AS_NODE: "1",
        NO_COLOR: "1",
        GITHUB_TOKEN: "ghp_x",
        TERMINFO: "/x",
      }),
    ).toEqual(["CLAUDECODE", "ELECTRON_RUN_AS_NODE", "GITHUB_TOKEN", "NO_COLOR", "TERMINFO"]);
  });

  it("finds nothing in what Gajae's own launch gives", () => {
    expect(
      contaminatedNames(coreEnvironment({ HOME: "/h", SHELL: "/bin/zsh", LANG: "C" }, { session: "gajae", path: "/usr/bin" })),
    ).toEqual([]);
  });
});

describe("environment text", () => {
  it("reads an env -0 block, values with = and newlines included", () => {
    expect(parseEnvBlock("A=1\0B=x=y\0C=two\nlines\0")).toEqual({ A: "1", B: "x=y", C: "two\nlines" });
  });

  it("reads the PATH between the probe's markers, after whatever a profile printed", () => {
    expect(parseLoginPath("motd\n__GAJAE_PATH_START__\n/a:/b\n__GAJAE_PATH_END__\n")).toBe("/a:/b");
    expect(parseLoginPath("__GAJAE_PATH_START__\n\n__GAJAE_PATH_END__\n")).toBeNull();
    expect(parseLoginPath("nothing")).toBeNull();
  });
});

describe("loginShellPath", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "gajae-login-path-"));
  const script = (name: string, body: string): string => {
    const file = path.join(directory, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  };

  it("takes the PATH a login shell prints", async () => {
    const shell = script("fake-shell", "printf 'hello\\n__GAJAE_PATH_START__\\n/login/bin:/usr/bin\\n__GAJAE_PATH_END__\\n'");
    await expect(loginShellPath({ shell, env: { HOME: directory } })).resolves.toBe("/login/bin:/usr/bin");
  });

  it("gives up on a shell that does not answer in time", async () => {
    const shell = script("slow-shell", "sleep 5");
    await expect(loginShellPath({ shell, env: { HOME: directory }, timeoutMs: 150 })).resolves.toBeNull();
  });

  it("gives up on a shell that cannot start", async () => {
    await expect(loginShellPath({ shell: path.join(directory, "missing"), env: {} })).resolves.toBeNull();
  });
});

describe("withoutInherited", () => {
  it("starts hc through bash, which closes every descriptor above stderr first", () => {
    expect(withoutInherited("/x/hc", ["connect"], "/bin/sh", "darwin")).toEqual([
      "/bin/sh",
      ["-c", CLOSE_INHERITED, "gajae", "/x/hc", "connect"],
    ]);
  });

  it("starts hc directly where there is no bash", () => {
    expect(withoutInherited("/x/hc", ["connect"], "/no/such/bash", "darwin")).toEqual(["/x/hc", ["connect"]]);
    expect(withoutInherited("hc.exe", ["connect"], "/bin/sh", "win32")).toEqual(["hc.exe", ["connect"]]);
  });
});
