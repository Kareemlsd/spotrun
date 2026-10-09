"""OS-level containment for the process that runs the function.

Mirrors src/core/sandbox.ts. Inside the sandbox there is no network and the
filesystem is read-only except for one scratch folder. The in-process guard
still decides what the function sees; this is the backstop for what the guard
cannot see (C extensions, import-time code, child processes).
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile


class Sandbox(object):
    def __init__(self, kind, label, binary=None, reason=None):
        self.kind = kind
        self.label = label
        self.binary = binary
        self.reason = reason

    def wrap(self, command, cwd, scratch):
        if self.kind == "bubblewrap":
            return [
                self.binary,
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
            ] + list(command)  # fmt: skip
        if self.kind == "sandbox-exec":
            return [self.binary, "-p", seatbelt_profile(scratch)] + list(command)
        return list(command)


def none(reason):
    return Sandbox("none", "guard only, no OS sandbox", reason=reason)


def seatbelt_profile(scratch):
    real = os.path.realpath(scratch)
    return "\n".join(
        [
            "(version 1)",
            "(allow default)",
            "(deny network*)",
            "(allow network* (local unix))",
            '(deny file-write* (subpath "/"))',
            "(allow file-write* (subpath %s) (subpath %s))" % (json.dumps(scratch), json.dumps(real)),
            '(allow file-write* (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/"))',
        ]
    )


def make_scratch():
    return tempfile.mkdtemp(prefix="spotrun-")


def scratch_env(scratch):
    return {
        "TMPDIR": scratch,
        "TEMP": scratch,
        "TMP": scratch,
        "XDG_CACHE_HOME": os.path.join(scratch, "cache"),
        "MPLCONFIGDIR": os.path.join(scratch, "mpl"),
    }


def _probe(sandbox, python):
    scratch = make_scratch()
    code = "import tempfile, os; open(os.path.join(tempfile.gettempdir(), 'probe'), 'w').close(); print('SPOTRUN_SANDBOX_OK')"
    env = dict(os.environ)
    env.update(scratch_env(scratch))
    try:
        done = subprocess.run(
            sandbox.wrap([python, "-c", code], scratch, scratch),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=15,
        )
        output = done.stdout.decode("utf-8", "replace")
    except (OSError, subprocess.SubprocessError) as exc:
        output = str(exc)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    if "SPOTRUN_SANDBOX_OK" in output:
        return None
    return " ".join(output.strip().splitlines()[-2:]) or "the sandboxed interpreter did not start"


_cache = {}


def detect(python, mode, platform=None):
    """The sandbox to use for an interpreter. Tried once with a trivial command."""
    if mode == "off":
        return none("turned off with SPOTRUN_SANDBOX=off")
    platform = platform or sys.platform
    key = (platform, python)
    if key in _cache:
        return _cache[key]
    if platform.startswith("linux"):
        binary = shutil.which("bwrap")
        candidate = Sandbox("bubblewrap", "OS sandbox (bubblewrap): no network, read-only files", binary) if binary else None
        missing = "bubblewrap (bwrap) is not installed"
    elif platform == "darwin":
        binary = "/usr/bin/sandbox-exec" if os.path.exists("/usr/bin/sandbox-exec") else shutil.which("sandbox-exec")
        candidate = Sandbox("sandbox-exec", "OS sandbox (macOS seatbelt): no network, read-only files", binary) if binary else None
        missing = "sandbox-exec was not found"
    else:
        candidate = None
        missing = "no OS sandbox is available on this platform"
    if candidate is None:
        found = none(missing)
    else:
        problem = _probe(candidate, python)
        found = candidate if problem is None else none("%s did not work here: %s" % (candidate.kind, problem))
    _cache[key] = found
    return found
