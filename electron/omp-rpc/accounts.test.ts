import { describe, expect, it, vi } from "vitest";
import type { OmpLoginEvent } from "../../shared/omp-accounts.js";
import { OmpAccounts } from "./accounts.js";
import { FakeRpcProcess, settle } from "./fake-process.test-util.js";

function setup() {
  const children: { child: FakeRpcProcess; args: readonly string[] }[] = [];
  let pendingLogin: Record<string, unknown> | undefined;
  const openUrl = vi.fn();
  const accounts = new OmpAccounts({
    detect: async () => ({ id: "omp", name: "Oh My Pi", installed: true, binary: "/bin/omp", version: "19.1.1" }),
    environment: async () => ({ PATH: "/usr/bin" }),
    cwd: "/tmp/gajae",
    openUrl,
    idleMs: 10,
    spawn: (_binary, args) => {
      const child = new FakeRpcProcess();
      children.push({ child, args });
      child.respond((frame) => {
        if (typeof frame.id !== "string" || frame.type === "extension_ui_response") return;
        const answer = (data?: unknown) =>
          queueMicrotask(() => child.emitFrames({ id: frame.id, type: "response", command: frame.type, success: true, ...(data === undefined ? {} : { data }) }));
        if (frame.type === "get_login_providers")
          answer({
            providers: [
              { id: "anthropic", name: "Anthropic (Claude Pro/Max)", available: true, authenticated: true },
              { id: "openai-codex", name: "ChatGPT Plus/Pro", available: false, authenticated: false },
            ],
          });
        else if (frame.type === "get_logout_accounts")
          answer({ accounts: [{ credentialId: 3, provider: "anthropic", label: "work", detail: "OAuth", type: "oauth", active: true }, { label: "no id" }] });
        else if (frame.type === "login") pendingLogin = frame;
        else answer();
      });
      queueMicrotask(() => child.ready());
      return child;
    },
  });
  const finishLogin = () => {
    const child = children.at(-1)!.child;
    child.emitFrames({ id: pendingLogin!.id, type: "response", command: "login", success: true, data: { providerId: pendingLogin!.providerId } });
  };
  return { accounts, children, openUrl, finishLogin };
}

describe("OmpAccounts", () => {
  it("lists providers and stored credentials from an omp that keeps no session", async () => {
    const { accounts, children } = setup();
    await expect(accounts.listProviders()).resolves.toEqual([
      { id: "anthropic", name: "Anthropic (Claude Pro/Max)", available: true, authenticated: true },
      { id: "openai-codex", name: "ChatGPT Plus/Pro", available: false, authenticated: false },
    ]);
    expect(children[0]!.args).toEqual(["--mode", "rpc-ui", "--no-session", "--cwd", "/tmp/gajae"]);
    await expect(accounts.listAccounts("anthropic")).resolves.toEqual([
      { credentialId: 3, provider: "anthropic", label: "work", detail: "OAuth", type: "oauth", active: true },
    ]);
    await accounts.logout("anthropic", 3);
    expect(children[0]!.child.sent("logout")[0]).toMatchObject({ providerId: "anthropic", credentialId: 3 });
    accounts.dispose();
  });

  it("opens a login's browser URL, passes on what it asks, and answers with the user's reply", async () => {
    const { accounts, children, openUrl, finishLogin } = setup();
    const events: OmpLoginEvent[] = [];
    const outcome = accounts.startLogin("anthropic", (event) => events.push(event));
    await settle(6);
    const child = children[0]!.child;
    child.emitFrames(
      { type: "extension_ui_request", id: "u1", method: "open_url", url: "https://claude.ai/oauth?x=1", launchUrl: "http://127.0.0.1:5555/l", instructions: "Paste the code" },
      { type: "extension_ui_request", id: "u2", method: "open_url", url: "file:///etc/passwd" },
      { type: "extension_ui_request", id: "u3", method: "notify", message: "Waiting for the browser", notifyType: "info" },
      { type: "extension_ui_request", id: "u4", method: "input", title: "Paste the authorization code", placeholder: "code#state" },
    );
    await settle();
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith("http://127.0.0.1:5555/l");
    expect(events).toEqual([
      { kind: "open_url", url: "https://claude.ai/oauth?x=1", instructions: "Paste the code" },
      { kind: "progress", message: "Waiting for the browser", tone: "info" },
      { kind: "input", requestId: "u4", title: "Paste the authorization code", placeholder: "code#state" },
    ]);
    accounts.respond("u4", "abc#def");
    await settle();
    expect(child.sent("extension_ui_response")).toEqual([{ type: "extension_ui_response", id: "u4", value: "abc#def" }]);
    // an answer to a question that is gone is dropped
    accounts.respond("u4", "again");
    finishLogin();
    await expect(outcome).resolves.toEqual({ status: "done", providerId: "anthropic" });
    accounts.dispose();
  });

  it("ends a cancelled login and closes the questions it left", async () => {
    const { accounts, children } = setup();
    const events: OmpLoginEvent[] = [];
    const outcome = accounts.startLogin("anthropic", (event) => events.push(event));
    await settle(6);
    children[0]!.child.emitFrames({ type: "extension_ui_request", id: "c1", method: "confirm", title: "Use at your own risk?", message: "Terms" });
    await settle();
    await expect(accounts.startLogin("other", () => undefined)).rejects.toThrow("already running");
    accounts.cancelLogin();
    await expect(outcome).resolves.toEqual({ status: "cancelled" });
    expect(events.at(-1)).toEqual({ kind: "closed", requestId: "c1" });
    accounts.dispose();
  });
});
