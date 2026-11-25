import { describe, expect, it } from "vitest";
import type { AgentSession } from "../backend/types";
import { newSessionLike } from "./use-composer-callbacks";

describe("newSessionLike", () => {
  it("starts another omp chat from an omp chat, and GJC from anything else", () => {
    const omp = { runtime: "omp-rpc", workspace: "/a" } as AgentSession;
    expect(newSessionLike(omp, "/work/repo")).toEqual({ title: "repo", workspace: "/work/repo", kind: "terminal", agentKind: "omp", surface: "chat" });
    expect(newSessionLike({ runtime: "gjc" } as AgentSession, "/work/repo")).toMatchObject({ workspace: "/work/repo" });
    expect(newSessionLike(null, "/w")).not.toHaveProperty("kind");
  });
});
