/**
 * omp's RPC UI requests as the chat's cards (design §10): tool approvals (`select` with an
 * "Allow tool:" title), the ask tool's HTML `form`, an extension's `ask`, `select`, `confirm`,
 * `input` and `editor` dialogs. Only reading and answering lives here; the controller keeps them.
 */
import type { PermissionOption } from "../../shared/agent-contract.js";
import type { LiveToolCall } from "./live-rows.js";

// ---- approvals

/** The tool an approval prompt asks about (omp 19.1.1 tools/approval.ts `approvalHeader`). */
export function approvalToolName(title: string): string | undefined {
  const match = /^Allow tool: (\S+)/u.exec(title);
  return match?.[1];
}

/**
 * The running call an approval prompt is about. RPC prompts carry no call id (P0), so the prompt
 * is matched by content: a call of the tool it names, started and not finished nor paired yet,
 * whose argument values (each one's first line) all appear in the prompt; among those the oldest.
 * With none, the oldest unpaired call of that tool.
 */
export function pairApproval(title: string, calls: readonly LiveToolCall[], paired: ReadonlySet<string>): LiveToolCall | undefined {
  const toolName = approvalToolName(title);
  if (!toolName) return undefined;
  const open = calls
    .filter((call) => call.name === toolName && !paired.has(call.callId))
    .sort((left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0));
  const lines = title.split("\n").slice(1).map((line) => line.trim());
  // a value omp prints as a whole line (`Command: <it>`) beats one found inside another line
  const rank = (call: LiveToolCall): number => {
    const values = argumentLines(call.input);
    if (values.length > 0 && values.every((value) => lines.some((line) => line === value || line.endsWith(`: ${value}`)))) return 2;
    return values.every((value) => title.includes(value)) ? 1 : 0;
  };
  let best: LiveToolCall | undefined;
  let bestRank = -1;
  for (const call of open) {
    const score = rank(call);
    if (score > bestRank) {
      best = call;
      bestRank = score;
    }
  }
  return best;
}

function argumentLines(input: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const value of Object.values(input)) {
    if (typeof value !== "string") continue;
    const first = value.split("\n", 1)[0]!.trim();
    // omp cuts long values in its prompt; a line that long is compared by its start
    if (first) lines.push(first.slice(0, 200));
  }
  return lines;
}

/** One choice of an approval card and the omp option label it answers with. */
export interface ApprovalChoice {
  option: PermissionOption;
  label: string;
}

/**
 * The choices a card offers for omp's options: this call ("Approve", "Approve Once") and "Deny".
 * Grants and the "for this session" answer are omp's to offer in its own UI: the card's choices
 * mean what they say everywhere (allow once, reject), and project command rules cover the rest.
 */
export function approvalChoices(options: readonly string[]): ApprovalChoice[] {
  const choices: ApprovalChoice[] = [];
  const once = options.find((option) => option === "Approve" || option === "Approve Once");
  if (once) choices.push({ option: { optionId: "allow_once", kind: "allow_once", name: "Allow once" }, label: once });
  if (options.includes("Deny")) choices.push({ option: { optionId: "reject_once", kind: "reject_once", name: "Reject" }, label: "Deny" });
  return choices;
}

/** The prompt's lines after its header, as the card's summary of a call it could not pair. */
export function approvalDetail(title: string): string {
  return title
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" · ")
    .slice(0, 200);
}

// ---- HTML forms (the ask tool, omp 19.1.1 `ui.formDialog`)

export interface FormChoiceOption {
  value: string;
  label: string;
  checked: boolean;
  disabled: boolean;
}

export type FormField =
  | {
      kind: "choice";
      name: string;
      label: string;
      multi: boolean;
      /** A `<select>`: only its options answer. A radio or checkbox group also takes free text ("Other"). */
      select: boolean;
      other: boolean;
      required: boolean;
      options: FormChoiceOption[];
    }
  | { kind: "text"; name: string; label: string; multiline: boolean; required: boolean; value: string };

const SKIPPED = new Set(["script", "style", "head", "title", "template", "noscript", "button", "iframe"]);
const BLOCKS = new Set(["p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6", "section", "header", "footer", "dd", "dt", "summary", "br", "hr", "tr"]);
const TEXT_TYPES = new Set(["text", "email", "url", "number", "range", "tel", "search", "date", "time", "datetime-local", "month", "week", "color", "password"]);

function attributes(source: string): Map<string, string> {
  const found = new Map<string, string>();
  const pattern = /([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
  for (const match of source.matchAll(pattern)) found.set(match[1]!.toLowerCase(), decode(match[2] ?? match[3] ?? match[4] ?? ""));
  return found;
}

function decode(text: string): string {
  return text
    .replace(/&#(\d+);/gu, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/gu, '"')
    .replace(/&apos;|&#39;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&nbsp;/gu, " ")
    .replace(/&amp;/gu, "&");
}

const clean = (text: string): string => text.replace(/\s+/gu, " ").trim();

/**
 * The fields of an ask form, in order, with the question each one asks: its `<label>`, else the
 * fieldset's `<legend>`, else the text before it. A lenient reading of the HTML omp's own form
 * parser takes (`<fieldset>`, `<label>`, radio and checkbox groups, `<select>`, `<textarea>`,
 * text inputs); hidden inputs are omp's to fill in.
 */
export function parseHtmlForm(html: string): FormField[] {
  const fields: FormField[] = [];
  const groups = new Map<string, Extract<FormField, { kind: "choice" }>>();
  const labelsFor = new Map<string, string>();
  // first pass: <label for="id">text</label>
  for (const match of html.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/giu)) {
    const target = attributes(match[1]!).get("for");
    if (target) labelsFor.set(target, clean(decode(match[2]!.replace(/<[^>]*>/gu, " "))));
  }
  let text = "";
  let legend = "";
  let inLegend = false;
  let labelDepth = 0;
  let labelText = "";
  let labelInputs: { field: FormField; option?: FormChoiceOption }[] = [];
  let skipping = "";
  let select: Extract<FormField, { kind: "choice" }> | undefined;
  let option: { value?: string; text: string; checked: boolean; disabled: boolean } | undefined;
  let textarea: { name: string; label: string; required: boolean; text: string } | undefined;
  const context = (): string => clean(labelText) || clean(legend) || clean(text);
  const tokens = html.matchAll(/<!--[\s\S]*?-->|<(\/?)([A-Za-z][A-Za-z0-9-]*)([^>]*)>|([^<]+)/gu);
  for (const token of tokens) {
    const [, closing, rawName, rawAttributes, rawText] = token;
    if (rawText !== undefined) {
      if (skipping) continue;
      const piece = decode(rawText);
      if (option) option.text += piece;
      else if (textarea) textarea.text += piece;
      else if (inLegend) legend += piece;
      else if (labelDepth > 0) labelText += piece;
      else text += piece;
      continue;
    }
    if (!rawName) continue;
    const name = rawName.toLowerCase();
    if (skipping) {
      if (closing && name === skipping) skipping = "";
      continue;
    }
    if (SKIPPED.has(name) && !closing) {
      if (!/\/\s*$/u.test(rawAttributes ?? "")) skipping = name;
      continue;
    }
    const attrs = attributes(rawAttributes ?? "");
    if (name === "fieldset" && !closing) legend = "";
    else if (name === "legend") {
      inLegend = !closing;
      if (!closing) legend = "";
    } else if (name === "label") {
      if (!closing) {
        labelDepth += 1;
        if (labelDepth === 1) {
          labelText = "";
          labelInputs = [];
        }
      } else if (labelDepth > 0) {
        labelDepth -= 1;
        if (labelDepth === 0) {
          // a radio or checkbox inside a label is named by that label's text
          const said = clean(labelText);
          for (const entry of labelInputs) if (entry.option && said) entry.option.label = said;
          for (const entry of labelInputs) if (!entry.option && entry.field.kind === "text" && said && !entry.field.label) entry.field.label = said;
          labelText = "";
          labelInputs = [];
        }
      }
    } else if (BLOCKS.has(name) && !inLegend && labelDepth === 0 && !closing) {
      text = "";
    } else if (name === "select") {
      if (!closing) {
        const field: Extract<FormField, { kind: "choice" }> = {
          kind: "choice",
          name: attrs.get("name") ?? "",
          label: labelsFor.get(attrs.get("id") ?? "") ?? context(),
          multi: attrs.has("multiple"),
          select: true,
          other: false,
          required: attrs.has("required"),
          options: [],
        };
        select = field;
        fields.push(field);
        if (labelDepth > 0) labelInputs.push({ field });
      } else if (select) {
        if (!select.multi && select.options.length > 0 && !select.options.some((entry) => entry.checked)) {
          const first = select.options.find((entry) => !entry.disabled);
          if (first) first.checked = true;
        }
        select = undefined;
      }
    } else if (name === "option") {
      const finish = () => {
        if (option && select) {
          const label = clean(option.text);
          select.options.push({ value: option.value ?? label, label, checked: option.checked, disabled: option.disabled });
        }
        option = undefined;
      };
      finish();
      if (!closing && select) option = { ...(attrs.has("value") ? { value: attrs.get("value")! } : {}), text: "", checked: attrs.has("selected"), disabled: attrs.has("disabled") };
    } else if (name === "textarea") {
      if (!closing)
        textarea = { name: attrs.get("name") ?? "", label: labelsFor.get(attrs.get("id") ?? "") ?? context(), required: attrs.has("required"), text: "" };
      else if (textarea) {
        const field: FormField = { kind: "text", name: textarea.name, label: textarea.label || textarea.name, multiline: true, required: textarea.required, value: textarea.text.replace(/^\r?\n/u, "") };
        fields.push(field);
        textarea = undefined;
      }
    } else if (name === "input" && !closing) {
      const type = (attrs.get("type") ?? "text").toLowerCase();
      const fieldName = attrs.get("name") ?? "";
      if (type === "radio" || type === "checkbox") {
        const key = `${type}\u0000${fieldName}`;
        let group = groups.get(key);
        if (!group) {
          group = {
            kind: "choice",
            name: fieldName,
            label: clean(legend) || clean(text),
            multi: type === "checkbox",
            select: false,
            other: false,
            required: attrs.has("required"),
            options: [],
          };
          groups.set(key, group);
          fields.push(group);
        }
        group.required ||= attrs.has("required");
        const value = attrs.get("value") ?? "on";
        const entry: FormChoiceOption = {
          value,
          label: labelsFor.get(attrs.get("id") ?? "") ?? attrs.get("aria-label") ?? value,
          checked: attrs.has("checked"),
          disabled: attrs.has("disabled"),
        };
        group.options.push(entry);
        if (labelDepth > 0) labelInputs.push({ field: group, option: entry });
      } else if (TEXT_TYPES.has(type)) {
        const field: FormField = {
          kind: "text",
          name: fieldName,
          label: labelsFor.get(attrs.get("id") ?? "") ?? (labelDepth > 0 ? "" : context()),
          multiline: false,
          required: attrs.has("required"),
          value: attrs.get("value") ?? "",
        };
        fields.push(field);
        if (labelDepth > 0) labelInputs.push({ field });
      }
    }
  }
  // a radio or checkbox group of two or more without its own "Other" also takes free text
  for (const field of fields)
    if (field.kind === "choice" && !field.select && field.options.length >= 2)
      field.other = !field.options.some((entry) => /^\s*other\b/iu.test(entry.label));
  return fields.filter((field) => field.name).map((field) => (field.kind === "text" && !field.label ? { ...field, label: field.name.replace(/[_-]+/gu, " ") } : field));
}

/** What a form field's answer is under omp's form rules, or why it cannot be. */
export function formValue(
  field: FormField,
  selected: readonly string[],
  custom: string | undefined,
): { value: string | string[] } | { error: string } {
  const text = custom?.trim() ?? "";
  if (field.kind === "text") {
    const value = text || selected[0] || "";
    if (!value && field.required) return { error: "답을 입력해 주세요" };
    return { value };
  }
  const values = selected.flatMap((label) => field.options.filter((entry) => entry.label === label && !entry.disabled).map((entry) => entry.value));
  if (text && !field.other) return { error: "목록에서 골라 주세요" };
  if (field.multi) {
    const all = text ? [...values, text] : values;
    if (all.length === 0 && field.required) return { error: "하나 이상 골라 주세요" };
    return { value: all };
  }
  const value = text || values[0];
  if (value === undefined) return { error: "하나를 골라 주세요" };
  return { value };
}
