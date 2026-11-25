import { useEffect, useState } from "react";
import { Check, Circle, CircleDot, ListChecks, Timer, X } from "lucide-react";
import type { SessionLiveStatus, SubagentSnapshot, TodoSnapshotTask } from "../../shared/agent-contract";
import { t } from "../i18n";

const DONE = new Set(["completed", "done", "complete"]);
const ACTIVE = new Set(["in_progress", "in-progress", "active", "running"]);

function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function TaskMark({ task }: { task: TodoSnapshotTask }) {
  if (DONE.has(task.status ?? "")) return <Check size={12} className="turn-status-task-icon is-done" aria-label={t("완료")} />;
  if (ACTIVE.has(task.status ?? "")) return <CircleDot size={12} className="turn-status-task-icon is-active" aria-label={t("진행 중")} />;
  return <Circle size={12} className="turn-status-task-icon" aria-label={t("대기")} />;
}

/**
 * The line above the composer while an agent works (omp's chat): how long the turn has run, what
 * it does now, its todo progress (a checklist on click) and how full the context is.
 */
export function TurnStatusLine({ status, running }: { status: SessionLiveStatus; running: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  const [todoOpen, setTodoOpen] = useState(false);
  const started = running ? status.turnStartedAtMs : undefined;
  useEffect(() => {
    if (started === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [started]);
  const tasks = (status.todo ?? []).flatMap((phase) => phase.tasks);
  const done = tasks.filter((task) => DONE.has(task.status ?? "")).length;
  const parts = [
    started !== undefined,
    running && Boolean(status.activity),
    tasks.length > 0,
    status.contextPercent !== undefined,
  ];
  if (!parts.some(Boolean)) return null;
  return (
    <div className="turn-status-line" role="status">
      {started !== undefined && (
        <span className="turn-status-elapsed" title={t("이번 턴이 지난 시간")}>
          <Timer size={12} aria-hidden="true" />
          {elapsedLabel(now - started)}
        </span>
      )}
      {running && status.activity && (
        <span className="turn-status-activity" title={status.activity}>
          {status.activity}
        </span>
      )}
      {tasks.length > 0 && (
        <span className="turn-status-todo">
          <button type="button" aria-expanded={todoOpen} title={t("할 일 목록")} onClick={() => setTodoOpen((open) => !open)}>
            <ListChecks size={12} aria-hidden="true" />
            {done}/{tasks.length}
          </button>
          {todoOpen && (
            <span className="turn-status-todo-menu" role="dialog" aria-label={t("할 일 목록")}>
              <header>
                <strong>{t("할 일")}</strong>
                <small>
                  {done}/{tasks.length}
                </small>
                <button type="button" className="icon-button" aria-label={t("닫기")} onClick={() => setTodoOpen(false)}>
                  <X size={12} />
                </button>
              </header>
              {(status.todo ?? []).map((phase, phaseIndex) => (
                <section key={`${phase.name ?? ""}-${phaseIndex}`}>
                  {phase.name && <strong>{phase.name}</strong>}
                  <ul>
                    {phase.tasks.map((task, index) => (
                      <li key={index} className={DONE.has(task.status ?? "") ? "is-done" : ""}>
                        <TaskMark task={task} />
                        <span>{task.content}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </span>
          )}
        </span>
      )}
      {status.contextPercent !== undefined && (
        <span className="turn-status-context" title={t("이 대화가 쓴 컨텍스트 비율")}>
          {t`컨텍스트 ${Math.round(status.contextPercent)}%`}
        </span>
      )}
    </div>
  );
}

const SUBAGENT_STATUS: Record<SubagentSnapshot["status"], string> = {
  running: "실행 중",
  completed: "완료",
  failed: "실패",
  waiting: "대기",
};

function money(value: number): string {
  return value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(3)}`;
}

function tokens(value: number): string {
  return value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
}

/** omp's subagents in this chat: running, done and parked ones, with what each reports of its work. */
export function SubagentsPanel({ subagents, onClose }: { subagents: readonly SubagentSnapshot[]; onClose: () => void }) {
  const order: SubagentSnapshot["status"][] = ["running", "waiting", "completed", "failed"];
  const sorted = [...subagents].sort((left, right) => order.indexOf(left.status) - order.indexOf(right.status));
  return (
    <aside className="subagents-panel" aria-label={t("서브에이전트")}>
      <header>
        <strong>{t("서브에이전트")}</strong>
        <small>{subagents.length}</small>
        <button type="button" className="icon-button" aria-label={t("닫기")} onClick={onClose}>
          <X size={14} />
        </button>
      </header>
      {sorted.length === 0 ? (
        <p className="subagents-empty">{t("이 대화에서 실행된 서브에이전트가 없습니다")}</p>
      ) : (
        <ul>
          {sorted.map((agent) => {
            const meta = [
              agent.model,
              agent.costUsd !== undefined ? money(agent.costUsd) : undefined,
              agent.elapsedMs !== undefined ? elapsedLabel(agent.elapsedMs) : undefined,
              agent.toolCount !== undefined ? t`도구 ${agent.toolCount}` : undefined,
              agent.contextTokens !== undefined
                ? agent.contextWindow
                  ? t`컨텍스트 ${Math.round((agent.contextTokens / agent.contextWindow) * 100)}%`
                  : t`토큰 ${tokens(agent.contextTokens)}`
                : undefined,
            ].filter(Boolean);
            return (
              <li key={agent.id} className={`subagent-row subagent-row--${agent.status}`}>
                <span className="subagent-row-head">
                  <strong>{agent.label}</strong>
                  <span className={`subagent-status subagent-status--${agent.status}`}>{t(SUBAGENT_STATUS[agent.status])}</span>
                </span>
                {agent.objective && <p className="subagent-objective">{agent.objective}</p>}
                {meta.length > 0 && <small className="subagent-meta">{meta.join(" · ")}</small>}
                {agent.recent && <small className="subagent-recent">{agent.recent}</small>}
                {agent.sessionFile && (
                  <code className="subagent-file" title={t("서브에이전트 기록 파일")}>
                    {agent.sessionFile}
                  </code>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
