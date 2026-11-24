import { describe, expect, it, vi } from "vitest";
import type { ToolActivity, TranscriptItem } from "../../shared/agent-contract.js";
import type { HookChannel } from "./agent-hooks.js";
import { approvalAnswer, HerdrApprovals, stableKey } from "./approvals.js";
import { composeRows } from "./transcript/transcripts.js";

const SID = "terminal-0b1c";

function channel() {
  const listeners: (() => void)[] = [];
  const replies: string[] = [];
  let closed = false;
  const value: HookChannel & { replies: string[]; close(): void } = {
    replies,
    reply(answer: string) {
      if (closed) return;
      replies.push(answer);
      closed = true;
      for (const listener of listeners.splice(0)) listener();
    },
    get closed() {
      return closed;
    },
    onClose(listener: () => void) {
      if (closed) listener();
      else listeners.push(listener);
    },
    close() {
      closed = true;
      for (const listener of listeners.splice(0)) listener();
    },
  };
  return value;
}

function setup(rules?: { decide?: ReturnType<typeof vi.fn>; add?: ReturnType<typeof vi.fn> }) {
  let now = 1_000;
  const changed = vi.fn();
  const approvals = new HerdrApprovals({
    ...(rules
      ? {
          commandRules: {
            decide: (rules.decide ?? vi.fn(async () => undefined)) as never,
            add: (rules.add ?? vi.fn(async () => undefined)) as never,
          },
        }
      : {}),
    workspaceOf: () => "/work/demo",
    lastRowId: () => `${SID}:u1`,
    changed,
    now: () => now,
    waitMs: 60_000,
  });
  return { approvals, changed, tick: (ms: number) => (now += ms) };
}

const BASH = { tool_name: "Bash", tool_input: { command: "npm test", description: "Run tests" } };
const ALLOW = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}';

describe("HerdrApprovals", () => {
  it("pairs Claude Code's request with the PreToolUse of the same tool and input, and shows a card", async () => {
    const { approvals, changed } = setup();
    approvals.notePreToolUse(SID, { tool_use_id: "toolu_old", tool_name: "Bash", tool_input: { command: "ls" } });
    approvals.notePreToolUse(SID, { tool_use_id: "toolu_1", tool_name: "Bash", tool_input: { description: "Run tests", command: "npm test" } });
    const hook = channel();
    await approvals.request(SID, BASH, hook);
    const [card] = approvals.overlay(SID);
    expect(card).toMatchObject({
      afterId: `${SID}:u1`,
      row: { id: `${SID}:toolu_1`, name: "bash", status: "approval-required", description: "Run tests" },
    });
    expect(card!.row.permissionOptions!.map((option) => option.kind)).toEqual(["allow_once", "reject_once"]);
    expect(approvals.owns(`${SID}:toolu_1`)).toBe(true);
    expect(hook.replies).toEqual([]);
    expect(changed).toHaveBeenCalledWith(SID);
  });

  it("answers the hook with the card's decision, and the card says how it went", async () => {
    const { approvals } = setup();
    approvals.notePreToolUse(SID, { tool_use_id: "toolu_1", ...BASH });
    const hook = channel();
    await approvals.request(SID, BASH, hook);
    expect(approvals.decisionInfo(`${SID}:toolu_1`, { optionId: "allow_once" })).toEqual({ name: "이번만 허용", requiresConfirmation: true });
    await approvals.resolve(`${SID}:toolu_1`, { optionId: "allow_once" });
    expect(hook.replies).toEqual([ALLOW]);
    expect(approvals.overlay(SID)[0]!.row).toMatchObject({ status: "approved" });
    expect(approvals.overlay(SID)[0]!.row.permissionOptions).toBeUndefined();
    await expect(approvals.resolve(`${SID}:toolu_1`, { optionId: "allow_once" })).rejects.toThrow(/No pending permission/u);
  });

  it("declines with the user's words for the agent, or stops it as the terminal's No does", () => {
    expect(JSON.parse(approvalAnswer("deny", "use pnpm instead")).hookSpecificOutput.decision).toEqual({
      behavior: "deny",
      message: "use pnpm instead",
      interrupt: false,
    });
    expect(JSON.parse(approvalAnswer("deny")).hookSpecificOutput.decision).toMatchObject({ behavior: "deny", interrupt: true });
  });

  it("lets the project's command rules decide first, with no card", async () => {
    const decide = vi.fn(async () => ({ decision: "allow" as const, prefix: "npm test" }));
    const { approvals } = setup({ decide });
    const hook = channel();
    await approvals.request(SID, { ...BASH, tool_use_id: "call_9" }, hook);
    expect(decide).toHaveBeenCalledWith("/work/demo", "bash", "npm test");
    expect(hook.replies).toEqual([ALLOW]);
    expect(approvals.owns(`${SID}:call_9`)).toBe(false);
    expect(approvals.overlay(SID)[0]!.row).toMatchObject({ status: "approved", autoDecision: { decision: "allow", prefix: "npm test" } });
  });

  it("saves a rule from the card before answering, and still answers when it cannot", async () => {
    const add = vi.fn(async () => undefined);
    const { approvals } = setup({ add });
    const hook = channel();
    await approvals.request(SID, { ...BASH, tool_use_id: "call_1" }, hook);
    await approvals.resolve(`${SID}:call_1`, { optionId: "reject_once", rule: { prefix: "npm test" } });
    expect(add).toHaveBeenCalledWith("/work/demo", "npm test", "reject");
    expect(JSON.parse(hook.replies[0]!).hookSpecificOutput.decision.behavior).toBe("deny");

    const failing = setup({ add: vi.fn(async () => Promise.reject(new Error("disk full"))) });
    const second = channel();
    await failing.approvals.request(SID, { ...BASH, tool_use_id: "call_2" }, second);
    await expect(failing.approvals.resolve(`${SID}:call_2`, { optionId: "allow_once", rule: { prefix: "npm" } })).rejects.toThrow("disk full");
    expect(second.replies).toEqual([ALLOW]);
  });

  it("lets go of a card answered at the terminal: the tool ran, the dialog closed, the turn stopped, or the hook left", async () => {
    const { approvals } = setup();
    const ran = channel();
    await approvals.request(SID, { ...BASH, tool_use_id: "a" }, ran);
    approvals.notePostToolUse(SID, { tool_use_id: "a" });
    expect(ran.replies).toEqual([""]);
    expect(approvals.overlay(SID).find((card) => card.row.id === `${SID}:a`)).toMatchObject({ released: true, row: { status: "completed" } });

    const closed = channel();
    await approvals.request(SID, { ...BASH, tool_use_id: "b" }, closed);
    closed.close();
    expect(approvals.owns(`${SID}:b`)).toBe(false);

    const stopped = channel();
    await approvals.request(SID, { ...BASH, tool_use_id: "c" }, stopped);
    approvals.releaseSession(SID, "stopped");
    expect(stopped.replies).toEqual([""]);
    expect(approvals.hasPending(SID)).toBe(false);
  });

  it("shows what an approved call printed on a card that has no transcript row", async () => {
    const { approvals } = setup();
    const hook = channel();
    await approvals.request(SID, { ...BASH, tool_use_id: "repl_1" }, hook);
    await approvals.resolve(`${SID}:repl_1`, { optionId: "allow_once" });
    approvals.notePostToolUse(SID, { tool_use_id: "repl_1", tool_response: { stdout: "ok\n", stderr: "", interrupted: false } });
    expect(approvals.overlay(SID)[0]!.row).toMatchObject({ status: "completed", output: "ok\n" });
  });

  it("lets go only of what was asked before the dialog closed", async () => {
    const { approvals, tick } = setup();
    const early = channel();
    await approvals.request(SID, { ...BASH, tool_use_id: "early" }, early);
    tick(500);
    const closedAt = 1_499;
    tick(500);
    const late = channel();
    await approvals.request(SID, { ...BASH, tool_use_id: "late" }, late);
    approvals.releaseSession(SID, "answered", closedAt);
    expect(early.replies).toEqual([""]);
    expect(late.replies).toEqual([]);
  });

  it("lets go of a card whose call the transcript shows finished", async () => {
    const { approvals } = setup();
    const hook = channel();
    await approvals.request(SID, { ...BASH, tool_use_id: "toolu_7" }, hook);
    const finished = { id: `${SID}:toolu_7`, kind: "tool", sessionId: SID, name: "bash", description: "", status: "denied", createdAt: "" } as ToolActivity;
    approvals.noteRows(SID, [finished]);
    expect(hook.replies).toEqual([""]);
    expect(approvals.overlay(SID)).toEqual([]);
  });

  it("gives up after its wait, so the card never outlives the agent's dialog", async () => {
    vi.useFakeTimers();
    try {
      const { approvals } = setup();
      const hook = channel();
      await approvals.request(SID, { ...BASH, tool_use_id: "slow" }, hook);
      vi.advanceTimersByTime(60_001);
      expect(hook.replies).toEqual([""]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("spells an omp call id the way the window's and a phone's id checks take it", async () => {
    const { approvals } = setup();
    await approvals.request(SID, { tool_name: "bash", tool_input: { command: "ls" }, tool_use_id: "call_1|fc_2" }, channel());
    const id = approvals.overlay(SID)[0]!.row.id;
    expect(id).toBe(`${SID}:call_1_fc_2`);
    expect(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(id)).toBe(true);
  });

  it("reads inputs the same whatever their key order", () => {
    expect(stableKey({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(stableKey({ a: [{ c: 3, d: 2 }], b: 1 }));
  });
});

describe("composeRows", () => {
  const tool = (id: string, status: ToolActivity["status"]): ToolActivity => ({ id, kind: "tool", sessionId: SID, name: "bash", description: "", status, createdAt: "" });
  const message = (id: string): TranscriptItem => ({ id, kind: "message", sessionId: SID, role: "user", content: "x", createdAt: "" });

  it("lays a waiting card over the call's own row, and leaves a finished one to the transcript", () => {
    const card = { row: { ...tool("t1", "approval-required"), permissionOptions: [{ optionId: "allow_once", kind: "allow_once" as const, name: "Allow" }] } };
    expect(composeRows([message("u1"), tool("t1", "running")], [card])[1]).toMatchObject({ status: "approval-required", permissionOptions: [{ kind: "allow_once" }] });
    expect(composeRows([message("u1"), tool("t1", "completed")], [card])[1]).toMatchObject({ status: "completed" });
    expect(composeRows([tool("t1", "running")], [{ ...card, released: true }])[0]).toMatchObject({ status: "running" });
  });

  it("places a card with no row of its own after the row that was last, so later rows keep the order", () => {
    const rows = composeRows([message("u1"), message("u2")], [{ row: tool("x", "approval-required"), afterId: "u1" }]);
    expect(rows.map((row) => row.id)).toEqual(["u1", "x", "u2"]);
    const later = composeRows([message("u1"), message("u2"), message("u3")], [
      { row: tool("x", "approved"), afterId: "u2" },
      { row: tool("y", "approval-required"), afterId: "u2" },
    ]);
    expect(later.map((row) => row.id)).toEqual(["u1", "u2", "x", "y", "u3"]);
  });
});
