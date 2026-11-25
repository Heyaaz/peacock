/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConfigOption } from "../../shared/agent-contract";
import { ModelCatalogPicker } from "./model-catalog-picker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

const PICKER_OPTION: AgentConfigOption = {
  id: "model",
  name: "모델",
  category: "model",
  type: "select",
  currentValue: "opencodex/opengateway/deepseek/flash",
  scopes: [
    { id: "default", name: "메인", enabled: true, current: "flash" },
    { id: "smol", name: "smol", enabled: false, current: "GPT-6.2 Sol" },
  ],
  options: [
    { value: "opencodex/opengateway/deepseek/flash", name: "flash", kind: "model", catalog: { provider: "opencodex", recent: true, tokensPerSecond: 132, contextWindow: 950_000, cost: { input: 0, output: 0 } } },
    {
      value: "opencodex/gpt-6.2-sol",
      name: "GPT-6.2 Sol",
      kind: "model",
      catalog: { provider: "opencodex", recent: true, roles: [{ role: "smol", label: "SMOL" }, { role: "slow", label: "SLOW" }], intelligence: 57.3, tokensPerSecond: 44, contextWindow: 872_000, cost: { input: 0, output: 0 } },
    },
    { value: "openai/gpt-6.1-sol", name: "GPT-6.1 Sol", kind: "model", catalog: { provider: "openai", intelligence: 55, contextWindow: 922_000, cost: { input: 2, output: 10 } } },
    { value: "xai/grok-4.7", name: "Grok 4.7", kind: "model", catalog: { provider: "xai", contextWindow: 500_000, cost: { input: 0, output: 0 } } },
  ],
};

async function mount(option: AgentConfigOption = PICKER_OPTION) {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(ModelCatalogPicker, { option, onSelect, onClose })));
  return { node: host, onSelect, onClose };
}

const key = (node: Element, value: string) =>
  act(async () => node.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true })));

describe("ModelCatalogPicker", () => {
  it("lists recent models first, then the rest, with roles, free badges and the catalog's figures", async () => {
    const { node } = await mount();
    const sections = [...node.querySelectorAll(".model-catalog-section")].map((section) => section.textContent);
    expect(sections).toEqual(["최근 2", "모든 모델 2"]);
    const rows = [...node.querySelectorAll(".model-catalog-row")];
    expect(rows.map((row) => row.querySelector(".model-catalog-id")?.textContent)).toEqual(["opengateway/deepseek/flash", "gpt-6.2-sol", "gpt-6.1-sol", "grok-4.7"]);
    expect([...rows[1]!.querySelectorAll(".model-catalog-pill")].map((pill) => pill.textContent)).toEqual(["무료", "smol", "slow"]);
    expect([...rows[1]!.querySelectorAll(".model-catalog-num")].map((cell) => cell.textContent)).toEqual(["57", "44", "872k", "무료"]);
    expect([...rows[2]!.querySelectorAll(".model-catalog-num")].map((cell) => cell.textContent)).toEqual(["55", "", "922k", "$2·10"]);
    expect(rows[0]!.getAttribute("aria-selected")).toBe("true");
    expect(node.querySelector(".model-catalog-count")?.textContent).toBe("4 / 4");
    expect(node.querySelector(".model-catalog-foot")?.textContent).toContain("범위: 메인");
  });

  it("searches by id, provider or role, and moves and chooses with the keyboard", async () => {
    const { node, onSelect, onClose } = await mount();
    const input = node.querySelector<HTMLInputElement>("input[type=search]")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "sol");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(node.querySelector(".model-catalog-count")?.textContent).toBe("2 / 4");
    expect([...node.querySelectorAll(".model-catalog-section")].map((section) => section.textContent)).toEqual(["최근 1", "검색 결과 1"]);
    await key(input, "ArrowDown");
    await key(input, "Enter");
    expect(onSelect).toHaveBeenCalledWith("openai/gpt-6.1-sol");
    await key(input, "Escape");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("offers only the scopes a choice can be set for, and leaves out columns nothing fills", async () => {
    const bare: AgentConfigOption = { ...PICKER_OPTION, scopes: undefined, options: PICKER_OPTION.options!.map((choice) => ({ ...choice, catalog: { provider: choice.catalog!.provider } })) };
    const { node } = await mount(bare);
    // no column has figures, so the header row is left out
    expect(node.querySelector(".model-catalog-head")).toBeNull();
    expect(node.querySelector(".model-catalog-scope")).toBeNull();
    await act(async () => root!.unmount());
    root = undefined;
    const { node: scoped } = await mount();
    await act(async () => scoped.querySelector<HTMLButtonElement>(".model-catalog-scope > button")!.click());
    const options = [...scoped.querySelectorAll<HTMLButtonElement>(".model-catalog-scope-menu > button")];
    expect(options.map((option) => [option.textContent, option.disabled])).toEqual([
      ["메인flash", false],
      ["smolGPT-6.2 Sol", true],
    ]);
  });
});

/** GJC's model menu: profiles in their groups and concrete models, no catalog figures. */
const GJC_OPTION: AgentConfigOption = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "codex-medium",
  options: [
    { value: "opga-high", name: "OPGA High", group: "Built-in profiles", description: "Bundled with GJC" },
    { value: "codex-medium", name: "Codex Medium", group: "Built-in profiles" },
    { value: "mine", name: "Mine", group: "Custom profiles" },
    ...Array.from({ length: 5 }, (_, index) => ({ value: `bedrock/gpt-${index}`, name: `GPT ${index}`, group: "bedrock", kind: "model" as const })),
  ],
};

describe("ModelCatalogPicker for GJC", () => {
  afterEach(() => localStorage.clear());

  async function mountGjc(tools?: ReturnType<typeof createElement>) {
    const onSelect = vi.fn();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root!.render(createElement(ModelCatalogPicker, { option: GJC_OPTION, onSelect, onClose: () => undefined, favorites: true, tools })),
    );
    return { node: host, onSelect };
  }
  const sections = (node: Element) => [...node.querySelectorAll(".model-catalog-section")].map((section) => section.textContent);
  const names = (node: Element) => [...node.querySelectorAll(".model-catalog-id")].map((name) => name.textContent);

  it("leads with the one in use, keeps the profile groups, and lists models by id with no columns or scope", async () => {
    const { node, onSelect } = await mountGjc();
    expect(sections(node)).toEqual(["사용 중·즐겨찾기 1", "Built-in profiles 1", "Custom profiles 1", "모델 5"]);
    expect(names(node).slice(0, 4)).toEqual(["Codex Medium", "OPGA High", "Mine", "gpt-0"]);
    expect(node.querySelector(".model-catalog-desc")?.textContent).toBe("Bundled with GJC");
    expect(node.querySelector(".model-catalog-head")).toBeNull();
    expect(node.querySelector(".model-catalog-scope")).toBeNull();
    await act(async () => node.querySelectorAll<HTMLElement>(".model-catalog-row")[3]!.click());
    expect(onSelect).toHaveBeenCalledWith("bedrock/gpt-0");
  });

  it("stars a row into the lead section and remembers it", async () => {
    const { node } = await mountGjc();
    const star = [...node.querySelectorAll<HTMLButtonElement>(".model-catalog-star")].find((button) => button.getAttribute("aria-label") === "Mine 즐겨찾기")!;
    await act(async () => star.click());
    expect(names(node).slice(0, 2)).toEqual(["Codex Medium", "Mine"]);
    expect(JSON.parse(localStorage.getItem("gajae:model-favorites")!)).toEqual(["mine"]);
  });

  it("searches profiles and models together and shows the tools strip", async () => {
    const { node } = await mountGjc(createElement("span", { className: "probe-tool" }, "tools"));
    expect(node.querySelector(".model-catalog-tools .probe-tool")).not.toBeNull();
    const input = node.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "gpt 3");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(sections(node)).toEqual(["모델 1"]);
    expect(names(node)).toEqual(["gpt-3"]);
  });
});
