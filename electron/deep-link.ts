import path from "node:path";
import type { SessionShortcut } from "../shared/settings-ipc.js";

export const DEEP_LINK_PROTOCOL = "peacock:";
/** The scheme before the rename, still honoured: links saved in notes, shortcuts and scripts keep working. */
export const LEGACY_DEEP_LINK_PROTOCOL = "gajae:";
const DEEP_LINK_PROTOCOLS: readonly string[] = [DEEP_LINK_PROTOCOL, LEGACY_DEEP_LINK_PROTOCOL];
export const DEEP_LINK_PROMPT_LIMIT = 20_000;
const SESSION_ID_LIMIT = 256;

/**
 * What one peacock:// URL (or gajae://, its name before the rename) asks a window to do.
 * Anything that is not such a link is `undefined` and ignored. A link the app recognizes
 * but cannot honour becomes `invalidLink`, so the user who clicked it is told why nothing opened.
 *
 * - `peacock://new?prompt=…&path=…` opens the new-session dialog, never a session.
 * - `peacock://session/<id>` opens a session the window knows.
 */
export function sessionShortcutForDeepLink(
  url: string,
  isDirectory: (candidate: string) => boolean,
): SessionShortcut | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (!DEEP_LINK_PROTOCOLS.includes(parsed.protocol)) return undefined;
  if (parsed.hostname === "new" && (parsed.pathname === "" || parsed.pathname === "/"))
    return newSessionLink(parsed.searchParams, isDirectory);
  if (parsed.hostname === "session") return openSessionLink(parsed.pathname);
  return undefined;
}

export function deepLinksInArgv(argv: readonly string[]): string[] {
  return argv.filter((argument) => DEEP_LINK_PROTOCOLS.some((protocol) => argument.startsWith(`${protocol}//`)));
}

function newSessionLink(
  query: URLSearchParams,
  isDirectory: (candidate: string) => boolean,
): SessionShortcut {
  const prompt = query.get("prompt") ?? "";
  if (prompt.length > DEEP_LINK_PROMPT_LIMIT)
    return { type: "invalidLink", reason: { kind: "prompt", limit: DEEP_LINK_PROMPT_LIMIT } };
  const requested = query.get("path");
  if (requested !== null && !(path.isAbsolute(requested) && isDirectory(requested)))
    return { type: "invalidLink", reason: { kind: "path", path: requested.slice(0, 512) } };
  return {
    type: "new",
    prefill: {
      ...(requested !== null ? { workspace: path.resolve(requested) } : {}),
      ...(prompt.trim() ? { prompt } : {}),
    },
  };
}

function openSessionLink(pathname: string): SessionShortcut {
  let sessionId: string;
  try {
    sessionId = decodeURIComponent(pathname.replace(/^\//u, ""));
  } catch {
    return { type: "invalidLink", reason: { kind: "session" } };
  }
  if (!sessionId || sessionId.length > SESSION_ID_LIMIT || sessionId.includes("/"))
    return { type: "invalidLink", reason: { kind: "session" } };
  return { type: "open", sessionId };
}
