import { describe, expect, it } from "vitest";
import { parseContextReport } from "./context-report.js";

// omp 19.1.1's `/context` over RPC on a resumed session, as its command_output frame carried it
const LIVE = [
  "Context window: 950000 tokens (2% used)",
  "  System prompt    [\u001b[38;5;248m░\u001b[39m\u001b[38;5;243m░░░░░░░░░░░░░░░░░░░░░░░\u001b[39m] 0%  1861 tokens",
  "  System tools     [\u001b[38;5;248m░\u001b[39m\u001b[38;5;243m░░░░░░░░░░░░░░░░░░░░░░░\u001b[39m] 1%  5743 tokens",
  "  System context   [\u001b[38;5;248m░\u001b[39m\u001b[38;5;243m░░░░░░░░░░░░░░░░░░░░░░░\u001b[39m] 0%  663 tokens",
  "  Instruction files [\u001b[38;5;248m░\u001b[39m\u001b[38;5;243m░░░░░░░░░░░░░░░░░░░░░░░\u001b[39m] 0%  1309 tokens",
  "  Skills           [\u001b[38;5;248m░\u001b[39m\u001b[38;5;243m░░░░░░░░░░░░░░░░░░░░░░░\u001b[39m] 0%  1523 tokens",
  "  Messages         [\u001b[38;5;248m░\u001b[39m\u001b[38;5;243m░░░░░░░░░░░░░░░░░░░░░░░\u001b[39m] 0%  3251 tokens",
  "  Auto-compact buf [\u001b[38;5;248m█\u001b[39m\u001b[38;5;243m███░░░░░░░░░░░░░░░░░░░░\u001b[39m] 15%  142500 tokens",
  "  Free             [\u001b[38;5;248m█\u001b[39m\u001b[38;5;243m███████████████████░░░░\u001b[39m] 83%  793150 tokens",
].join("\n");

describe("parseContextReport", () => {
  it("reads omp's window, categories, buffer and free room", () => {
    expect(parseContextReport(LIVE)).toEqual({
      contextWindow: 950000,
      usedTokens: 14350,
      categories: [
        { id: "systemPrompt", label: "System prompt", tokens: 1861 },
        { id: "systemTools", label: "System tools", tokens: 5743 },
        { id: "systemContext", label: "System context", tokens: 663 },
        { id: "instructionFiles", label: "Instruction files", tokens: 1309 },
        { id: "skills", label: "Skills", tokens: 1523 },
        { id: "messages", label: "Messages", tokens: 3251 },
      ],
      autoCompactBufferTokens: 142500,
      freeTokens: 793150,
      notes: [],
    });
  });

  it("reads a category omp left out for having no tokens as 0, and keeps an unknown one", () => {
    const report = parseContextReport(
      ["Context window: 1000 tokens (50% used)", "  Messages         [██] 40%  400 tokens", "  MCP tools        [█] 10%  100 tokens"].join("\n"),
    )!;
    expect(report.categories.find((category) => category.id === "skills")?.tokens).toBe(0);
    expect(report.categories.at(-1)).toEqual({ id: "other", label: "MCP tools", tokens: 100 });
    expect(report.usedTokens).toBe(500);
    expect(report.autoCompactBufferTokens).toBe(0);
  });

  it("keeps snapcompact's lines as notes", () => {
    const report = parseContextReport(
      [
        "Context window: 1000 tokens (10% used)",
        "  Messages         [█] 10%  100 tokens",
        "Snapcompact (estimated wire savings):",
        "  System prompt: stays text (no net savings)",
      ].join("\n"),
    )!;
    expect(report.notes).toEqual(["Snapcompact (estimated wire savings):", "System prompt: stays text (no net savings)"]);
    expect(report.categories.find((category) => category.id === "systemPrompt")?.tokens).toBe(0);
  });

  it("returns null when omp cannot tell", () => {
    expect(parseContextReport("Context usage is unavailable: no model is selected for this session.")).toBeNull();
    expect(parseContextReport("Context\nWindow: 1000\nUsed: 10")).toBeNull();
  });
});
