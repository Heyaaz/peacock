import { FolderGit2, GitBranch, SquareTerminal } from "lucide-react";
import type { ReactNode } from "react";
import type { GitStatusSnapshot } from "../../shared/agent-contract";
import type { AgentSession } from "../backend/types";
import { t } from "../i18n";
import { TerminalView } from "./terminal-view";

/**
 * A terminal session in place of a conversation: its title, folder, and terminal. A session that
 * offers the folder's git panel has its branch in the header and a button that opens the changed
 * files beside the terminal (`panel`, shown while `diffOpen`): the terminal keeps its place and only
 * gets narrower, and it is refitted by the same observer that follows the window.
 */
export function TerminalSessionPane({
  session,
  git = null,
  changedFiles = false,
  diffOpen = false,
  onToggleDiff,
  panel,
}: {
  session: AgentSession;
  /** The folder's git status, when the session offers it. */
  git?: GitStatusSnapshot | null;
  /** Whether the session offers the changed-files panel at all. */
  changedFiles?: boolean;
  diffOpen?: boolean;
  onToggleDiff?: () => void;
  panel?: ReactNode;
}) {
  const branch = git?.branch || session.worktree?.branch;
  const showPanel = changedFiles && diffOpen;
  return (
    <main className="workspace" data-surface="terminal">
      <header className="chat-header">
        <div className="chat-identity">
          <span className="header-avatar header-avatar--terminal">
            <SquareTerminal size={18} aria-hidden="true" />
          </span>
          <span>
            <strong>{session.title}</strong>
            <small>
              {t("CLI")}
              <span className="chat-branch" title={session.workspace}>
                {session.subtitle}
              </span>
              {branch && (
                <span className="chat-branch" title={t`${git?.workspace ?? session.workspace}의 현재 Git 브랜치`}>
                  <GitBranch size={11} />
                  {branch}
                </span>
              )}
            </small>
          </span>
        </div>
        {changedFiles && onToggleDiff && (
          <div className="chat-header__actions">
            <button
              className={`icon-button ${diffOpen ? "is-active" : ""}`}
              type="button"
              title={t("변경 파일 보기")}
              aria-label={t("변경 파일 보기")}
              aria-pressed={diffOpen}
              onClick={onToggleDiff}
            >
              <FolderGit2 size={18} />
            </button>
          </div>
        )}
      </header>
      <div className="workspace-body">
        <TerminalView
          key={session.id}
          session={session.id}
          cwd={session.workspace}
          active
          hidden={false}
        />
        {showPanel && panel}
      </div>
    </main>
  );
}
