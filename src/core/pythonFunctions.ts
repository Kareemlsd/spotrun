/**
 * Finds function definitions in Python source without a language server.
 *
 * A small scanner tracks strings, comments and bracket depth so that only
 * real statement starts are considered, then an indentation stack gives each
 * `def` its qualified name and extent.
 */

export interface PyFunction {
  name: string;
  /** dotted path from module level, e.g. "Basket.add" */
  qualname: string;
  /** 0-based line of the `def` keyword */
  line: number;
  /** 0-based line where the signature ends (the line holding the colon) */
  headerEnd: number;
  /** 0-based last line of the body */
  endLine: number;
  indent: number;
  isAsync: boolean;
  className: string | null;
  /** reachable from module level through classes only (not nested in a function) */
  runnable: boolean;
}

interface Scope {
  kind: "class" | "def";
  name: string;
  indent: number;
  fn?: PyFunction;
}

const DEFINITION = /^(async\s+def|def|class)\s+([A-Za-z_]\w*)/;

function indentWidth(line: string): number {
  let width = 0;
  for (const ch of line) {
    if (ch === " ") {
      width += 1;
    } else if (ch === "\t") {
      width += 8 - (width % 8);
    } else {
      break;
    }
  }
  return width;
}

export function parsePythonFunctions(text: string): PyFunction[] {
  const lines = text.split(/\r?\n/);
  const functions: PyFunction[] = [];
  const stack: Scope[] = [];

  let triple: string | null = null;
  let depth = 0;
  let continued = false;
  let pendingHeader: PyFunction | null = null;
  let lastCodeLine = -1;

  const closeScopes = (indent: number, endLine: number) => {
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      const scope = stack.pop()!;
      if (scope.fn) {
        scope.fn.endLine = Math.max(endLine, scope.fn.headerEnd);
      }
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const startsStatement = triple === null && depth === 0 && !continued;
    const trimmed = line.trim();

    if (startsStatement && trimmed !== "" && !trimmed.startsWith("#")) {
      const indent = indentWidth(line);
      closeScopes(indent, lastCodeLine);
      const match = DEFINITION.exec(trimmed);
      if (match) {
        const isClass = match[1] === "class";
        const name = match[2];
        if (isClass) {
          stack.push({ kind: "class", name, indent });
        } else {
          const parents = stack.map((s) => s.name);
          const enclosingClass = stack.length > 0 && stack[stack.length - 1].kind === "class" ? stack[stack.length - 1].name : null;
          const fn: PyFunction = {
            name,
            qualname: [...parents, name].join("."),
            line: i,
            headerEnd: i,
            endLine: i,
            indent,
            isAsync: match[1].startsWith("async"),
            className: enclosingClass,
            runnable: stack.every((s) => s.kind === "class"),
          };
          functions.push(fn);
          stack.push({ kind: "def", name, indent, fn });
          pendingHeader = fn;
        }
      }
    }

    // Scan the line to keep string / bracket state for the next one.
    let j = 0;
    let sawCode = false;
    while (j < line.length) {
      if (triple !== null) {
        const close = line.indexOf(triple, j);
        if (close === -1) {
          j = line.length;
        } else {
          j = close + 3;
          triple = null;
        }
        sawCode = true;
        continue;
      }
      const ch = line[j];
      if (ch === "#") {
        break;
      }
      if (ch === '"' || ch === "'") {
        sawCode = true;
        if (line.startsWith(ch.repeat(3), j)) {
          triple = ch.repeat(3);
          j += 3;
          continue;
        }
        j += 1;
        while (j < line.length && line[j] !== ch) {
          j += line[j] === "\\" ? 2 : 1;
        }
        j += 1;
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") {
        depth += 1;
      } else if (ch === ")" || ch === "]" || ch === "}") {
        depth = Math.max(0, depth - 1);
      }
      if (ch !== " " && ch !== "\t") {
        sawCode = true;
      }
      j += 1;
    }
    const code = line.replace(/#.*$/, "").trimEnd();
    continued = triple === null && code.endsWith("\\");

    if (sawCode) {
      lastCodeLine = i;
    }
    if (pendingHeader && triple === null && depth === 0 && !continued) {
      pendingHeader.headerEnd = i;
      pendingHeader = null;
    }
  }
  closeScopes(-1, lastCodeLine);
  return functions;
}

/** The function to run for a cursor on `line` (0-based), or undefined. */
export function functionAt(functions: PyFunction[], line: number): PyFunction | undefined {
  let best: PyFunction | undefined;
  for (const fn of functions) {
    if (line >= fn.line && line <= fn.endLine && fn.runnable) {
      if (!best || fn.line >= best.line) {
        best = fn;
      }
    }
  }
  if (best) {
    return best;
  }
  // Cursor on a decorator line just above a definition.
  return undefined;
}

export function findByQualname(functions: PyFunction[], qualname: string): PyFunction | undefined {
  return functions.find((fn) => fn.qualname === qualname && fn.runnable);
}

/** Signature text, normalised, used to notice when cached arguments are stale. */
export function signatureOf(text: string, fn: PyFunction): string {
  const lines = text.split(/\r?\n/).slice(fn.line, fn.headerEnd + 1);
  return lines.map((l) => l.replace(/#.*$/, "").trim()).join(" ").replace(/\s+/g, " ");
}

export function sourceOf(text: string, fn: PyFunction): string {
  const lines = text.split(/\r?\n/);
  let start = fn.line;
  while (start > 0 && lines[start - 1].trim().startsWith("@") && indentWidth(lines[start - 1]) === fn.indent) {
    start -= 1;
  }
  const body = lines.slice(start, fn.endLine + 1);
  const strip = Math.min(...body.filter((l) => l.trim() !== "").map(indentWidth));
  return body.map((l) => (l.trim() === "" ? "" : l.slice(Math.min(strip, l.length - l.trimStart().length)))).join("\n");
}

/** 0-based line of the `def` keyword at or after `fromLine` (which may be a decorator). */
export function defLineFrom(lines: string[], fromLine: number): number {
  for (let i = fromLine; i < Math.min(lines.length, fromLine + 40); i++) {
    if (/^\s*(async\s+def|def)\s/.test(lines[i])) {
      return i;
    }
  }
  return fromLine;
}
