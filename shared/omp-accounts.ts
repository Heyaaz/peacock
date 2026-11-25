/**
 * omp's sign-in, as the settings' omp section drives it over omp's RPC (19.1.1
 * `get_login_providers`, `login`, `get_logout_accounts`, `logout`). No token
 * crosses this boundary: omp keeps credentials in its own store, and the window only
 * sees providers, account labels and what a login asks the user to do.
 */

export const OMP_ACCOUNTS_IPC = {
  listProviders: "omp-accounts:list-providers",
  listAccounts: "omp-accounts:list-accounts",
  login: "omp-accounts:login",
  respond: "omp-accounts:respond",
  cancelLogin: "omp-accounts:cancel-login",
  logout: "omp-accounts:logout",
  /** Main to window: what the running login asks or reports. */
  loginEvent: "omp-accounts:login-event",
} as const;

export interface OmpLoginProvider {
  id: string;
  name: string;
  /** omp can sign in to it on this Mac. */
  available: boolean;
  /** omp holds a credential for it. */
  authenticated: boolean;
}

/** A stored credential `logout` can remove; `active` marks one the session may be using. */
export interface OmpLogoutAccount {
  credentialId: number;
  provider: string;
  label: string;
  detail: string;
  type: "api_key" | "oauth";
  active: boolean;
}

/** What a running login shows the user. */
export type OmpLoginEvent =
  | { kind: "open_url"; url: string; instructions?: string }
  | { kind: "progress"; message: string; tone: "info" | "warning" | "error" }
  | { kind: "input"; requestId: string; title: string; placeholder?: string }
  | { kind: "confirm"; requestId: string; title: string; message?: string }
  | { kind: "select"; requestId: string; title: string; options: string[] }
  | { kind: "closed"; requestId: string };

/** The answer to an input, confirm or select of a login; null cancels it. */
export type OmpLoginAnswer = string | boolean | null;

export type OmpLoginOutcome = { status: "done"; providerId: string } | { status: "cancelled" } | { status: "failed"; error: string };

export interface OmpAccountsDesktopBridge {
  listProviders(): Promise<OmpLoginProvider[]>;
  listAccounts(providerId: string): Promise<OmpLogoutAccount[]>;
  login(providerId: string): Promise<OmpLoginOutcome>;
  respond(requestId: string, answer: OmpLoginAnswer): Promise<void>;
  cancelLogin(): Promise<void>;
  logout(providerId: string, credentialId: number): Promise<void>;
  onLoginEvent(listener: (event: OmpLoginEvent) => void): () => void;
}
