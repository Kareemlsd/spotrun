/**
 * Dig deep: before proposing inputs, the model may look things up in the
 * user's codebase. The exchange is plain JSON over ordinary chat messages,
 * so it works with any model, including ones without tool calling.
 *
 * Each turn the model replies with either one lookup
 *   {"action": "search" | "read" | "definition" | "usages" | "list", ...}
 * or the final answer
 *   {"args": {...}, "imports": [...], "notes": "..."}.
 */

import * as fs from "fs";
import * as path from "path";
import { extractJson, toPythonLiteral } from "./prompts";
import { parsePythonFunctions, sourceOf } from "./pythonFunctions";

export interface DigMessage {
  role: "user" | "assistant";
  text: string;
}

export interface DigAnswer {
  args: Record<string, string>;
  imports: string[];
  notes: string;
}

export interface DigOutcome extends DigAnswer {
  /** Human-readable list of what was looked up, in order. */
  lookups: string[];
}

export interface DigHost {
  /** Workspace-relative paths of readable text files, forward slashes. */
  listFiles(): Promise<string[]>;
  readFile(relative: string): Promise<string | undefined>;
}

const SKIP_DIRS = new Set([
  "node_modules",
  "site-packages",
  "dist-packages",
  "venv",
  "env",
  "build",
  "dist",
  "__pycache__",
  "__pypackages__",
  "target",
  "out",
]);
const TEXT_EXTENSIONS = new Set([".py", ".pyi", ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".md", ".rst", ".txt", ".csv", ".sql"]);
const SECRET_NAME = /(^\.env)|secret|credential|password|token|\.pem$|\.key$|id_rsa/i;
const MAX_FILE_BYTES = 400_000;
const MAX_FILES = 4000;
const RESULT_LIMIT = 6000;

/** Reads files under `root`, skipping dependencies, hidden folders, binaries and anything that looks like a secret. */
export function createFsHost(root: string): DigHost {
  let cached: string[] | undefined;
  const walk = async (dir: string, relative: string, out: string[]): Promise<void> => {
    if (out.length >= MAX_FILES) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name.startsWith(".") || SECRET_NAME.test(entry.name)) {
        continue;
      }
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          await walk(path.join(dir, entry.name), rel, out);
        }
      } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        out.push(rel);
      }
    }
  };
  return {
    async listFiles() {
      if (!cached) {
        cached = [];
        await walk(root, "", cached);
      }
      return cached;
    },
    async readFile(relative: string) {
      const normalised = relative.replace(/\\/g, "/").replace(/^\.\//, "");
      const full = path.resolve(root, normalised);
      const inside = path.relative(root, full);
      // Only files the listing would also offer: inside the root, not hidden, not a secret.
      if (inside.startsWith("..") || path.isAbsolute(inside)) {
        return undefined;
      }
      const parts = inside.split(path.sep);
      if (parts.some((p) => p.startsWith(".") || SECRET_NAME.test(p)) || parts.slice(0, -1).some((p) => SKIP_DIRS.has(p))) {
        return undefined;
      }
      try {
        const stat = await fs.promises.stat(full);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
          return undefined;
        }
        return await fs.promises.readFile(full, "utf8");
      } catch {
        return undefined;
      }
    },
  };
}

// ------------------------------------------------------------------ replies

export type DigReply = { kind: "final"; answer: DigAnswer } | { kind: "action"; action: Record<string, unknown> } | undefined;

export function parseDigReply(text: string): DigReply {
  const parsed = extractJson(text);
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  const object = parsed as Record<string, unknown>;
  if (typeof object.action === "string") {
    return { kind: "action", action: object };
  }
  if (object.args && typeof object.args === "object") {
    const args: Record<string, string> = {};
    for (const [name, value] of Object.entries(object.args as Record<string, unknown>)) {
      const expr = typeof value === "string" ? value.trim() : toPythonLiteral(value);
      if (expr) {
        args[name] = expr;
      }
    }
    const imports = Array.isArray(object.imports) ? object.imports.filter((i): i is string => typeof i === "string" && i.trim() !== "").map((i) => i.trim()) : [];
    return { kind: "final", answer: { args, imports, notes: typeof object.notes === "string" ? object.notes.trim().slice(0, 1500) : "" } };
  }
  return undefined;
}

// ------------------------------------------------------------------ lookups

function clip(text: string, limit = RESULT_LIMIT): string {
  return text.length > limit ? text.slice(0, limit) + "\n... (truncated)" : text;
}

function numbered(lines: string[], first: number): string {
  return lines.map((line, i) => `${String(first + i).padStart(4)}  ${line}`).join("\n");
}

function matcher(query: string): RegExp {
  try {
    return new RegExp(query);
  } catch {
    return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  }
}

async function eachFile(host: DigHost, only: (file: string) => boolean, visit: (file: string, lines: string[]) => boolean | void): Promise<void> {
  for (const file of await host.listFiles()) {
    if (!only(file)) {
      continue;
    }
    const content = await host.readFile(file);
    if (content === undefined) {
      continue;
    }
    if (visit(file, content.split(/\r?\n/)) === false) {
      return;
    }
  }
}

const isPython = (file: string) => file.endsWith(".py") || file.endsWith(".pyi");

/** Carries out one lookup. Returns the text shown to the model and a short label for the user. */
export async function runLookup(host: DigHost, action: Record<string, unknown>): Promise<{ label: string; text: string }> {
  const kind = String(action.action);
  const str = (key: string) => (typeof action[key] === "string" ? (action[key] as string).trim() : "");

  if (kind === "list") {
    const prefix = str("dir").replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\/$/, "");
    const files = (await host.listFiles()).filter((f) => !prefix || f.startsWith(prefix + "/"));
    return { label: `list ${prefix || "."}`, text: files.length > 0 ? clip(files.slice(0, 300).join("\n")) : "No files there." };
  }

  if (kind === "read") {
    const file = str("file").replace(/\\/g, "/");
    const content = await host.readFile(file);
    if (content === undefined) {
      return { label: `read ${file}`, text: `Cannot read ${file}. Use "list" to see which files exist.` };
    }
    const lines = content.split(/\r?\n/);
    const start = Math.max(1, Number(action.start) || 1);
    const end = Math.min(lines.length, Number(action.end) || start + 149, start + 199);
    return { label: `read ${file}:${start}-${end}`, text: clip(`${file} (lines ${start}-${end} of ${lines.length})\n${numbered(lines.slice(start - 1, end), start)}`) };
  }

  if (kind === "search") {
    const query = str("query");
    if (!query) {
      return { label: "search", text: 'Give a "query".' };
    }
    const pattern = matcher(query);
    const hits: string[] = [];
    await eachFile(
      host,
      () => true,
      (file, lines) => {
        for (let i = 0; i < lines.length; i++) {
          if (pattern.test(lines[i])) {
            hits.push(`${file}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
            if (hits.length >= 40) {
              return false;
            }
          }
        }
        return true;
      },
    );
    return { label: `search ${query}`, text: hits.length > 0 ? clip(hits.join("\n")) : `No match for ${query}.` };
  }

  if (kind === "definition") {
    const name = str("name").split(".").pop() ?? "";
    if (!/^[A-Za-z_]\w*$/.test(name)) {
      return { label: "definition", text: 'Give a plain identifier as "name".' };
    }
    const blocks: string[] = [];
    await eachFile(host, isPython, (file, lines) => {
      const text = lines.join("\n");
      for (const fn of parsePythonFunctions(text)) {
        if (fn.name === name && blocks.length < 3) {
          blocks.push(`# ${file}:${fn.line + 1}\n${sourceOf(text, fn).split("\n").slice(0, 80).join("\n")}`);
        }
      }
      for (let i = 0; i < lines.length && blocks.length < 3; i++) {
        const cls = new RegExp(`^(\\s*)class\\s+${name}\\b`).exec(lines[i]);
        const assign = !cls && new RegExp(`^${name}\\s*(:[^=]+)?=`).test(lines[i]);
        if (cls) {
          let start = i;
          while (start > 0 && lines[start - 1].trim().startsWith("@")) {
            start -= 1;
          }
          const indent = cls[1].length;
          let end = i + 1;
          while (end < lines.length && end - start < 90 && (lines[end].trim() === "" || lines[end].length - lines[end].trimStart().length > indent)) {
            end += 1;
          }
          blocks.push(`# ${file}:${i + 1}\n${lines.slice(start, end).join("\n").trimEnd()}`);
        } else if (assign) {
          blocks.push(`# ${file}:${i + 1}\n${lines.slice(i, Math.min(lines.length, i + 12)).join("\n")}`);
        }
      }
      return blocks.length < 3;
    });
    return { label: `definition ${name}`, text: blocks.length > 0 ? clip(blocks.join("\n\n")) : `No definition of ${name} found in the workspace.` };
  }

  if (kind === "usages") {
    const name = str("name").split(".").pop() ?? "";
    if (!/^[A-Za-z_]\w*$/.test(name)) {
      return { label: "usages", text: 'Give a plain identifier as "name".' };
    }
    const call = new RegExp(`\\b${name}\\s*\\(`);
    const snippets: string[] = [];
    await eachFile(host, isPython, (file, lines) => {
      for (let i = 0; i < lines.length; i++) {
        if (call.test(lines[i]) && !/^\s*(async\s+def|def|class)\s/.test(lines[i])) {
          const from = Math.max(0, i - 8);
          const to = Math.min(lines.length, i + 4);
          snippets.push(`# ${file}:${i + 1}\n${numbered(lines.slice(from, to), from + 1)}`);
          if (snippets.length >= 6) {
            return false;
          }
          i = to;
        }
      }
      return true;
    });
    return { label: `usages ${name}`, text: snippets.length > 0 ? clip(snippets.join("\n\n")) : `No call of ${name} found in the workspace.` };
  }

  return { label: kind, text: `Unknown action "${kind}". Use search, read, definition, usages or list, or give the final answer.` };
}

// --------------------------------------------------------------------- loop

export function digInstructions(maxSteps: number): string {
  return [
    "",
    "DIG DEEP IS ON. The signature alone may not tell you what these inputs look like, so before answering you may look things up in the user's codebase.",
    `You have up to ${maxSteps} lookups. To make one, reply with exactly one JSON object and nothing else:`,
    '- {"action": "usages", "name": "<function or class>"}  call sites with the lines that build the arguments',
    '- {"action": "definition", "name": "<class, function or constant>"}  its source',
    '- {"action": "search", "query": "<regular expression>"}  matching lines across the workspace',
    '- {"action": "read", "file": "<relative path>", "start": 1, "end": 120}  part of a file',
    '- {"action": "list", "dir": "<relative folder, optional>"}  file names',
    "Good things to find: how real callers build these arguments, the definitions of the types involved, test fixtures and sample data, config files, and the keys, attributes and shapes the function body relies on.",
    "",
    "When you know enough, reply with the final answer instead:",
    '{"args": {"<parameter name>": "<python expression>", ...}, "imports": ["from package.module import Name", ...], "notes": "<what you learned>"}',
    "- The rules above for the expressions still apply.",
    '- "imports": import statements for names the expressions use that the function\'s own module does not define. Only import or from-import statements, from the user\'s workspace or the standard library.',
    '- "notes": at most five sentences on the data shapes and conventions you found. They are reused later to invent consistent values for fake dependencies.',
    "- Build inputs that make the function do real work and return something meaningful, not the smallest thing that avoids an error.",
  ].join("\n");
}

export interface DigOptions {
  host: DigHost;
  /** The ordinary argument prompt; the dig instructions are appended to it. */
  prompt: string;
  maxSteps: number;
  send(messages: DigMessage[]): Promise<string | undefined>;
  onStep?(step: number, label: string): void;
}

/** Runs the lookup conversation. Returns undefined when the model gave nothing usable. */
export async function dig(options: DigOptions): Promise<DigOutcome | undefined> {
  const messages: DigMessage[] = [{ role: "user", text: options.prompt + "\n" + digInstructions(options.maxSteps) }];
  const lookups: string[] = [];
  let malformed = 0;
  // Extra turns so the model can still answer after its last lookup, after
  // one malformed reply, and after one lookup refused for being over budget.
  for (let turn = 0; turn < options.maxSteps + 4; turn++) {
    const reply = await options.send(messages);
    if (reply === undefined) {
      return undefined;
    }
    messages.push({ role: "assistant", text: reply });
    const parsed = parseDigReply(reply);
    if (parsed?.kind === "final") {
      return { ...parsed.answer, lookups };
    }
    if (!parsed) {
      malformed += 1;
      if (malformed > 1) {
        return undefined;
      }
      messages.push({ role: "user", text: "That was not a single JSON object. Reply with one lookup or the final answer, as JSON only." });
      continue;
    }
    if (lookups.length >= options.maxSteps) {
      messages.push({ role: "user", text: "No lookups left. Reply now with the final answer JSON, using what you have learned." });
      continue;
    }
    const result = await runLookup(options.host, parsed.action);
    lookups.push(result.label);
    options.onStep?.(lookups.length, result.label);
    const left = options.maxSteps - lookups.length;
    messages.push({
      role: "user",
      text: `${result.text}\n\n${left > 0 ? `${left} lookup${left === 1 ? "" : "s"} left. Reply with the next lookup or the final answer.` : "That was the last lookup. Reply now with the final answer JSON."}`,
    });
  }
  return undefined;
}
