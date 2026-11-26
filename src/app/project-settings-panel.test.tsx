/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectSettings, ProjectSettingsEntry } from "../../shared/project-settings";
import { setLanguageMode } from "../i18n";
import { ProjectSettingsPanel } from "./project-settings-panel";
import { settingsOfDraft } from "./project-settings-draft";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  setLanguageMode("ko");
});

const SAVED: ProjectSettings = { newSessionWorktree: true, setupScript: "npm ci", copyFiles: [".env"] };
const ENTRIES: ProjectSettingsEntry[] = [{ root: "/work/zeta", settings: SAVED }];

type Bridge = NonNullable<Parameters<typeof ProjectSettingsPanel>[0]["bridge"]>;

async function renderPanel(bridge: Bridge | undefined, projects = [{ root: "/work/alpha" }, { root: "/work/zeta" }]) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(ProjectSettingsPanel, { bridge, projects }));
  });
  return container;
}

function field(container: HTMLElement, label: string): HTMLTextAreaElement {
  return container.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)!;
}

async function type(element: HTMLTextAreaElement, value: string) {
  await act(async () => {
    // React tracks the value through the prototype's setter
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const saveButton = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLButtonElement>(".project-settings-actions button")].find((button) => button.textContent === "저장")!;

describe("settingsOfDraft", () => {
  it("reads the copy box as one path to a line, normalized and without repeats", () => {
    expect(
      settingsOfDraft({ newSessionWorktree: false, setupScript: "  make  \n", copyFiles: "./.env\n\n  config//a.json \r\n.env\n" }),
    ).toEqual({ settings: { newSessionWorktree: false, setupScript: "make", copyFiles: [".env", "config/a.json"] } });
  });

  it("names the line that cannot be saved", () => {
    expect(settingsOfDraft({ newSessionWorktree: false, setupScript: "", copyFiles: ".env\n../secret" })).toEqual({
      error: "복사할 파일 경로가 올바르지 않습니다: ../secret",
    });
  });

  it("refuses a script or a list that is over the limit", () => {
    expect("error" in settingsOfDraft({ newSessionWorktree: false, setupScript: "x".repeat(8001), copyFiles: "" })).toBe(true);
    const many = Array.from({ length: 51 }, (_, index) => `f${index}`).join("\n");
    expect("error" in settingsOfDraft({ newSessionWorktree: false, setupScript: "", copyFiles: many })).toBe(true);
  });
});

describe("ProjectSettingsPanel", () => {
  it("offers the known projects and the saved one, and shows the saved settings of the first", async () => {
    const container = await renderPanel({ listProjectSettings: async () => ENTRIES, setProjectSettings: vi.fn() }, [{ root: "/work/alpha" }]);
    // alpha and zeta, by name: alpha has none saved
    expect(container.querySelector(".dropdown-trigger")?.textContent).toBe("alpha");
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
    expect(field(container, "setup 스크립트").value).toBe("");
    expect(field(container, "복사할 파일").value).toBe("");
  });

  it("switches project and shows that project's settings", async () => {
    const container = await renderPanel({ listProjectSettings: async () => ENTRIES, setProjectSettings: vi.fn() });
    await act(async () => container.querySelector<HTMLButtonElement>(".dropdown-trigger")!.click());
    const zeta = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((option) => option.textContent?.includes("zeta"))!;
    await act(async () => zeta.click());
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
    expect(field(container, "setup 스크립트").value).toBe("npm ci");
    expect(field(container, "복사할 파일").value).toBe(".env");
    expect(container.querySelector(".settings-path")?.textContent).toBe("/work/zeta");
  });

  it("saves the edited project's settings and shows what the host returned", async () => {
    const next: ProjectSettingsEntry[] = [{ root: "/work/alpha", settings: { newSessionWorktree: true, setupScript: "make", copyFiles: [".env", "a.json"] } }];
    const set = vi.fn(async () => next);
    const container = await renderPanel({ listProjectSettings: async () => [], setProjectSettings: set });
    expect(saveButton(container).disabled).toBe(true);
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await type(field(container, "setup 스크립트"), "make");
    await type(field(container, "복사할 파일"), ".env\na.json");
    expect(saveButton(container).disabled).toBe(false);
    await act(async () => saveButton(container).click());
    expect(set).toHaveBeenCalledWith("/work/alpha", { newSessionWorktree: true, setupScript: "make", copyFiles: [".env", "a.json"] });
    expect(container.querySelector(".project-settings-note")?.textContent).toBe("저장했습니다.");
    expect(saveButton(container).disabled).toBe(true);
  });

  it("keeps each project's unsaved edits while another is shown", async () => {
    const container = await renderPanel({ listProjectSettings: async () => ENTRIES, setProjectSettings: vi.fn() });
    await type(field(container, "setup 스크립트"), "alpha edit");
    await act(async () => container.querySelector<HTMLButtonElement>(".dropdown-trigger")!.click());
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((option) => option.textContent?.includes("zeta"))!.click());
    expect(field(container, "setup 스크립트").value).toBe("npm ci");
    await act(async () => container.querySelector<HTMLButtonElement>(".dropdown-trigger")!.click());
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((option) => option.textContent?.includes("alpha"))!.click());
    expect(field(container, "setup 스크립트").value).toBe("alpha edit");
  });

  it("does not send a path the host would refuse", async () => {
    const set = vi.fn();
    const container = await renderPanel({ listProjectSettings: async () => [], setProjectSettings: set });
    await type(field(container, "복사할 파일"), "../outside");
    await act(async () => saveButton(container).click());
    expect(set).not.toHaveBeenCalled();
    expect(container.querySelector(".diff-error")?.textContent).toBe("복사할 파일 경로가 올바르지 않습니다: ../outside");
  });

  it("shows nothing when the user declines the host's confirmation of the script", async () => {
    const container = await renderPanel({
      listProjectSettings: async () => [],
      setProjectSettings: async () => {
        throw new Error("Operation cancelled");
      },
    });
    await type(field(container, "setup 스크립트"), "rm -rf /tmp/x");
    await act(async () => saveButton(container).click());
    expect(container.querySelector(".diff-error")).toBeNull();
    expect(field(container, "setup 스크립트").value).toBe("rm -rf /tmp/x");
    expect(saveButton(container).disabled).toBe(false);
  });

  it("reports a failed save and keeps the edit", async () => {
    const container = await renderPanel({
      listProjectSettings: async () => [],
      setProjectSettings: async () => {
        throw new Error("disk full");
      },
    });
    await type(field(container, "setup 스크립트"), "make");
    await act(async () => saveButton(container).click());
    expect(container.querySelector(".diff-error")?.textContent).toBe("disk full");
    expect(field(container, "setup 스크립트").value).toBe("make");
  });

  it("explains an empty list, and a missing bridge", async () => {
    const empty = await renderPanel({ listProjectSettings: async () => [], setProjectSettings: vi.fn() }, []);
    expect(empty.textContent).toContain("프로젝트가 없습니다");
    act(() => root?.unmount());
    const none = await renderPanel(undefined);
    expect(none.textContent).toContain("데스크톱 앱에서 볼 수 있습니다.");
    expect(none.querySelector("textarea")).toBeNull();
  });

  it("is in English when English is selected", async () => {
    setLanguageMode("en");
    const container = await renderPanel({ listProjectSettings: async () => ENTRIES, setProjectSettings: vi.fn() });
    expect(container.textContent).toContain("Project settings");
    expect(container.textContent).toContain("Files to copy");
    expect(container.textContent).not.toMatch(/[가-힣]/u);
  });
});
