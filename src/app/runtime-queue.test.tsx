/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeQueue } from "./runtime-queue";
import { saveComposerQueue } from "./composer-session";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

describe("RuntimeQueue", () => {
  it("offers send-now for a follow-up and removal for each message", async () => {
    const onPromote = vi.fn();
    const onRemove = vi.fn();
    const sessionId = "runtime-queue-session";
    saveComposerQueue(sessionId, []);
    const queued = [
      { id: "steer-0", text: "now", mode: "steer" as const, label: "now" },
      { id: "follow-0", text: "later", mode: "followUp" as const, label: "later" },
    ];
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(createElement(RuntimeQueue, { sessionId, queued, onPromote, onRemove })));
    const items = host.querySelectorAll(".composer-queue-item");
    expect([...items].map((item) => item.querySelector(".composer-queue-send")?.textContent ?? null)).toEqual([null, "지금 보내기"]);
    await act(async () => items[1]!.querySelector<HTMLButtonElement>(".composer-queue-send")!.click());
    await act(async () => items[0]!.querySelector<HTMLButtonElement>(".composer-queue-discard")!.click());
    expect(onPromote).toHaveBeenCalledWith(queued[1]);
    expect(onRemove).toHaveBeenCalledWith(queued[0]);
    await act(async () => root!.render(createElement(RuntimeQueue, { sessionId, queued: [], onPromote, onRemove })));
    expect(host.querySelector(".runtime-queue")).toBeNull();
    saveComposerQueue(sessionId, []);
  });

  it("drops a steering entry the composer already shows as a delivered chip", async () => {
    const sessionId = "runtime-queue-dedupe";
    saveComposerQueue(sessionId, [{
      id: "receipt", text: "change course", mode: "steer", label: "Steer",
      images: [], files: [], delivered: true,
    }]);
    const queued = [
      { id: "steer-0", text: "change course", mode: "steer" as const, label: "change course" },
      { id: "follow-0", text: "later", mode: "followUp" as const, label: "later" },
    ];
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(createElement(RuntimeQueue, {
      sessionId, queued, onPromote: vi.fn(), onRemove: vi.fn(),
    })));
    expect([...host.querySelectorAll(".composer-queue-text")].map((item) => item.textContent))
      .toEqual(["later"]);
    saveComposerQueue(sessionId, []);
  });
});
