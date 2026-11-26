import { afterEach, describe, expect, it } from "vitest";
import { setLanguageMode } from "../i18n";
import { worktreeSetupMessage } from "./worktree-setup";

afterEach(() => setLanguageMode("ko"));

describe("worktreeSetupMessage", () => {
  it("says the session was opened, and which files were not copied and why", () => {
    const message = worktreeSetupMessage({
      copyProblems: [
        { path: ".env", reason: "symlink" },
        { path: "big.bin", reason: "too-large" },
        { path: "x", reason: "something-new" },
      ],
    });
    expect(message).toContain("세션은 그대로 열었습니다");
    expect(message).toContain(".env (심볼릭 링크), big.bin (너무 큼), x (something-new)");
  });

  it("names the exit code and the last thing the script printed", () => {
    const message = worktreeSetupMessage({
      setup: { status: "failed", exitCode: 3, output: "installing\n\nERR! missing package\n" },
    });
    expect(message).toContain("종료 코드 3(으)로");
    expect(message).toContain("마지막 출력: ERR! missing package");
    expect(message).not.toContain("installing");
  });

  it.each([
    ["timeout", undefined, "제한 시간"],
    ["error", undefined, "시작하지 못했습니다"],
    ["failed", undefined, "중간에 중단"],
  ] as const)("describes a %s setup", (status, exitCode, text) => {
    const message = worktreeSetupMessage({ setup: { status, ...(exitCode === undefined ? {} : { exitCode }), output: "" } });
    expect(message).toContain(text);
    expect(message).not.toContain("마지막 출력");
  });

  it("cuts a very long last line", () => {
    const message = worktreeSetupMessage({ setup: { status: "failed", exitCode: 1, output: "x".repeat(500) } });
    expect(message.length).toBeLessThan(500);
    expect(message.endsWith("…")).toBe(true);
  });

  it("reports both problems in English when English is selected", () => {
    setLanguageMode("en");
    const message = worktreeSetupMessage({
      copyProblems: [{ path: ".env", reason: "outside" }],
      setup: { status: "timeout", output: "still going" },
    });
    expect(message).toContain("There was a problem preparing the new worktree. The session was opened anyway.");
    expect(message).toContain("Files not copied: .env (points outside the folder)");
    expect(message).toContain("did not finish in time");
    expect(message).toContain("Last output: still going");
    expect(message).not.toMatch(/[가-힣]/u);
  });
});
