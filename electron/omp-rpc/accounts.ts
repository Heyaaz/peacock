import { spawn } from "node:child_process";
import type {
  OmpLoginAnswer,
  OmpLoginEvent,
  OmpLoginOutcome,
  OmpLoginProvider,
  OmpLogoutAccount,
} from "../../shared/omp-accounts.js";
import type { AgentAvailability } from "../../shared/terminal-ipc.js";
import { withoutInherited } from "../herdr-core/env.js";
import { record, string } from "../herdr-core/transcript/transcript-records.js";
import { OmpRpcClient, type RpcFrame, type RpcProcess } from "./rpc-client.js";

export interface OmpAccountsOptions {
  detect: () => Promise<AgentAvailability>;
  environment: () => Promise<Record<string, string>>;
  /** The folder omp runs in; it keeps no session (`--no-session`). */
  cwd: string;
  /** Opens an http(s) URL a login gives in the browser. */
  openUrl: (url: string) => void;
  spawn?: (binary: string, args: readonly string[], options: { cwd: string; env: Record<string, string> }) => RpcProcess;
  log?: (message: string, error?: unknown) => void;
  /** How long an unused omp stays up for the next call. */
  idleMs?: number;
  readyTimeoutMs?: number;
}

const IDLE_MS = 120_000;
/** A login waits for the user in the browser; omp itself gives a prompt 10 minutes. */
const LOGIN_TIMEOUT_MS = 15 * 60_000;

/**
 * omp's sign-in over its RPC (design §10): an omp of its own, started on demand
 * with no session and stopped when idle, lists the providers it can sign in to and
 * the credentials it holds, runs a login and removes a credential. A login's browser
 * URL is opened here; what it asks (a pasted code, an acknowledgement) goes to the
 * window that started it, whose answer comes back through `respond`.
 */
export class OmpAccounts {
  private client?: OmpRpcClient;
  private starting?: Promise<OmpRpcClient>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private login?: { providerId: string; emit: (event: OmpLoginEvent) => void; requests: Map<string, string>; cancelled: boolean };
  private disposed = false;

  constructor(private readonly options: OmpAccountsOptions) {}

  async listProviders(): Promise<OmpLoginProvider[]> {
    const data = record(await this.call({ type: "get_login_providers" }));
    return (Array.isArray(data.providers) ? data.providers.map(record) : []).flatMap((provider): OmpLoginProvider[] => {
      const id = string(provider.id);
      return id
        ? [{ id, name: string(provider.name) ?? id, available: provider.available !== false, authenticated: provider.authenticated === true }]
        : [];
    });
  }

  async listAccounts(providerId: string): Promise<OmpLogoutAccount[]> {
    const data = record(await this.call({ type: "get_logout_accounts", providerId }));
    return (Array.isArray(data.accounts) ? data.accounts.map(record) : []).flatMap((account): OmpLogoutAccount[] => {
      if (typeof account.credentialId !== "number" || !Number.isInteger(account.credentialId)) return [];
      return [
        {
          credentialId: account.credentialId,
          provider: string(account.provider) ?? providerId,
          label: string(account.label) ?? "",
          detail: string(account.detail) ?? "",
          type: account.type === "api_key" ? "api_key" : "oauth",
          active: account.active === true,
        },
      ];
    });
  }

  /** Runs one login; the window hears what it asks through `emit`. One at a time. */
  async startLogin(providerId: string, emit: (event: OmpLoginEvent) => void): Promise<OmpLoginOutcome> {
    if (this.login) throw new Error("A login is already running");
    const login = { providerId, emit, requests: new Map<string, string>(), cancelled: false };
    this.login = login;
    try {
      const client = await this.ensure();
      this.holdOpen();
      await client.call({ type: "login", providerId }, LOGIN_TIMEOUT_MS);
      return { status: "done", providerId };
    } catch (error) {
      if (login.cancelled) return { status: "cancelled" };
      return { status: "failed", error: error instanceof Error ? error.message : String(error) };
    } finally {
      for (const requestId of login.requests.keys()) emit({ kind: "closed", requestId });
      if (this.login === login) this.login = undefined;
      this.scheduleIdle();
    }
  }

  /** The user's answer to what the running login asked; null cancels that question. */
  respond(requestId: string, answer: OmpLoginAnswer): void {
    const login = this.login;
    const method = login?.requests.get(requestId);
    if (!login || !method || !this.client) return;
    login.requests.delete(requestId);
    if (answer === null) this.client.send({ type: "extension_ui_response", id: requestId, cancelled: true });
    else if (method === "confirm") this.client.send({ type: "extension_ui_response", id: requestId, confirmed: answer === true });
    else this.client.send({ type: "extension_ui_response", id: requestId, value: String(answer) });
  }

  /** Stops the running login: its omp ends, and the next call starts another. */
  cancelLogin(): void {
    const login = this.login;
    if (!login) return;
    login.cancelled = true;
    this.client?.close(500);
  }

  async logout(providerId: string, credentialId: number): Promise<void> {
    await this.call({ type: "logout", providerId, credentialId });
  }

  dispose(): void {
    this.disposed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.client?.close(500);
  }

  private async call(command: Record<string, unknown> & { type: string }): Promise<unknown> {
    const client = await this.ensure();
    this.holdOpen();
    try {
      return await client.call(command);
    } finally {
      this.scheduleIdle();
    }
  }

  private ensure(): Promise<OmpRpcClient> {
    if (this.disposed) return Promise.reject(new Error("The app is closing"));
    if (this.client && !this.client.exited) return Promise.resolve(this.client);
    this.starting ??= this.start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async start(): Promise<OmpRpcClient> {
    const agent = await this.options.detect();
    if (!agent.installed || !agent.binary) throw new Error(`${agent.name}: ${agent.reason ?? "not installed"}`);
    const env = await this.options.environment();
    const args = ["--mode", "rpc-ui", "--no-session", "--cwd", this.options.cwd];
    const child = this.options.spawn
      ? this.options.spawn(agent.binary, args, { cwd: this.options.cwd, env })
      : (() => {
          const [command, argv] = withoutInherited(agent.binary!, args);
          return spawn(command, argv, { cwd: this.options.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
        })();
    const client = new OmpRpcClient(child, { log: (message) => this.options.log?.(`omp accounts: ${message}`) });
    this.client = client;
    client.onFrame((frame) => this.onFrame(client, frame));
    client.onExit(() => {
      if (this.client === client) this.client = undefined;
    });
    try {
      await client.waitReady(this.options.readyTimeoutMs ?? 30_000);
    } catch (error) {
      client.close(500);
      if (this.client === client) this.client = undefined;
      throw error;
    }
    return client;
  }

  /** A login's browser URL, its progress, and what it asks the user. */
  private onFrame(client: OmpRpcClient, frame: RpcFrame): void {
    if (frame.type !== "extension_ui_request" || client !== this.client) return;
    const login = this.login;
    const id = string(frame.id);
    if (!login || !id) return;
    switch (frame.method) {
      case "open_url": {
        const web = (value: unknown) => {
          const url = string(value);
          return url && /^https?:\/\//iu.test(url) ? url : undefined;
        };
        // omp's short loopback URL survives being copied; the full one is the window's link
        const launch = web(frame.launchUrl) ?? web(frame.url);
        if (!launch) return;
        this.options.openUrl(launch);
        login.emit({ kind: "open_url", url: web(frame.url) ?? launch, ...(string(frame.instructions) ? { instructions: string(frame.instructions)! } : {}) });
        return;
      }
      case "notify":
        login.emit({
          kind: "progress",
          message: string(frame.message) ?? "",
          tone: frame.notifyType === "error" ? "error" : frame.notifyType === "warning" ? "warning" : "info",
        });
        return;
      case "input":
        // a secret omp would ask for is refused by omp itself over RPC; nothing secret is shown here
        login.requests.set(id, "input");
        login.emit({ kind: "input", requestId: id, title: string(frame.title) ?? "", ...(string(frame.placeholder) ? { placeholder: string(frame.placeholder)! } : {}) });
        return;
      case "confirm":
        login.requests.set(id, "confirm");
        login.emit({ kind: "confirm", requestId: id, title: string(frame.title) ?? "", ...(string(frame.message) ? { message: string(frame.message)! } : {}) });
        return;
      case "select": {
        const options = Array.isArray(frame.options) ? frame.options.filter((option): option is string => typeof option === "string") : [];
        login.requests.set(id, "select");
        login.emit({ kind: "select", requestId: id, title: string(frame.title) ?? "", options });
        return;
      }
      case "cancel": {
        const target = string(frame.targetId);
        if (target && login.requests.delete(target)) login.emit({ kind: "closed", requestId: target });
        return;
      }
      default:
        return;
    }
  }

  private holdOpen(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private scheduleIdle(): void {
    if (this.login) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (!this.login) this.client?.close(500);
    }, this.options.idleMs ?? IDLE_MS);
    this.idleTimer.unref?.();
  }
}
