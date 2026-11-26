import { execFile as execFileCallback } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { PullRequestService } from "./pull-request-service.js";
import type { CommandOptions, CommandResult, CommandRunner } from "./repo-service.js";

const execFile = promisify(execFileCallback);

/**
 * `gh` is only ever a fake here: the service is given an executable name nothing on disk answers
 * to, and the runner below sends exactly that name to a script. A call to any other program that is
 * not `git` is a failure, so no test can reach GitHub or run a real `gh`.
 */
const GH = "/nonexistent/never-run/gh";

const sandboxes: string[] = [];

afterEach(() => {
  for (const directory of sandboxes.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  return stdout;
}

interface RepoOptions {
  /** The `origin` URL; none when absent. */
  remote?: string | null;
  branch?: string;
  /** The branch's commits are on the remote (as the remote-tracking ref says). */
  pushed?: boolean;
  /** One more commit that is not on the remote. */
  unpushed?: boolean;
}

async function repository(options: RepoOptions = {}): Promise<string> {
  const parent = realpathSync(mkdtempSync(path.join(tmpdir(), "gajae-pull-request-")));
  sandboxes.push(parent);
  const repo = path.join(parent, "repo");
  mkdirSync(repo);
  await git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "tracked.txt"), "tracked\n");
  await git(repo, "add", "tracked.txt");
  await git(repo, "commit", "-q", "-m", "init");
  const remote = options.remote === undefined ? "https://github.com/acme/widgets.git" : options.remote;
  if (remote) await git(repo, "remote", "add", "origin", remote);
  const branch = options.branch ?? "work/x";
  if (branch !== "main") await git(repo, "checkout", "-q", "-b", branch);
  writeFileSync(path.join(repo, "widget.txt"), "widget\n");
  await git(repo, "add", "widget.txt");
  await git(repo, "commit", "-q", "-m", "Add widget", "-m", "Longer explanation.");
  if (options.pushed !== false && remote) await git(repo, "update-ref", `refs/remotes/origin/${branch}`, "HEAD");
  if (options.unpushed) {
    writeFileSync(path.join(repo, "later.txt"), "later\n");
    await git(repo, "add", "later.txt");
    await git(repo, "commit", "-q", "-m", "Later");
  }
  return repo;
}

interface GhCall {
  args: string[];
  options: CommandOptions | undefined;
}

type GhScript = (args: string[], options: CommandOptions | undefined) => CommandResult | string;

function harness(script: GhScript, tempRoot?: string) {
  const calls: GhCall[] = [];
  const run: CommandRunner = async (file, args, options) => {
    if (file === GH) {
      calls.push({ args: [...args], options });
      const answer = script([...args], options);
      return typeof answer === "string" ? { stdout: answer, stderr: "" } : answer;
    }
    if (file !== "git") throw new Error(`unexpected program ${file}`);
    return execFile(file, [...args]);
  };
  const service = new PullRequestService({ ghExecutable: GH, run, ...(tempRoot ? { tempRoot } : {}) });
  const created = () => calls.filter((call) => call.args[0] === "pr" && call.args[1] === "create");
  return { service, calls, created };
}

const repoInfo = (info: Record<string, unknown>) => JSON.stringify(info);
const own = repoInfo({ isFork: false, parent: null, defaultBranchRef: { name: "main" } });

const rollup = [{ status: "COMPLETED", conclusion: "SUCCESS" }];
const listed = (number: number, extra: Record<string, unknown> = {}) => ({
  number,
  title: `PR ${number}`,
  state: "OPEN",
  isDraft: false,
  url: `https://github.com/acme/widgets/pull/${number}`,
  author: { login: "me" },
  headRefName: "work/x",
  baseRefName: "main",
  reviewDecision: "",
  updatedAt: "2026-11-26T00:00:00Z",
  statusCheckRollup: rollup,
  isCrossRepository: false,
  headRepositoryOwner: { login: "acme" },
  ...extra,
});

/** The usual repository answers, with the pull request list and creation left to each test. */
function github(parts: { list?: unknown[]; create?: (args: string[]) => string; view?: unknown; repos?: Record<string, string> }): GhScript {
  const repos = parts.repos ?? { "acme/widgets": own };
  return (args) => {
    if (args[0] === "repo" && args[1] === "view") {
      const info = repos[args[2]];
      if (info === undefined) throw new Error(`gh: Could not resolve to a Repository (${args[2]})`);
      return info;
    }
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify(parts.list ?? []);
    if (args[0] === "pr" && args[1] === "create") {
      if (!parts.create) throw new Error("this test does not create a pull request");
      return parts.create(args);
    }
    if (args[0] === "pr" && args[1] === "view") {
      if (parts.view === undefined) throw new Error("gh: no pull request view in this test");
      return JSON.stringify(parts.view);
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
}

describe("finding the pull request of a session's branch", () => {
  it("reports where a new one would go and what it could start with", async () => {
    const repo = await repository();
    const { service, calls } = harness(github({}));
    const result = await service.findPull(repo);
    expect(result).toEqual({
      state: "ok",
      value: {
        target: { repo: "acme/widgets", base: "main", branch: "work/x", head: "work/x", fork: false },
        pull: null,
        pushed: true,
        draft: { title: "Add widget", body: "Longer explanation." },
      },
    });
    expect(calls[0].args.slice(0, 3)).toEqual(["repo", "view", "acme/widgets"]);
    expect(calls[1].args.slice(0, 4)).toEqual(["pr", "list", "--repo", "acme/widgets"]);
    expect(calls).toHaveLength(2);
    const list = calls[1].args;
    expect(list.slice(list.indexOf("--head"), list.indexOf("--head") + 2)).toEqual(["--head", "work/x"]);
    expect(list[list.indexOf("--state") + 1]).toBe("open");
  });

  it("never lets gh prompt, runs it in the worktree and pins the host", async () => {
    const repo = await repository();
    const { service, calls } = harness(github({}));
    await service.findPull(repo);
    for (const call of calls) {
      expect(call.options?.cwd).toBe(repo);
      expect(call.options?.env).toMatchObject({ GH_PROMPT_DISABLED: "1", GH_HOST: "github.com", GIT_TERMINAL_PROMPT: "0" });
    }
  });

  it("returns the open pull request with its CI, and ignores one from a fork that shares the branch name", async () => {
    const repo = await repository();
    const { service } = harness(
      github({
        list: [
          listed(4, { isCrossRepository: true, headRepositoryOwner: { login: "stranger" } }),
          listed(9),
        ],
      }),
    );
    const result = await service.findPull(repo);
    expect(result.state).toBe("ok");
    if (result.state !== "ok") return;
    expect(result.value.pull).toMatchObject({
      number: 9,
      url: "https://github.com/acme/widgets/pull/9",
      state: "open",
      ci: { state: "passing", total: 1 },
    });
  });

  it("sends a branch pushed to a fork to the fork's parent, with the fork's owner in the head", async () => {
    const repo = await repository({ remote: "git@github.com:me/widgets.git" });
    const { service } = harness(
      github({
        repos: {
          "me/widgets": repoInfo({
            isFork: true,
            parent: { name: "widgets", owner: { login: "acme" } },
            defaultBranchRef: { name: "main" },
          }),
          "acme/widgets": repoInfo({ defaultBranchRef: { name: "develop" } }),
        },
        list: [
          listed(5, { isCrossRepository: true, headRepositoryOwner: { login: "other" } }),
          listed(7),
          listed(6, { isCrossRepository: true, headRepositoryOwner: { login: "Me" } }),
        ],
      }),
    );
    const result = await service.findPull(repo);
    expect(result.state).toBe("ok");
    if (result.state !== "ok") return;
    expect(result.value.target).toEqual({
      repo: "acme/widgets",
      base: "develop",
      branch: "work/x",
      head: "me:work/x",
      fork: true,
    });
    expect(result.value.pull?.number).toBe(6);
  });

  it("follows the remote the branch tracks instead of assuming origin", async () => {
    const repo = await repository();
    await git(repo, "remote", "add", "mine", "https://github.com/me/widgets.git");
    await git(repo, "config", "branch.work/x.remote", "mine");
    await git(repo, "update-ref", "refs/remotes/mine/work/x", "HEAD");
    const { service, calls } = harness(
      github({ repos: { "me/widgets": own } }),
    );
    const result = await service.findPull(repo);
    expect(result.state).toBe("ok");
    expect(calls[0].args[2]).toBe("me/widgets");
  });

  it.each([["main"], ["trunk"]])("does not offer a pull request from the default branch (%s)", async (branch) => {
    const repo = await repository({ branch });
    const { service, calls } = harness(
      github({ repos: { "acme/widgets": repoInfo({ isFork: false, defaultBranchRef: { name: branch } }) } }),
    );
    expect(await service.findPull(repo)).toEqual({ state: "default-branch", branch });
    expect(calls.some((call) => call.args[1] === "list")).toBe(false);
  });

  it("does not offer a fork's own default branch either", async () => {
    const repo = await repository({ remote: "https://github.com/me/widgets", branch: "main" });
    const { service } = harness(
      github({
        repos: {
          "me/widgets": repoInfo({ isFork: true, parent: { name: "widgets", owner: { login: "acme" } }, defaultBranchRef: { name: "main" } }),
          "acme/widgets": repoInfo({ defaultBranchRef: { name: "develop" } }),
        },
      }),
    );
    expect(await service.findPull(repo)).toEqual({ state: "default-branch", branch: "main" });
  });

  it("never hands gh a repository name that could be read as an option", async () => {
    const repo = await repository({ remote: "https://github.com/-evil/widgets.git" });
    const { service, calls } = harness(github({}));
    expect(await service.findPull(repo)).toMatchObject({ state: "error" });
    expect(calls).toHaveLength(0);
  });

  it("has nothing to say about a detached HEAD, and asks GitHub nothing", async () => {
    const repo = await repository();
    await git(repo, "checkout", "-q", "--detach");
    const { service, calls } = harness(github({}));
    expect(await service.findPull(repo)).toEqual({ state: "no-branch" });
    expect(calls).toHaveLength(0);
  });

  it("says the branch is not pushed when the remote has never seen it, or is behind it", async () => {
    const never = await repository({ pushed: false });
    const behind = await repository({ unpushed: true });
    for (const repo of [never, behind]) {
      const { service } = harness(github({}));
      const result = await service.findPull(repo);
      expect(result.state === "ok" && result.value.pushed).toBe(false);
    }
  });

  it("reports why GitHub could not answer", async () => {
    const noRemote = await repository({ remote: null });
    expect(await harness(github({})).service.findPull(noRemote)).toEqual({ state: "no-remote" });

    const elsewhere = await repository({ remote: "https://gitlab.com/acme/widgets.git" });
    expect(await harness(github({})).service.findPull(elsewhere)).toEqual({
      state: "not-github",
      remote: "https://gitlab.com/acme/widgets.git",
    });

    const repo = await repository();
    const missing = await harness(() => {
      throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
    }).service.findPull(repo);
    expect(missing).toMatchObject({ state: "no-cli" });

    const signedOut = await harness(() => {
      throw new Error("To get started with GitHub CLI, please run:  gh auth login");
    }).service.findPull(repo);
    expect(signedOut).toMatchObject({ state: "unauthenticated" });
  });
});

describe("opening a pull request", () => {
  const input = { title: "Add widget", body: "Why: it is needed.\n\n```sh\n$(rm -rf ~)\n```" };
  const url = "https://github.com/acme/widgets/pull/12";
  const created = listed(12, { title: "Add widget" });

  async function open(options: { body?: { seen: string | undefined }; confirmedTarget?: boolean } = {}) {
    const repo = await repository();
    const tempRoot = mkdtempSync(path.join(tmpdir(), "gajae-pull-request-temp-"));
    sandboxes.push(tempRoot);
    const run = harness(
      github({
        create: (args) => {
          const file = args[args.indexOf("--body-file") + 1];
          if (options.body) options.body.seen = readFileSync(file, "utf8");
          return `\nCreating pull request for work/x into main in acme/widgets\n\n${url}\n`;
        },
        view: created,
      }),
      tempRoot,
    );
    return { repo, tempRoot, ...run };
  }

  it("creates it with the target as arguments and the body in a file, then reads it back", async () => {
    const body = { seen: undefined as string | undefined };
    const { service, repo, created: creates, tempRoot } = await open({ body });
    const result = await service.createPull(repo, input);
    expect(result).toMatchObject({ state: "ok", value: { number: 12, url, ci: { state: "passing" } } });
    const [call] = creates();
    expect(call.args).toEqual([
      "pr",
      "create",
      "--repo",
      "acme/widgets",
      "--head",
      "work/x",
      "--base",
      "main",
      "--title",
      "Add widget",
      "--body-file",
      expect.stringContaining("peacock-pr-"),
    ]);
    // the body never travels as an argument
    expect(call.args.join("\n")).not.toContain("rm -rf");
    expect(body.seen).toBe(input.body);
    // and nothing of it stays on disk
    expect(existsSync(call.args[call.args.length - 1])).toBe(false);
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  it("waits longer than a read does, and never lets gh prompt", async () => {
    const { service, repo, created: creates } = await open();
    await service.createPull(repo, input);
    const [call] = creates();
    expect(call.options?.timeoutMs).toBeGreaterThan(25_000);
    expect(call.options).toMatchObject({ cwd: repo, env: { GH_PROMPT_DISABLED: "1", GH_HOST: "github.com" } });
  });

  it("passes a title that looks like a flag as the title's value", async () => {
    const { service, repo, created: creates } = await open();
    await service.createPull(repo, { title: "--web", body: "" });
    const [call] = creates();
    expect(call.args.slice(call.args.indexOf("--title"), call.args.indexOf("--title") + 2)).toEqual(["--title", "--web"]);
  });

  it("opens it in the fork's parent, from the fork", async () => {
    const repo = await repository({ remote: "https://github.com/me/widgets" });
    const { service, created: creates } = harness(
      github({
        repos: {
          "me/widgets": repoInfo({ isFork: true, parent: { name: "widgets", owner: { login: "acme" } }, defaultBranchRef: { name: "main" } }),
          "acme/widgets": repoInfo({ defaultBranchRef: { name: "develop" } }),
        },
        create: () => url,
        view: created,
      }),
    );
    await service.createPull(repo, input);
    const args = creates()[0].args;
    expect(args.slice(args.indexOf("--repo"), args.indexOf("--repo") + 6)).toEqual([
      "--repo",
      "acme/widgets",
      "--head",
      "me:work/x",
      "--base",
      "develop",
    ]);
  });

  it("hands back the pull request that is already open instead of creating another", async () => {
    const repo = await repository();
    const { service, created: creates } = harness(github({ list: [listed(3)] }));
    const result = await service.createPull(repo, input);
    expect(result).toMatchObject({ state: "ok", value: { number: 3 } });
    expect(creates()).toHaveLength(0);
  });

  it("does not create one for a branch that is not pushed", async () => {
    const repo = await repository({ unpushed: true });
    const { service, created: creates } = harness(github({}));
    expect(await service.createPull(repo, input)).toEqual({ state: "not-pushed", branch: "work/x" });
    expect(creates()).toHaveLength(0);
  });

  it("does not create one when the target is not the one the person confirmed", async () => {
    const repo = await repository();
    const { service, created: creates } = harness(github({ create: () => url }));
    const result = await service.createPull(repo, input, {
      repo: "someone/else",
      base: "main",
      branch: "work/x",
      head: "work/x",
      fork: false,
    });
    expect(result.state).toBe("error");
    expect(creates()).toHaveLength(0);
  });

  it("creates it when the target is the one that was confirmed", async () => {
    const repo = await repository();
    const { service, created: creates } = harness(github({ create: () => url, view: created }));
    const result = await service.createPull(
      repo,
      input,
      { repo: "acme/widgets", base: "main", branch: "work/x", head: "work/x", fork: false },
    );
    expect(result.state).toBe("ok");
    expect(creates()).toHaveLength(1);
  });

  it("treats gh's \"already exists\" refusal as the pull request that is there", async () => {
    const repo = await repository();
    let listings = 0;
    const script = github({ list: [], create: () => { throw new Error(`a pull request for branch "work/x" into branch "main" already exists:\n${url}`); } });
    const { service } = harness((args, options) => {
      if (args[1] === "list") {
        listings += 1;
        // the first look finds nothing; the one after the refusal finds the pull request someone else just opened
        return JSON.stringify(listings === 1 ? [] : [listed(12)]);
      }
      return script(args, options);
    });
    const result = await service.createPull(repo, input);
    expect(result).toMatchObject({ state: "ok", value: { number: 12 } });
  });

  it("keeps a token out of the failure it reports", async () => {
    const repo = await repository();
    const token = "ghp_" + "a".repeat(36);
    const { service } = harness(
      github({
        create: () => {
          throw new Error(`GraphQL: Resource not accessible by personal access token ${token} (createPullRequest)`);
        },
      }),
    );
    const result = await service.createPull(repo, input);
    expect(result.state).toBe("error");
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).toContain("[redacted]");
  });

  it("reports an answer without a pull request address as a failure", async () => {
    const repo = await repository();
    const { service } = harness(github({ create: () => "Warning: 1 uncommitted change\n" }));
    expect(await service.createPull(repo, input)).toMatchObject({ state: "error" });
  });

  it("keeps the pull request when only reading it back fails", async () => {
    const repo = await repository();
    const { service } = harness(github({ create: () => url }));
    expect(await service.createPull(repo, input)).toMatchObject({
      state: "ok",
      value: { number: 12, url, title: "Add widget", ci: { state: "none" } },
    });
  });

  it.each([
    [{ title: "   ", body: "x" }, "title is required"],
    [{ title: "two\nlines", body: "x" }, "one line"],
    [{ title: "x".repeat(257), body: "" }, "at most 256"],
    [{ title: "t", body: "x".repeat(60_001) }, "at most 60000"],
    [{ title: "t", body: "nul\0" }, "at most 60000"],
  ])("refuses a title or body that is not valid before asking anyone (%#)", async (bad, message) => {
    const repo = await repository();
    const { service, calls } = harness(github({}));
    await expect(service.createPull(repo, bad)).rejects.toThrow(message);
    expect(calls).toHaveLength(0);
  });
});
