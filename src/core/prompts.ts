import { NeedArgs, NeedValue } from "./types";

const HELPERS = "datetime, date, timedelta, timezone, Decimal, Path, UUID, math, json, re, np (numpy), pd (pandas)";

export interface ArgsPromptInput {
  relativePath: string;
  qualname: string;
  context: string;
  need: NeedArgs;
  usages: string[];
}

export function buildArgsPrompt(input: ArgsPromptInput): string {
  const params = input.need.params
    .filter((p) => p.kind !== "VAR_POSITIONAL" && p.kind !== "VAR_KEYWORD")
    .map((p) => {
      const type = p.annotation ? `: ${p.annotation}` : "";
      if (p.is_self) {
        return `- ${p.name} (the ${input.need.class_name ?? "class"} instance the method runs on; optional)`;
      }
      return p.has_default ? `- ${p.name}${type} (optional, default ${p.default})` : `- ${p.name}${type} (required)`;
    });
  const usages =
    input.usages.length > 0
      ? `\nExisting calls found in the workspace, as a guide to realistic values:\n${input.usages.map((u) => "```python\n" + u + "\n```").join("\n")}\n`
      : "";
  return [
    "You generate sample inputs so that one Python function can be executed and inspected line by line.",
    "",
    `File: ${input.relativePath}`,
    "```python",
    input.context,
    "```",
    "",
    `Function to run: \`${input.qualname}\``,
    "Parameters:",
    params.length > 0 ? params.join("\n") : "(none)",
    usages,
    "Reply with one JSON object and nothing else:",
    '{"args": {"<parameter name>": "<python expression>", ...}}',
    "",
    "Rules:",
    `- Each value is a single Python expression written as a JSON string. It is evaluated inside the module, so every name defined or imported there can be used, for example to construct its dataclasses or enums. Also available: ${HELPERS}.`,
    "- Choose small, realistic values that take the function down its main path: non-empty collections of 2 or 3 elements, values that pass the function's own validation, values that reach the interesting branch.",
    "- For a parameter that is a connection, session, client, socket, open file, logger, or any other object that talks to the outside world or is impractical to construct, use the bare name FAKE. A FAKE accepts any attribute access and any call; the values it yields are filled in later.",
    "- Leave out optional parameters unless a different value makes the run more informative.",
    "- For a method's `self`, either give an expression that constructs the instance (use FAKE for effectful constructor arguments) or leave it out to have one built automatically.",
    "- No imports, no statements, no comments, no markdown.",
  ].join("\n");
}

export interface ValuePromptInput {
  qualname: string;
  functionSource: string;
  need: NeedValue;
  known: { path: string; expr: string }[];
  args: { name: string; value: string }[];
}

const OP_HINTS: Record<string, string> = {
  iter: "It is iterated, so give a list (or dict if the loop uses .items()) with 2 or 3 elements shaped the way the loop body reads them.",
  len: "Its length is taken, so give a sized collection.",
  contains: "A membership test is run against it, so give a collection.",
  bool: "It is used in a truth test. Give the real value it would hold, not just True or False, if later lines use it as more than a flag.",
  eq: "It is compared for equality. Give the value it would actually hold.",
  cmp: "It is ordered against another value. Give a value of the same type.",
  num: "It is used as a number (or concatenated). Give a value of the matching type.",
  index: "It is used as an integer index or count. Give an int.",
  str: "It is turned into text. Give the string, or a value whose str() is realistic.",
  any: 'A concrete value is required at this point. If it truly has to stay an opaque object whose methods are called next (a client, a response object), reply {"value": "FAKE"}.',
};

export function buildValuePrompt(input: ValuePromptInput): string {
  const need = input.need;
  const known =
    input.known.length > 0
      ? ["Values already invented in this run (stay consistent with them):", ...input.known.slice(-10).map((k) => `- ${k.path} = ${k.expr}`), ""]
      : [];
  const args = input.args.length > 0 ? ["Arguments of this run:", ...input.args.map((a) => `- ${a.name} = ${a.value}`), ""] : [];
  return [
    "A Python function is being executed with fake stand-ins for its external dependencies (databases, HTTP, files, clients).",
    "One of those stand-ins is now used as a concrete value. Invent a realistic value for it.",
    "",
    `Function: \`${input.qualname}\``,
    "```python",
    input.functionSource,
    "```",
    "",
    ...args,
    ...known,
    need.text ? `Current line: \`${need.text}\`` : "The function has just returned.",
    `Expression that needs a value: \`${need.path}\``,
    `How it is used: ${need.detail ?? "as a value"}`,
    OP_HINTS[need.op] ?? "",
    "",
    "Reply with one JSON object and nothing else:",
    '{"value": "<python expression>"}',
    "",
    "Rules:",
    `- A single Python expression written as a JSON string. Prefer literals: numbers, strings, lists, dicts, None, True, False. Names from the module may be used, for example to build model instances, plus ${HELPERS}.`,
    "- Match how the rest of the function uses it: the keys it reads, the attributes it accesses, the types it compares against.",
    "- Prefer the value that lets execution continue along the main path, such as a success status or a non-empty result.",
    "- No imports, no statements, no comments, no markdown.",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

/** Pulls the first JSON object out of a model reply, tolerating code fences and prose. */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json|python)?/gi, "").trim();
  let start = cleaned.indexOf("{");
  while (start !== -1) {
    const end = matchingBrace(cleaned, start);
    if (end !== -1) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        // Not JSON (prose with braces); try the next candidate.
      }
    }
    start = cleaned.indexOf("{", start + 1);
  }
  return undefined;
}

function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/** Python literal for a JSON value, for models that answer with raw JSON instead of an expression string. */
export function toPythonLiteral(value: unknown): string {
  if (value === null || value === undefined) {
    return "None";
  }
  if (typeof value === "boolean") {
    return value ? "True" : "False";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "float('nan')";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(toPythonLiteral).join(", ")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).map(([k, v]) => `${JSON.stringify(k)}: ${toPythonLiteral(v)}`);
  return `{${entries.join(", ")}}`;
}

function asExpression(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  if (value === undefined) {
    return undefined;
  }
  return toPythonLiteral(value);
}

export function parseArgsReply(text: string): Record<string, string> | undefined {
  const parsed = extractJson(text) as { args?: Record<string, unknown> } | undefined;
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  const source = parsed.args && typeof parsed.args === "object" ? parsed.args : (parsed as Record<string, unknown>);
  const args: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    const expr = asExpression(value);
    if (expr !== undefined) {
      args[name] = expr;
    }
  }
  return args;
}

export function parseValueReply(text: string): string | undefined {
  const parsed = extractJson(text) as { value?: unknown } | undefined;
  if (!parsed || typeof parsed !== "object" || !("value" in parsed)) {
    return undefined;
  }
  return asExpression(parsed.value);
}

/**
 * Context given to the model for argument generation: the whole file when it
 * is small, otherwise its imports, the class definitions the signature
 * refers to, the enclosing class header and constructor, and the function.
 */
export function buildContext(text: string, functionSource: string, signature: string, className: string | null, limit = 12000): string {
  if (text.length <= limit) {
    return text;
  }
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (/^(import |from \S+ import )/.test(line)) {
      out.push(line);
    }
  }
  const wanted = new Set<string>([...(signature.match(/[A-Z][A-Za-z0-9_]*/g) ?? []), ...(className ? [className] : [])]);
  for (let i = 0; i < lines.length; i++) {
    const match = /^class\s+([A-Za-z_]\w*)/.exec(lines[i]);
    if (!match || !wanted.has(match[1])) {
      continue;
    }
    out.push("");
    let start = i;
    while (start > 0 && lines[start - 1].startsWith("@")) {
      start -= 1;
    }
    let taken = 0;
    for (let j = start; j < lines.length && taken < 60; j++, taken++) {
      if (j > i && /^\S/.test(lines[j]) && !lines[j].startsWith("#")) {
        break;
      }
      out.push(lines[j]);
    }
  }
  out.push("", "# ... (rest of the file omitted) ...", "", functionSource);
  const joined = out.join("\n");
  return joined.length > limit * 2 ? joined.slice(0, limit * 2) : joined;
}
