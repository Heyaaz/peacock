import type { AgentKindId } from "../../shared/agent-contract";
import type { AgentControlPreferences } from "../backend/types";
import { t } from "../i18n";

/** The agents Settings › 에이전트 shows, in this order; the shell has nothing to set. */
export const SETTINGS_AGENTS = ["claude", "omp", "codex", "gjc"] as const satisfies readonly AgentKindId[];
export type SettingsAgent = (typeof SETTINGS_AGENTS)[number];

/** What GJC's tool approval setting is called on screen. */
export function gjcApprovalLabel(value: AgentControlPreferences["permissionHandling"]): string {
  if (value === "auto") return t("GJC 스마트 정책");
  if (value === "always-allow") return t("항상 허용");
  return t("명령 실행만 확인");
}
