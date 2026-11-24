/*
 * Adapted from Ovis (https://github.com/devswha/ovis), MIT License, Copyright (c) 2026 devswha
 * (server/agent-catalog-detect.ts): an agent is installed where one of its executables is found,
 * on PATH first, then the login shell's PATH, then where its installer puts it.
 */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { AGENT_CATALOG, type AgentCatalogEntry } from "../../shared/agent-catalog.js";
import type { AgentKindId } from "../../shared/agent-contract.js";
import type { AgentAvailability } from "../../shared/terminal-ipc.js";
import { hostText } from "../host-text.js";

export type VersionRunner = (binary: string, args: readonly string[]) => Promise<string | null>;

const runVersion: VersionRunner = (binary, args) =>
  new Promise((resolve) => {
    execFile(
      binary,
      [...args],
      { timeout: 5000, env: { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "/usr/bin:/bin" } },
      (error, stdout) => resolve(error ? null : String(stdout)),
    );
  });

/** The first dotted version in what a version flag printed ("2.1.331 (Claude Code)", "omp v19.1.1"). */
export function parseAgentVersion(output: string): string | undefined {
  return /\d+\.\d+(?:\.\d+)?/u.exec(output)?.[0];
}

async function executable(file: string): Promise<{ mtimeMs: number } | undefined> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return undefined;
    await access(file, constants.X_OK);
    return { mtimeMs: info.mtimeMs };
  } catch {
    return undefined;
  }
}

export interface AgentDetectorOptions {
  /** Directories to search, in order: this process's PATH, then the login shell's. */
  searchPath: () => Promise<readonly string[]>;
  home: string;
  version?: VersionRunner;
  catalog?: readonly AgentCatalogEntry[];
}

/**
 * Finds each terminal agent as an absolute path: hc reads a bare `argv[0]` as one of its own
 * templates, and a Finder-launched app's PATH has none of the user's folders. A version answer is
 * kept per executable and its modification time, so a reinstall is noticed and nothing else re-runs.
 */
export class AgentDetector {
  private readonly versions = new Map<string, { mtimeMs: number; version: string | null }>();
  private readonly catalog: readonly AgentCatalogEntry[];
  private readonly version: VersionRunner;

  constructor(private readonly options: AgentDetectorOptions) {
    this.catalog = options.catalog ?? AGENT_CATALOG;
    this.version = options.version ?? runVersion;
  }

  async list(): Promise<AgentAvailability[]> {
    return Promise.all(this.catalog.map((entry) => this.detect(entry.id)));
  }

  async detect(id: AgentKindId): Promise<AgentAvailability> {
    const entry = this.catalog.find((candidate) => candidate.id === id);
    if (!entry) return { id, name: id, installed: false, reason: hostText("알 수 없는 에이전트입니다") };
    // the login shell is always there; the terminal decides which one
    if (entry.binaries.length === 0) return { id, name: entry.name, installed: true };
    const directories = [
      ...(await this.options.searchPath()),
      ...entry.installDirs.map((directory) =>
        directory.startsWith("~/") ? path.join(this.options.home, directory.slice(2)) : directory,
      ),
    ].filter((directory) => path.isAbsolute(directory));
    const seen = new Set<string>();
    for (const directory of directories) {
      for (const name of entry.binaries) {
        const binary = path.join(directory, name);
        if (seen.has(binary)) continue;
        seen.add(binary);
        const found = await executable(binary);
        if (!found) continue;
        const version = await this.cachedVersion(binary, found.mtimeMs, entry.versionArgs);
        if (version === null)
          return {
            id,
            name: entry.name,
            installed: false,
            binary,
            reason: hostText("실행 파일은 있지만 버전 확인에 실패했습니다"),
          };
        return { id, name: entry.name, installed: true, binary, ...(version ? { version } : {}) };
      }
    }
    return { id, name: entry.name, installed: false, reason: hostText("설치되어 있지 않습니다") };
  }

  private async cachedVersion(binary: string, mtimeMs: number, args: readonly string[]): Promise<string | null> {
    const cached = this.versions.get(binary);
    if (cached && cached.mtimeMs === mtimeMs) return cached.version;
    const output = await this.version(binary, args);
    const version = output === null ? null : (parseAgentVersion(output) ?? "");
    this.versions.set(binary, { mtimeMs, version });
    return version;
  }
}
