import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Check, ExternalLink, LogIn, LogOut } from "lucide-react";
import type {
  OmpAccountsDesktopBridge,
  OmpLoginEvent,
  OmpLoginProvider,
  OmpLogoutAccount,
} from "../../shared/omp-accounts";
import { t } from "../i18n";

function errorText(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, "");
}

type Question = Extract<OmpLoginEvent, { kind: "input" | "confirm" | "select" }>;

interface LoginState {
  providerId: string;
  url?: string;
  instructions?: string;
  progress: { message: string; tone: "info" | "warning" | "error" }[];
  questions: Question[];
}

/** What a running login shows: the browser link, its instructions and progress, and what it asks. */
function LoginPanel({
  bridge,
  login,
  onCancel,
}: {
  bridge: OmpAccountsDesktopBridge;
  login: LoginState;
  onCancel: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const submit = (event: FormEvent, question: Question) => {
    event.preventDefault();
    void bridge.respond(question.requestId, drafts[question.requestId] ?? "");
  };
  return (
    <div className="omp-login" role="status">
      <strong>{t("브라우저에서 로그인을 마치세요")}</strong>
      {login.instructions && <p className="omp-login-instructions">{login.instructions}</p>}
      {login.url && (
        <a className="omp-login-link" href={login.url} target="_blank" rel="noreferrer">
          <ExternalLink size={12} aria-hidden="true" />
          {t("로그인 페이지 다시 열기")}
        </a>
      )}
      {login.progress.slice(-3).map((entry, index) => (
        <small key={index} className={`omp-login-progress omp-login-progress--${entry.tone}`}>
          {entry.message}
        </small>
      ))}
      {login.questions.map((question) =>
        question.kind === "input" ? (
          <form key={question.requestId} className="omp-login-question" onSubmit={(event) => submit(event, question)}>
            <label>
              <span>{question.title}</span>
              <input
                autoFocus
                value={drafts[question.requestId] ?? ""}
                placeholder={question.placeholder}
                onChange={(event) => setDrafts((current) => ({ ...current, [question.requestId]: event.target.value }))}
              />
            </label>
            <button type="submit">{t("보내기")}</button>
          </form>
        ) : question.kind === "confirm" ? (
          <div key={question.requestId} className="omp-login-question">
            <span>
              {question.title}
              {question.message && <small>{question.message}</small>}
            </span>
            <button type="button" onClick={() => void bridge.respond(question.requestId, true)}>
              {t("예")}
            </button>
            <button type="button" onClick={() => void bridge.respond(question.requestId, false)}>
              {t("아니요")}
            </button>
          </div>
        ) : (
          <div key={question.requestId} className="omp-login-question">
            <span>{question.title}</span>
            {question.options.map((option) => (
              <button key={option} type="button" onClick={() => void bridge.respond(question.requestId, option)}>
                {option}
              </button>
            ))}
          </div>
        ),
      )}
      <button type="button" className="omp-login-cancel" onClick={onCancel}>
        {t("로그인 취소")}
      </button>
    </div>
  );
}

/**
 * omp's sign-in in the agents settings: the providers omp can sign in to, which it
 * holds a credential for, a login (OAuth in the browser, a pasted code when omp asks)
 * and a logout the host confirms. No token reaches the window.
 */
export function OmpAccountsSection({ bridge }: { bridge: OmpAccountsDesktopBridge }) {
  const [providers, setProviders] = useState<OmpLoginProvider[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [login, setLogin] = useState<LoginState | null>(null);
  const [accounts, setAccounts] = useState<{ providerId: string; list: OmpLogoutAccount[] } | null>(null);
  const [others, setOthers] = useState(false);
  const [query, setQuery] = useState("");

  const reload = useCallback(() => {
    bridge.listProviders().then(
      (list) => {
        setProviders(list);
        setError("");
      },
      (cause: unknown) => setError(errorText(cause)),
    );
  }, [bridge]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(
    () =>
      bridge.onLoginEvent((event) => {
        setLogin((current) => {
          if (!current) return current;
          switch (event.kind) {
            case "open_url":
              return { ...current, url: event.url, ...(event.instructions ? { instructions: event.instructions } : {}) };
            case "progress":
              return { ...current, progress: [...current.progress, { message: event.message, tone: event.tone }] };
            case "closed":
              return { ...current, questions: current.questions.filter((question) => question.requestId !== event.requestId) };
            default:
              return { ...current, questions: [...current.questions.filter((question) => question.requestId !== event.requestId), event] };
          }
        });
      }),
    [bridge],
  );

  async function startLogin(provider: OmpLoginProvider): Promise<void> {
    setError("");
    setNotice("");
    setAccounts(null);
    setLogin({ providerId: provider.id, progress: [], questions: [] });
    try {
      const outcome = await bridge.login(provider.id);
      if (outcome.status === "done") setNotice(t`${provider.name}에 로그인했습니다`);
      else if (outcome.status === "failed") setError(outcome.error);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLogin(null);
      reload();
    }
  }

  async function showAccounts(provider: OmpLoginProvider): Promise<void> {
    setError("");
    setNotice("");
    try {
      setAccounts({ providerId: provider.id, list: await bridge.listAccounts(provider.id) });
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function logout(account: OmpLogoutAccount): Promise<void> {
    setError("");
    try {
      await bridge.logout(account.provider, account.credentialId);
      setNotice(t("로그아웃했습니다"));
      setAccounts(null);
      reload();
    } catch (cause) {
      const message = errorText(cause);
      if (message !== "Operation cancelled") setError(message);
    }
  }

  return (
    <div className="omp-accounts">
      <span className="omp-accounts-head">
        <strong>{t("omp 로그인")}</strong>
        <small>{t("omp가 쓰는 구독 계정입니다. 자격 증명은 omp가 보관하고 이 앱에는 오지 않습니다.")}</small>
      </span>
      {providers === null && !error && <small>{t("확인 중…")}</small>}
      {providers && (
        <ul className="omp-accounts-list">
          {providers
            .filter((provider) => {
              // omp knows ~100 providers: the signed-in ones, and the rest on request
              if (provider.authenticated || login?.providerId === provider.id) return true;
              if (!others) return false;
              const needle = query.trim().toLowerCase();
              return !needle || provider.name.toLowerCase().includes(needle) || provider.id.toLowerCase().includes(needle);
            })
            .map((provider) => (
            <li key={provider.id} className={provider.available ? undefined : "is-unavailable"}>
              <span className="omp-accounts-name">
                {provider.name}
                {provider.authenticated && (
                  <span className="ready-badge ready-badge--connected">
                    <Check size={11} /> {t("로그인됨")}
                  </span>
                )}
              </span>
              <span className="omp-accounts-actions">
                {provider.authenticated && (
                  <button type="button" disabled={login !== null} onClick={() => void showAccounts(provider)}>
                    <LogOut size={12} aria-hidden="true" /> {t("로그아웃")}
                  </button>
                )}
                <button
                  type="button"
                  disabled={login !== null || !provider.available}
                  title={provider.available ? undefined : t("이 Mac에서는 omp가 이 제공자에 로그인할 수 없습니다")}
                  onClick={() => void startLogin(provider)}
                >
                  <LogIn size={12} aria-hidden="true" /> {provider.authenticated ? t("다시 로그인") : t("로그인")}
                </button>
              </span>
              {login?.providerId === provider.id && (
                <LoginPanel bridge={bridge} login={login} onCancel={() => void bridge.cancelLogin()} />
              )}
              {accounts?.providerId === provider.id && (
                <div className="omp-accounts-credentials">
                  {accounts.list.length === 0 ? (
                    <small>{t("omp가 저장한 자격 증명이 없습니다 (환경 변수 등 다른 곳에서 온 것일 수 있습니다)")}</small>
                  ) : (
                    accounts.list.map((account) => (
                      <span key={account.credentialId} className="omp-accounts-credential">
                        <span>
                          {account.label || account.provider}
                          <small>
                            {[account.type === "oauth" ? "OAuth" : t("API 키"), account.detail, account.active ? t("사용 중") : ""]
                              .filter(Boolean)
                              .join(" · ")}
                          </small>
                        </span>
                        <button type="button" className="is-danger" onClick={() => void logout(account)}>
                          {t("로그아웃")}
                        </button>
                      </span>
                    ))
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {providers && (
        <span className="omp-accounts-more">
          <button type="button" aria-expanded={others} onClick={() => setOthers((open) => !open)}>
            {others
              ? t("다른 제공자 숨기기")
              : t`다른 제공자에 로그인 (${providers.filter((provider) => !provider.authenticated).length})`}
          </button>
          {others && (
            <input
              value={query}
              placeholder={t("제공자 찾기")}
              aria-label={t("제공자 찾기")}
              onChange={(event) => setQuery(event.target.value)}
            />
          )}
        </span>
      )}
      {notice && <small className="omp-accounts-notice">{notice}</small>}
      {error && (
        <small className="composer-error" role="alert">
          {error}
        </small>
      )}
    </div>
  );
}
