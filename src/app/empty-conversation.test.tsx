import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Transcript } from "./transcript";

const noop = () => undefined;

describe("empty conversation state", () => {
  it("shows the plain prompt with no meta block when none is given", () => {
    const markup = renderToStaticMarkup(
      createElement(Transcript, {
        sessionId: "session-1",
        items: [],
        onResolveTool: noop,
      }),
    );
    expect(markup).toContain("무엇부터 할까요?");
    expect(markup).toContain("맡길 일을 적으세요.");
    expect(markup).not.toContain("Gajae");
    expect(markup).not.toContain("empty-conversation__meta");
  });

  it("names the session's agent and leaves out what that agent does not have", () => {
    const markup = renderToStaticMarkup(
      createElement(Transcript, {
        sessionId: "session-1",
        items: [],
        onResolveTool: noop,
        assistantName: "Claude Code",
        // a terminal agent's chat: no model the app can read, no slash commands of its own
        emptyStateMeta: { workspace: "/Users/dev/gajae-bot", recentWorkspaces: ["/Users/dev/gajae-bot"] },
      }),
    );
    expect(markup).toContain("Claude Code에게 맡길 일을 적으세요.");
    expect(markup).not.toContain("확인 중…");
    expect(markup).not.toContain("/resume");
  });

  it("shows the model it has, and 확인 중… only while one is still coming", () => {
    const meta = { workspace: "/w", recentWorkspaces: ["/w"], modelPending: true, commandExamples: "/compact, /model" };
    const known = renderToStaticMarkup(
      createElement(Transcript, { sessionId: "s", items: [], onResolveTool: noop, assistantName: "Oh My Pi", emptyStateMeta: { ...meta, modelDisplay: "deepseek-v4" } }),
    );
    expect(known).toContain("deepseek-v4");
    expect(known).not.toContain("확인 중…");
    expect(known).toContain("/compact, /model");
    expect(known).not.toContain("/resume");
    const coming = renderToStaticMarkup(
      createElement(Transcript, { sessionId: "s", items: [], onResolveTool: noop, emptyStateMeta: meta }),
    );
    expect(coming).toContain("확인 중…");
  });

  it("shows workspace, model, shortcut hints, and other-workspace shortcuts", () => {
    const markup = renderToStaticMarkup(
      createElement(Transcript, {
        sessionId: "session-1",
        items: [],
        onResolveTool: noop,
        emptyStateMeta: {
          workspace: "/Users/dev/gajae-bot",
          modelDisplay: "GJC default",
          recentWorkspaces: ["/Users/dev/gajae-bot", "/Users/dev/other-repo"],
          onWorkspaceChange: vi.fn(),
        },
      }),
    );
    expect(markup).toContain("empty-conversation__meta");
    expect(markup).toContain("gajae-bot");
    expect(markup).toContain("GJC default");
    expect(markup).toContain("other-repo");
    expect(markup).toContain("⌘K");
    expect(markup).toContain("⌘F");
  });

  it("omits the other-workspace shortcuts when there is only the current one", () => {
    const markup = renderToStaticMarkup(
      createElement(Transcript, {
        sessionId: "session-1",
        items: [],
        onResolveTool: noop,
        emptyStateMeta: {
          workspace: "/Users/dev/gajae-bot",
          recentWorkspaces: ["/Users/dev/gajae-bot"],
        },
      }),
    );
    expect(markup).not.toContain("empty-conversation__workspaces");
  });
});
