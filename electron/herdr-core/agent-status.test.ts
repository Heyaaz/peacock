import { describe, expect, it } from "vitest";
import { activityOf, factsOfTerminal, sessionStatusOf, type TerminalFacts } from "./agent-status.js";

const live = (state: string | null, reported = true): TerminalFacts => ({
  state: "live",
  reported,
  status: state === null ? null : { state },
});
const finished = (extra: Partial<TerminalFacts>): TerminalFacts => ({ state: "finished", reported: true, status: null, ...extra });

describe("sessionStatusOf", () => {
  it("maps 7501 states as the design table says", () => {
    expect(sessionStatusOf(live("working"))).toBe("running");
    expect(sessionStatusOf(live("blocked"))).toBe("waiting");
    expect(sessionStatusOf(live("idle"))).toBe("idle");
    expect(sessionStatusOf(live("done"))).toBe("idle");
    expect(sessionStatusOf(live("error"))).toBe("failed");
    expect(sessionStatusOf(live("something-new"))).toBe("unknown");
  });

  it("calls a program that never reported unknown, and keeps the last status over a brief null", () => {
    expect(sessionStatusOf(live(null, false))).toBe("unknown");
    expect(sessionStatusOf(live(null), "waiting")).toBe("waiting");
    expect(sessionStatusOf(undefined)).toBe("idle");
  });

  it("calls a clean or requested end idle, and any other end failed", () => {
    expect(sessionStatusOf(finished({ reason: "exited", exitCode: 0 }))).toBe("idle");
    expect(sessionStatusOf(finished({ reason: "killed", signal: 1 }))).toBe("idle");
    expect(sessionStatusOf(finished({ reason: "exited", exitCode: 1 }))).toBe("failed");
    expect(sessionStatusOf(finished({ reason: "holder_lost" }))).toBe("failed");
  });
});

describe("activityOf", () => {
  it("tells a finished turn, a wait for approval and an error once, on the change", () => {
    expect(activityOf(live("working"), live("done"))).toBe("completed");
    expect(activityOf(live("done"), live("done"))).toBeUndefined();
    expect(activityOf(live("working"), live("blocked"))).toBe("permission");
    expect(activityOf(live("blocked"), live("blocked"))).toBeUndefined();
    expect(activityOf(live("working"), live("error"))).toBe("failed");
    expect(activityOf(live("working"), live("idle"))).toBeUndefined();
  });

  it("tells an abnormal end, never a requested one", () => {
    expect(activityOf(live("working"), finished({ reason: "exited", exitCode: 2 }))).toBe("failed");
    expect(activityOf(live("working"), finished({ reason: "killed", signal: 1 }))).toBeUndefined();
    expect(activityOf(finished({ reason: "exited", exitCode: 2 }), finished({ reason: "exited", exitCode: 2 }))).toBeUndefined();
  });

  it("reads a terminal record", () => {
    expect(factsOfTerminal({ state: "live", reported: true, status: { state: "working" } })).toEqual({
      state: "live",
      reported: true,
      status: { state: "working" },
      exitCode: null,
      reason: null,
      signal: null,
    });
  });
});
