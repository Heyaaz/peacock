/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageDelivery, SessionCapabilities } from "../../shared/agent-contract";
import type { AgentSession } from "../backend/types";
import { TerminalChatComposer } from "./terminal-chat-composer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
});

const session = (status: AgentSession["status"]): AgentSession => ({
  id: "terminal-1",
  title: "Claude 작업",
  subtitle: "Claude Code · repo",
  workspace: "/repo",
  runtime: "herdr",
  status,
  updatedAt: "now",
  pinned: false,
  unread: false,
  accent: "#56d4dd",
  ownership: "gajae",
  attachment: "attached",
  agentKind: "claude",
  surfaces: ["terminal", "chat"],
});

const CAN_SEND = { send: true, cancel: true } as SessionCapabilities;

async function mount(props: Partial<Parameters<typeof TerminalChatComposer>[0]> = {}) {
  const onSend = vi.fn<(text: string) => Promise<MessageDelivery>>().mockResolvedValue("prompt");
  const onCancel = vi.fn<() => Promise<void>>().mockResolvedValue();
  const onOpenTerminal = vi.fn();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      createElement(TerminalChatComposer, { session: session("idle"), capabilities: CAN_SEND, agentName: "Claude Code", onSend, onCancel, onOpenTerminal, ...props }),
    ),
  );
  const textarea = host.querySelector("textarea")!;
  const type = async (text: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(textarea, text);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const enter = async (init: KeyboardEventInit = {}) =>
    act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }));
    });
  return { node: host, textarea, type, enter, onSend, onCancel, onOpenTerminal };
}

describe("terminal agent composer", () => {
  it("sends the trimmed text on Enter and clears the draft once it is typed into the terminal", async () => {
    const { textarea, type, enter, onSend } = await mount();
    await type("  hello  ");
    await enter();
    expect(onSend).toHaveBeenCalledExactlyOnceWith("hello");
    expect(textarea.value).toBe("");
  });

  it("keeps the draft and says why when the agent waits on a dialog", async () => {
    const onSend = vi.fn<(text: string) => Promise<MessageDelivery>>().mockResolvedValue({ kind: "not_executed", detail: "approve Bash: rm x" });
    const { node, textarea, type, enter } = await mount({ onSend });
    await type("go");
    await enter();
    expect(textarea.value).toBe("go");
    expect(node.querySelector(".composer-error")?.textContent).toContain("approve Bash: rm x");
  });

  it("does not send on Shift+Enter or an Enter that ends an IME composition", async () => {
    const { type, enter, onSend } = await mount();
    await type("안녕");
    await enter({ shiftKey: true });
    await enter({ isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("offers stop while the agent works with nothing typed", async () => {
    const { node, onCancel } = await mount({ session: session("running") });
    const stop = node.querySelector<HTMLButtonElement>(".send-button--stop")!;
    await act(async () => stop.click());
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("points at the terminal when the agent cannot take chat input, or waits there", async () => {
    const closed = await mount({ capabilities: { send: false, cancel: false } as SessionCapabilities });
    expect(closed.textarea.disabled).toBe(true);
    await act(async () => closed.node.querySelector<HTMLButtonElement>(".composer-terminal-link")!.click());
    expect(closed.onOpenTerminal).toHaveBeenCalledOnce();
    act(() => root?.unmount());
    const waiting = await mount({ session: session("waiting") });
    expect(waiting.node.textContent).toContain("터미널에서 응답을 기다리고 있습니다");
  });
});
