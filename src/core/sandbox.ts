/**
 * OS-level containment for the Python subprocess.
 *
 * The in-process guard decides what the function under test sees (fakes,
 * in-memory files). It cannot see everything: C extensions doing their own
 * I/O, code that runs while the module is imported, child processes. The
 * sandbox is the backstop for those. Inside it there is no network at all
 * and the filesystem is read-only except for one scratch folder, enforced
 * by the operating system rather than by Python.
 */

import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export type SandboxMode = "auto" | "off" | "required";

export interface Sandbox {
  kind: "bubblewrap" | "sandbox-exec" | "none";
  /** Shown to the user. */
  label: string;
  /** Why there is no sandbox, when kind is "none". */
  reason?: string;
  wrap(command: string, args: string[], cwd: string, scratch: string): { command: string; args: string[] };
}

const NONE = (reason: string): Sandbox => ({
  kind: "none",
  label: "guard only, no OS sandbox",
  reason,
  wrap: (command, args) => ({ command, args }),
});

function which(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

function bubblewrap(binary: string): Sandbox {
  return {
    kind: "bubblewrap",
    label: "OS sandbox (bubblewrap): no network, read-only files",
    wrap: (command, args, cwd, scratch) => ({
      command: binary,
      args: [
        "--ro-bind", "/", "/",
        "--dev", "/dev",
        "--proc", "/proc",
        "--bind", scratch, scratch,
        "--unshare-net",
        "--unshare-ipc",
        "--unshare-pid",
        "--die-with-parent",
        "--chdir", cwd,
        "--",
        command,
        ...args,
      ],
    }),
  };
}

export function seatbeltProfile(scratch: string): string {
  const quoted = JSON.stringify(scratch);
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    // Local sockets that the interpreter and asyncio need are not network access.
    '(allow network* (local unix))',
    '(deny file-write* (subpath "/"))',
    `(allow file-write* (subpath ${quoted}) (subpath ${JSON.stringify(fs.existsSync(scratch) ? fs.realpathSync(scratch) : scratch)}))`,
    '(allow file-write* (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/"))',
  ].join("\n");
}

function seatbelt(binary: string): Sandbox {
  return {
    kind: "sandbox-exec",
    label: "OS sandbox (macOS seatbelt): no network, read-only files",
    wrap: (command, args, _cwd, scratch) => ({ command: binary, args: ["-p", seatbeltProfile(scratch), command, ...args] }),
  };
}

/** A fresh folder the sandboxed process may write to. The caller removes it. */
export function makeScratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "spotrun-"));
}

export function scratchEnv(scratch: string): NodeJS.ProcessEnv {
  return { TMPDIR: scratch, TEMP: scratch, TMP: scratch, XDG_CACHE_HOME: path.join(scratch, "cache"), MPLCONFIGDIR: path.join(scratch, "mpl") };
}

function probe(sandbox: Sandbox, python: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const scratch = makeScratch();
    const done = (problem: string | undefined) => {
      fs.rm(scratch, { recursive: true, force: true }, () => resolve(problem));
    };
    const wrapped = sandbox.wrap(python, ["-c", "import tempfile, os; open(os.path.join(tempfile.gettempdir(), 'probe'), 'w').close(); print('SPOTRUN_SANDBOX_OK')"], scratch, scratch);
    let output = "";
    let child;
    try {
      child = spawn(wrapped.command, wrapped.args, { env: { ...process.env, ...scratchEnv(scratch) }, windowsHide: true });
    } catch (error) {
      done(String(error));
      return;
    }
    const timer = setTimeout(() => child.kill(), 10000);
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      done(String(error));
    });
    child.on("close", () => {
      clearTimeout(timer);
      done(output.includes("SPOTRUN_SANDBOX_OK") ? undefined : output.trim().split("\n").slice(-2).join(" ") || "the sandboxed interpreter did not start");
    });
  });
}

const cache = new Map<string, Promise<Sandbox>>();

/**
 * The sandbox to use for an interpreter. It is tried once with a trivial
 * command; if that does not work on this machine, runs fall back to the
 * guard alone (or are refused when the mode is "required").
 */
export function detectSandbox(python: string, mode: SandboxMode, platform: NodeJS.Platform = process.platform): Promise<Sandbox> {
  if (mode === "off") {
    return Promise.resolve(NONE("turned off in the settings"));
  }
  const key = `${platform}|${python}`;
  let found = cache.get(key);
  if (!found) {
    found = (async () => {
      let candidate: Sandbox | undefined;
      if (platform === "linux") {
        const binary = which("bwrap");
        candidate = binary ? bubblewrap(binary) : undefined;
        if (!candidate) {
          return NONE("bubblewrap (bwrap) is not installed");
        }
      } else if (platform === "darwin") {
        const binary = fs.existsSync("/usr/bin/sandbox-exec") ? "/usr/bin/sandbox-exec" : which("sandbox-exec");
        candidate = binary ? seatbelt(binary) : undefined;
        if (!candidate) {
          return NONE("sandbox-exec was not found");
        }
      } else {
        return NONE("no OS sandbox is available on this platform");
      }
      const problem = await probe(candidate, python);
      return problem === undefined ? candidate : NONE(`${candidate.kind} did not work here: ${problem}`);
    })();
    cache.set(key, found);
  }
  return found;
}

export function forgetSandboxProbes(): void {
  cache.clear();
}
