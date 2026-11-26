/**
 * @vitest-environment happy-dom
 */
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiffSnapshot, GitStatusSnapshot } from "../../shared/agent-contract";
import type { AgentBackend } from "../backend/agent-backend";
import type { AgentSession } from "../backend/types";
import { useDiff, useGitStatus, useTurnEnds } from "./use-selected-session";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

type Status = AgentSession["status"];

/** Mounts a hook under test and hands back what it returned on the last render, and a way to re-render it. */
function mount<Props, Result>(hook: (props: Props) => Result, initial: Props) {
  const seen: { result?: Result } = {};
  function Harness({ props }: { props: Props }) {
    const result = hook(props);
    useEffect(() => {
      seen.result = result;
    });
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const render = async (props: Props) => {
    await act(async () => {
      root!.render(createElement(Harness, { props }));
    });
  };
  return { seen, render, start: () => render(initial) };
}

describe("useTurnEnds", () => {
  const run = async (steps: [string | undefined, Status | undefined][]) => {
    const harness = mount(({ id, status }: { id: string | undefined; status: Status | undefined }) => useTurnEnds(id, status), {
      id: steps[0]![0],
      status: steps[0]![1],
    });
    await harness.start();
    const counts: number[] = [harness.seen.result!];
    for (const [id, status] of steps.slice(1)) {
      await harness.render({ id, status });
      counts.push(harness.seen.result!);
    }
    return counts;
  };

  it("counts a turn when the status leaves one, not when one starts or waits", async () => {
    expect(
      await run([
        ["s", "idle"],
        ["s", "running"],
        ["s", "waiting"],
        ["s", "running"],
        ["s", "idle"],
        ["s", "running"],
        ["s", "idle"],
      ]),
    ).toEqual([0, 0, 0, 0, 1, 1, 2]);
  });

  it("counts a turn that ends in a failure, or that never left starting", async () => {
    expect(await run([["s", "starting"], ["s", "idle"], ["s", "running"], ["s", "failed"]])).toEqual([0, 1, 1, 2]);
  });

  it("does not count a move between states that are not a turn", async () => {
    expect(await run([["s", "idle"], ["s", "failed"], ["s", "unknown"], ["s", "idle"]])).toEqual([0, 0, 0, 0]);
  });

  it("starts again at zero for another session, whatever that session was doing", async () => {
    expect(
      await run([
        ["a", "running"],
        ["a", "idle"],
        ["b", "running"],
        ["b", "idle"],
        ["a", "idle"],
      ]),
    ).toEqual([0, 1, 0, 1, 0]);
  });

  it("is zero with no session", async () => {
    expect(await run([[undefined, undefined], [undefined, "running"], [undefined, "idle"]])).toEqual([0, 0, 1]);
  });
});

describe("useGitStatus", () => {
  const status = (branch: string): GitStatusSnapshot => ({ workspace: "/w", branch, ahead: 0, behind: 0, files: [] });

  function backendOf(read: (id: string) => Promise<GitStatusSnapshot>) {
    const getGitStatus = vi.fn(read);
    return { backend: { getGitStatus } as unknown as AgentBackend, getGitStatus };
  }
  const flush = () => act(async () => void (await Promise.resolve()));

  it("reads when the session is selected, and holds the answer", async () => {
    const { backend, getGitStatus } = backendOf(async () => status("main"));
    const harness = mount(({ id, turns }: { id: string | undefined; turns: number }) => useGitStatus(backend, id, turns), { id: "s1", turns: 0 });
    await harness.start();
    await flush();
    expect(getGitStatus).toHaveBeenCalledTimes(1);
    expect(getGitStatus).toHaveBeenCalledWith("s1");
    expect(harness.seen.result).toMatchObject({ branch: "main" });
  });

  it("reads again when a turn ends and when the window gets focus back, and at no other time", async () => {
    const { backend, getGitStatus } = backendOf(async () => status("main"));
    const harness = mount(({ turns }: { turns: number }) => useGitStatus(backend, "s1", turns), { turns: 0 });
    await harness.start();
    await flush();
    expect(getGitStatus).toHaveBeenCalledTimes(1);
    // re-rendering with the same count (a status change that is not a turn's end) reads nothing
    await harness.render({ turns: 0 });
    await harness.render({ turns: 0 });
    expect(getGitStatus).toHaveBeenCalledTimes(1);
    await harness.render({ turns: 1 });
    await flush();
    expect(getGitStatus).toHaveBeenCalledTimes(2);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(getGitStatus).toHaveBeenCalledTimes(3);
  });

  it("reads for another session, and forgets the first when none is selected", async () => {
    const { backend, getGitStatus } = backendOf(async (id) => status(id));
    const harness = mount(({ id }: { id: string | undefined }) => useGitStatus(backend, id, 0), { id: "s1" as string | undefined });
    await harness.start();
    await flush();
    await harness.render({ id: "s2" });
    await flush();
    expect(getGitStatus.mock.calls.map(([id]) => id)).toEqual(["s1", "s2"]);
    expect(harness.seen.result).toMatchObject({ branch: "s2" });
    await harness.render({ id: undefined });
    await flush();
    expect(harness.seen.result).toBeNull();
    expect(getGitStatus).toHaveBeenCalledTimes(2);
  });

  it("does not read on focus once the session is gone, and drops an answer that arrives late", async () => {
    let finish!: (value: GitStatusSnapshot) => void;
    const { backend, getGitStatus } = backendOf(
      () =>
        new Promise<GitStatusSnapshot>((resolve) => {
          finish = resolve;
        }),
    );
    const harness = mount(({ id }: { id: string | undefined }) => useGitStatus(backend, id, 0), { id: "s1" as string | undefined });
    await harness.start();
    await flush();
    await harness.render({ id: undefined });
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(getGitStatus).toHaveBeenCalledTimes(1);
    await act(async () => finish(status("late")));
    expect(harness.seen.result).toBeNull();
  });

  it("shows no status when the read fails", async () => {
    const { backend } = backendOf(async () => {
      throw new Error("no git");
    });
    const harness = mount(() => useGitStatus(backend, "s1", 0), undefined);
    await harness.start();
    await flush();
    expect(harness.seen.result).toBeNull();
  });
});

describe("useDiff", () => {
  const snapshot = (id: string): DiffSnapshot => ({ sessionId: id, workspace: "/w", files: [], refreshedAt: "now" });

  function setup() {
    const getDiff = vi.fn(async (id: string) => snapshot(id));
    const backend = { getDiff } as unknown as AgentBackend;
    const selected = { current: "s1" as string | null };
    return { backend, getDiff, selected };
  }
  type Props = { open: boolean; id: string | null; follow?: number };

  it("reads when the panel opens and when the session changes, and not on a turn's end by itself", async () => {
    const { backend, getDiff, selected } = setup();
    const harness = mount(
      ({ open, id }: Props) => useDiff(backend, open, id, selected, "/w"),
      { open: false, id: "s1" } as Props,
    );
    await harness.start();
    expect(getDiff).not.toHaveBeenCalled();
    await harness.render({ open: true, id: "s1" });
    expect(getDiff).toHaveBeenCalledTimes(1);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(getDiff).toHaveBeenCalledTimes(1);
    selected.current = "s2";
    await harness.render({ open: true, id: "s2" });
    expect(getDiff.mock.calls.map(([id]) => id)).toEqual(["s1", "s2"]);
    expect(harness.seen.result?.followedReads).toBe(0);
  });

  describe("following a session's turns", () => {
    const hook = (backend: AgentBackend, selected: { current: string | null }) => ({ open, id, follow }: Props) =>
      useDiff(backend, open, id, selected, "/w", follow);

    it("reads an open panel again when a turn ends and when the window gets focus back", async () => {
      const { backend, getDiff, selected } = setup();
      const harness = mount(hook(backend, selected), { open: true, id: "s1", follow: 0 } as Props);
      await harness.start();
      expect(getDiff).toHaveBeenCalledTimes(1);
      await harness.render({ open: true, id: "s1", follow: 0 });
      expect(getDiff).toHaveBeenCalledTimes(1);
      await harness.render({ open: true, id: "s1", follow: 1 });
      expect(getDiff).toHaveBeenCalledTimes(2);
      expect(harness.seen.result?.followedReads).toBe(1);
      await act(async () => window.dispatchEvent(new Event("focus")));
      expect(getDiff).toHaveBeenCalledTimes(3);
      expect(harness.seen.result?.followedReads).toBe(2);
    });

    it("keeps the diff on screen while it reads again", async () => {
      const { backend, selected } = setup();
      const harness = mount(hook(backend, selected), { open: true, id: "s1", follow: 0 } as Props);
      await harness.start();
      expect(harness.seen.result?.diff).toMatchObject({ sessionId: "s1" });
      await harness.render({ open: true, id: "s1", follow: 1 });
      expect(harness.seen.result?.diff).toMatchObject({ sessionId: "s1" });
    });

    it("reads nothing for a closed panel", async () => {
      const { backend, getDiff, selected } = setup();
      const harness = mount(hook(backend, selected), { open: false, id: "s1", follow: 0 } as Props);
      await harness.start();
      await harness.render({ open: false, id: "s1", follow: 1 });
      await act(async () => window.dispatchEvent(new Event("focus")));
      expect(getDiff).not.toHaveBeenCalled();
    });

    it("reads once, not twice, when the session changes and its turn count starts over", async () => {
      const { backend, getDiff, selected } = setup();
      const harness = mount(hook(backend, selected), { open: true, id: "s1", follow: 3 } as Props);
      await harness.start();
      selected.current = "s2";
      await harness.render({ open: true, id: "s2", follow: 0 });
      expect(getDiff.mock.calls.map(([id]) => id)).toEqual(["s1", "s2"]);
      expect(harness.seen.result?.followedReads).toBe(0);
    });

    it("stops listening for focus when the panel closes", async () => {
      const { backend, getDiff, selected } = setup();
      const harness = mount(hook(backend, selected), { open: true, id: "s1", follow: 0 } as Props);
      await harness.start();
      await harness.render({ open: false, id: "s1", follow: 0 });
      await act(async () => window.dispatchEvent(new Event("focus")));
      expect(getDiff).toHaveBeenCalledTimes(1);
    });
  });
});
