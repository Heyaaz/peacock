import type { PermissionOption } from "./agent-contract.js";

/**
 * Korean labels for the approval choices, keyed by kind. GJC names the choices
 * in English ("Allow once"), so the name is shown only for a kind this table
 * does not know.
 */
export const PERMISSION_OPTION_LABELS: Readonly<Record<string, string>> = {
  allow_once: "이번만 허용",
  allow_session: "이 세션 동안 허용",
  allow_always: "항상 허용",
  reject_once: "거절",
  reject_always: "항상 거절",
};

/**
 * A choice as the host names it (its own dialogs, a confirmation). A grant names what it
 * covers: omp's folder and target grants, for this session or always.
 */
export function permissionOptionLabel(option: Pick<PermissionOption, "kind" | "name" | "grant">): string {
  const grant = option.grant;
  if (grant && (option.kind === "allow_session" || option.kind === "allow_always")) {
    const always = option.kind === "allow_always";
    if (grant.scope === "folder") return always ? `폴더 항상 허용: ${grant.target ?? ""}` : `이 세션 동안 폴더 허용: ${grant.target ?? ""}`;
    if (grant.files) return always ? "이 파일 항상 허용" : "이 세션 동안 이 파일 허용";
    return always ? "이 대상 항상 허용" : "이 세션 동안 이 대상 허용";
  }
  return PERMISSION_OPTION_LABELS[option.kind] ?? option.name;
}
