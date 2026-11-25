/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionTreeEntry } from "../../shared/agent-contract";
import { SessionTreeDialog } from "./session-tree";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

const ENTRIES: SessionTreeEntry[] = [
  { id: "u1", role: "user", text: "first question", depth: 0, onPath: true, current: false, rewritable: true },
  { id: "a2", role: "assistant", text: "new answer", depth: 0, onPath: true, current: true },
  { id: "u9", role: "user", text: "abandoned", depth: 1, onPath: false, current: false, rewritable: true },
  { id: "a9", role: "assistant", text: "abandoned answer", depth: 1, onPath: false, current: false },
];

describe("SessionTreeDialog", () => {
  it("lists the tree, marks where the chat is, moves to an entry, and forks or rewrites from a message of yours", async () => {
    const onFork = vi.fn(async () => undefined);
    const onNavigate = vi.fn(async () => undefined);
    const onClose = vi.fn();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(createElement(SessionTreeDialog, { load: async () => ENTRIES, onFork, onNavigate, onClose })));
    const rows = [...host.querySelectorAll(".session-tree-entry")];
    expect(rows.map((row) => [row.querySelector(".session-tree-text")?.textContent, row.className.includes("is-current")])).toEqual([
      ["first question", false],
      ["new answer", true],
      ["abandoned", false],
      ["abandoned answer", false],
    ]);
    // another branch's reply: move there
    expect([...rows[3]!.querySelectorAll("button")].map((button) => button.textContent?.trim())).toEqual(["여기로 이동"]);
    expect((rows[2] as HTMLElement).style.paddingLeft).toBe("26px");
    // a message of yours on any branch: rewrite (in place) or fork; the current entry has nowhere to move
    expect([...rows[2]!.querySelectorAll("button")].map((button) => button.textContent?.trim())).toEqual(["여기서 다시 쓰기", "여기까지 포크"]);
    expect(rows[1]!.querySelector(".session-tree-actions")).toBeNull();
    const [rewrite, fork] = [...rows[0]!.querySelectorAll("button")];
    await act(async () => fork!.click());
    expect(onFork).toHaveBeenCalledWith(ENTRIES[0]);
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => rewrite!.click());
    expect(onNavigate).toHaveBeenCalledWith(ENTRIES[0]);
  });

  it("keeps the dialog open with the reason when omp refuses", async () => {
    const onClose = vi.fn();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root!.render(
        createElement(SessionTreeDialog, { load: async () => ENTRIES, onFork: async () => Promise.reject(new Error("Session is busy")), onClose }),
      ),
    );
    await act(async () => host!.querySelector<HTMLButtonElement>(".session-tree-entry button")!.click());
    expect(host.querySelector(".diff-error")?.textContent).toBe("Session is busy");
    expect(onClose).not.toHaveBeenCalled();
  });
});
