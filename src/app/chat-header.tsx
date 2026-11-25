import { Bot, FolderGit2, GitBranch, Layers, MessageCircleQuestion, PanelRight, SquareTerminal, Users } from "lucide-react";
import type { GitStatusSnapshot } from "../../shared/agent-contract";
import type { AgentSession, ToolViewMode } from "../backend/types";
import gajaeIconUrl from "../assets/gajae-icon-ui.png";
import { t } from "../i18n";
import { statusLabel } from "./format";
import { Dropdown } from "./primitives";

interface ChatHeaderProps {
  selectedSession: AgentSession;
  selectedGit: GitStatusSnapshot | null;
  surface: "chat" | "terminal";
  setSurface: (surface: "chat" | "terminal") => void;
  setTerminalMounted: (mounted: boolean) => void;
  toolViewMode: ToolViewMode;
  changeToolViewMode: (mode: ToolViewMode) => void;
  diffOpen: boolean;
  setDiffOpen: (update: (open: boolean) => boolean) => void;
  inspectorOpen: boolean;
  setInspectorOpen: (update: (open: boolean) => boolean) => void;
  /** Absent when the backend cannot answer side questions. */
  sideOpen?: boolean;
  setSideOpen?: (update: (open: boolean) => boolean) => void;
  /**
   * A terminal agent's chat (Claude Code, omp): the agent's terminal is the session's own, and
   * GJC's changed-files and session-info panels have nothing to read for it.
   */
  terminalAgent?: boolean;
  /** The mark of such an agent: a terminal agent's terminal, or the bot of a chat the app drives (omp's RPC chat). */
  agentIcon?: "terminal" | "chat";
  /** Absent where the session has one screen only (a phone shows a terminal agent's chat). */
  surfaceToggle?: boolean;
  /** The subagents panel of a chat that lists them (omp's); absent elsewhere. */
  subagentsOpen?: boolean;
  setSubagentsOpen?: (update: (open: boolean) => boolean) => void;
}

export function ChatHeader({
  selectedSession,
  selectedGit,
  surface,
  setSurface,
  setTerminalMounted,
  toolViewMode,
  changeToolViewMode,
  diffOpen,
  setDiffOpen,
  inspectorOpen,
  setInspectorOpen,
  sideOpen = false,
  setSideOpen,
  terminalAgent = false,
  agentIcon = "terminal",
  surfaceToggle = true,
  subagentsOpen = false,
  setSubagentsOpen,
}: ChatHeaderProps) {
  return (
  <header className="chat-header">
    <div className="chat-identity">
      {terminalAgent ? (
        <span className="header-avatar header-avatar--terminal">
          {agentIcon === "chat" ? <Bot size={18} aria-hidden="true" /> : <SquareTerminal size={18} aria-hidden="true" />}
        </span>
      ) : (
        <span className="header-avatar">
          <img src={gajaeIconUrl} alt="" />
        </span>
      )}
      <span>
        <strong>{selectedSession.title}</strong>
        <small>
          <span
            className={`presence-inline presence-inline--${selectedSession.phase === "compacting" ? "compacting" : selectedSession.status}`}
          />
          {statusLabel(selectedSession.status, selectedSession.phase)}
          {selectedSession.attachment === "terminal-only" && (
            <span className="chat-sync">{t("제어 연결 없음 · 기록 동기화 중")}</span>
          )}
          {selectedSession.attachment === "recovering" && (
            <span
              className="chat-sync"
              title={t("삭제·재연결 결과를 확인하지 못해 기록을 보존했습니다. 이 세션은 다시 이어서 진행해야 보낼 수 있습니다.")}
            >
              {t("복구 필요 · 읽기 전용")} </span>
          )}
          {terminalAgent && (
            <span className="chat-branch" title={selectedSession.workspace}>
              {selectedSession.subtitle}
            </span>
          )}
          {(selectedGit?.branch ||
            selectedSession.worktree?.branch) && (
            <span
              className="chat-branch"
              title={t`${selectedGit?.workspace ?? selectedSession.workspace}의 현재 Git 브랜치`}
            >
              <GitBranch size={11} />
              {selectedGit?.branch || selectedSession.worktree?.branch}
            </span>
          )}
        </small>
      </span>
    </div>
    <div className="chat-header__actions">
      {surfaceToggle && (
      <div className="surface-mode-toggle" role="group" aria-label={t("채팅과 터미널")}>
        <button
          type="button"
          className={surface === "chat" ? "is-active" : ""}
          aria-pressed={surface === "chat"}
          onClick={() => setSurface("chat")}
        >
          {t("채팅")}
        </button>
        <button
          type="button"
          className={surface === "terminal" ? "is-active" : ""}
          aria-pressed={surface === "terminal"}
          data-terminal-toggle
          onClick={() => {
            if (!terminalAgent) setTerminalMounted(true);
            setSurface("terminal");
          }}
        >
          {t("터미널")}
        </button>
      </div>
      )}
      <div className="tool-view-mode-toggle">
        <Dropdown ariaLabel={t("대화 표시 방식")} icon={<Layers size={15} aria-hidden="true" />} value={toolViewMode} onChange={changeToolViewMode}
          options={[
            { value: "basic", label: t("요약"), description: t("도구 요약") },
            { value: "reasoning", label: t("기본"), description: t("도구 카드") },
            { value: "detailed", label: t("상세"), description: t("추론까지 펼침") },
          ]} />
      </div>
      {setSubagentsOpen && (
        <button
          className={`icon-button ${subagentsOpen ? "is-active" : ""}`}
          type="button"
          title={t("서브에이전트")}
          aria-pressed={subagentsOpen}
          onClick={() => setSubagentsOpen((open) => !open)}
        >
          <Users size={18} />
        </button>
      )}
      {setSideOpen && (
        <button
          className={`icon-button ${sideOpen ? "is-active" : ""}`}
          type="button"
          title={t("사이드 채팅 (⌘⇧B)")}
          aria-pressed={sideOpen}
          onClick={() => setSideOpen((open) => !open)}
        >
          <MessageCircleQuestion size={18} />
        </button>
      )}
      {!terminalAgent && (
        <button
          className={`icon-button ${diffOpen ? "is-active" : ""}`}
          type="button"
          title={t("변경 파일 보기")}
          onClick={() => setDiffOpen((open) => !open)}
        >
          <FolderGit2 size={18} />
        </button>
      )}
      {!terminalAgent && (
        <button
          className={`icon-button ${inspectorOpen ? "is-active" : ""}`}
          type="button"
          data-session-info
          title={t("세션 정보")}
          onClick={() => setInspectorOpen((open) => !open)}
        >
          <PanelRight size={18} />
        </button>
      )}
    </div>
  </header>
  );
}
