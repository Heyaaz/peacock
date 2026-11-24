/*
 * Adapted from Ovis (https://github.com/devswha/ovis), MIT License, Copyright (c) 2026 devswha
 * (scripts/hc-types.ts): ported from a Bun TypeScript script to a Node ESM script.
 */
/**
 * TypeScript types for the herdr-core (`hc`) API, generated from hc's own OpenRPC document
 * (`hc schema`, herdr-core's schema/hc.openrpc.json, Apache-2.0).
 * - String enums widen with `(string & {})`, as herdr's do: hc grows its vocabulary between
 *   releases, and a word from a newer core must still flow through.
 */

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { herdrCoreBinary } from "./herdr-core-pin.mjs";

const execFileAsync = promisify(execFile);

export const HC_METHODS = [
  "events.subscribe",
  "hello",
  "machine.exec",
  "server.restart",
  "server.status",
  "server.stop",
  "terminal.attach",
  "terminal.get",
  "terminal.interrupt",
  "terminal.keys",
  "terminal.kill",
  "terminal.label",
  "terminal.list",
  "terminal.read",
  "terminal.rm",
  "terminal.run",
  "terminal.send",
];

const REF_PREFIX = "#/components/schemas/";

function refName(ref) {
  if (!ref.startsWith(REF_PREFIX)) throw new Error(`unsupported $ref: ${ref}`);
  return ref.slice(REF_PREFIX.length);
}

export function methodTypeName(method) {
  return method.split(/[._]/).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
}

function walkRefs(node, onRef) {
  if (Array.isArray(node)) {
    for (const item of node) walkRefs(item, onRef);
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string") onRef(refName(value));
    else walkRefs(value, onRef);
  }
}

function tsType(def, indent) {
  // `true` (and `{}`) is JSON Schema for "any value"
  if (def === true || !def || typeof def !== "object" || Object.keys(def).length === 0) return "unknown";
  const node = def;
  if (node.$ref) return refName(node.$ref);
  if (node.enum) {
    const literals = [...node.enum].sort().map((value) => JSON.stringify(value));
    return `${literals.join(" | ")} | (string & {})`;
  }
  if (node.anyOf || node.oneOf) {
    const variants = node.anyOf ?? node.oneOf;
    const rendered = [...new Set(variants.map((variant) => tsType(variant, indent)))];
    return rendered.includes("unknown") ? "unknown" : rendered.join(" | ");
  }
  const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
  const nullable = types.includes("null");
  const primary = types.filter((type) => type !== "null");
  if (primary.length === 0) return nullable ? "null" : "unknown";
  const render = (kind) => {
    switch (kind) {
      case "string":
        return "string";
      case "integer":
      case "number":
        return "number";
      case "boolean":
        return "boolean";
      case "array": {
        const item = tsType(node.items, indent);
        if (typeof node.minItems === "number" && node.minItems === node.maxItems && node.minItems > 0 && node.minItems <= 4) {
          return `[${Array.from({ length: node.minItems }, () => item).join(", ")}]`;
        }
        return /[|&]/.test(item) ? `(${item})[]` : `${item}[]`;
      }
      case "object":
        if (node.properties) return renderObject(node, indent);
        if (node.additionalProperties && node.additionalProperties !== true) return `Record<string, ${tsType(node.additionalProperties, indent)}>`;
        return "Record<string, unknown>";
      default:
        return "unknown";
    }
  };
  const body = primary.map(render).join(" | ");
  return nullable ? `${body} | null` : body;
}

function propertyKey(key) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

function renderFields(fields, indent) {
  if (fields.length === 0) return "Record<string, never>";
  const inner = `${indent}  `;
  const lines = [...fields]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((field) => `${inner}${propertyKey(field.key)}${field.required ? "" : "?"}: ${tsType(field.schema, inner)};`);
  return `{\n${lines.join("\n")}\n${indent}}`;
}

function renderObject(def, indent) {
  const required = def.required ?? [];
  const properties = def.properties ?? {};
  return renderFields(Object.keys(properties).map((key) => ({ key, required: required.includes(key), schema: properties[key] })), indent);
}

function declaration(name, def) {
  if (def.type === "object" && def.properties) return `export interface ${name} ${renderObject(def, "")}`;
  return `export type ${name} = ${tsType(def, "")};`;
}

export function generateHcTypes(schema) {
  const methods = schema.methods ?? [];
  const records = schema.components?.schemas ?? {};
  const found = new Set();
  const visit = (name) => {
    if (found.has(name)) return;
    const def = records[name];
    if (!def) throw new Error(`missing schema ${name}`);
    found.add(name);
    walkRefs(def, visit);
  };

  const declarations = new Map();
  const entries = [];
  for (const method of HC_METHODS) {
    const spec = methods.find((candidate) => candidate.name === method);
    if (!spec) throw new Error(`hc's schema has no method ${method}`);
    const params = spec.params ?? [];
    walkRefs(params.map((param) => param.schema), visit);
    walkRefs(spec.result?.schema, visit);
    const base = methodTypeName(method);
    const paramsName = `${base}Params`;
    if (records[paramsName]) throw new Error(`${paramsName} would shadow hc's own schema of that name`);
    declarations.set(paramsName, params.length === 0
      ? `export type ${paramsName} = Record<string, never>;`
      : `export interface ${paramsName} ${renderFields(params.map((param) => ({ key: param.name, required: param.required === true, schema: param.schema })), "")}`);
    entries.push(`  ${JSON.stringify(method)}: { params: ${paramsName}; result: ${tsType(spec.result?.schema, "  ")} };`);
  }
  for (const name of found) declarations.set(name, declaration(name, records[name]));

  const body = [...declarations.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) => text);

  const header = [
    "/**",
    " * GENERATED FILE - DO NOT EDIT.",
    " *",
    ` * Source: herdr-core (hc) OpenRPC schema, hc ${schema.info?.version}, ${schema.info?.license?.name ?? "unknown license"}.`,
    " * Regenerate with: npm run herdr-core:types",
    " * Verify freshness with: npm run herdr-core:types -- --check",
    " */",
    "",
  ].join("\n");
  const map = [
    "/** Every hc method Gajae calls, with its params and its result. */",
    "export interface HcMethods {",
    ...entries,
    "}",
    "",
    "export type HcMethod = keyof HcMethods;",
  ].join("\n");
  return `${header}\n${body.join("\n\n")}\n\n${map}\n`;
}

const OUTPUT = fileURLToPath(new URL("../electron/herdr-core/hc-api.generated.ts", import.meta.url));

/**
 * hc's own schema. `hc schema` answers for the core it reaches and starts one when none runs, so
 * it is asked under a throwaway session that is stopped afterwards; `--schema <file>` reads a saved one.
 */
async function readSchema(args) {
  const at = args.indexOf("--schema");
  if (at !== -1) return JSON.parse(await readFile(args[at + 1], "utf8"));
  const hc = herdrCoreBinary(fileURLToPath(new URL("..", import.meta.url)));
  const env = { HOME: process.env.HOME ?? "", PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HC_SESSION: `gajae-typegen-${process.pid}` };
  try {
    const { stdout } = await execFileAsync(hc, ["schema"], { env, maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(stdout);
  } finally {
    await execFileAsync(hc, ["server", "stop"], { env }).catch(() => undefined);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const schema = await readSchema(args);
  const text = generateHcTypes(schema);
  if (args.includes("--check")) {
    const current = await readFile(OUTPUT, "utf8").catch(() => "");
    if (current !== text) {
      console.error(`${OUTPUT} is out of date: run npm run herdr-core:types`);
      process.exit(1);
    }
    console.log("hc types are up to date");
  } else {
    await writeFile(OUTPUT, text);
    console.log(`wrote ${OUTPUT} from hc ${schema.info?.version}`);
  }
}
