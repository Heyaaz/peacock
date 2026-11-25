import { ipcMain } from "electron";
import { OMP_ACCOUNTS_IPC, type OmpLoginAnswer } from "../shared/omp-accounts.js";
import { requiredId } from "./gjc-input-validation.js";
import { hostText } from "./host-text.js";
import type { IpcSecurity } from "./ipc-security.js";
import type { OmpAccounts } from "./omp-rpc/accounts.js";

/**
 * The settings' omp sign-in (design §10): providers, stored credentials, a login whose
 * questions go to the window that started it, and a logout the user confirms in the
 * host's own dialog.
 */
export function registerOmpAccountsIpc(accounts: OmpAccounts, security: IpcSecurity): () => void {
  const handle = (channel: string, handler: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, security.guarded(async (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => handler(event, ...args)));
  };
  handle(OMP_ACCOUNTS_IPC.listProviders, () => accounts.listProviders());
  handle(OMP_ACCOUNTS_IPC.listAccounts, (_event, providerId) => accounts.listAccounts(requiredId(providerId, "Provider ID")));
  handle(OMP_ACCOUNTS_IPC.login, (event, providerId) => {
    const sender = event.sender;
    return accounts.startLogin(requiredId(providerId, "Provider ID"), (loginEvent) => {
      if (!sender.isDestroyed()) sender.send(OMP_ACCOUNTS_IPC.loginEvent, loginEvent);
    });
  });
  handle(OMP_ACCOUNTS_IPC.respond, (_event, requestId, answer) => {
    if (answer !== null && typeof answer !== "string" && typeof answer !== "boolean") throw new Error("A login answer is text, yes/no or nothing");
    accounts.respond(requiredId(requestId, "Request ID"), answer as OmpLoginAnswer);
  });
  handle(OMP_ACCOUNTS_IPC.cancelLogin, () => accounts.cancelLogin());
  handle(OMP_ACCOUNTS_IPC.logout, async (event, providerId, credentialId) => {
    const provider = requiredId(providerId, "Provider ID");
    if (typeof credentialId !== "number" || !Number.isInteger(credentialId)) throw new Error("Credential ID must be an integer");
    await security.authorizeDestructive(event, {
      message: hostText("omp에서 이 계정을 로그아웃할까요?"),
      detail: `${provider} · ${hostText("omp가 저장한 자격 증명을 지웁니다.")}`,
      confirmLabel: hostText("로그아웃"),
      danger: true,
    });
    await accounts.logout(provider, credentialId);
  });
  return () => {
    for (const channel of Object.values(OMP_ACCOUNTS_IPC)) if (channel !== OMP_ACCOUNTS_IPC.loginEvent) ipcMain.removeHandler(channel);
  };
}
