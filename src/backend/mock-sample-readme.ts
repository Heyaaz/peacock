import type { MockSample, MockScriptHost } from "./mock-agent-backend";
import type { AgentSession, QuestionActivity, ToolActivity, TranscriptItem } from "./types";
import type {
  ContextBreakdown,
  GoalSnapshot,
  SessionTreeEntry,
  SessionUsageStats,
  SessionCapabilities,
} from "../../shared/agent-contract";

/**
 * The English sample the README clips are recorded on (`?backend=mock&sample=readme`).
 *
 * It is invented end to end: a few repositories, a few sessions, and one scripted request
 * (`DEMO_REQUEST`) that reads code, runs the tests, asks which retry policy to use, edits and
 * finishes while its goal ticks to 3/3. Nothing here touches a real session.
 * `scripts/record-readme-clips.mjs` records on it; the default mock stays Korean.
 */
export const DEMO_REQUEST = "Add retry with exponential backoff to the router client";

const API = "/Users/dev/api-server";
const SHOP = "/Users/dev/web-shop";

const modelOptions = [
  { value: "codex-eco", name: "Codex Eco", group: "Built-in profiles" },
  { value: "codex-medium", name: "Codex Medium", group: "Built-in profiles" },
  { value: "codex-pro", name: "Codex Pro", group: "Built-in profiles" },
  ...[
    ["openai-codex", "gpt-6.1", "GPT-6.1"],
    ["openai-codex", "gpt-6.1-mini", "GPT-6.1 mini"],
    ["google", "gemini-3-pro", "Gemini 3 Pro"],
    ["google", "gemini-3-flash", "Gemini 3 Flash"],
    ["xai", "grok-4.7", "Grok 4.7"],
    ["moonshot", "kimi-k3", "Kimi K3"],
  ].map(([provider, id, name]) => ({
    value: `${provider}/${id}`,
    name: name!,
    group: provider!,
    kind: "model" as const,
  })),
];

function gjcSession(fields: Partial<AgentSession> & Pick<AgentSession, "id" | "title" | "workspace">): AgentSession {
  return {
    subtitle: fields.workspace.split("/").at(-1) ?? "",
    runtime: "gjc",
    status: "idle",
    updatedAt: "now",
    pinned: false,
    unread: false,
    accent: "#ff8a34",
    ownership: "gajae",
    attachment: "attached",
    runtimeState: {
      permissionHandling: "prompt",
      mcpServers: [],
      skills: [],
      rules: [],
      tools: [],
      refreshedAt: "now",
    },
    usagePercent: 3.4,
    modelDisplay: "GPT-5.6 Sol",
    ...fields,
  };
}

// What omp's chat offers (shared/agent-catalog.ts, `chatCapabilities`); suggestions come
// from one side question per finished turn, as in the real chat.
const ompCapabilities: Partial<SessionCapabilities> = {
  send: true,
  cancel: true,
  approvals: true,
  questions: true,
  goal: true,
  fork: true,
  compact: true,
  sideQuestion: true,
  suggestion: true,
  modelConfig: true,
  thinking: true,
  git: true,
  attachments: true,
  streaming: true,
  contextBreakdown: true,
  subagentControl: true,
  queueEdit: true,
  runtimeModes: true,
  exportHtml: true,
  sessionTree: true,
  userShell: true,
};

const sessions: AgentSession[] = [
  gjcSession({
    id: "retry-backoff",
    title: "Add retry with backoff",
    workspace: API,
    updatedAt: "now",
  }),
  gjcSession({
    id: "flaky-checkout",
    title: "Fix flaky checkout test",
    workspace: SHOP,
    status: "waiting",
    updatedAt: "1m",
    unread: true,
    usagePercent: 11.8,
  }),
  gjcSession({
    id: "auth-middleware",
    title: "Refactor auth middleware",
    subtitle: "api-server",
    workspace: `${API}.gajae-worktrees/auth-split`,
    // a managed worktree is what the changed-files panel reads git from
    worktree: {
      sourceWorkspace: API,
      path: `${API}.gajae-worktrees/auth-split`,
      branch: "feat/auth-split",
      managed: true,
    },
    status: "running",
    updatedAt: "4m",
    usagePercent: 27.5,
  }),
  gjcSession({
    id: "release-notes",
    title: "Write release notes for 2.4",
    workspace: SHOP,
    updatedAt: "1h",
    usagePercent: 6.2,
  }),
  // an omp chat: its turn runs, and its status line reports what it does and how full its context is
  gjcSession({
    id: "omp-react",
    title: "Upgrade to React 20",
    workspace: SHOP,
    runtime: "omp-rpc",
    agentKind: "omp",
    surfaces: ["chat"],
    capabilities: ompCapabilities,
    status: "running",
    updatedAt: "2m",
    usagePercent: 41,
    modelDisplay: "Gemini 3 Pro",
    liveStatus: {
      turnStartedAtMs: Date.now() - 42_000,
      activity: "Running npm install",
      todo: [
        {
          name: "Upgrade",
          tasks: [
            { content: "Bump react and react-dom", status: "completed" },
            { content: "Fix the removed APIs", status: "in_progress" },
            { content: "Run the test suite", status: "pending" },
          ],
        },
      ],
      contextPercent: 41,
      contextTokens: 82_000,
      contextWindow: 200_000,
      queued: [],
      modes: [
        { id: "fast", enabled: false },
        { id: "autoCompaction", enabled: true },
        { id: "autoRetry", enabled: true },
      ],
    },
  }),
];

const approvalOptions = [
  { optionId: "allow_once", kind: "allow_once" as const, name: "Allow once" },
  { optionId: "allow_always", kind: "allow_always" as const, name: "Always allow" },
  { optionId: "reject_once", kind: "reject_once" as const, name: "Reject once" },
  { optionId: "reject_always", kind: "reject_always" as const, name: "Always reject" },
];

const codeOutput = (text: string) => JSON.stringify({ content: [{ type: "text", text }] });

const transcripts: Record<string, TranscriptItem[]> = {
  "retry-backoff": [],
  "flaky-checkout": [
    {
      id: "flaky-1",
      kind: "message",
      sessionId: "flaky-checkout",
      role: "user",
      content: "The checkout test fails about one run in five. Find out why.",
      createdAt: "10:12",
    },
    {
      id: "flaky-2",
      kind: "tool",
      sessionId: "flaky-checkout",
      name: "read",
      description: "Read tests/checkout.spec.ts",
      targetPath: "tests/checkout.spec.ts",
      status: "completed",
      createdAt: "10:12",
    },
    {
      id: "flaky-3",
      kind: "message",
      sessionId: "flaky-checkout",
      role: "assistant",
      content:
        "The cart fixture resolves after the payment stub is installed, so the test sometimes charges an empty cart. Before I change the fixture I want to see what is uncommitted in the working tree.",
      createdAt: "10:13",
    },
    {
      id: "flaky-4",
      kind: "tool",
      sessionId: "flaky-checkout",
      name: "bash",
      description: "Check the working tree",
      command: JSON.stringify({ command: "git status --short" }),
      status: "approval-required",
      permissionOptions: approvalOptions,
      createdAt: "10:13",
    },
  ],
  "auth-middleware": [
    {
      id: "auth-1",
      kind: "message",
      sessionId: "auth-middleware",
      role: "user",
      content: "Split the auth middleware into token parsing and session lookup.",
      createdAt: "10:20",
    },
    {
      id: "auth-2",
      kind: "message",
      sessionId: "auth-middleware",
      role: "assistant",
      content: "I'll read how the middleware is used first, then move token parsing into its own module.",
      createdAt: "10:20",
    },
    {
      id: "auth-3",
      kind: "tool",
      sessionId: "auth-middleware",
      name: "read",
      description: "Read src/auth/middleware.ts",
      targetPath: "src/auth/middleware.ts",
      status: "completed",
      createdAt: "10:21",
    },
    {
      id: "auth-4",
      kind: "tool",
      sessionId: "auth-middleware",
      name: "bash",
      description: "Run the auth tests",
      command: JSON.stringify({ command: "npm test -- auth" }),
      status: "running",
      createdAt: "10:22",
    },
  ],
  "omp-react": [
    {
      id: "omp-1",
      kind: "message",
      sessionId: "omp-react",
      role: "user",
      content: "Upgrade the storefront to React 20 and fix whatever breaks.",
      createdAt: "10:30",
    },
    {
      id: "omp-2",
      kind: "message",
      sessionId: "omp-react",
      role: "assistant",
      content: "I'll bump the packages first, then fix what the type checker reports.",
      createdAt: "10:30",
    },
    {
      id: "omp-3",
      kind: "tool",
      sessionId: "omp-react",
      name: "read",
      description: "Read package.json",
      targetPath: "package.json",
      status: "completed",
      createdAt: "10:31",
    },
    {
      id: "omp-4",
      kind: "tool",
      sessionId: "omp-react",
      name: "edit",
      description: "Bump react and react-dom to 20",
      targetPath: "package.json",
      diff: [
        "@@ -12,8 +12,8 @@",
        " 12|  \"dependencies\": {",
        "-13|    \"react\": \"^19.2.0\",",
        "-14|    \"react-dom\": \"^19.2.0\",",
        "+13|    \"react\": \"^20.0.0\",",
        "+14|    \"react-dom\": \"^20.0.0\",",
        " 15|    \"zustand\": \"^5.0.0\"",
        " 16|  }",
      ].join("\n"),
      status: "completed",
      createdAt: "10:31",
    },
    {
      id: "omp-5",
      kind: "tool",
      sessionId: "omp-react",
      name: "bash",
      description: "Install the new versions",
      command: JSON.stringify({ command: "npm install" }),
      status: "running",
      createdAt: "10:32",
    },
  ],
  "release-notes": [
    {
      id: "notes-1",
      kind: "message",
      sessionId: "release-notes",
      role: "user",
      content: "Show how a release goes from a tag to published notes, as a diagram.",
      createdAt: "09:40",
    },
    {
      id: "notes-2",
      kind: "message",
      sessionId: "release-notes",
      role: "assistant",
      content:
        "A release goes from a tag to published notes in three steps. CI builds the tag, the notes are drafted from merged pull requests, and a maintainer publishes them.\n\n```mermaid\nflowchart LR\n  Tag[Git tag v2.4] --> CI[CI build]\n  CI --> Draft[Draft notes]\n  Draft --> Publish[Publish on GitHub]\n```",
      createdAt: "09:41",
    },
  ],
};

function retryGoal(completed: number, mode: GoalSnapshot["mode"] = "active"): GoalSnapshot {
  const tasks = [
    "Read how RouterClient sends requests",
    "Retry 5xx and network errors with backoff",
    "Cover the retry path with tests",
  ];
  return {
    enabled: true,
    mode,
    objective: "Make the router client resilient",
    completed,
    total: tasks.length,
    tasks: tasks.map((content, index) => ({
      content,
      status: index < completed ? "completed" : index === completed ? "in_progress" : "pending",
    })),
  };
}

const goals: Record<string, GoalSnapshot> = {
  "retry-backoff": retryGoal(0),
  "auth-middleware": {
    enabled: true,
    mode: "active",
    objective: "Split auth into token and session modules",
    completed: 2,
    total: 4,
    tasks: [
      { content: "Read the middleware and its callers", status: "completed" },
      { content: "Move token parsing into token.ts", status: "completed" },
      { content: "Keep session lookup in middleware.ts", status: "in_progress" },
      { content: "Run the auth tests", status: "pending" },
    ],
  },
};

/** The scripted request: read, test, ask, edit, test, finish. */
function runDemo(host: MockScriptHost, sessionId: string): void {
  const at = (delay: number, task: () => void) => host.after(sessionId, delay, task);
  const tool = (fields: Pick<ToolActivity, "id" | "name" | "description"> & Partial<ToolActivity>): ToolActivity => ({
    kind: "tool",
    sessionId,
    status: "running",
    createdAt: "now",
    ...fields,
  });

  at(500, () =>
    host.append({
      id: "demo-thought",
      kind: "thought",
      sessionId,
      content: "Read how RouterClient sends a request before deciding where a retry belongs.",
      createdAt: "now",
      streaming: false,
    }),
  );
  at(1500, () =>
    host.append(
      tool({
        id: "demo-read",
        name: "read",
        description: "Read src/router/client.ts",
        targetPath: "src/router/client.ts",
      }),
    ),
  );
  at(2300, () => {
    host.patchTool(sessionId, "demo-read", {
      status: "completed",
      output: codeOutput(
        [
          "export class RouterClient {",
          "  async send(request: RouterRequest) {",
          "    const response = await this.transport.fetch(request);",
          "    if (!response.ok) throw new RouterError(response.status);",
          "    return response.json();",
          "  }",
          "}",
        ].join("\n"),
      ),
    });
    host.setGoal(sessionId, retryGoal(1));
  });
  at(2700, () =>
    host.append(
      tool({
        id: "demo-test-1",
        name: "bash",
        description: "Run the router tests",
        command: JSON.stringify({ command: "npm test -- router" }),
      }),
    ),
  );
  at(4400, () =>
    host.patchTool(sessionId, "demo-test-1", {
      status: "completed",
      output: "✓ 42 passed (1.8s)",
    }),
  );
  at(5000, () => {
    const question: QuestionActivity = {
      id: "demo-question",
      kind: "question",
      sessionId,
      question: "Which retry policy should RouterClient use?",
      options: [
        { label: "Exponential backoff with jitter", recommended: true },
        { label: "Fixed 1s delay, 3 attempts" },
        { label: "No retry, surface the error" },
      ],
      multi: false,
      status: "pending",
      createdAt: "now",
      answerable: true,
      tag: "pending",
      expectedSessionId: sessionId,
    };
    host.append(question);
    host.setStatus(sessionId, "waiting");
  });
}

function finishDemo(host: MockScriptHost, sessionId: string): void {
  const at = (delay: number, task: () => void) => host.after(sessionId, delay, task);
  host.setStatus(sessionId, "running");
  at(800, () =>
    host.append({
      id: "demo-edit-1",
      kind: "tool",
      sessionId,
      name: "edit",
      description: "Retry 5xx responses and network errors with backoff",
      targetPath: "src/router/client.ts",
      diff: [
        "@@ -1,9 +1,27 @@",
        " 1|export class RouterClient {",
        "+2|  private readonly maxAttempts = 4;",
        "+3|",
        " 4|  async send(request: RouterRequest) {",
        "-5|    const response = await this.transport.fetch(request);",
        "-6|    if (!response.ok) throw new RouterError(response.status);",
        "-7|    return response.json();",
        "+5|    for (let attempt = 1; ; attempt += 1) {",
        "+6|      try {",
        "+7|        const response = await this.transport.fetch(request);",
        "+8|        if (response.status < 500) return response.json();",
        "+9|        if (attempt === this.maxAttempts) throw new RouterError(response.status);",
        "+10|      } catch (error) {",
        "+11|        if (!isNetworkError(error) || attempt === this.maxAttempts) throw error;",
        "+12|      }",
        "+13|      await sleep(backoff(attempt));",
        "+14|    }",
        " 15|  }",
        " 16|}",
      ].join("\n"),
      status: "running",
      createdAt: "now",
    }),
  );
  at(1700, () => {
    host.patchTool(sessionId, "demo-edit-1", { status: "completed" });
    host.setGoal(sessionId, retryGoal(2));
  });
  at(2000, () =>
    host.append({
      id: "demo-edit-2",
      kind: "tool",
      sessionId,
      name: "edit",
      description: "Cover the retry path with tests",
      targetPath: "src/router/client.test.ts",
      diff: [
        "@@ -20,3 +20,14 @@",
        " 20|  });",
        "+21|",
        "+22|  it(\"retries a 503 with backoff\", async () => {",
        "+23|    const client = clientFailingTimes(2, 503);",
        "+24|    await expect(client.send(request)).resolves.toEqual(ok);",
        "+25|    expect(client.attempts).toBe(3);",
        "+26|  });",
        "+27|",
        "+28|  it(\"gives up after four attempts\", async () => {",
        "+29|    const client = clientFailingTimes(10, 503);",
        "+30|    await expect(client.send(request)).rejects.toThrow(RouterError);",
        "+31|    expect(client.attempts).toBe(4);",
        "+32|  });",
        " 33|});",
      ].join("\n"),
      status: "running",
      createdAt: "now",
    }),
  );
  at(2800, () => host.patchTool(sessionId, "demo-edit-2", { status: "completed" }));
  at(3100, () =>
    host.append({
      id: "demo-test-2",
      kind: "tool",
      sessionId,
      name: "bash",
      description: "Run the router tests",
      command: JSON.stringify({ command: "npm test -- router" }),
      status: "running",
      createdAt: "now",
    }),
  );
  at(4700, () => {
    host.patchTool(sessionId, "demo-test-2", {
      status: "completed",
      output: "✓ 45 passed (2.1s)",
    });
    host.setGoal(sessionId, retryGoal(3));
  });
  at(5200, () =>
    host.streamReply(
      sessionId,
      [
        "Done. `RouterClient.send` now retries 5xx responses and network errors ",
        "with exponential backoff and jitter: up to 4 attempts, capped at 8s. ",
        "I added two tests for the retry path, and all 45 router tests pass.",
      ],
      () => host.setGoal(sessionId, retryGoal(3, "complete")),
    ),
  );
}

export const readmeSample: MockSample = {
  sessions,
  transcripts,
  modelOptions,
  goal: { enabled: false, completed: 0, total: 0 },
  goals,
  terminalSessions: true,
  workspace: API,
  sideAnswer: () =>
    [
      "Here is the scope of the refactor so far. This answer comes from the session's context and is not saved to the transcript.",
      "",
      "| File | Change |",
      "| --- | --- |",
      "| src/auth/token.ts | New: token parsing |",
      "| src/auth/middleware.ts | Keeps only session lookup |",
      "| src/auth/middleware.test.ts | Split to match |",
      "",
      "- [x] The main session keeps running",
      "- [x] Nothing is added to the transcript",
      "- [ ] Ask in the main thread to act on it",
    ].join("\n"),
  suggestion: "Add a test for the expired-token case",
  reply: [
    "Done. ",
    "I added it to the draft and kept the layout of the earlier notes.",
  ],
  ruleFollowUp: () => ({
    description: "Check the branch",
    output: "## main...origin/main\n M src/checkout/cart.ts\n M tests/checkout.spec.ts",
  }),
  diffFiles: (sessionId) => [
    {
      id: `${sessionId}-diff-1`,
      path: "src/auth/middleware.ts",
      patch: [
        "--- a/src/auth/middleware.ts",
        "+++ b/src/auth/middleware.ts",
        "@@ -1,14 +1,12 @@",
        " import type { Request, Response, NextFunction } from \"express\";",
        "+import { parseToken } from \"./token\";",
        " ",
        " export async function requireSession(req: Request, res: Response, next: NextFunction) {",
        "-  const header = req.headers.authorization ?? \"\";",
        "-  const [scheme, value] = header.split(\" \");",
        "-  if (scheme !== \"Bearer\" || !value) return res.sendStatus(401);",
        "+  const token = parseToken(req.headers.authorization);",
        "+  if (!token) return res.sendStatus(401);",
        "+  if (token.expired) return res.status(401).json({ error: \"token_expired\" });",
        "   const session = await sessions.find(value);",
        "+  if (!session) return res.sendStatus(401);",
        "   req.session = session;",
        "   next();",
        " }",
      ].join("\n") + "\n",
    },
    {
      id: `${sessionId}-diff-2`,
      path: "src/auth/token.ts",
      patch: [
        "--- /dev/null",
        "+++ b/src/auth/token.ts",
        "@@ -0,0 +1,8 @@",
        "+export function parseToken(header: string | undefined) {",
        "+  const [scheme, value] = (header ?? \"\").split(\" \");",
        "+  if (scheme !== \"Bearer\" || !value) return null;",
        "+  return { value, expired: isExpired(value) };",
        "+}",
      ].join("\n") + "\n",
    },
  ],
  subagents: () => [],
  contextBreakdown: (sessionId): ContextBreakdown | null =>
    sessionId === "omp-react"
      ? {
          model: "Gemini 3 Pro",
          contextWindow: 200_000,
          usedTokens: 82_000,
          categories: [
            { id: "systemPrompt", label: "System prompt", tokens: 3_200 },
            { id: "systemTools", label: "System tools", tokens: 11_400 },
            { id: "instructionFiles", label: "Instruction files", tokens: 2_100 },
            { id: "skills", label: "Skills", tokens: 1_800 },
            { id: "messages", label: "Messages", tokens: 63_500 },
          ],
          autoCompactBufferTokens: 20_000,
          freeTokens: 98_000,
          autoCompactAtTokens: 180_000,
          notes: [],
        }
      : null,
  sessionStats: (): SessionUsageStats => ({
    costUsd: 0.84,
    tokens: { input: 61_200, output: 9_800, reasoning: 5_100, cacheRead: 412_000, cacheWrite: 21_300, total: 509_400 },
    requests: 23,
    userMessages: 3,
    toolCalls: 31,
    premiumRequests: 0,
  }),
  sessionTree: (): SessionTreeEntry[] => [
    { id: "t1", role: "user", text: "Upgrade the storefront to React 20 and fix whatever breaks.", depth: 0, onPath: true, current: false, rewritable: true },
    { id: "t2", role: "assistant", text: "I'll bump the packages first, then fix what the type checker reports.", depth: 0, onPath: true, current: false },
    { id: "t3", role: "user", text: "Also drop the legacy context API.", depth: 0, onPath: true, current: true, rewritable: true },
    { id: "t4", role: "user", text: "Keep the legacy context API for now.", depth: 1, onPath: false, current: false, rewritable: true },
    { id: "t5", role: "assistant", text: "Leaving the legacy context API in place and upgrading around it.", depth: 1, onPath: false, current: false },
  ],
  script: {
    send(host, sessionId, text) {
      if (sessionId !== "retry-backoff" || text !== DEMO_REQUEST) return false;
      runDemo(host, sessionId);
      return true;
    },
    answer(host, sessionId, gateId) {
      if (sessionId === "retry-backoff" && gateId === "demo-question") finishDemo(host, sessionId);
    },
  },
};

/** The same sample before any session exists: the empty window with its agent chips. */
export const readmeStartSample: MockSample = {
  ...readmeSample,
  sessions: [],
  transcripts: {},
  goals: {},
};
