/** Shapes shared with the Python runtime (see python/spotrun_runtime/runner.py). */

export interface Step {
  /** frame id */
  f: number;
  /** 1-based line number */
  l: number;
  /** variables written by executing this line */
  w?: Record<string, string>;
  /** value returned (or yielded) from this line */
  ret?: string;
  /** exception raised on this line */
  exc?: string;
  /** number of steps skipped before this one (long loops) */
  gap?: number;
}

export interface FrameRecord {
  id: number;
  file: number;
  name: string;
  line: number;
  parent: number;
  depth: number;
  args: Record<string, string>;
  ret?: string;
  end?: number;
}

export interface ArgInfo {
  name: string;
  expr: string | null;
  source: "llm" | "cache" | "pin" | "heuristic" | "default" | null;
  value?: string;
  error?: string;
  rejected?: string;
  note?: string;
}

export interface Resolution {
  key: string;
  path: string;
  op: string;
  expr: string | null;
  source: "llm" | "cache" | "pin" | "heuristic";
  value: string | null;
  file: string | null;
  line: number;
  text: string;
  step: number;
  error?: string;
}

export interface Effect {
  kind: "faked" | "skipped" | "file";
  what: string;
  step: number;
  file: string | null;
  line: number;
}

export interface Blocked {
  event: string;
  what: string;
  file: string | null;
  line: number;
  target: string | null;
  step: number;
}

export interface ExceptionInfo {
  type: string;
  message: string;
  blocked: boolean;
  frames: { file: string; line: number; name: string; text: string }[];
}

export interface EagerHint {
  line: string;
  paths: string[];
  why: string;
}

export interface RunResult {
  type: "result";
  fatal?: string;
  qualname: string;
  file: string;
  args: ArgInfo[];
  is_async: boolean;
  return?: string;
  files: string[];
  frames: FrameRecord[];
  steps: Step[];
  truncated: boolean;
  skipped: number;
  exception: ExceptionInfo | null;
  outputs: [number, "out" | "err", string][];
  resolutions: Resolution[];
  effects: Effect[];
  blocked: Blocked[];
  retry: { patch?: string; eager?: EagerHint } | null;
  llm_calls: number;
  written_files: string[];
}

export interface ParamInfo {
  name: string;
  kind: string;
  annotation: string | null;
  has_default: boolean;
  default: string | null;
  is_self: boolean;
}

export interface NeedArgs {
  type: "need_args";
  params: ParamInfo[];
  class_name: string | null;
  names: string[];
}

export interface NeedValue {
  type: "need_value";
  path: string;
  op: string;
  detail: string | null;
  file: string | null;
  line: number;
  text: string;
}

export interface Pins {
  args: Record<string, string>;
  fakes: Record<string, string>;
}

export interface StartRequest {
  type: "start";
  file: string;
  qualname: string;
  root: string;
  llm: boolean;
  args: Record<string, string> | null;
  pins: Pins;
  cache: Record<string, string>;
  extra_patches: string[];
  eager: EagerHint[];
  scope: string;
  limits: Record<string, number>;
  trace?: boolean;
}

/** Everything remembered about one function between runs. */
export interface FunctionData {
  signature: string;
  args: Record<string, string> | null;
  fakes: Record<string, string>;
  patches: string[];
  eager: EagerHint[];
  pins: Pins;
  /** What the user asked the inputs to look like, oldest first. */
  instructions: string[];
  /** Arguments of the run a new instruction refines. Not persisted. */
  previousArgs?: Record<string, string> | null;
}

export function emptyFunctionData(signature: string): FunctionData {
  return { signature, args: null, fakes: {}, patches: [], eager: [], pins: { args: {}, fakes: {} }, instructions: [] };
}
