import { useCallback, useEffect, useRef, useState } from "react";
import type { GitStatusSnapshot } from "../../shared/agent-contract";
import {
  PULL_REQUEST_BODY_LIMIT,
  PULL_REQUEST_TITLE_LIMIT,
  type PullRequestQuery,
  type PullRequestStatus,
} from "../../shared/pull-request";
import type { GithubPullSummary } from "../../shared/repo-ipc";
import type { AgentBackend } from "../backend/agent-backend";
import type { AgentSession } from "../backend/types";
import { t } from "../i18n";
import { humanErrorMessage, isDeclinedConfirmation } from "./format";
import { ciLabel, pullRequestFailureText } from "./github-labels";

/**
 * The last step of the diff panel's commit, push, pull request path.
 *
 * The host does the work and asks the person before it creates anything; this only looks up the
 * session branch's pull request, shows it (a link and its CI) when there is one, and otherwise offers
 * a title and description to open one with, starting from the latest commit. It reads GitHub when the
 * branch has an upstream, when a turn ends, and when asked: never on a timer.
 */

type Lookup =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; result: PullRequestQuery<PullRequestStatus> }
  | { status: "failed"; error: string };

/** A link only when GitHub gave an https address; anything else is shown as text. */
function PullLink({ pull }: { pull: GithubPullSummary }) {
  const label = `#${pull.number} ${pull.title}`.trim();
  return pull.url.startsWith("https://") ? (
    <a href={pull.url} target="_blank" rel="noreferrer noopener">
      {label}
    </a>
  ) : (
    <span>{label}</span>
  );
}

function Pull({ pull, onRefresh }: { pull: GithubPullSummary; onRefresh: () => void }) {
  return (
    <div className="pull-request__existing">
      <PullLink pull={pull} />
      <span className="pull-request__badges">
        {pull.draft && <span className="repo-badge">Draft</span>}
        <span className={`repo-badge repo-badge--${pull.ci.state}`}>{ciLabel(pull.ci)}</span>
        <button className="button-secondary" type="button" onClick={onRefresh}>
          {t("PR 상태 새로 고침")}
        </button>
      </span>
    </div>
  );
}

function PullRequestStep({
  session,
  backend,
  git,
  busy,
  refreshKey,
}: {
  session: AgentSession;
  backend: AgentBackend;
  git: GitStatusSnapshot | null;
  busy: boolean;
  refreshKey?: number;
}) {
  const sessionId = session.id;
  const branch = git?.branch ?? "";
  const hasUpstream = Boolean(git?.upstream);
  const [lookup, setLookup] = useState<Lookup>({ status: "idle" });
  const [again, setAgain] = useState(0);
  const [open, setOpen] = useState(false);
  // What the person typed; absent until they type, so the latest commit's wording follows the branch.
  const [typed, setTyped] = useState<{ title: string; body: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [problem, setProblem] = useState("");
  const request = useRef(0);

  const find = useCallback(
    () => backend.findPullRequest!(sessionId),
    [backend, sessionId],
  );

  useEffect(() => {
    const mine = ++request.current;
    if (!branch || !hasUpstream) {
      queueMicrotask(() => {
        if (request.current === mine) setLookup({ status: "idle" });
      });
      return () => {
        request.current += 1;
      };
    }
    queueMicrotask(() => {
      // a result already on screen stays while the next one is read
      if (request.current === mine) setLookup((current) => (current.status === "ready" ? current : { status: "loading" }));
    });
    void find().then(
      (result) => {
        if (request.current === mine) setLookup({ status: "ready", result });
      },
      (error: unknown) => {
        if (request.current === mine) setLookup({ status: "failed", error: humanErrorMessage(error) });
      },
    );
    return () => {
      request.current += 1;
    };
  }, [find, branch, hasUpstream, refreshKey, again]);

  if (!branch) return null;
  const title = <strong>Pull request</strong>;
  if (!hasUpstream)
    return (
      <section className="pull-request">
        {title}
        <p className="pull-request__hint">{t("Push하면 Pull request를 만들 수 있습니다.")}</p>
      </section>
    );
  if (lookup.status === "idle" || (lookup.status === "loading"))
    return (
      <section className="pull-request">
        {title}
        <p className="pull-request__hint">{t("Pull request 확인 중…")}</p>
      </section>
    );
  const retry = (
    <button className="button-secondary" type="button" onClick={() => setAgain((count) => count + 1)}>
      {t("다시 확인")}
    </button>
  );
  if (lookup.status === "failed")
    return (
      <section className="pull-request">
        {title}
        <p className="diff-error">{lookup.error}</p>
        {retry}
      </section>
    );
  const { result } = lookup;
  if (result.state !== "ok")
    return (
      <section className="pull-request">
        {title}
        <p className="pull-request__hint">{pullRequestFailureText(result)}</p>
        {result.state !== "default-branch" && result.state !== "no-branch" && retry}
      </section>
    );
  const { target, pull, pushed, draft } = result.value;
  if (pull)
    return (
      <section className="pull-request">
        {title}
        <Pull pull={pull} onRefresh={() => setAgain((count) => count + 1)} />
      </section>
    );
  const ready = pushed && (git?.ahead ?? 0) === 0;
  const values = typed ?? { title: draft.title, body: draft.body };
  const valid =
    values.title.trim().length > 0 &&
    values.title.length <= PULL_REQUEST_TITLE_LIMIT &&
    !/[\r\n]/u.test(values.title) &&
    values.body.length <= PULL_REQUEST_BODY_LIMIT;

  async function create(): Promise<void> {
    if (!valid || creating) return;
    setCreating(true);
    setProblem("");
    try {
      const created = await backend.createPullRequest!(sessionId, values);
      if (created.state === "ok") {
        setLookup({
          status: "ready",
          result: { state: "ok", value: { target, pull: created.value, pushed, draft } },
        });
        setOpen(false);
        setTyped(null);
      } else setProblem(pullRequestFailureText(created));
    } catch (error) {
      // declining the host's question is an answer, not a failure to report
      if (!isDeclinedConfirmation(error)) setProblem(humanErrorMessage(error));
    } finally {
      setCreating(false);
    }
  }

  return (
    <section className="pull-request">
      {title}
      <p className="pull-request__hint">
        {t("{repo}의 {base} 브랜치로 보냅니다", { repo: target.repo, base: target.base })}
        {target.fork && ` ${t("(포크의 상위 저장소)")}`}
      </p>
      {!ready && <p className="pull-request__hint">{t("Push하지 않은 커밋이 있습니다. 먼저 Push하세요.")}</p>}
      {!open ? (
        <div>
          <button className="button-primary" type="button" disabled={busy || !ready} onClick={() => setOpen(true)}>
            {t("PR 만들기")}
          </button>
        </div>
      ) : (
        <form
          className="pull-request__form"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <input
            aria-label={t("PR 제목")}
            placeholder={t("PR 제목")}
            value={values.title}
            maxLength={PULL_REQUEST_TITLE_LIMIT}
            onChange={(event) => setTyped({ ...values, title: event.target.value })}
          />
          <textarea
            aria-label={t("PR 본문")}
            placeholder={t("PR 본문 (선택)")}
            value={values.body}
            maxLength={PULL_REQUEST_BODY_LIMIT}
            rows={6}
            onChange={(event) => setTyped({ ...values, body: event.target.value })}
          />
          {problem && (
            <p className="diff-error" role="alert">
              {problem}
            </p>
          )}
          <div>
            <button className="button-secondary" type="button" disabled={creating} onClick={() => setOpen(false)}>
              {t("취소")}
            </button>
            <button className="button-primary" type="submit" disabled={busy || creating || !ready || !valid}>
              {creating ? t("만드는 중…") : t("PR 만들기")}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

/**
 * The pull request step, when the backend can open pull requests and the session works in a worktree this
 * app made. It is keyed by the session so nothing typed or read for one session can reach another.
 */
export function PullRequestSection(props: {
  session: AgentSession;
  backend: AgentBackend;
  git: GitStatusSnapshot | null;
  busy: boolean;
  refreshKey?: number;
}) {
  if (!props.backend.findPullRequest || !props.backend.createPullRequest) return null;
  return <PullRequestStep key={props.session.id} {...props} />;
}
