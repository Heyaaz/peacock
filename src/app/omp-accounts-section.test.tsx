/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OmpAccountsDesktopBridge, OmpLoginEvent, OmpLoginOutcome } from "../../shared/omp-accounts";
import { OmpAccountsSection } from "./omp-accounts-section";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

function fakeBridge() {
  let listener: ((event: OmpLoginEvent) => void) | undefined;
  let finish: (outcome: OmpLoginOutcome) => void = () => undefined;
  const bridge: OmpAccountsDesktopBridge = {
    listProviders: vi.fn(async () => [
      { id: "anthropic", name: "Anthropic", available: true, authenticated: true },
      { id: "copilot", name: "GitHub Copilot", available: true, authenticated: false },
    ]),
    listAccounts: vi.fn(async () => [{ credentialId: 3, provider: "anthropic", label: "work", detail: "", type: "oauth" as const, active: true }]),
    login: vi.fn(() => new Promise<OmpLoginOutcome>((resolve) => (finish = resolve))),
    respond: vi.fn(async () => undefined),
    cancelLogin: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    onLoginEvent: (next) => {
      listener = next;
      return () => (listener = undefined);
    },
  };
  return { bridge, emit: (event: OmpLoginEvent) => listener?.(event), finish: (outcome: OmpLoginOutcome) => finish(outcome) };
}

describe("OmpAccountsSection", () => {
  it("lists providers, runs a login with what omp asks, and signs out an account", async () => {
    const { bridge, emit, finish } = fakeBridge();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(createElement(OmpAccountsSection, { bridge })));
    const rows = () => [...host!.querySelectorAll(".omp-accounts-list > li")];
    expect(rows().map((row) => row.querySelector(".omp-accounts-name")?.textContent)).toEqual(["Anthropic 로그인됨"]);
    await act(async () => host!.querySelector<HTMLButtonElement>(".omp-accounts-more button")!.click());
    expect(rows().map((row) => row.querySelector(".omp-accounts-name")?.textContent)).toEqual(["Anthropic 로그인됨", "GitHub Copilot"]);
    const loginButton = [...rows()[1]!.querySelectorAll("button")].find((button) => button.textContent?.includes("로그인"))!;
    await act(async () => loginButton.click());
    expect(bridge.login).toHaveBeenCalledWith("copilot");
    await act(async () => {
      emit({ kind: "open_url", url: "https://github.com/login/device", instructions: "Code: ABCD-1234" });
      emit({ kind: "input", requestId: "r1", title: "Paste the code" });
    });
    expect(host.querySelector(".omp-login-instructions")?.textContent).toBe("Code: ABCD-1234");
    expect(host.querySelector<HTMLAnchorElement>(".omp-login-link")?.href).toBe("https://github.com/login/device");
    const input = host.querySelector<HTMLInputElement>(".omp-login-question input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "xyz");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => host!.querySelector<HTMLFormElement>(".omp-login-question")!.requestSubmit());
    expect(bridge.respond).toHaveBeenCalledWith("r1", "xyz");
    await act(async () => finish({ status: "done", providerId: "copilot" }));
    expect(host.querySelector(".omp-login")).toBeNull();
    expect(host.querySelector(".omp-accounts-notice")?.textContent).toBe("GitHub Copilot에 로그인했습니다");
    const signOut = [...rows()[0]!.querySelectorAll("button")].find((button) => button.textContent?.includes("로그아웃"))!;
    await act(async () => signOut.click());
    expect(bridge.listAccounts).toHaveBeenCalledWith("anthropic");
    await act(async () => host!.querySelector<HTMLButtonElement>(".omp-accounts-credential button")!.click());
    expect(bridge.logout).toHaveBeenCalledWith("anthropic", 3);
  });
});
