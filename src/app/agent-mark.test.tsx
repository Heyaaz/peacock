import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentKindId } from "../../shared/agent-contract";
import type { TranscriptItem } from "../backend/types";
import { AgentMark } from "./agent-mark";
import { AssistantAgentKindContext, AssistantNameContext } from "./assistant-name";
import { TranscriptItemView } from "./transcript";

function render(agentKind: AgentKindId | null): string {
  return renderToStaticMarkup(createElement(AgentMark, { agentKind }));
}

/** The label beside this mark already names the agent; the mark itself has to say which one. */
describe("AgentMark", () => {
  it("draws the agent's own mark, not a shared bot", () => {
    for (const kind of ["omp", "gjc", "claude", "codex", "shell"] as const)
      expect(render(kind)).toContain(`data-agent="${kind}"`);
    expect(render("omp")).toContain("<svg");
    expect(render("gjc")).toContain("🦀");
  });

  it("falls back to the generic bot when the agent is unknown", () => {
    expect(render(null)).toContain('data-agent="unknown"');
    expect(render(null)).toContain("lucide-bot");
  });

  it("reads the session's agent in the author row", () => {
    const message: TranscriptItem = {
      id: "a1",
      sessionId: "s-1",
      kind: "message",
      role: "assistant",
      content: "hello",
      createdAt: "13:15",
    };
    const markup = renderToStaticMarkup(
      createElement(
        AssistantAgentKindContext.Provider,
        { value: "omp" },
        createElement(
          AssistantNameContext.Provider,
          { value: "Oh My Pi" },
          createElement(TranscriptItemView, {
            item: message,
            onResolveTool: () => undefined,
            onReadArtifact: undefined,
          }),
        ),
      ),
    );
    expect(markup).toContain("Oh My Pi");
    expect(markup).toContain("13:15");
    expect(markup).toContain('data-agent="omp"');
  });
});
