import { describe, expect, it } from "vitest";
import {
  AGENT_CATALOG,
  agentCatalogEntry,
  agentSupportsSurface,
} from "./agent-catalog.js";
import {
  AGENT_KIND_IDS,
  capabilitiesOf,
  SESSION_CAPABILITY_KEYS,
} from "./agent-contract.js";

describe("agent catalog", () => {
  it("has exactly one entry for every agent kind", () => {
    const ids = AGENT_CATALOG.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...AGENT_KIND_IDS].sort());
    for (const id of AGENT_KIND_IDS) expect(agentCatalogEntry(id).id).toBe(id);
  });

  it("gives every entry a name and a screen it opens on that it supports", () => {
    for (const entry of AGENT_CATALOG) {
      expect(entry.name.trim()).not.toBe("");
      expect(entry.surfaces.length).toBeGreaterThan(0);
      expect(new Set(entry.surfaces).size).toBe(entry.surfaces.length);
      for (const surface of entry.surfaces)
        expect(["chat", "terminal"]).toContain(surface);
      expect(entry.surfaces).toContain(entry.defaultSurface);
    }
  });

  it("names executables as bare names and install folders under home or root", () => {
    for (const entry of AGENT_CATALOG) {
      for (const binary of entry.binaries) expect(binary).toMatch(/^[A-Za-z0-9._-]+$/u);
      for (const directory of entry.installDirs)
        expect(directory.startsWith("~/") || directory.startsWith("/")).toBe(true);
      if (entry.binaries.length > 0) expect(entry.versionArgs.length).toBeGreaterThan(0);
    }
  });

  it("detects every agent but the login shell by an executable", () => {
    for (const entry of AGENT_CATALOG)
      if (entry.id === "shell") expect(entry.binaries).toEqual([]);
      else expect(entry.binaries).toContain(entry.id);
  });

  it("looks for gjc where the app already does", () => {
    expect(agentCatalogEntry("gjc").installDirs).toEqual(["~/.local/bin", "~/.bun/bin"]);
  });

  it("states every capability for every entry", () => {
    for (const entry of AGENT_CATALOG)
      expect(Object.keys(entry.capabilities).sort()).toEqual(
        [...SESSION_CAPABILITY_KEYS].sort(),
      );
  });

  it("offers nothing on an agent without a chat screen", () => {
    for (const entry of AGENT_CATALOG) {
      if (entry.surfaces.includes("chat")) continue;
      expect(Object.values(entry.capabilities).every((value) => value === false)).toBe(true);
    }
  });

  it("offers for gjc exactly what a GJC session offers today", () => {
    expect(agentCatalogEntry("gjc").capabilities).toEqual(
      capabilitiesOf({ runtime: "gjc" }),
    );
  });

  it("keeps attachments and streaming off for agents read from their transcript", () => {
    for (const id of ["claude", "omp"] as const) {
      const { capabilities } = agentCatalogEntry(id);
      expect(capabilities.attachments).toBe(false);
      expect(capabilities.streaming).toBe(false);
      expect(capabilities.send).toBe(true);
    }
  });

  it("answers which screens an agent supports", () => {
    expect(agentSupportsSurface("claude", "chat")).toBe(true);
    expect(agentSupportsSurface("claude", "terminal")).toBe(true);
    expect(agentSupportsSurface("codex", "chat")).toBe(false);
    expect(agentSupportsSurface("gjc", "terminal")).toBe(false);
    expect(agentSupportsSurface("shell", "terminal")).toBe(true);
  });

  it("refuses a kind it does not list", () => {
    expect(() => agentCatalogEntry("hermes" as never)).toThrow("Unknown agent kind");
  });
});
