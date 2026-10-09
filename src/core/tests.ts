/**
 * Turning recorded runs into test functions in the user's codebase.
 *
 * The model decides where the tests belong and writes them; this module
 * prepares what it needs to decide well (the observed runs, the existing
 * test layout and conventions) and merges its answer into a file without
 * overwriting anything.
 */

import { DigHost } from "./dig";
import { extractJson } from "./prompts";
import { RunResult } from "./types";

export interface TestScenario {
  title: string;
  args: { name: string; expr: string }[];
  imports: string[];
  /** Real calls that were replaced during the run. */
  faked: string[];
  /** Values the replaced calls produced, as the function used them. */
  invented: { path: string; value: string }[];
  outcome: { kind: "return"; value: string } | { kind: "raise"; type: string; message: string };
}

/** A run that can be turned into a test, or the reason it cannot. */
export function scenarioFromResult(title: string, result: RunResult): TestScenario | string {
  if (result.fatal) {
    return "it could not be run";
  }
  if (result.exception?.blocked) {
    return "it was stopped at a real side effect";
  }
  const args = (result.args ?? [])
    .filter((a) => a.source !== "default")
    .map((a) => ({ name: a.name, expr: a.expr ?? a.value ?? "FAKE" }));
  return {
    title,
    args,
    imports: result.imports ?? [],
    faked: [...new Set((result.effects ?? []).map((e) => e.what))].slice(0, 12),
    invented: (result.resolutions ?? [])
      .filter((r) => !r.error && (r.expr ?? r.value))
      .map((r) => ({ path: r.path, value: r.expr ?? r.value ?? "" }))
      .slice(0, 20),
    outcome: result.exception
      ? { kind: "raise", type: result.exception.type, message: result.exception.message }
      : { kind: "return", value: result.return ?? "None" },
  };
}

// ------------------------------------------------------------ repo context

export interface RepoContext {
  /** Existing test files and conftest files, workspace-relative. */
  testFiles: string[];
  /** Folders that contain Python source, to show the layout. */
  sourceFolders: string[];
  /** Test configuration found in the workspace. */
  config: { path: string; text: string }[];
  /** The existing test file for this module, in full. */
  related?: { path: string; text: string };
  /** Another test file, as an example of the project's conventions. */
  sample?: { path: string; text: string };
}

const TEST_FILE = /(^|\/)(test_[^/]*\.py|[^/]*_test\.py|conftest\.py)$/;
const CONFIG_FILE = /(^|\/)(pytest\.ini|pyproject\.toml|setup\.cfg|tox\.ini)$/;

function head(text: string, lines: number, chars: number): string {
  const cut = text.split(/\r?\n/).slice(0, lines).join("\n");
  return cut.length > chars ? cut.slice(0, chars) + "\n# ... (truncated)" : cut;
}

/** Collects what the model needs to place and style the tests. */
export async function gatherRepoContext(host: DigHost, sourceRelative: string, functionName: string): Promise<RepoContext> {
  const files = await host.listFiles();
  const source = sourceRelative.replace(/\\/g, "/");
  const stem = (source.split("/").pop() ?? "").replace(/\.py$/, "");
  const testFiles = files.filter((f) => TEST_FILE.test(f));
  const sourceFolders = [...new Set(files.filter((f) => f.endsWith(".py") && !TEST_FILE.test(f)).map((f) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ".")))].slice(0, 40);

  const config: { path: string; text: string }[] = [];
  for (const file of files.filter((f) => CONFIG_FILE.test(f)).slice(0, 4)) {
    const text = await host.readFile(file);
    if (!text) {
      continue;
    }
    if (file.endsWith("pyproject.toml") || file.endsWith("setup.cfg") || file.endsWith("tox.ini")) {
      // Only the test-related sections of general config files.
      const sections = text.split(/\n(?=\[)/).filter((section) => /^\[(tool\.)?(pytest|tool:pytest|coverage|testenv)/.test(section.trim()));
      if (sections.length > 0) {
        config.push({ path: file, text: head(sections.join("\n"), 40, 1500) });
      }
    } else {
      config.push({ path: file, text: head(text, 40, 1500) });
    }
  }

  const byName = testFiles.filter((f) => {
    const base = f.split("/").pop() ?? "";
    return base === `test_${stem}.py` || base === `${stem}_test.py`;
  });
  // Prefer the one whose folder mirrors the source file's folder.
  const sourceDir = source.includes("/") ? source.slice(0, source.lastIndexOf("/")) : "";
  byName.sort((a, b) => Number(b.includes(sourceDir) && sourceDir !== "") - Number(a.includes(sourceDir) && sourceDir !== "") || a.length - b.length);
  let relatedPath: string | undefined = byName[0];
  if (!relatedPath) {
    const call = new RegExp(`\\b${functionName.replace(/[^\w]/g, "")}\\s*\\(`);
    for (const file of testFiles.filter((f) => !f.endsWith("conftest.py")).slice(0, 150)) {
      const text = await host.readFile(file);
      if (text && call.test(text) && new RegExp(`\\b${stem}\\b`).test(text)) {
        relatedPath = file;
        break;
      }
    }
  }
  let related: RepoContext["related"];
  if (relatedPath) {
    const text = await host.readFile(relatedPath);
    if (text !== undefined) {
      related = { path: relatedPath, text: text.length > 9000 ? text.slice(0, 4000) + "\n# ... (middle omitted) ...\n" + text.slice(-4000) : text };
    }
  }
  let sample: RepoContext["sample"];
  const other = testFiles.find((f) => f !== relatedPath && !f.endsWith("conftest.py"));
  if (other) {
    const text = await host.readFile(other);
    if (text) {
      sample = { path: other, text: head(text, 70, 3000) };
    }
  }
  const conftest = testFiles.find((f) => f.endsWith("conftest.py"));
  if (conftest) {
    const text = await host.readFile(conftest);
    if (text) {
      config.push({ path: conftest, text: head(text, 60, 2500) });
    }
  }
  return { testFiles: testFiles.slice(0, 120), sourceFolders, config, related, sample };
}

// ------------------------------------------------------------------ prompt

export interface TestsPromptInput {
  relativePath: string;
  /** Dotted module name the runtime imported the file as. */
  module: string | undefined;
  qualname: string;
  functionSource: string;
  scenarios: TestScenario[];
  repo: RepoContext;
}

export function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 50) || "case"
  );
}

export function buildTestsPrompt(input: TestsPromptInput): string {
  const repo = input.repo;
  const functionName = input.qualname.split(".").pop() ?? input.qualname;
  const scenarios = input.scenarios.map((s, index) => {
    const lines = [`Case ${index + 1}: ${s.title}`, `  suggested test name: test_${slug(functionName)}_${slug(s.title)}`];
    lines.push(s.args.length > 0 ? "  arguments:" : "  arguments: none");
    for (const arg of s.args) {
      lines.push(`    ${arg.name} = ${arg.expr}`);
    }
    if (s.imports.length > 0) {
      lines.push(`  the arguments use: ${s.imports.join("; ")}`);
    }
    if (s.faked.length > 0) {
      lines.push("  external calls that were replaced by fakes (the test must mock these):");
      for (const call of s.faked) {
        lines.push(`    ${call}`);
      }
    }
    if (s.invented.length > 0) {
      lines.push("  values those fakes produced, as the function used them:");
      for (const value of s.invented) {
        lines.push(`    ${value.path} = ${value.value}`);
      }
    }
    lines.push(s.outcome.kind === "return" ? `  observed result: returned ${s.outcome.value}` : `  observed result: raised ${s.outcome.type}: ${s.outcome.message}`);
    return lines.join("\n");
  });

  const layout: string[] = [];
  layout.push(repo.testFiles.length > 0 ? "Existing test files:\n" + repo.testFiles.map((f) => `- ${f}`).join("\n") : "There are no test files in this workspace yet.");
  layout.push("Folders with Python source:\n" + repo.sourceFolders.map((f) => `- ${f}`).join("\n"));
  for (const file of repo.config) {
    layout.push(`${file.path}:\n\`\`\`\n${file.text}\n\`\`\``);
  }
  if (repo.related) {
    layout.push(`This file already tests the module. Add to it; do not repeat its tests:\n${repo.related.path}\n\`\`\`python\n${repo.related.text}\n\`\`\``);
  }
  if (repo.sample) {
    layout.push(`An example of how tests are written in this project (${repo.sample.path}):\n\`\`\`python\n${repo.sample.text}\n\`\`\``);
  }

  return [
    "You write unit tests for one Python function from runs that were observed and that the developer has approved. Each case below becomes one test that reproduces that run.",
    "",
    `Function \`${input.qualname}\` in ${input.relativePath}${input.module ? ` (importable as module \`${input.module}\`)` : ""}:`,
    "```python",
    input.functionSource,
    "```",
    "",
    "Observed runs:",
    scenarios.join("\n\n"),
    "",
    "The project:",
    layout.join("\n\n"),
    "",
    "Reply with one JSON object and nothing else:",
    '{"file": "<path relative to the workspace root>", "imports": ["<one import statement>", ...], "code": "<the test functions>", "reason": "<one sentence on why this file>"}',
    "",
    "Where the tests go:",
    "- If a file already tests this module, use that file.",
    "- Otherwise create a new file where this project keeps its tests, following the naming and folder pattern of the existing test files. Mirror the source file's sub-folder if the existing tests do.",
    `- If the project has no tests yet, use tests/test_${slug(input.relativePath.split("/").pop()?.replace(/\.py$/, "") ?? "module")}.py.`,
    "",
    "How to write them:",
    "- Use the framework and style the project already uses (pytest functions by default; unittest classes only if the existing tests are). Reuse fixtures from conftest.py where they fit.",
    "- One test per case, named as suggested unless that name exists already.",
    '- "imports" holds every import the code needs, one statement per entry, written the way the project\'s tests import this module. "code" holds only the tests and any small helpers, with no import statements.',
    "- Replace the external calls listed for a case with unittest.mock (patch the name where the function's module looks it up) or pytest's monkeypatch, and make the mock return objects shaped so that the listed values come out the way the function reads them. For an argument given as FAKE, pass a mock configured the same way. A test must not reach the network, a database or the filesystem outside tmp_path.",
    "- Assert the observed result: equality for returned values (pytest.approx for floats), pytest.raises for an observed exception. Do not assert on anything that was not observed.",
    "- No explanations, no markdown.",
  ].join("\n");
}

export interface TestsAnswer {
  file: string;
  imports: string[];
  code: string;
  reason: string;
}

export function parseTestsReply(text: string): TestsAnswer | undefined {
  const parsed = extractJson(text) as Record<string, unknown> | undefined;
  if (!parsed || typeof parsed.file !== "string" || typeof parsed.code !== "string" || parsed.code.trim() === "") {
    return undefined;
  }
  const code = parsed.code
    .replace(/^```(?:python)?\s*\n/, "")
    .replace(/\n```\s*$/, "")
    .replace(/\r\n/g, "\n");
  const imports: string[] = [];
  const add = (line: string) => {
    const trimmed = line.trim();
    if (/^(import\s|from\s+\S+\s+import\s)/.test(trimmed) && !imports.includes(trimmed)) {
      imports.push(trimmed);
    }
  };
  if (Array.isArray(parsed.imports)) {
    parsed.imports.filter((i): i is string => typeof i === "string").forEach((i) => i.split("\n").forEach(add));
  }
  // Tolerate imports left at the top of the code.
  const body: string[] = [];
  let leading = true;
  for (const line of code.split("\n")) {
    if (leading && /^(import\s|from\s+\S+\s+import\s)/.test(line)) {
      add(line);
    } else {
      if (line.trim() !== "") {
        leading = false;
      }
      body.push(line);
    }
  }
  return { file: parsed.file.trim(), imports, code: body.join("\n").trim() + "\n", reason: typeof parsed.reason === "string" ? parsed.reason.trim() : "" };
}

/** A safe workspace-relative path for a test file, or undefined. */
export function validateTestPath(file: string): string | undefined {
  const normalised = file
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .trim();
  if (!normalised.endsWith(".py") || normalised.startsWith("/") || /^[A-Za-z]:/.test(normalised)) {
    return undefined;
  }
  const parts = normalised.split("/");
  if (parts.some((p) => p === "" || p === ".." || p.startsWith(".")) || !/^[\w.\-/]+$/.test(normalised)) {
    return undefined;
  }
  return normalised;
}

// ------------------------------------------------------------------- merge

const TEST_DEF = /^(?:async\s+)?def\s+(test_\w+)\s*\(|^class\s+(Test\w*)\b/gm;

export function testNames(code: string): string[] {
  const names: string[] = [];
  for (const match of code.matchAll(TEST_DEF)) {
    names.push(match[1] ?? match[2]);
  }
  return names;
}

export interface MergeResult {
  text: string;
  /** Top-level test functions and classes that were added. */
  names: string[];
  /** 0-based line where the added code starts. */
  line: number;
  created: boolean;
}

/**
 * Adds the tests to a file's text without touching what is there: missing
 * imports go after the existing imports, the tests go at the end, and a new
 * test whose name is taken gets a numeric suffix.
 */
export function mergeTests(existing: string | undefined, imports: string[], code: string): MergeResult {
  let added = code.replace(/\s+$/, "") + "\n";
  if (existing === undefined || existing.trim() === "") {
    const header = imports.length > 0 ? imports.join("\n") + "\n\n\n" : "";
    return { text: header + added, names: testNames(added), line: header.split("\n").length - 1, created: true };
  }
  const taken = new Set([...existing.matchAll(/^\s*(?:async\s+)?def\s+(\w+)\s*\(|^class\s+(\w+)\b/gm)].map((m) => m[1] ?? m[2]));
  for (const name of testNames(added)) {
    if (!taken.has(name)) {
      taken.add(name);
      continue;
    }
    let suffix = 2;
    while (taken.has(`${name}_${suffix}`)) {
      suffix += 1;
    }
    added = added.replace(new RegExp(`\\b${name}\\b`, "g"), `${name}_${suffix}`);
    taken.add(`${name}_${suffix}`);
  }

  const lines = existing.replace(/\r\n/g, "\n").split("\n");
  const present = new Set(lines.map((l) => l.trim()));
  const missing = imports.filter((i) => !present.has(i));
  if (missing.length > 0) {
    // After the last top-level import statement, including a parenthesised one.
    let after = -1;
    let depth = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (depth > 0 || /^(import\s|from\s+\S+\s+import\s)/.test(line)) {
        depth += (line.match(/\(/g) ?? []).length - (line.match(/\)/g) ?? []).length;
        depth = Math.max(0, depth);
        after = i;
      } else if (/^(def|class|async\s+def|@)\b/.test(line)) {
        break;
      }
    }
    lines.splice(after + 1, 0, ...missing);
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  const start = lines.length + 2;
  return { text: lines.join("\n") + "\n\n\n" + added, names: testNames(added), line: start, created: false };
}
