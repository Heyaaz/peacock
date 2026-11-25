import type { ContextBreakdown, ContextCategoryId } from "../../shared/agent-contract.js";
import { stripTerminalControls } from "../herdr-core/transcript/transcript-records.js";

/** omp's categories (pi-tui's context-usage), in the order it lists them, by the label `/context` prints. */
const CATEGORIES: readonly [label: string, id: Exclude<ContextCategoryId, "other">][] = [
  ["System prompt", "systemPrompt"],
  ["System tools", "systemTools"],
  ["System context", "systemContext"],
  ["Instruction files", "instructionFiles"],
  ["Skills", "skills"],
  ["Messages", "messages"],
];
const BUFFER_LABEL = "Auto-compact buf";
const FREE_LABEL = "Free";

const HEAD = /^Context window: (\d+) tokens \((\d+)% used\)$/;
// "  <label padded to 16> [<bar>] <share>%  <n> tokens"
const ROW = /^ {2}(\S.*?)\s+\[[^\]]*\](?:\s+[<>]?\d+(?:\.\d+)?%)?\s+(\d+) tokens$/;

/**
 * The text omp 19.1.1's `/context` prints over RPC (`buildContextReportText`, a
 * `command_output` frame) as data: the window, each category's tokens, the
 * auto-compaction buffer and the free room. omp prints only categories with
 * tokens, so a missing one reads 0; a line it adds that is not a row, such as
 * snapcompact's savings, is kept as a note. Null when omp says it cannot tell
 * (no model) or the text is not the report.
 */
export function parseContextReport(text: string): ContextBreakdown | null {
  // omp colours its ASCII bars
  const lines = stripTerminalControls(text).split("\n");
  const head = HEAD.exec((lines[0] ?? "").trim());
  if (!head) return null;
  const contextWindow = Number(head[1]);
  const found = new Map<string, number>();
  const others: ContextBreakdown["categories"] = [];
  let autoCompactBufferTokens = 0;
  let freeTokens = 0;
  const notes: string[] = [];
  for (const line of lines.slice(1)) {
    const row = ROW.exec(line.trimEnd());
    if (!row) {
      if (line.trim()) notes.push(line.trim());
      continue;
    }
    const label = row[1]!.trim();
    const tokens = Number(row[2]);
    if (label === BUFFER_LABEL) autoCompactBufferTokens = tokens;
    else if (label === FREE_LABEL) freeTokens = tokens;
    else if (CATEGORIES.some(([known]) => known === label)) found.set(label, tokens);
    else others.push({ id: "other", label, tokens });
  }
  const categories = [
    ...CATEGORIES.map(([label, id]) => ({ id, label, tokens: found.get(label) ?? 0 })),
    ...others,
  ];
  const usedTokens = categories.reduce((sum, category) => sum + category.tokens, 0);
  return { contextWindow, usedTokens, categories, autoCompactBufferTokens, freeTokens, notes };
}
