import { execute, ExecOptions, Handlers } from "./runtimeProcess";
import { FunctionData, RunResult, StartRequest } from "./types";

export interface RunSpec {
  file: string;
  qualname: string;
  root: string;
  scope: string;
  llm: boolean;
  limits: Record<string, number>;
}

export interface SessionOutcome {
  result: RunResult;
  data: FunctionData;
  attempts: number;
}

export function buildRequest(spec: RunSpec, data: FunctionData): StartRequest {
  return {
    type: "start",
    file: spec.file,
    qualname: spec.qualname,
    root: spec.root,
    llm: spec.llm,
    args: data.args,
    pins: data.pins,
    cache: data.fakes,
    extra_patches: data.patches,
    eager: data.eager,
    imports: data.imports ?? [],
    scope: spec.scope,
    limits: spec.limits,
  };
}

/** Folds what a run learned (model answers, recovery hints) back into the stored data. */
export function absorb(data: FunctionData, result: RunResult): { data: FunctionData; retry: boolean } {
  const next: FunctionData = {
    signature: data.signature,
    args: data.args ? { ...data.args } : null,
    fakes: { ...data.fakes },
    patches: [...data.patches],
    eager: [...data.eager],
    pins: { args: { ...data.pins.args }, fakes: { ...data.pins.fakes } },
    instructions: [...(data.instructions ?? [])],
    imports: [...(data.imports ?? [])],
    notes: data.notes,
    lookups: data.lookups ? [...data.lookups] : undefined,
  };
  if (result.fatal) {
    return { data: next, retry: false };
  }
  for (const record of result.resolutions ?? []) {
    if (record.source === "llm" && record.expr) {
      next.fakes[record.key] = record.expr;
    }
  }
  const generated = (result.args ?? []).filter((a) => a.source === "llm" && a.expr);
  if (generated.length > 0) {
    next.args = {};
    next.imports = [...(result.imports ?? [])];
    for (const arg of result.args) {
      if ((arg.source === "llm" || arg.source === "cache") && arg.expr) {
        next.args[arg.name] = arg.expr;
      }
    }
  }
  let retry = false;
  const hint = result.retry;
  if (hint?.patch && !next.patches.includes(hint.patch)) {
    next.patches.push(hint.patch);
    retry = true;
  }
  if (hint?.eager) {
    const key = JSON.stringify([hint.eager.line, hint.eager.paths]);
    if (!next.eager.some((e) => JSON.stringify([e.line, e.paths]) === key)) {
      next.eager.push(hint.eager);
      retry = true;
    }
  }
  return { data: next, retry };
}

/**
 * Runs the function, and runs it again when the runtime reports a way past
 * a failure: a library call that tried a real side effect gets patched, a
 * fake that reached code needing a concrete value gets resolved up front.
 */
export async function runWithRetries(
  spec: RunSpec,
  data: FunctionData,
  handlers: Handlers,
  options: ExecOptions,
  maxAttempts = 4,
): Promise<SessionOutcome> {
  let current = data;
  let result: RunResult | undefined;
  let attempts = 0;
  while (attempts < maxAttempts) {
    attempts += 1;
    result = await execute(buildRequest(spec, current), handlers, options);
    const absorbed = absorb(current, result);
    current = absorbed.data;
    if (!absorbed.retry) {
      break;
    }
  }
  return { result: result!, data: current, attempts };
}
