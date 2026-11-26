import { afterEach, describe, expect, it } from "vitest";
import { hostFormat, hostText, setHostLanguage } from "./host-text.js";

afterEach(() => setHostLanguage("ko"));

describe("hostFormat", () => {
  it("fills the values into the Korean template", () => {
    expect(hostFormat("브랜치 삭제: {0} (push하지 않은 커밋 {1}개가 사라집니다)", ["peacock/a", 3])).toBe(
      "브랜치 삭제: peacock/a (push하지 않은 커밋 3개가 사라집니다)",
    );
  });

  it("translates the template whole, then fills the values in", () => {
    setHostLanguage("en");
    expect(hostFormat("브랜치 삭제: {0} (push하지 않은 커밋 {1}개가 사라집니다)", ["peacock/a", 3])).toBe(
      "Delete branch: peacock/a (3 unpushed commits will be lost)",
    );
  });

  it("keeps a value that looks like a placeholder as it is, and leaves a placeholder with no value", () => {
    expect(hostFormat("worktree 삭제: {0}", ["/w/{1}/x"])).toBe("worktree 삭제: /w/{1}/x");
    expect(hostFormat("worktree 삭제: {0}", [])).toBe("worktree 삭제: {0}");
  });

  it("is hostText for a sentence with nothing in it", () => {
    setHostLanguage("en");
    expect(hostFormat("남겨 두기", [])).toBe(hostText("남겨 두기"));
  });
});
