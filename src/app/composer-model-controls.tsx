import type { ReactNode } from "react";
import { Check, Zap } from "lucide-react";
import type { AgentCommand, AgentConfigOption } from "../backend/types";
import { t } from "../i18n";
import { FastTierControls } from "./composer-fast-tier";
import { ModelCatalogPicker } from "./model-catalog-picker";

interface ModelControlsProps {
  modelOption: AgentConfigOption;
  thinkingOption: AgentConfigOption | undefined;
  modelDisplay: string | undefined;
  currentEffort: string;
  /** null: the context share is shown elsewhere (the turn status line), so it is left out here. */
  usagePercent: number | null | undefined;
  fastMode: boolean;
  fastBusy: boolean;
  readOnly: boolean;
  commands: AgentCommand[];
  configMenu: string | null;
  onToggleMenu: (id: string) => void;
  onSelectConfig: (configId: string, value: string) => void;
  /** Changes a setting and leaves the menu open (the thinking level inside the model picker). */
  onChangeConfig?: (configId: string, value: string) => void;
  onSetFastTier: (fast: boolean) => Promise<void>;
}

/** The strip under the model picker's search: the thinking level, and GJC's Fast tier pair. */
function PickerTools({
  thinkingOption,
  fast,
  onThinking,
}: {
  thinkingOption: AgentConfigOption | undefined;
  fast: ReactNode;
  onThinking: (value: string) => void;
}) {
  const levels = thinkingOption?.options ?? [];
  if (levels.length === 0 && !fast) return null;
  return (
    <>
      {levels.length > 0 && (
        <span className="model-catalog-thinking" role="group" aria-label={t("사고 수준")}>
          <small>{t("사고 수준")}</small>
          {levels.map((choice) => (
            <button
              key={choice.value}
              type="button"
              aria-pressed={choice.value === thinkingOption?.currentValue}
              onClick={() => onThinking(choice.value)}
            >
              {choice.name}
            </button>
          ))}
        </span>
      )}
      {fast}
    </>
  );
}

export function ModelControls({
  modelOption,
  thinkingOption,
  modelDisplay,
  currentEffort,
  usagePercent,
  fastMode,
  fastBusy,
  readOnly,
  commands,
  configMenu,
  onToggleMenu,
  onSelectConfig: selectConfig,
  onChangeConfig,
  onSetFastTier,
}: ModelControlsProps) {
  // a catalog-backed menu is omp's, whose switches sit off the context bar; GJC's keeps its Fast pair here
  const catalogBacked = modelOption.options?.some((choice) => choice.catalog) ?? false;
  return (
            <span className="composer-model">
              {/* Left enabled during a run: this popover is where the Fast tier is
                  switched, and the runtime applies a tier to the open session. A
                  model change mid-turn is refused by the runtime and surfaced by the
                  shell, which is better than hiding both controls until the turn ends. */}
              <button
                type="button"
                title={t("모델 바꾸기: /model · 사고 수준 바꾸기: ⇧⇥")}
                onClick={() => onToggleMenu(modelOption.id)}
              >
                <strong>
                  {modelOption.options?.find(
                    (choice) => choice.value === modelOption.currentValue,
                  )?.name ??
                    modelDisplay ??
                    String(modelOption.currentValue)}
                </strong>
                <i />
                <span title={t("사고 수준")}>{currentEffort}</span>
                {usagePercent !== null && (
                  <>
                    <i />
                    <span title={t("이 대화가 쓴 컨텍스트 비율")}>
                      {usagePercent === undefined
                        ? "—"
                        : t`컨텍스트 ${usagePercent.toFixed(1)}%`}
                    </span>
                  </>
                )}
                {fastMode && (
                  <>
                    <i />
                    <span
                      className="composer-fast-mode"
                      title={t("Fast 모드 켜짐")}
                      aria-label={t("Fast 모드 켜짐")}
                    >
                      <Zap size={10} aria-hidden="true" />
                      Fast
                    </span>
                  </>
                )}
              </button>
              {configMenu === modelOption.id && (
                <ModelCatalogPicker
                  option={modelOption}
                  favorites={!catalogBacked}
                  tools={
                    <PickerTools
                      thinkingOption={thinkingOption}
                      fast={
                        catalogBacked ? null : (
                          <FastTierControls
                            commands={commands}
                            fastMode={fastMode}
                            busy={fastBusy}
                            readOnly={readOnly}
                            onSelect={(fast) => void onSetFastTier(fast)}
                          />
                        )
                      }
                      onThinking={(value) =>
                        thinkingOption && (onChangeConfig ?? selectConfig)(thinkingOption.id, value)
                      }
                    />
                  }
                  onSelect={(value) => selectConfig(modelOption.id, value)}
                  onClose={() => onToggleMenu(modelOption.id)}
                />
              )}
              {thinkingOption && configMenu === thinkingOption.id && (
                <span className="config-option-menu config-option-menu--effort">
                  <header>
                    <strong>{t("추론 Effort")}</strong>
                    <small>⇧⇥</small>
                  </header>
                  {thinkingOption.options?.map((choice) => (
                    <button
                      key={choice.value}
                      type="button"
                      className={
                        choice.value === thinkingOption.currentValue
                          ? "is-current"
                          : ""
                      }
                      onClick={() =>
                        selectConfig(thinkingOption.id, choice.value)
                      }
                    >
                      <span>{choice.name}</span>
                      {choice.value === thinkingOption.currentValue && (
                        <Check size={12} />
                      )}
                    </button>
                  ))}
                </span>
              )}
            </span>
  );
}
