/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextBreakdown } from "../../shared/agent-contract";
import { ContextBar, ContextDialog } from "./context-usage";
import { TurnStatusLine } from "./turn-status";

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

const BREAKDOWN: ContextBreakdown = {
  model: "DeepSeek Flash",
  contextWindow: 950000,
  usedTokens: 14350,
  categories: [
    { id: "systemPrompt", label: "System prompt", tokens: 1861 },
    { id: "systemTools", label: "System tools", tokens: 5743 },
    { id: "systemContext", label: "System context", tokens: 663 },
    { id: "instructionFiles", label: "Instruction files", tokens: 1309 },
    { id: "skills", label: "Skills", tokens: 0 },
    { id: "messages", label: "Messages", tokens: 4774 },
  ],
  autoCompactBufferTokens: 142500,
  freeTokens: 793150,
  autoCompactAtTokens: 807500,
  notes: ["Snapcompact: inactive (model has no image input)"],
};

describe("ContextBar", () => {
  it("shows the share, the window, and opens the breakdown or compacts", async () => {
    const onOpen = vi.fn();
    const onCompact = vi.fn();
    const node = await mount(
      createElement(ContextBar, { status: { contextPercent: 13.2, contextTokens: 123456, contextWindow: 950000 }, onOpen, onCompact }),
    );
    expect(node.querySelector(".context-bar-percent")?.textContent).toBe("13%");
    expect(node.querySelector(".context-bar-window")?.textContent).toBe("950K");
    expect(node.querySelector<HTMLElement>(".context-bar-fill")?.style.width).toBe("13.2%");
    expect(node.querySelector(".context-bar-meter")?.getAttribute("title")).toBe("컨텍스트 123K / 950K 토큰 · 눌러서 자세히 보기");
    await act(async () => node.querySelector<HTMLButtonElement>(".context-bar-meter")!.click());
    await act(async () => node.querySelector<HTMLButtonElement>('[aria-label="지금 압축"]')!.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onCompact).toHaveBeenCalledTimes(1);
  });

  it("warns as the window fills, and shows nothing without a share", async () => {
    const node = await mount(createElement(ContextBar, { status: { contextPercent: 92 }, onOpen: () => undefined }));
    expect(node.querySelector(".context-bar")?.className).toContain("context-bar--danger");
    expect(node.querySelector('[aria-label="지금 압축"]')).toBeNull();
    await act(async () => root!.render(createElement(ContextBar, { status: {}, onOpen: () => undefined })));
    expect(node.querySelector(".context-bar")).toBeNull();
  });
});

describe("ContextDialog", () => {
  it("reads the breakdown and shows the total, the room before auto-compaction, a bar and a row per category", async () => {
    const onClose = vi.fn();
    const node = await mount(createElement(ContextDialog, { load: async () => BREAKDOWN, onClose, onCompact: () => undefined }));
    expect(node.querySelector(".context-dialog header code")?.textContent).toBe("DeepSeek Flash");
    expect(node.querySelector(".context-dialog-used")?.textContent).toBe("14.3K/ 950K 토큰 · 2%");
    expect(node.querySelector(".context-dialog-room")?.textContent).toBe("자동 압축까지 793K 남음 (85%)");
    expect(node.querySelectorAll(".context-dialog-meter .context-segment").length).toBe(5 + 2);
    expect(node.querySelector<HTMLElement>(".context-dialog-mark")?.style.left).toBe("85%");
    expect(
      [...node.querySelectorAll(".context-dialog-rows li")].map((row) =>
        [...row.querySelectorAll("span")].map((cell) => cell.textContent),
      ),
    ).toEqual([
      ["시스템 프롬프트", "1.9K", "0.2%"],
      ["도구 정의", "5.7K", "0.6%"],
      ["시스템 컨텍스트", "663", "0.1%"],
      ["지침 파일", "1.3K", "0.1%"],
      ["스킬", "0", "0.0%"],
      ["대화 메시지", "4.8K", "0.5%"],
      ["자동 압축 여유분", "143K", "15.0%"],
      ["남은 공간", "793K", "83.5%"],
    ]);
    expect(node.querySelector(".context-dialog-omp-notes")?.textContent).toBe("Snapcompact: inactive (model has no image input)");
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(onClose).toHaveBeenCalled();
  });

  it("says so when omp cannot tell or the call fails", async () => {
    const node = await mount(createElement(ContextDialog, { load: async () => null, onClose: () => undefined }));
    expect(node.querySelector(".context-dialog-status")?.textContent).toContain("알려주지 않았습니다");
    expect(node.querySelector(".context-dialog footer .button-secondary")).toBeNull();
    const failing = () => Promise.reject(new Error("omp exited"));
    await act(async () => root!.render(createElement(ContextDialog, { load: failing, onClose: () => undefined })));
    expect(node.querySelector(".diff-error")?.textContent).toBe("omp exited");
  });
});

describe("TurnStatusLine with the context bar", () => {
  it("leaves the context share to the bar", async () => {
    const node = await mount(createElement(TurnStatusLine, { running: false, status: { contextPercent: 30 }, hideContext: true }));
    expect(node.querySelector(".turn-status-line")).toBeNull();
  });
});

describe("ContextBar switches", () => {
  it("lists omp's switches in a popover and flips one", async () => {
    const onSetMode = vi.fn();
    const node = await mount(
      createElement(ContextBar, {
        status: {
          contextPercent: 10,
          modes: [
            { id: "fast", enabled: true, inactive: true },
            { id: "autoCompaction", enabled: true },
            { id: "autoRetry", enabled: true, assumed: true },
          ],
        },
        onOpen: () => undefined,
        onSetMode,
      }),
    );
    const button = node.querySelector<HTMLButtonElement>('[aria-label="실행 모드"]')!;
    expect(button.className).toContain("is-active");
    await act(async () => button.click());
    const rows = [...node.querySelectorAll(".runtime-mode")];
    expect(rows.map((row) => row.querySelector("strong")?.textContent)).toEqual(["빠른 모드", "자동 압축", "자동 재시도"]);
    expect(rows[0]!.querySelector(".runtime-mode-note")?.textContent).toBe("이 모델에는 적용되지 않습니다");
    expect(rows[2]!.querySelector(".runtime-mode-note")).not.toBeNull();
    await act(async () => rows[1]!.querySelector<HTMLInputElement>("input")!.click());
    expect(onSetMode).toHaveBeenCalledWith("autoCompaction", false);
  });
});
