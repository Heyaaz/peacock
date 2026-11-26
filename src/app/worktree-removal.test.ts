import { afterEach, describe, expect, it } from "vitest";
import { setLanguageMode } from "../i18n";
import { worktreeRemovalMessage } from "./worktree-removal";

afterEach(() => setLanguageMode("ko"));

describe("worktreeRemovalMessage", () => {
  it("says nothing when the worktree went with the session", () => {
    expect(worktreeRemovalMessage({ status: "removed" })).toBeUndefined();
  });

  it("says which branch is still there when the worktree is gone but the branch could not be deleted", () => {
    expect(worktreeRemovalMessage({ status: "removed", branchKept: "peacock/a", detail: "error: cannot delete" })).toBe(
      "worktree는 지웠지만 브랜치 peacock/a은(는) 지우지 못했습니다. error: cannot delete",
    );
    expect(worktreeRemovalMessage({ status: "removed", branchKept: "peacock/a" })).toBe(
      "worktree는 지웠지만 브랜치 peacock/a은(는) 지우지 못했습니다.",
    );
  });

  it("says why a worktree the user asked to remove is still there, and that the session is gone", () => {
    expect(worktreeRemovalMessage({ status: "kept", reason: "shared" })).toContain("다른 세션이 이 worktree를 쓰고 있어");
    expect(worktreeRemovalMessage({ status: "kept", reason: "changed" })).toContain("확인한 뒤 worktree의 내용이 바뀌어");
    const failed = worktreeRemovalMessage({ status: "kept", reason: "failed", detail: "fatal: cannot remove" })!;
    expect(failed).toContain("worktree를 지우지 못했습니다");
    expect(failed).toContain("fatal: cannot remove");
    for (const reason of ["shared", "changed", "failed"] as const)
      expect(worktreeRemovalMessage({ status: "kept", reason })).toContain("세션만 지웠습니다");
  });

  it("is in English when English is selected", () => {
    setLanguageMode("en");
    for (const outcome of [
      { status: "kept", reason: "shared" },
      { status: "kept", reason: "changed" },
      { status: "kept", reason: "failed", detail: "x" },
      { status: "removed", branchKept: "b", detail: "y" },
    ] as const) expect(worktreeRemovalMessage(outcome)).not.toMatch(/[가-힣]/u);
    expect(worktreeRemovalMessage({ status: "kept", reason: "shared" })).toBe(
      "Another session is using this worktree, so it was kept. Only the session was deleted.",
    );
  });
});
