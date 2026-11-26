import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockAgentBackend } from "./mock-agent-backend";
import { DEMO_REQUEST } from "./mock-sample-readme";
import type { AgentEvent } from "./types";

describe("MockAgentBackend", () => {
  let backend: MockAgentBackend;

  beforeEach(() => {
    vi.useFakeTimers();
    backend = new MockAgentBackend();
  });

  afterEach(() => {
    backend.dispose();
    vi.useRealTimers();
  });

  it("provides isolated session and transcript snapshots", async () => {
    const firstSessions = await backend.listSessions();
    const secondSessions = await backend.listSessions();
    expect(firstSessions).not.toBe(secondSessions);
    expect(firstSessions[0]).not.toBe(secondSessions[0]);

    const firstTranscript = await backend.getTranscript("agent-control");
    const secondTranscript = await backend.getTranscript("agent-control");
    expect(firstTranscript).not.toBe(secondTranscript);
    expect(firstTranscript[0]).not.toBe(secondTranscript[0]);
  });

  it("creates runtime-neutral sessions and emits creation events", async () => {
    const events: AgentEvent[] = [];
    backend.subscribe((event) => events.push(event));

    const session = await backend.createSession({
      runtime: "hermes",
      title: "Daily brief",
      workspace: "/tmp/daily",
      isolation: "workspace",
    });

    expect(session).toMatchObject({
      title: "Daily brief",
      runtime: "hermes",
      status: "idle",
    });
    expect(events).toEqual([{ type: "session.created", session }]);
    expect(await backend.getTranscript(session.id)).toEqual([]);
  });

  it("streams a mock reply and returns the session to idle", async () => {
    const events: AgentEvent[] = [];
    backend.subscribe((event) => events.push(event));

    await backend.sendMessage("agent-control", {
      text: "Connect the runtime",
      images: [],
      files: [],
    });
    await vi.runAllTimersAsync();

    const transcript = await backend.getTranscript("agent-control");
    expect(transcript.at(-2)).toMatchObject({
      kind: "message",
      role: "user",
      content: "Connect the runtime",
    });
    expect(transcript.at(-1)).toMatchObject({
      kind: "message",
      role: "assistant",
      content: expect.stringContaining("GJC와 Hermes"),
      streaming: false,
    });
    expect(events.some((event) => event.type === "message.delta")).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.updated",
        session: expect.objectContaining({ status: "idle" }),
      }),
    );
  });

  it("keeps image attachments in the visible user transcript", async () => {
    await backend.sendMessage("agent-control", {
      text: "Inspect this screenshot",
      images: [
        {
          id: "image-1",
          name: "screen.png",
          mimeType: "image/png",
          token: "image-capability",
          data: "aW1hZ2U=",
        },
      ],
      files: [],
    });

    const transcript = await backend.getTranscript("agent-control");
    expect(transcript.at(-1)).toMatchObject({
      kind: "message",
      role: "user",
      images: [{ name: "screen.png", mimeType: "image/png" }],
    });
  });

  it("cancels scheduled output and resolves approval requests", async () => {
    const events: AgentEvent[] = [];
    backend.subscribe((event) => events.push(event));

    await backend.sendMessage("agent-control", {
      text: "Stop this run",
      images: [],
      files: [],
    });
    await backend.cancelRun("agent-control");
    await vi.runAllTimersAsync();

    const transcript = await backend.getTranscript("agent-control");
    expect(
      transcript.some(
        (item) => item.kind === "message" && item.content === "Stop this run",
      ),
    ).toBe(true);
    expect(
      transcript.some(
        (item) =>
          item.kind === "message" &&
          item.role === "assistant" &&
          item.createdAt === "now",
      ),
    ).toBe(false);

    await backend.resolveToolCall("tool-approval-1", {
      optionId: "allow_once",
    });
    expect(events.at(-1)).toMatchObject({
      type: "tool.updated",
      tool: {
        id: "tool-approval-1",
        status: "approved",
        output: "Approved for this run",
      },
    });
  });

  it("renames and deletes sessions through observable events", async () => {
    const events: AgentEvent[] = [];
    backend.subscribe((event) => events.push(event));

    await backend.renameSession("agent-control", "Renamed agent");
    expect(events.at(-1)).toMatchObject({
      type: "session.updated",
      session: { id: "agent-control", title: "Renamed agent" },
    });

    await backend.deleteSession("agent-control");
    expect(events.at(-1)).toEqual({
      type: "session.deleted",
      sessionId: "agent-control",
    });
    expect(
      (await backend.listSessions()).some(
        (session) => session.id === "agent-control",
      ),
    ).toBe(false);
  });

  it("exposes deterministic fork parent context", async () => {
    const fork = await backend.forkSession({
      sourceSessionId: "agent-control",
      title: "Forked",
    });
    expect(fork.title).toBe("Forked");
    expect((await backend.getTranscript(fork.id)).at(-1)).toMatchObject({
      kind: "notice",
      content: expect.stringContaining("agent-control"),
    });
  });

  it("transitions mock git state and keeps file attachments visible", async () => {
    await backend.sendMessage("agent-control", {
      text: "Review files",
      images: [],
      files: [
        {
          id: "f1",
          name: "notes.txt",
          mimeType: "text/plain",
          size: 4,
          token: "file-capability",
        },
      ],
    });
    expect((await backend.getTranscript("agent-control")).at(-1)).toMatchObject(
      { content: expect.stringContaining("notes.txt") },
    );
    await backend.stageFiles("agent-control", ["README.md"]);
    expect(
      (await backend.getGitStatus("agent-control")).files[0],
    ).toMatchObject({ index: "M" });
    await backend.commitChanges("agent-control", "save");
    expect((await backend.getGitStatus("agent-control")).ahead).toBe(1);
    expect((await backend.pushChanges("agent-control")).ahead).toBe(0);
  });
});

describe("MockAgentBackend README sample", () => {
  let backend: MockAgentBackend;

  beforeEach(() => {
    vi.useFakeTimers();
    backend = new MockAgentBackend("readme");
  });

  afterEach(() => {
    backend.dispose();
    vi.useRealTimers();
  });

  it("serves English sessions and offers every agent, while the default stays as it was", async () => {
    expect((await backend.listSessions()).map((session) => session.title)).toEqual([
      "Add retry with backoff",
      "Fix flaky checkout test",
      "Refactor auth middleware",
      "Write release notes for 2.4",
      "Upgrade to React 20",
    ]);
    expect(backend.terminalSessions).toBe(true);
    expect(new MockAgentBackend().terminalSessions).toBe(false);
    expect((await new MockAgentBackend("readme-start").listSessions())).toEqual([]);
  });

  it("runs the scripted request: it asks a question, then finishes with its goal at 3/3", async () => {
    const events: AgentEvent[] = [];
    backend.subscribe((event) => events.push(event));
    expect(await backend.getGoal("retry-backoff")).toMatchObject({ completed: 0, total: 3 });

    await backend.sendMessage("retry-backoff", { text: DEMO_REQUEST, images: [], files: [] });
    await vi.advanceTimersByTimeAsync(6_000);

    const question = (await backend.getTranscript("retry-backoff")).find((item) => item.kind === "question");
    expect(question).toMatchObject({ status: "pending", answerable: true });
    expect((await backend.listSessions()).find((session) => session.id === "retry-backoff")?.status).toBe("waiting");
    expect(await backend.getGoal("retry-backoff")).toMatchObject({ completed: 1 });

    await backend.answerQuestion("retry-backoff", "demo-question", {
      selected: ["Exponential backoff with jitter"],
    });
    await vi.runAllTimersAsync();

    expect(await backend.getGoal("retry-backoff")).toMatchObject({ completed: 3, total: 3, mode: "complete" });
    expect((await backend.listSessions()).find((session) => session.id === "retry-backoff")?.status).toBe("idle");
    const transcript = await backend.getTranscript("retry-backoff");
    expect(transcript.filter((item) => item.kind === "tool").map((item) => item.status)).toEqual(
      Array(5).fill("completed"),
    );
    expect(transcript.at(-1)).toMatchObject({ kind: "message", role: "assistant", streaming: false });
    expect(events.some((event) => event.type === "tool.updated")).toBe(true);
  });

  it("answers any other request with its canned reply", async () => {
    await backend.sendMessage("release-notes", { text: "Add a section", images: [], files: [] });
    await vi.runAllTimersAsync();
    expect((await backend.getTranscript("release-notes")).at(-1)).toMatchObject({
      role: "assistant",
      content: expect.stringContaining("Done."),
    });
  });
});
