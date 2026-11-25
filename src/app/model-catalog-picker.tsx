import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import type { AgentConfigOption, AgentConfigOptionValue } from "../../shared/agent-contract";
import { t } from "../i18n";

/** Rows a search shows past the recent block; the catalog can hold a thousand models. */
const ROW_LIMIT = 300;

type Column = "intelligence" | "speed" | "context" | "price";

const COLUMN_LABELS: Record<Column, { label: string; title: string }> = {
  intelligence: { label: "Int", title: "지능 점수" },
  speed: { label: "t/s", title: "초당 출력 토큰" },
  context: { label: "Ctx", title: "컨텍스트 창" },
  price: { label: "$/M", title: "100만 토큰당 입력·출력 가격" },
};

/** The CSS color a role's dot takes: omp's role colors as Gajae's theme names them. */
const ROLE_TONES: Readonly<Record<string, string>> = {
  default: "success",
  smol: "warning",
  slow: "accent",
  advisor: "info",
  vision: "danger",
};

function tokens(value: number): string {
  if (value >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

function trim(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(value < 10 ? 2 : 1).replace(/\.?0+$/u, "");
}

function free(choice: AgentConfigOptionValue): boolean {
  const cost = choice.catalog?.cost;
  return cost !== undefined && cost.input === 0 && cost.output === 0;
}

function price(choice: AgentConfigOptionValue): string {
  const cost = choice.catalog?.cost;
  if (!cost) return "";
  if (free(choice)) return t("무료");
  return `$${trim(cost.input)}·${trim(cost.output)}`;
}

/** The model's id without its provider, as the row names it. */
function rowName(choice: AgentConfigOptionValue): string {
  const provider = choice.catalog?.provider;
  return provider && choice.value.startsWith(`${provider}/`) ? choice.value.slice(provider.length + 1) : choice.value;
}

/** Two letters standing for the provider, the row's small mark. */
function monogram(provider: string): string {
  const letters = provider.replace(/[^A-Za-z0-9]/gu, "");
  return (letters.slice(0, 2) || "?").toUpperCase();
}

function matchesQuery(choice: AgentConfigOptionValue, needle: string): boolean {
  if (!needle) return true;
  const haystack = `${choice.value} ${choice.name} ${choice.catalog?.roles?.map((role) => role.label).join(" ") ?? ""}`.toLowerCase();
  return needle.split(/\s+/u).every((part) => haystack.includes(part));
}

/**
 * A model catalog picker (omp's chat): search, the scope a choice is for, the agent's recent
 * models first, then every model, each row with its provider, role tags and what the catalog knows
 * of it (score, speed, context window, price). ↑/↓ move, Enter chooses, Esc closes. Columns
 * nothing in the catalog fills are left out.
 */
export function ModelCatalogPicker({
  option,
  onSelect,
  onClose,
}: {
  option: AgentConfigOption;
  onSelect(value: string): void;
  onClose(): void;
}) {
  const all = useMemo(() => option.options ?? [], [option.options]);
  const scopes = option.scopes ?? [];
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState(() => scopes.find((entry) => entry.enabled)?.id ?? "");
  const [scopeOpen, setScopeOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const needle = query.trim().toLowerCase();

  const { recent, rest, matched } = useMemo(() => {
    const found = all.filter((choice) => matchesQuery(choice, needle));
    return {
      recent: found.filter((choice) => choice.catalog?.recent),
      rest: found.filter((choice) => !choice.catalog?.recent).slice(0, ROW_LIMIT),
      matched: found.length,
    };
  }, [all, needle]);
  const rows = useMemo(() => [...recent, ...rest], [recent, rest]);
  const columns = useMemo(
    () =>
      (Object.keys(COLUMN_LABELS) as Column[]).filter((column) =>
        all.some((choice) => {
          const facts = choice.catalog;
          if (column === "intelligence") return facts?.intelligence !== undefined;
          if (column === "speed") return facts?.tokensPerSecond !== undefined;
          if (column === "context") return facts?.contextWindow !== undefined;
          return facts?.cost !== undefined;
        }),
      ),
    [all],
  );

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (choice: AgentConfigOptionValue | undefined): void => {
    if (!choice) return;
    onSelect(choice.value);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (scopeOpen) setScopeOpen(false);
      else onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => Math.min(rows.length - 1, current + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => Math.max(0, current - 1));
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      choose(rows[active]);
    }
  };

  const currentScope = scopes.find((entry) => entry.id === scope);
  const current = all.find((choice) => choice.value === option.currentValue);
  const gridColumns = `minmax(0, 1fr) ${columns.map((column) => (column === "price" ? "64px" : "46px")).join(" ")} 18px`;
  const row = (choice: AgentConfigOptionValue, index: number) => {
    const isCurrent = choice.value === option.currentValue;
    const facts = choice.catalog;
    return (
      <button
        key={choice.value}
        type="button"
        role="option"
        aria-selected={isCurrent}
        data-row={index}
        className={`model-catalog-row${index === active ? " is-active" : ""}${isCurrent ? " is-current" : ""}`}
        style={{ gridTemplateColumns: gridColumns }}
        onMouseEnter={() => setActive(index)}
        onClick={() => choose(choice)}
      >
        <span className="model-catalog-name">
          <span className="model-catalog-provider" title={facts?.provider}>
            {monogram(facts?.provider ?? choice.group ?? "")}
          </span>
          <span className="model-catalog-id" title={choice.value}>
            {rowName(choice)}
          </span>
          {free(choice) && <span className="model-catalog-pill model-catalog-pill--free">{t("무료")}</span>}
          {facts?.roles?.map((role) => (
            <span key={role.role} className={`model-catalog-pill model-catalog-pill--role model-catalog-tone--${ROLE_TONES[role.role] ?? "muted"}`}>
              <i aria-hidden="true" />
              {role.label.toLowerCase()}
            </span>
          ))}
        </span>
        {columns.map((column) => (
          <span key={column} className="model-catalog-num">
            {column === "intelligence" && facts?.intelligence !== undefined ? Math.round(facts.intelligence) : null}
            {column === "speed" && facts?.tokensPerSecond !== undefined ? Math.round(facts.tokensPerSecond) : null}
            {column === "context" && facts?.contextWindow !== undefined ? tokens(facts.contextWindow) : null}
            {column === "price" ? price(choice) : null}
          </span>
        ))}
        <span className="model-catalog-check">{isCurrent && <Check size={13} aria-label={t("사용 중")} />}</span>
      </button>
    );
  };

  return (
    <div className="model-catalog-picker" role="dialog" aria-label={t("모델 고르기")} onKeyDown={onKeyDown}>
      <header className="model-catalog-bar">
        <label className="model-catalog-search">
          <Search size={13} aria-hidden="true" />
          <input
            type="search"
            autoFocus
            value={query}
            placeholder={t("모델 이름, provider, 역할로 찾기")}
            aria-label={t("모델 찾기")}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
          />
        </label>
        {scopes.length > 0 && (
          <span className="model-catalog-scope">
            <button type="button" aria-haspopup="listbox" aria-expanded={scopeOpen} onClick={() => setScopeOpen((open) => !open)}>
              {t("범위")} <strong>{currentScope?.name ?? scope}</strong>
              <ChevronDown size={12} aria-hidden="true" />
            </button>
            {scopeOpen && (
              <span className="model-catalog-scope-menu" role="listbox" aria-label={t("범위")}>
                {scopes.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    role="option"
                    aria-selected={entry.id === scope}
                    disabled={!entry.enabled}
                    title={entry.enabled ? undefined : t("RPC에서는 이 세션의 메인 모델만 바꿀 수 있습니다")}
                    onClick={() => {
                      setScope(entry.id);
                      setScopeOpen(false);
                    }}
                  >
                    <span>{entry.name}</span>
                    {entry.current && <small>{entry.current}</small>}
                    {entry.id === scope && <Check size={12} aria-hidden="true" />}
                  </button>
                ))}
              </span>
            )}
          </span>
        )}
        <span className="model-catalog-count">{t`${matched} / ${all.length}`}</span>
        <kbd>esc</kbd>
      </header>
      <div className="model-catalog-head" style={{ gridTemplateColumns: gridColumns }} aria-hidden="true">
        <span />
        {columns.map((column) => (
          <span key={column} title={t(COLUMN_LABELS[column].title)}>
            {COLUMN_LABELS[column].label}
          </span>
        ))}
        <span />
      </div>
      <div className="model-catalog-list" role="listbox" aria-label={t("모델")} ref={listRef}>
        {recent.length > 0 && (
          <div className="model-catalog-section">
            {t("최근")} <small>{recent.length}</small>
          </div>
        )}
        {recent.map((choice, index) => row(choice, index))}
        {rest.length > 0 && (
          <div className="model-catalog-section">
            {needle ? t("검색 결과") : t("모든 모델")} <small>{matched - recent.length}</small>
          </div>
        )}
        {rest.map((choice, index) => row(choice, recent.length + index))}
        {rows.length === 0 && <p className="model-catalog-empty">{t("맞는 모델이 없습니다")}</p>}
      </div>
      <footer className="model-catalog-foot">
        <span>
          {t("범위")}: {currentScope?.name ?? t("메인")}
        </span>
        {current && (
          <span className="model-catalog-foot-current" title={current.value}>
            {t("사용 중")}: {current.name}
          </span>
        )}
        <span className="model-catalog-keys">↑↓ Enter</span>
      </footer>
    </div>
  );
}
