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
    return (await this.synced(sessionId)).follower.items();
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
    return (await this.synced(sessionId)).follower.revision();
  }

  forget(sessionId: string): void {
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
      const changed = await follower.sync(await this.options.locate(sessionId));
      // whoever caused the read, the window hears what changed since it last read
      if (changed) this.publish(sessionId, follower.items());
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
