/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiffSnapshot, GitStatusSnapshot } from "../../shared/agent-contract";
import type { DiffScope, TurnDiffReason, TurnDiffState } from "../../shared/turn-diff";
import type { AgentBackend } from "../backend/agent-backend";
import type { AgentSession } from "../backend/types";
import { DiffPanel } from "./inspector";
import { turnDiffReasonText, turnStartLabel } from "./turn-diff-text";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const session: AgentSession = {
  id: "a",
  title: "a",
  subtitle: "gajae-bot",
  workspace: "/tmp/a",
  runtime: "gjc",
  status: "idle",
  updatedAt: "10:00",
  updatedAtMs: 1,
  pinned: false,
  unread: false,
  accent: "#ff8a34",
  ownership: "gajae",
  attachment: "attached",
};

const git: GitStatusSnapshot = { workspace: "/tmp/a", branch: "main", ahead: 0, behind: 0, files: [] };
const startedAt = "2026-11-26T04:30:00.000Z";

function snapshot(extra: Partial<DiffSnapshot> = {}): DiffSnapshot {
  return {
    sessionId: "a",
    workspace: "/tmp/a",
    refreshedAt: "now",
    files: [{ id: "a.ts", path: "a.ts", patch: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new" }],
    ...extra,
  };
}

describe("the choice between everything and this turn", () => {
  const backend = { getGitStatus: () => Promise.resolve(git) } as unknown as AgentBackend;
  let root: Root;
  let host: HTMLDivElement;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
  });

  async function show(diff: DiffSnapshot | null, options: { scope?: DiffScope; onScopeChange?: ((scope: DiffScope) => void) | null } = {}) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root.render(
        createElement(DiffPanel, {
          session,
          backend,
          diff,
          loading: false,
          onRefresh: () => undefined,
          onClose: () => undefined,
          ...(options.scope ? { scope: options.scope } : {}),
          ...(options.onScopeChange === null ? {} : { onScopeChange: options.onScopeChange ?? (() => undefined) }),
        }),
      );
    });
  }

  /** The notes where the file list would be; a session with no worktree of its own also carries its own note. */
  const notes = () => [...host.querySelectorAll(".diff-empty")].map((note) => note.textContent);
  const option = (label: string) =>
    [...host.querySelectorAll(".diff-scope__option")].find((candidate) => candidate.textContent === label) as HTMLButtonElement;
  const ready: TurnDiffState = { state: "ready", startedAt };
  const unavailable = (reason: TurnDiffReason, detail?: string): TurnDiffState => ({ state: "unavailable", reason, ...(detail ? { detail } : {}) });

  it("is not offered where the host cannot read a turn alone, or the screen has no way to choose", async () => {
    await show(snapshot());
    expect(host.querySelector(".diff-scope")).toBeNull();
    act(() => root.unmount());
    host.remove();
    await show(snapshot({ turn: ready }), { onScopeChange: null });
    expect(host.querySelector(".diff-scope")).toBeNull();
  });

  it("offers both, with everything chosen, and a turn that can be read", async () => {
    const onScopeChange = vi.fn();
    await show(snapshot({ turn: ready }), { onScopeChange });
    expect(option("전체").getAttribute("aria-pressed")).toBe("true");
    expect(option("이번 턴").getAttribute("aria-pressed")).toBe("false");
    expect(option("이번 턴").disabled).toBe(false);
    await act(async () => option("이번 턴").click());
    expect(onScopeChange).toHaveBeenCalledWith("turn");
    await act(async () => option("전체").click());
    expect(onScopeChange).toHaveBeenLastCalledWith("all");
  });

  it.each<[TurnDiffReason, string | undefined]>([
    ["no-turn", undefined],
    ["unsupported", undefined],
    ["not-git", undefined],
    ["too-large", undefined],
    ["lost", undefined],
    ["failed", "git said no"],
  ])("turns the choice off and says why when the reason is %s", async (reason, detail) => {
    const onScopeChange = vi.fn();
    const turn = unavailable(reason, detail);
    await show(snapshot({ turn }), { onScopeChange });
    const text = turnDiffReasonText(turn as Extract<TurnDiffState, { state: "unavailable" }>);
    expect(option("이번 턴").disabled).toBe(true);
    expect(option("이번 턴").title).toBe(text);
    expect(host.querySelector(".diff-scope__reason")!.textContent).toBe(text);
    await act(async () => option("이번 턴").click());
    expect(onScopeChange).not.toHaveBeenCalled();
    if (detail) expect(text).toContain(detail);
  });

  it("has a sentence of its own for every reason", () => {
    const reasons: TurnDiffReason[] = ["no-turn", "unsupported", "not-git", "too-large", "failed", "lost"];
    const sentences = reasons.map((reason) => turnDiffReasonText({ state: "unavailable", reason }));
    expect(new Set(sentences).size).toBe(reasons.length);
    for (const sentence of sentences) expect(sentence.length).toBeGreaterThan(0);
  });

  it("shows which turn it is when only a turn is shown", async () => {
    await show(snapshot({ scope: "turn", turn: ready }), { scope: "turn" });
    expect(option("이번 턴").getAttribute("aria-pressed")).toBe("true");
    expect(option("전체").getAttribute("aria-pressed")).toBe("false");
    expect(host.querySelector(".diff-scope__reason")!.textContent).toBe(turnStartLabel(startedAt));
    expect(host.textContent).toContain("a.ts");
  });

  it("says nothing changed in the turn, not that nothing changed", async () => {
    await show(snapshot({ scope: "turn", turn: ready, files: [] }), { scope: "turn" });
    expect(notes()).toContain("이번 턴에 바뀐 파일이 없습니다.");
    expect(notes()).not.toContain("변경된 파일이 없습니다.");
    act(() => root.unmount());
    host.remove();
    await show(snapshot({ turn: ready, files: [] }));
    expect(notes()).toContain("변경된 파일이 없습니다.");
    expect(notes()).not.toContain("이번 턴에 바뀐 파일이 없습니다.");
  });

  it("gives the reason instead of an empty list when the turn it shows is gone, and still lets the person go back", async () => {
    const onScopeChange = vi.fn();
    const turn = unavailable("lost");
    await show(snapshot({ scope: "turn", turn, files: [] }), { scope: "turn", onScopeChange });
    expect(notes()).toContain(turnDiffReasonText(turn as Extract<TurnDiffState, { state: "unavailable" }>));
    expect(notes()).not.toContain("변경된 파일이 없습니다.");
    expect(notes()).not.toContain("이번 턴에 바뀐 파일이 없습니다.");
    expect(option("이번 턴").disabled).toBe(false);
    await act(async () => option("전체").click());
    expect(onScopeChange).toHaveBeenCalledWith("all");
  });

  it("names a turn by its start, and does not break on a time it cannot read", () => {
    expect(turnStartLabel(startedAt)).toMatch(/\d/u);
    expect(turnStartLabel("not a time")).toBe("이번 턴의 변경");
  });
});
