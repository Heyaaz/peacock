import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { LiveToolCall } from "./live-rows.js";
import { approvalChoices, approvalDetail, approvalToolName, formValue, pairApproval, parseHtmlForm } from "./ui-requests.js";

function incoming(name: string): Record<string, unknown>[] {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { dir: string; frame: Record<string, unknown> })
    .filter((row) => row.dir === "in")
    .map((row) => row.frame);
}

const call = (callId: string, command: string, startedAt: number): LiveToolCall => ({ callId, rowId: `s:${callId}`, name: "bash", input: { command }, startedAt });

describe("approval prompts", () => {
  it("pairs each of two parallel prompts with its own call by content, in either order (P0)", () => {
    const frames = incoming("approval-parallel.jsonl");
    const selects = frames.filter((frame) => frame.method === "select").map((frame) => String(frame.title));
    const calls = frames
      .filter((frame) => frame.type === "tool_execution_start")
      .map((frame, index) => call(String(frame.toolCallId), String((frame.args as { command: string }).command), index));
    expect(selects).toEqual(["Allow tool: bash\nCommand: echo gajae-a", "Allow tool: bash\nCommand: echo gajae-b"]);
    const paired = new Set<string>();
    const second = pairApproval(selects[1]!, calls, paired)!;
    paired.add(second.callId);
    const first = pairApproval(selects[0]!, calls, paired)!;
    expect([first.input.command, second.input.command]).toEqual(["echo gajae-a", "echo gajae-b"]);
  });

  it("falls back to the oldest unpaired call of the tool, and pairs nothing for another tool", () => {
    const calls = [call("a", "cat a.txt", 2), call("b", "pwd", 1)];
    expect(pairApproval("Allow tool: bash\nCommand: something else", calls, new Set())?.callId).toBe("b");
    expect(pairApproval("Allow tool: edit\nPath: x", calls, new Set())).toBeUndefined();
    // a short command that only appears inside another line loses to the call printed whole
    expect(pairApproval("Allow tool: bash\nCommand: echo else", [call("x", "ls", 1), call("y", "echo else", 2)], new Set())?.callId).toBe("y");
    expect(pairApproval("not an approval", calls, new Set())).toBeUndefined();
  });

  it("offers this call and Deny of omp's options, and reads the tool and detail", () => {
    expect(approvalChoices(["Approve", "Approve bash for this session", "Deny"])).toEqual([
      { option: { optionId: "allow_once", kind: "allow_once", name: "Allow once" }, label: "Approve" },
      { option: { optionId: "reject_once", kind: "reject_once", name: "Reject" }, label: "Deny" },
    ]);
    expect(approvalChoices(["Approve Directory: src", "Always Approve Directory: src", "Approve Once", "Deny"]).map((choice) => choice.label)).toEqual(["Approve Once", "Deny"]);
    expect(approvalToolName("Allow tool: mcp__github_get_issue\nOrigin: MCP server tool")).toBe("mcp__github_get_issue");
    expect(approvalDetail("Allow tool: bash\nReason: writes\nCommand: rm x")).toBe("Reason: writes · Command: rm x");
  });
});

describe("ask forms", () => {
  it("reads the ask tool's form omp 19.1.1 sent (P0)", () => {
    const html = String(incoming("ui-approval-form.jsonl").find((frame) => frame.method === "form")!.html);
    const fields = parseHtmlForm(html);
    expect(fields).toEqual([
      {
        kind: "choice",
        name: "color",
        label: "Pick a color",
        multi: false,
        select: false,
        other: true,
        required: false,
        options: [
          { value: "Red", label: "Red", checked: false, disabled: false },
          { value: "Blue", label: "Blue", checked: false, disabled: false },
        ],
      },
    ]);
    expect(formValue(fields[0]!, ["Blue"], undefined)).toEqual({ value: "Blue" });
    expect(formValue(fields[0]!, [], "Green")).toEqual({ value: "Green" });
    expect(formValue(fields[0]!, [], undefined)).toEqual({ error: "하나를 골라 주세요" });
  });

  it("reads selects, checkbox groups, labelled inputs and textareas, and leaves hidden inputs to omp", () => {
    const fields = parseHtmlForm(`<form>
      <input type="hidden" name="token" value="t">
      <p>Which files?</p>
      <label><input type="checkbox" name="files" value="a.ts" checked> a.ts</label>
      <label><input type="checkbox" name="files" value="b.ts"> b.ts</label>
      <label for="env">Environment</label>
      <select id="env" name="env"><option value="dev">Development</option><option value="prod" disabled>Production</option></select>
      <label>Note <input type="text" name="note" required></label>
      <h3>Details &amp; more</h3>
      <textarea name="details"></textarea>
      <script>ignored()</script>
    </form>`);
    expect(fields.map((field) => [field.kind, field.name, field.label])).toEqual([
      ["choice", "files", "Which files?"],
      ["choice", "env", "Environment"],
      ["text", "note", "Note"],
      ["text", "details", "Details & more"],
    ]);
    const [files, env, note, details] = fields;
    expect(files).toMatchObject({ multi: true, other: true });
    expect(env).toMatchObject({ select: true, other: false, options: [{ value: "dev", checked: true }, { value: "prod", disabled: true }] });
    expect(formValue(files!, ["a.ts", "b.ts"], undefined)).toEqual({ value: ["a.ts", "b.ts"] });
    expect(formValue(env!, ["Development"], undefined)).toEqual({ value: "dev" });
    expect(formValue(env!, ["Production"], undefined)).toEqual({ error: "하나를 골라 주세요" });
    expect(formValue(env!, [], "staging")).toEqual({ error: "목록에서 골라 주세요" });
    expect(formValue(note!, [], "  ")).toEqual({ error: "답을 입력해 주세요" });
    expect(formValue(details!, [], "line")).toEqual({ value: "line" });
  });
});
