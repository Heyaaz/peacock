/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("SubagentsPanel controls", () => {
  it("stops, tells more and shows the conversation in place of the file path", async () => {
    const control = {
      cancel: vi.fn(async () => true),
      steer: vi.fn(async () => undefined),
      messages: vi.fn(async () => [
        { role: "user" as const, text: "find it" },
        { role: "tool" as const, tool: "grep", text: "parse" },
        { role: "tool" as const, tool: "read", text: "ENOENT", error: true },
      ]),
    };
    const node = await mount(
      createElement(SubagentsPanel, {
        onClose: () => undefined,
        control,
        subagents: [
          { id: "sa-1", label: "scout", status: "running", sessionFile: "/tmp/sa-1.jsonl" },
          { id: "sa-2", label: "done", status: "completed" },
        ],
      }),
    );
    expect(node.querySelector(".subagent-file")).toBeNull();
    const rows = node.querySelectorAll(".subagent-row");
    expect([...rows[1]!.querySelectorAll(".subagent-action")].map((button) => button.textContent)).toEqual(["대화 보기"]);
    const buttons = [...rows[0]!.querySelectorAll<HTMLButtonElement>(".subagent-action")];
    expect(buttons.map((button) => button.textContent)).toEqual(["대화 보기", "지시 추가", "중지"]);
    await act(async () => buttons[2]!.click());
    expect(control.cancel).toHaveBeenCalledWith("sa-1");
    await act(async () => buttons[1]!.click());
    const input = rows[0]!.querySelector<HTMLInputElement>(".subagent-steer input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "check tests");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => rows[0]!.querySelector<HTMLFormElement>(".subagent-steer")!.requestSubmit());
    expect(control.steer).toHaveBeenCalledWith("sa-1", "check tests");
    expect(rows[0]!.querySelector(".subagent-steer")).toBeNull();
    await act(async () => buttons[0]!.click());
    expect([...rows[0]!.querySelectorAll(".subagent-message")].map((item) => [item.className, item.textContent])).toEqual([
      ["subagent-message subagent-message--user", "지시find it"],
      ["subagent-message subagent-message--tool", "grepparse"],
      ["subagent-message subagent-message--tool is-error", "readENOENT"],
    ]);
  });
});
