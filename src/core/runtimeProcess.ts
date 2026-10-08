import { spawn } from "child_process";
import { NeedArgs, NeedValue, RunResult, StartRequest } from "./types";

const PREFIX = "\x1eSPOTRUN ";

export interface Handlers {
  needArgs(message: NeedArgs): Promise<Record<string, string> | undefined>;
  needValue(message: NeedValue): Promise<string | undefined>;
}

export interface ExecOptions {
  python: string;
  mainScript: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  log?: (text: string) => void;
}

export class RunError extends Error {
  constructor(
    message: string,
    readonly detail: string = "",
    readonly kind: "spawn" | "timeout" | "cancelled" | "crash" = "crash",
  ) {
    super(message);
  }
}

/** Runs the Python runtime once and answers its questions through `handlers`. */
export function execute(request: StartRequest, handlers: Handlers, options: ExecOptions): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(options.python, ["-u", options.mainScript], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env, PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let settled = false;
    let buffer = "";
    let stderr = "";
    let stray = "";
    let timer: NodeJS.Timeout | undefined;
    let queue: Promise<void> = Promise.resolve();

    const finish = (error: Error | undefined, result?: RunResult) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      options.signal?.removeEventListener("abort", onAbort);
      if (child.exitCode === null) {
        child.kill();
      }
      if (error) {
        reject(error);
      } else {
        resolve(result!);
      }
    };
    const arm = () => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        finish(new RunError(`The run was stopped after ${Math.round(options.timeoutMs / 1000)} s without finishing.`, stderr, "timeout"));
      }, options.timeoutMs);
    };
    const pause = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    const onAbort = () => finish(new RunError("Cancelled.", "", "cancelled"));
    options.signal?.addEventListener("abort", onAbort);
    if (options.signal?.aborted) {
      onAbort();
      return;
    }

    const send = (message: unknown) => {
      if (!settled && child.stdin.writable) {
        child.stdin.write(JSON.stringify(message) + "\n");
      }
    };

    const handle = async (line: string) => {
      if (!line.startsWith(PREFIX)) {
        stray += line + "\n";
        return;
      }
      let message: { type: string };
      try {
        message = JSON.parse(line.slice(PREFIX.length));
      } catch {
        stray += line + "\n";
        return;
      }
      if (message.type === "result") {
        finish(undefined, message as RunResult);
      } else if (message.type === "need_args") {
        pause();
        let args: Record<string, string> | undefined;
        try {
          args = await handlers.needArgs(message as NeedArgs);
        } catch (error) {
          options.log?.(`argument generation failed: ${String(error)}`);
        }
        arm();
        send({ type: "args", args: args ?? null });
      } else if (message.type === "need_value") {
        pause();
        let expr: string | undefined;
        try {
          expr = await handlers.needValue(message as NeedValue);
        } catch (error) {
          options.log?.(`value generation failed: ${String(error)}`);
        }
        arm();
        send({ type: "value", expr: expr ?? null });
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        queue = queue.then(() => handle(line));
        newline = buffer.indexOf("\n");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => {
      finish(new RunError(`Could not start Python (${options.python}): ${error.message}`, "", "spawn"));
    });
    child.on("close", (code) => {
      void queue.then(() => {
        const detail = [stderr.trim(), stray.trim()].filter(Boolean).join("\n");
        finish(new RunError(`Python exited with code ${code} before reporting a result.`, detail, "crash"));
      });
    });

    arm();
    send(request);
  });
}
