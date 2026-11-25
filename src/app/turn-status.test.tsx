/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { SubagentsPanel, TurnStatusLine } from "./turn-status";
import { ThoughtCard } from "./transcript-item-view";
import { DiffView } from "./primitives";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

async function mount(element: ReturnType<typeof createElement>): Promise<HTMLDivElement> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(element));
  return host;
}

describe("TurnStatusLine", () => {
  it("shows the turn's time, activity, todo progress with its checklist, and context", async () => {
    const node = await mount(
      createElement(TurnStatusLine, {
        running: true,
        status: {
          turnStartedAtMs: Date.now() - 65_000,
          activity: "bash · npm test",
          contextPercent: 30.4,
          todo: [{ name: "Build", tasks: [{ content: "write", status: "completed" }, { content: "test", status: "in_progress" }, { content: "ship" }] }],
        },
      }),
    );
    expect(node.querySelector(".turn-status-elapsed")?.textContent).toBe("1m 5s");
    expect(node.querySelector(".turn-status-activity")?.textContent).toBe("bash · npm test");
    expect(node.querySelector(".turn-status-todo > button")?.textContent).toBe("1/3");
    expect(node.querySelector(".turn-status-context")?.textContent).toBe("컨텍스트 30%");
    await act(async () => node.querySelector<HTMLButtonElement>(".turn-status-todo > button")!.click());
    expect([...node.querySelectorAll(".turn-status-todo-menu li")].map((item) => [item.textContent, item.className])).toEqual([
      ["write", "is-done"],
      ["test", ""],
      ["ship", ""],
    ]);
  });

  it("shows nothing for an idle chat with no todo or context", async () => {
    const node = await mount(createElement(TurnStatusLine, { running: false, status: { activity: "old" } }));
    expect(node.querySelector(".turn-status-line")).toBeNull();
  });
});

describe("SubagentsPanel", () => {
  it("lists running subagents first with their model, cost, time, tools and context", async () => {
    const node = await mount(
      createElement(SubagentsPanel, {
        onClose: () => undefined,
        subagents: [
          { id: "b", label: "reviewer", status: "completed", objective: "review" },
          { id: "a", label: "scout", status: "running", objective: "find", model: "flash", costUsd: 0.0123, elapsedMs: 42_000, toolCount: 3, contextTokens: 5000, contextWindow: 100000, recent: "grep" },
        ],
      }),
    );
    const rows = [...node.querySelectorAll(".subagent-row")];
    expect(rows.map((row) => row.querySelector("strong")?.textContent)).toEqual(["scout", "reviewer"]);
    expect(rows[0]!.querySelector(".subagent-meta")?.textContent).toBe("flash · $0.012 · 42s · 도구 3 · 컨텍스트 5%");
    expect(rows[0]!.querySelector(".subagent-status")?.textContent).toBe("실행 중");
  });
});

describe("P6 card details", () => {
  it("says how long a thought took once it is done", async () => {
    const node = await mount(
      createElement(ThoughtCard, { item: { id: "t", kind: "thought", sessionId: "s", content: "hm", createdAt: "01:00", streaming: false, durationMs: 4200 }, expanded: false }),
    );
    expect(node.querySelector("header span")?.textContent).toBe("4초 생각함");
  });

  it("shows a long diff's first lines and the rest on request", async () => {
    const diff = ["--- a/x.ts", "+++ b/x.ts", "@@ -1,20 +1,20 @@", ...Array.from({ length: 20 }, (_, index) => `+line ${index}`)].join("\n");
    const node = await mount(createElement(DiffView, { diff, path: "x.ts" }));
    expect(node.querySelectorAll(".diff-line")).toHaveLength(12);
    const more = node.querySelector<HTMLButtonElement>(".tool-diff-more")!;
    expect(more.textContent).toBe("9줄 더 · 모두 보기");
    await act(async () => more.click());
    expect(node.querySelectorAll(".diff-line")).toHaveLength(21);
  });
});
