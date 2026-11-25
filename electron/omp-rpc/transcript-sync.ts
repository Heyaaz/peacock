import type { AgentEvent, TranscriptItem } from "../../shared/agent-contract.js";
import { transcriptItemEqual } from "../../shared/transcript-item-equal.js";

/** More changed rows than this at once travel as one synced window instead of one event each. */
const APPEND_EVENT_LIMIT = 16;

/**
 * What a window that holds `previous` must hear to hold `next`. Rows only added or changed in
 * place go as `transcript.appended`; rows replaced (a live turn read back from the session file
 * under the file's ids) go as one `transcript.synced` tail that starts at the last row both share,
 * which the window keeps everything before (mergeTranscriptTail), or as the whole list when they
 * share no first row.
 */
export function transcriptSyncEvents(sessionId: string, previous: readonly TranscriptItem[] | undefined, next: readonly TranscriptItem[]): AgentEvent[] {
  if (!previous) return [];
  let shared = 0;
  while (shared < previous.length && shared < next.length && previous[shared]!.id === next[shared]!.id) shared += 1;
  if (shared === previous.length) {
    const changed: number[] = [];
    for (let index = 0; index < previous.length; index += 1) if (!transcriptItemEqual(previous[index]!, next[index]!)) changed.push(index);
    for (let index = previous.length; index < next.length; index += 1) changed.push(index);
    if (changed.length === 0) return [];
    if (changed.length <= APPEND_EVENT_LIMIT) return changed.map((index) => ({ type: "transcript.appended", item: next[index]! }));
    const from = Math.max(0, Math.min(changed[0]!, previous.length - 1));
    return [{ type: "transcript.synced", sessionId, items: next.slice(from) }];
  }
  return [{ type: "transcript.synced", sessionId, items: shared > 0 ? next.slice(shared - 1) : next.slice() }];
}
