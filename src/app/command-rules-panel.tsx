import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import type { SettingsDesktopBridge } from "../../shared/agent-contract";
import type { ProjectCommandRules } from "../../shared/command-rules";
import { t } from "../i18n";
import { projectNameOf } from "./project-model";
import { SettingsSection } from "./settings-layout";

type Bridge = Pick<SettingsDesktopBridge, "listCommandRules" | "removeCommandRule">;

/**
 * The bash allow and reject rules saved per project from approval cards.
 *
 * Rules live in the desktop host, so a renderer without that bridge (the remote
 * web client) shows nothing: a view-only device must not read or change them.
 */
export function CommandRulesPanel({ bridge }: { bridge: Bridge | undefined }) {
  const [projects, setProjects] = useState<ProjectCommandRules[] | null>(null);
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    bridge.listCommandRules().then(
      (next) => {
        if (!active) return;
        setProjects(next);
        setError("");
      },
      (cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [bridge]);

  if (!bridge) return null;

  async function remove(root: string, prefix: string) {
    setRemoving(true);
    setError("");
    try {
      setProjects(await bridge!.removeCommandRule(root, prefix));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRemoving(false);
    }
  }

  const sorted = [...(projects ?? [])].sort((a, b) =>
    projectNameOf(a.root).localeCompare(projectNameOf(b.root)) || a.root.localeCompare(b.root),
  );

  return (
    <SettingsSection
      className="command-rules"
      title={t("명령 규칙")}
      description={t("승인 카드에서 저장한 규칙입니다. 프로젝트마다, 이 앞부분으로 시작하는 bash 명령은 묻지 않고 허용하거나 거절합니다.")}
    >
      {error && <p className="diff-error">{error}</p>}
      {projects && sorted.length === 0 && !error && (
        <p className="settings-empty">
          {t("저장한 규칙이 없습니다. 승인 카드에서 ‘앞부분 항상 허용’이나 ‘앞부분 항상 거부’를 누르면 여기에 쌓입니다.")}
        </p>
      )}
      {sorted.map((project) => (
        <section className="command-rules-project" key={project.root}>
          <h4>
            {projectNameOf(project.root)}
            <small>{project.root}</small>
          </h4>
          {project.rules.map((rule) => (
            <div className="command-rule-row" key={rule.prefix}>
              <em className={`command-rule-decision command-rule-decision--${rule.decision}`}>
                {rule.decision === "allow" ? t("허용") : t("거절")}
              </em>
              <code>{rule.prefix}</code>
              <button
                type="button"
                aria-label={t("{0} 규칙 삭제", { 0: rule.prefix })}
                disabled={removing}
                onClick={() => void remove(project.root, rule.prefix)}
              >
                <Trash2 size={12} aria-hidden="true" />
              </button>
            </div>
          ))}
        </section>
      ))}
    </SettingsSection>
  );
}
