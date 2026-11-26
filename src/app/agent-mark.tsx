import { Asterisk, Bot, Hexagon, Pi, Shrimp, SquareTerminal } from "lucide-react";
import type { AgentKindId } from "../../shared/agent-contract";

/**
 * Each agent's own mark, for the rows that name who answered.
 *
 * No vendor artwork ships with the app, so these are the glyphs that still read as
 * that agent: π for Oh My Pi, the asterisk for Claude, the knot-like hexagon for
 * Codex, the crayfish for GJC (gajae), the terminal for a shell. The fallback is
 * the generic bot a session without a known agent keeps.
 */
const MARKS: Record<AgentKindId, typeof Bot> = {
  claude: Asterisk,
  omp: Pi,
  codex: Hexagon,
  gjc: Shrimp,
  shell: SquareTerminal,
};

export function AgentMark({ agentKind, size = 14 }: { agentKind?: AgentKindId | null; size?: number }) {
  const Icon = agentKind ? MARKS[agentKind] : undefined;
  const Mark = Icon ?? Bot;
  return <Mark size={size} aria-hidden="true" />;
}
