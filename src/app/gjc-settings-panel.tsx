import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import type { SettingsDesktopBridge } from "../../shared/agent-contract";
import type {
  GjcSetting,
  GjcSettingValue,
} from "../../shared/gjc-settings";
import { t, useLanguage, type ResolvedLanguage } from "../i18n";
import { GJC_SETTING_GROUP_TEXT, GJC_SETTING_TEXT } from "./gjc-settings-text";
import { SettingsSection } from "./settings-layout";

type Bridge = Pick<SettingsDesktopBridge, "listGjcSettings" | "applyGjcSettings">;

type ShownSetting = GjcSetting & { label?: string; group: string };

/**
 * The name, description and group a setting shows in the current language. A
 * key the translation table does not know yet keeps GJC's own English text.
 */
function shown(setting: GjcSetting, language: ResolvedLanguage): ShownSetting {
  const text = GJC_SETTING_TEXT[setting.key];
  const root = setting.key.split(".")[0]!;
  const label = language === "ko" ? text?.ko : text?.en;
  const description =
    language === "ko"
      ? (text?.description ?? setting.description)
      : setting.description;
  return {
    ...setting,
    ...(label ? { label } : {}),
    ...(description ? { description } : { description: undefined }),
    group: GJC_SETTING_GROUP_TEXT[root]?.[language] ?? root,
  };
}

function groupBy(settings: ShownSetting[]): Array<[string, ShownSetting[]]> {
  const groups = new Map<string, ShownSetting[]>();
  for (const setting of settings)
    groups.set(setting.group, [...(groups.get(setting.group) ?? []), setting]);
  return [...groups];
}

/** Keeps the typed text, so a field can be cleared and retyped; only numbers are staged. */
function NumberField({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: number | null;
  disabled: boolean;
  onChange(value: number): void;
}) {
  const [text, setText] = useState(value === null ? "" : String(value));
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setText(value === null ? "" : String(value));
  }
  return (
    <input
      type="number"
      aria-label={label}
      value={text}
      placeholder={t("기본값")}
      disabled={disabled}
      onChange={(event) => {
        setText(event.target.value);
        const next = event.target.valueAsNumber;
        if (Number.isFinite(next)) onChange(next);
      }}
    />
  );
}

/**
 * GJC's own boolean and number settings, written with `gjc config set`.
 *
 * Edits are staged and applied as one batch because every write changes GJC for
 * the terminal too, and the host confirms that once per batch.
 */
export function GjcSettingsPanel({ bridge }: { bridge: Bridge | undefined }) {
  const [settings, setSettings] = useState<GjcSetting[] | null>(null);
  const [draft, setDraft] = useState<ReadonlyMap<string, GjcSettingValue>>(
    new Map(),
  );
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [applying, setApplying] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    bridge.listGjcSettings().then(
      (next) => {
        if (!active) return;
        setSettings(next);
        setError("");
      },
      (cause: unknown) => {
        if (active)
          setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [bridge, attempt]);

  const language = useLanguage();
  const needle = query.trim().toLowerCase();
  const groups = groupBy(
    (settings ?? [])
      .map((setting) => shown(setting, language))
      .filter((setting) => {
        if (!needle) return true;
        const text = GJC_SETTING_TEXT[setting.key];
        return [setting.key, setting.label, setting.description, setting.group, text?.ko, text?.en]
          .some((field) => field?.toLowerCase().includes(needle));
      }),
  );

  function stage(setting: GjcSetting, value: GjcSettingValue) {
    setDraft((current) => {
      const next = new Map(current);
      if (value === setting.value) next.delete(setting.key);
      else next.set(setting.key, value);
      return next;
    });
  }

  async function apply() {
    if (!bridge || draft.size === 0) return;
    setApplying(true);
    setError("");
    try {
      const next = await bridge.applyGjcSettings(
        [...draft].map(([key, value]) => ({ key, value })),
      );
      setSettings(next);
      setDraft(new Map());
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (!message.includes("Operation cancelled")) setError(message);
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="settings-stack gjc-settings">
      <div className="gjc-settings-toolbar">
        <label className="gjc-settings-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder={t("설정 이름이나 설명으로 찾기")}
            aria-label={t("GJC 설정 찾기")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <small role={error ? "alert" : undefined}>
          {!bridge
            ? t("데스크톱 앱에서만 설정할 수 있습니다.")
            : error
              ? t`불러오거나 저장하지 못했습니다: ${error}`
              : settings
                ? t`설정 ${settings.length}개 · 자동 압축과 재시도는 열린 세션에도 바로 적용됩니다`
                : t("불러오는 중…")}
        </small>
        {error && !settings && (
          <button type="button" className="button-secondary" onClick={() => setAttempt((n) => n + 1)}>
            {t("다시 시도")}
          </button>
        )}
      </div>
      {groups.map(([group, rows]) => (
        <SettingsSection className="gjc-settings-group" title={group} key={group}>
          {rows.map((setting) => {
            const staged = draft.get(setting.key);
            const value = staged ?? setting.value;
            return (
              <div
                className={
                  staged === undefined
                    ? "settings-toggle-row"
                    : "settings-toggle-row is-changed"
                }
                key={setting.key}
              >
                <span>
                  <strong title={setting.label ? setting.key : undefined}>
                    {setting.label ?? <code>{setting.key}</code>}
                    {setting.value === null && staged === undefined && (
                      <em>{t("기본값")}</em>
                    )}
                  </strong>
                  {setting.description && <small>{setting.description}</small>}
                </span>
                {setting.type === "boolean" ? (
                  <input
                    type="checkbox"
                    aria-label={setting.key}
                    checked={value === true}
                    disabled={applying}
                    onChange={(event) => stage(setting, event.target.checked)}
                  />
                ) : (
                  <NumberField
                    label={setting.key}
                    value={typeof value === "number" ? value : null}
                    disabled={applying}
                    onChange={(next) => stage(setting, next)}
                  />
                )}
              </div>
            );
          })}
        </SettingsSection>
      ))}
      {settings && groups.length === 0 && (
        <p className="settings-empty">{t("찾는 설정이 없습니다.")}</p>
      )}
      {draft.size > 0 && (
        <div className="gjc-settings-apply" role="region" aria-label={t("바꾼 설정")}>
          <span>{t`바꾼 설정 ${draft.size}개 · 적용하면 터미널의 GJC에도 반영됩니다`}</span>
          <button
            type="button"
            className="button-secondary"
            disabled={applying}
            onClick={() => setDraft(new Map())}
          >
            {t("되돌리기")}
          </button>
          <button
            type="button"
            className="button-primary"
            disabled={applying}
            onClick={() => void apply()}
          >
            {applying ? t("적용 중…") : t("적용")}
          </button>
        </div>
      )}
    </div>
  );
}
