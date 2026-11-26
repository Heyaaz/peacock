import { afterEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import type { DiffSnapshot } from "../shared/agent-contract.js";
import { GJC_IPC } from "../shared/gjc-ipc.js";
import type { TurnDiffState } from "../shared/turn-diff.js";
import { AttachmentStore } from "./attachment-store.js";
import { registerGjcIpcHandlers } from "./gjc-ipc-handlers.js";
import type { IpcSecurity } from "./ipc-security.js";
import type { TurnBaselines } from "./turn-baselines.js";

const handled = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handled.set(channel, handler);
    },
    removeHandler: (channel: string) => {
      handled.delete(channel);
    },
  },
}));

afterEach(() => handled.clear());

const event = { sender: { id: 5 } } as unknown as IpcMainInvokeEvent;
const call = (channel: string, ...args: unknown[]) => handled.get(channel)!(event, ...args);

const everything: DiffSnapshot = {
  sessionId: "s1",
  workspace: "/w",
  files: [{ id: "a.ts", path: "a.ts", patch: "diff --git a/a.ts b/a.ts" }],
  refreshedAt: "now",
};
const thisTurn: DiffSnapshot = { ...everything, files: [], scope: "turn", turn: { state: "ready", startedAt: "2026-11-26T04:00:00.000Z" } };
const ready: TurnDiffState = { state: "ready", startedAt: "2026-11-26T04:00:00.000Z" };

function setup(options: { withBaselines?: boolean } = {}) {
  const getDiff = vi.fn(async () => everything);
  const diff = vi.fn(async () => thisTurn);
  const state = vi.fn((): TurnDiffState => ready);
  registerGjcIpcHandlers(
    { getDiff } as never,
    new AttachmentStore(),
    { guarded: (handler: (...args: unknown[]) => unknown) => handler, owner: vi.fn(), authorizeDestructive: vi.fn() } as unknown as IpcSecurity,
    undefined,
    undefined,
    options.withBaselines === false ? undefined : ({ diff, state } as unknown as TurnBaselines),
  );
  return { getDiff, diff, state };
}

describe("reading a diff from the window", () => {
  it.each([[undefined], [{ scope: "all" }]])("answers everything, and says whether a turn can be read alone (%j)", async (options) => {
    const { getDiff, diff, state } = setup();
    expect(await call(GJC_IPC.getDiff, "s1", options)).toEqual({ ...everything, turn: ready });
    expect(getDiff).toHaveBeenCalledExactlyOnceWith("s1");
    expect(state).toHaveBeenCalledWith("s1");
    expect(diff).not.toHaveBeenCalled();
  });

  it("answers only the latest turn when asked, without reading the runtime's own diff", async () => {
    const { getDiff, diff } = setup();
    expect(await call(GJC_IPC.getDiff, "s1", { scope: "turn" })).toEqual(thisTurn);
    expect(diff).toHaveBeenCalledExactlyOnceWith("s1");
    expect(getDiff).not.toHaveBeenCalled();
  });

  it("answers what the runtime does, unchanged, where nothing keeps turns", async () => {
    const { getDiff } = setup({ withBaselines: false });
    expect(await call(GJC_IPC.getDiff, "s1")).toEqual(everything);
    expect(getDiff).toHaveBeenCalledWith("s1");
    await expect(call(GJC_IPC.getDiff, "s1", { scope: "turn" })).rejects.toThrow("not available");
  });

  it.each([["turn"], [{ scope: "week" }], [{ scope: "turn", path: "/etc" }], [{}], [null], [[]], [7]])(
    "rejects options that are not exactly a scope (%j)",
    async (options) => {
      const { getDiff, diff } = setup();
      await expect(call(GJC_IPC.getDiff, "s1", options)).rejects.toThrow();
      expect(getDiff).not.toHaveBeenCalled();
      expect(diff).not.toHaveBeenCalled();
    },
  );

  it("rejects a session id that is not one", async () => {
    const { diff } = setup();
    await expect(call(GJC_IPC.getDiff, "../x", { scope: "turn" })).rejects.toThrow("Session ID is invalid");
    expect(diff).not.toHaveBeenCalled();
  });
});
