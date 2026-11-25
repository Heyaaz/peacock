import { open, stat } from "node:fs/promises";
import type {
  AgentEvent,
  TranscriptChange,
  TranscriptItem,
  TranscriptPage,
  TranscriptPageRequest,
} from "../../../shared/agent-contract.js";
import { selectTranscriptPage, transcriptSyncWindow } from "../../../shared/transcript-page.js";
import { transcriptDelivery, transcriptItemEqual } from "../../../shared/transcript-item-equal.js";
import { createClaudeTranscriptParser } from "./claude-transcript.js";
import { createOmpTranscriptParser } from "./omp-transcript.js";
import type { TranscriptParser } from "./transcript-records.js";
import type { ApprovalOverlay } from "../approvals.js";

/** The agents whose transcripts Gajae reads into the chat. */
export type TranscriptFormat = "claude" | "omp";

/** Where a session's transcript is now. */
export interface TranscriptLocation {
  path: string;
  format: TranscriptFormat;
}

/**
 * How much of a transcript a first read takes, from its end. Claude Code writes request shapes and
 * prompt snapshots of tens of kilobytes on every turn, so a long session's file runs to many
 * megabytes; the chat shows its latest stretch, and row ids do not depend on where reading began.
 */
export const INITIAL_READ_BYTES = 16 * 1024 * 1024;
/** The most one read takes at a time. */
const READ_CHUNK_BYTES = 4 * 1024 * 1024;
/** How often watched transcripts are looked at (design §5.5: 250ms stat polling). */
export const TRANSCRIPT_POLL_MS = 250;
/** More changed rows than this at once travel as one synced window instead of one event each. */
const APPEND_EVENT_LIMIT = 16;

const PARSERS: Record<TranscriptFormat, (sessionId: string) => TranscriptParser> = {
  claude: createClaudeTranscriptParser,
  omp: createOmpTranscriptParser,
};

/**
 * One session's transcript file, read as it grows. A different path, a file replaced under the
 * same path, or one that got shorter is read again from the start (a `/clear` or a resume points
 * the session at another file); otherwise each read takes only the whole lines added since.
 */
export class TranscriptFollower {
  private parser: TranscriptParser;
  private location: TranscriptLocation | undefined;
  private identity: string | undefined;
  private offset = 0;
  /** The first read began inside the file: its first line is a part of one, and is skipped. */
  private torn = false;

  constructor(
    readonly sessionId: string,
    private readonly initialBytes = INITIAL_READ_BYTES,
  ) {
    this.parser = PARSERS.claude(sessionId);
  }

  /** Reads what the transcript gained; true when its rows may have changed. */
  async sync(location: TranscriptLocation | undefined): Promise<boolean> {
    const moved = location?.path !== this.location?.path || location?.format !== this.location?.format;
    if (!location) {
      if (!moved) return false;
      this.reset(undefined);
      return true;
    }
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(location.path);
    } catch {
      // not written yet (omp writes its file with its first message), or gone
      if (!moved && this.identity === undefined) return false;
      this.reset(location);
      return true;
    }
    if (!info.isFile()) return false;
    const identity = `${info.dev}:${info.ino}`;
    let changed = false;
    if (moved || identity !== this.identity || info.size < this.offset) {
      this.reset(location);
      this.identity = identity;
      this.offset = Math.max(0, info.size - this.initialBytes);
      this.torn = this.offset > 0;
      changed = true;
    }
    if (info.size > this.offset) changed = (await this.read(location.path, info.size)) || changed;
    return changed;
  }

  items(): TranscriptItem[] {
    return this.parser.items();
  }

  /** The leaf the agent moved to without a record of it yet (omp's tree navigation). */
  setLeaf(leaf: string | null | undefined): void {
    this.parser.setLeaf?.(leaf);
  }

  /** Changes whenever the rows may have: the file, and how far into it reading has come. */
  revision(): string | undefined {
    return this.identity === undefined ? undefined : `${this.location?.path ?? ""}:${this.identity}:${this.offset}`;
  }

  private reset(location: TranscriptLocation | undefined): void {
    this.location = location;
    this.identity = undefined;
    this.offset = 0;
    this.torn = false;
    this.parser = PARSERS[location?.format ?? "claude"](this.sessionId);
  }

  private async read(path: string, size: number): Promise<boolean> {
    const handle = await open(path, "r");
    let consumed = false;
    try {
      while (this.offset < size) {
        const length = Math.min(READ_CHUNK_BYTES, size - this.offset);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
        if (bytesRead <= 0) break;
        // only whole lines: a newline byte never sits inside a multi-byte UTF-8 character
        const end = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
        if (end < 0) {
          // a line longer than one chunk: wait for it no further than the whole file
          if (bytesRead < READ_CHUNK_BYTES) break;
          this.offset += bytesRead;
          this.torn = true;
          continue;
        }
        let text = buffer.subarray(0, end + 1).toString("utf8");
        this.offset += end + 1;
        if (this.torn) {
          text = text.slice(text.indexOf("\n") + 1);
          this.torn = false;
        }
        if (text) {
          this.parser.write(text);
          consumed = true;
        }
      }
    } finally {
      await handle.close();
    }
    return consumed;
  }
}

export interface HerdrTranscriptsOptions {
  /** Where a session's transcript is now; undefined for a session with no chat or no file yet. */
  locate(sessionId: string): Promise<TranscriptLocation | undefined>;
  emit(event: AgentEvent): void;
  /** Approval cards laid over the transcript's rows (approvals.ts). */
  overlay?(sessionId: string): ApprovalOverlay[];
  /** The transcript's own rows, each time they change (approvals let go of what finished). */
  onRows?(sessionId: string, rows: readonly TranscriptItem[]): void;
  pollMs?: number;
  initialBytes?: number;
  log?(message: string, error?: unknown): void;
}

/**
 * The transcripts of terminal agent sessions, read into chat rows (design §5.5). The window names
 * the sessions it shows (`watchTranscripts`); those are looked at every 250ms, and what changed
 * since the window last read goes to it as `transcript.appended` rows, a `transcript.synced`
 * window, or `transcript.invalidated` when rows went away or moved (another file).
 */
export class HerdrTranscripts {
  private readonly followers = new Map<string, TranscriptFollower>();
  private watched = new Set<string>();
  /** What the window was last given of each session, the baseline its next events are built on. */
  private readonly published = new Map<string, TranscriptItem[]>();
  /** The baseline of each session's safety-net read (getTranscriptChanges). */
  private readonly baselines = new Map<string, TranscriptItem[]>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private readonly syncing = new Map<string, Promise<{ follower: TranscriptFollower; changed: boolean }>>();
  /** Each session's rows with its approval cards laid over them, and the cards' version they hold. */
  private readonly composed = new Map<string, { version: number; items: TranscriptItem[] }>();
  private readonly overlayVersions = new Map<string, number>();

  constructor(private readonly options: HerdrTranscriptsOptions) {}

  watch(sessionIds: readonly string[]): void {
    this.watched = new Set(sessionIds);
    for (const sessionId of this.followers.keys())
      if (!this.watched.has(sessionId) && !this.published.has(sessionId)) this.followers.delete(sessionId);
    if (this.watched.size > 0 && !this.timer) {
      this.timer = setInterval(() => void this.tick(), this.options.pollMs ?? TRANSCRIPT_POLL_MS);
      this.timer.unref?.();
    } else if (this.watched.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async items(sessionId: string): Promise<TranscriptItem[]> {
    await this.synced(sessionId);
    return this.composed.get(sessionId)?.items ?? [];
  }

  /** The last row the session's chat holds now, if it was read. */
  lastRowId(sessionId: string): string | undefined {
    return this.composed.get(sessionId)?.items.at(-1)?.id;
  }

  /** The session's approval cards changed: the window hears it as it hears the transcript. */
  refresh(sessionId: string): void {
    this.overlayVersions.set(sessionId, (this.overlayVersions.get(sessionId) ?? 0) + 1);
    void this.synced(sessionId)
      .then(() => {
        // a read already past composing when the cards changed did not take them in
        if (this.composed.get(sessionId)?.version !== this.overlayVersions.get(sessionId)) return this.synced(sessionId);
        return undefined;
      })
      .catch((error: unknown) => this.options.log?.(`could not read the transcript of ${sessionId}`, error));
  }

  async page(sessionId: string, request?: TranscriptPageRequest): Promise<TranscriptPage> {
    const items = await this.items(sessionId);
    // the window now holds this read: later events are what changed after it
    this.published.set(sessionId, items);
    return selectTranscriptPage(items, request);
  }

  async changes(sessionId: string): Promise<TranscriptChange> {
    const items = await this.items(sessionId);
    const previous = this.baselines.get(sessionId);
    const next = transcriptSyncWindow(items, previous);
    this.baselines.set(sessionId, next);
    this.published.set(sessionId, items);
    return transcriptDelivery(previous, next);
  }

  async revision(sessionId: string): Promise<string | undefined> {
    const file = (await this.synced(sessionId)).follower.revision();
    const cards = this.overlayVersions.get(sessionId);
    return file === undefined && cards === undefined ? undefined : `${file ?? "none"}#${cards ?? 0}`;
  }

  forget(sessionId: string): void {
    this.composed.delete(sessionId);
    this.overlayVersions.delete(sessionId);
    this.followers.delete(sessionId);
    this.published.delete(sessionId);
    this.baselines.delete(sessionId);
    this.watched.delete(sessionId);
  }

  dispose(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.followers.clear();
    this.published.clear();
    this.baselines.clear();
  }

  /** The session's follower, caught up with its file; one read at a time per session. */
  private synced(sessionId: string): Promise<{ follower: TranscriptFollower; changed: boolean }> {
    const running = this.syncing.get(sessionId);
    if (running) return running;
    const read = (async () => {
      let follower = this.followers.get(sessionId);
      if (!follower) {
        follower = new TranscriptFollower(sessionId, this.options.initialBytes);
        this.followers.set(sessionId, follower);
      }
      const read = await follower.sync(await this.options.locate(sessionId));
      if (read) this.options.onRows?.(sessionId, follower.items());
      const version = this.overlayVersions.get(sessionId) ?? 0;
      const held = this.composed.get(sessionId);
      const changed = read || held?.version !== version;
      if (changed) {
        const items = composeRows(follower.items(), this.options.overlay?.(sessionId) ?? []);
        this.composed.set(sessionId, { version, items });
        // whoever caused the read, the window hears what changed since it last read
        this.publish(sessionId, items);
      }
      return { follower, changed };
    })().finally(() => this.syncing.delete(sessionId));
    this.syncing.set(sessionId, read);
    return read;
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const sessionId of [...this.watched]) {
        try {
          await this.synced(sessionId);
        } catch (error) {
          this.options.log?.(`could not read the transcript of ${sessionId}`, error);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private publish(sessionId: string, items: TranscriptItem[]): void {
    const previous = this.published.get(sessionId);
    // the window has not read this session: it reads a page when it shows it
    if (!previous) return;
    this.published.set(sessionId, items);
    if (previous.length > items.length || previous.some((item, index) => items[index]?.id !== item.id)) {
      this.baselines.delete(sessionId);
      this.options.emit({ type: "transcript.invalidated", sessionId });
      return;
    }
    const changed: number[] = [];
    for (let index = 0; index < previous.length; index += 1)
      if (!transcriptItemEqual(previous[index]!, items[index]!)) changed.push(index);
    for (let index = previous.length; index < items.length; index += 1) changed.push(index);
    if (changed.length === 0) return;
    if (changed.length <= APPEND_EVENT_LIMIT) {
      for (const index of changed) this.options.emit({ type: "transcript.appended", item: items[index]! });
      return;
    }
    // the window keeps what it has before the first row it already holds that changed
    const from = Math.max(0, Math.min(changed[0]!, previous.length - 1));
    this.options.emit({ type: "transcript.synced", sessionId, items: items.slice(from) });
  }
}

const FINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "denied", "cancelled"]);

/**
 * The transcript's rows with the approval cards laid over them. A card for a call the transcript
 * shows takes that row's place while it waits or until the row finishes; a card with no row of its
 * own follows the row that was last when it came, so the rows keep their order as the file grows.
 */
export function composeRows(items: readonly TranscriptItem[], overlays: readonly ApprovalOverlay[]): TranscriptItem[] {
  if (overlays.length === 0) return items.slice();
  const byId = new Map(overlays.map((overlay) => [overlay.row.id, overlay]));
  const rows = items.map((item) => {
    const overlay = byId.get(item.id);
    if (!overlay) return item;
    byId.delete(item.id);
    if (item.kind !== "tool" || overlay.released || FINAL_STATUSES.has(item.status)) return item;
    const { permissionOptions: _options, ...base } = item;
    return {
      ...base,
      status: overlay.row.status,
      ...(overlay.row.permissionOptions ? { permissionOptions: overlay.row.permissionOptions } : {}),
      ...(overlay.row.autoDecision ? { autoDecision: overlay.row.autoDecision } : {}),
    };
  });
  const placedAfter = new Map<string, string | undefined>();
  for (const overlay of overlays) {
    if (!byId.has(overlay.row.id)) continue;
    const anchor = overlay.afterId === undefined ? -1 : rows.findIndex((row) => row.id === overlay.afterId);
    if (anchor < 0) rows.push(overlay.row);
    else {
      let at = anchor + 1;
      while (at < rows.length && placedAfter.has(rows[at]!.id) && placedAfter.get(rows[at]!.id) === overlay.afterId) at += 1;
      rows.splice(at, 0, overlay.row);
    }
    placedAfter.set(overlay.row.id, overlay.afterId);
  }
  return rows;
}
