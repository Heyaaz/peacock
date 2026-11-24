import { describe, expect, it } from "vitest";
import { launchArgs, launchOptions, launchOptionsFault } from "./agent-launch.js";

describe("launchOptionsFault", () => {
  it("passes what each agent takes", () => {
    expect(launchOptionsFault("claude", { model: "opus[1m]", effort: "xhigh", permissionMode: "plan" })).toBeNull();
    expect(launchOptionsFault("codex", { model: "gpt-5.2", effort: "ultra" })).toBeNull();
    expect(launchOptionsFault("omp", { model: "openai/gpt-5.2" })).toBeNull();
    expect(launchOptionsFault("shell", undefined)).toBeNull();
  });

  it("refuses an option the agent does not take, an unknown one, and a value that could read as a flag", () => {
    expect(launchOptionsFault("omp", { effort: "high" })).toMatch(/does not take effort/u);
    expect(launchOptionsFault("codex", { permissionMode: "plan" })).toMatch(/does not take/u);
    expect(launchOptionsFault("shell", { model: "x" })).toMatch(/does not take/u);
    expect(launchOptionsFault("claude", { prompt: "rm -rf" })).toMatch(/Unknown launch option/u);
    expect(launchOptionsFault("claude", { model: "--dangerously-skip-permissions" })).toMatch(/not one/u);
    expect(launchOptionsFault("claude", { effort: "ultracode" })).toMatch(/not one/u);
    expect(launchOptionsFault("claude", { permissionMode: "dontAsk" })).toMatch(/not one/u);
    expect(launchOptionsFault("claude", { model: 3 })).toMatch(/short string/u);
    expect(launchOptionsFault("claude", ["--model"])).toMatch(/object/u);
  });
});

describe("launchArgs", () => {
  it("writes each agent's own flags", () => {
    expect(launchArgs("claude", { model: "haiku", effort: "low", permissionMode: "default" })).toEqual([
      "--model", "haiku", "--effort", "low", "--permission-mode", "default",
    ]);
    expect(launchArgs("codex", { model: "gpt-5.2", effort: "high" })).toEqual([
      "--model", "gpt-5.2", "-c", 'model_reasoning_effort="high"',
    ]);
    expect(launchArgs("omp", { model: "opus" })).toEqual(["--model=opus"]);
    expect(launchArgs("omp", { permissionMode: "always-ask" })).toEqual(["--approval-mode=always-ask"]);
    expect(launchOptionsFault("omp", { permissionMode: "bypassPermissions" })).toMatch(/not one omp takes/u);
    expect(launchArgs("claude", undefined)).toEqual([]);
  });

  it("keeps only checked fields", () => {
    expect(launchOptions("claude", { model: "haiku", effort: undefined })).toEqual({ model: "haiku" });
    expect(launchOptions("claude", {})).toBeUndefined();
    expect(() => launchOptions("omp", { effort: "high" })).toThrow();
  });
});
