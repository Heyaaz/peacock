import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmAnswer, confirmPage } from "./confirm-overlay.js";
import { setHostLanguage } from "./host-text.js";

vi.mock("electron", () => ({ BrowserWindow: class {}, nativeTheme: { shouldUseDarkColors: true } }));

afterEach(() => setHostLanguage("ko"));

describe("confirmPage", () => {
  it("escapes every piece of text it shows, so a title cannot become markup", () => {
    const page = confirmPage(
      { message: "<script>alert(1)</script>", detail: '"><img src=x onerror=alert(1)>' },
      "dark",
    );
    expect(page).not.toContain("<script>alert");
    expect(page).not.toContain("<img");
    expect(page).toContain("&#60;script&#62;");
  });

  it("answers only through its two buttons, with Cancel focused first", () => {
    const page = confirmPage({ message: "세션을 삭제할까요?", confirmLabel: "삭제", danger: true }, "light");
    const cancel = page.match(/<button[^>]*>취소<\/button>/u)?.[0] ?? "";
    const remove = page.match(/<button[^>]*>삭제<\/button>/u)?.[0] ?? "";
    expect(cancel).toContain('formaction="https://gajae-confirm.invalid/cancel"');
    expect(cancel).toContain("autofocus");
    expect(remove).toContain('formaction="https://gajae-confirm.invalid/continue"');
    expect(remove).toContain('class="danger"');
    expect(page).toContain("default-src 'none'");
    expect(page).not.toMatch(/<script/u);
  });

  it("labels the cancel button for a question whose no is not a cancellation, still answering no", () => {
    const page = confirmPage({ message: "이 세션의 worktree도 지울까요?", confirmLabel: "worktree도 지우기", cancelLabel: "남겨 두기", danger: true }, "dark");
    const keep = page.match(/<button[^>]*>남겨 두기<\/button>/u)?.[0] ?? "";
    expect(keep).toContain('formaction="https://gajae-confirm.invalid/cancel"');
    expect(keep).toContain("autofocus");
    expect(page).not.toMatch(/<button[^>]*>취소<\/button>/u);
    setHostLanguage("en");
    expect(confirmPage({ message: "이 세션의 worktree도 지울까요?", confirmLabel: "worktree도 지우기", cancelLabel: "남겨 두기" }, "dark")).toMatch(
      /<button[^>]*>Keep it<\/button>/u,
    );
  });

  it("uses the host language for its copy and the default button", () => {
    setHostLanguage("en");
    const page = confirmPage({ message: "세션을 삭제할까요?" }, "dark");
    expect(page).toContain("Delete this session?");
    expect(page).toMatch(/<button[^>]*>Cancel<\/button>/u);
    expect(page).toMatch(/<button class="primary"[^>]*>Continue<\/button>/u);
  });
});

describe("confirmAnswer", () => {
  it("reads the answer only from the dialog's own URLs", () => {
    expect(confirmAnswer("https://gajae-confirm.invalid/continue?")).toBe(true);
    expect(confirmAnswer("https://gajae-confirm.invalid/cancel")).toBe(false);
    expect(confirmAnswer("https://gajae-confirm.invalid/other")).toBeUndefined();
    expect(confirmAnswer("https://example.com/continue")).toBeUndefined();
    expect(confirmAnswer("not a url")).toBeUndefined();
  });
});
