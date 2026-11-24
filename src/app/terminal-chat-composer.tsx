import { ArrowUp, CircleStop, SquareTerminal } from "lucide-react";
import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { MessageDelivery, SessionCapabilities } from "../../shared/agent-contract";
import type { AgentSession } from "../backend/types";
import { t } from "../i18n";
import { humanErrorMessage } from "./format";

export interface TerminalChatComposerProps {
  session: AgentSession;
  capabilities: SessionCapabilities;
  /** The agent's name ("Claude Code"), for the hints. */
  agentName: string;
  onSend: (text: string) => Promise<MessageDelivery>;
  onCancel: () => Promise<void>;
  onOpenTerminal: () => void;
}

/**
 * The composer of a terminal agent's chat (design §5.5). What is typed goes into the agent's
 * terminal through herdr-core, so it is text only, and nothing waits in a queue here: the agent
 * takes a message sent while it works the way it takes one typed then. GJC's own controls (model,
 * goals, compaction, side questions, suggestions, attachments) are not offered. Nothing is shown
 * in the conversation until the agent writes the message to its transcript.
 */
export function TerminalChatComposer({ session, capabilities, agentName, onSend, onCancel, onOpenTerminal }: TerminalChatComposerProps) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const composingRef = useRef(false);
  const running = session.status === "running";
  const waiting = session.status === "waiting";
  const draft = value.trim();

  async function submit(): Promise<void> {
    if (!draft || sending || !capabilities.send) return;
    setSending(true);
    setError("");
    try {
      const delivery = await onSend(draft);
      if (typeof delivery === "object" && delivery.kind === "not_executed")
        setError(t`터미널에서 응답을 기다리고 있어 보내지 않았습니다: ${delivery.detail}`);
      else setValue("");
    } catch (cause) {
      setError(humanErrorMessage(cause));
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== "Enter" || event.shiftKey) return;
    // an Enter that commits an IME composition is not a send
    if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    void submit();
  }

  function cancel(): void {
    void onCancel().catch((cause: unknown) => setError(humanErrorMessage(cause)));
  }

  const openTerminal = (
    <button type="button" className="composer-terminal-link" onClick={onOpenTerminal}>
      <SquareTerminal size={11} aria-hidden="true" />
      {t("터미널 열기")}
    </button>
  );

  return (
    <form
      className="composer composer--terminal-agent"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {!capabilities.send ? (
        <small className="composer-hint">
          {t`${agentName}에 지금은 채팅으로 보낼 수 없습니다. 터미널에서 입력하세요.`} {openTerminal}
        </small>
      ) : waiting ? (
        <small className="composer-hint">
          {t`${agentName}이(가) 터미널에서 응답을 기다리고 있습니다.`} {openTerminal}
        </small>
      ) : null}
      {error && <small className="composer-error">{error}</small>}
      <div className="composer-field">
        <textarea
          aria-label={t`${session.title}에게 메시지 보내기`}
          placeholder={t`${agentName}에게 보낼 메시지 (터미널로 입력됩니다)`}
          rows={1}
          value={value}
          disabled={!capabilities.send}
          onChange={(event) => setValue(event.target.value)}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          onKeyDown={handleKeyDown}
        />
      </div>
      <div className="composer-toolbar">
        <div />
        <div className="composer-submit-actions">
          {draft || !running || !capabilities.cancel ? (
            <button
              className="send-button"
              type="submit"
              disabled={!draft || sending || !capabilities.send}
              aria-busy={sending}
              title={sending ? t("보내는 중…") : t("메시지 보내기")}
            >
              <ArrowUp size={18} />
            </button>
          ) : (
            <button className="send-button send-button--stop" type="button" onClick={cancel} title={t("작업 중단")}>
              <CircleStop size={18} />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
