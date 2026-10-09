"""Runs functions through the Spot Run runtime and decides who invents values.

The runtime (spotrun_runtime) is started as a separate process with the
project's interpreter. It asks questions over a JSON-lines channel: what the
arguments are, and what a faked dependency is once the code uses it as a
concrete value. Three sources can answer:

  model   a small model configured with SPOTRUN_MODEL
  agent   the calling agent, through the answer_value tool (the run pauses)
  guess   heuristics from names and type hints, no model at all

Everything here is written as generators so that a run can be suspended while
the agent is asked, with the runtime process kept alive in between.
"""

import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time

from . import model as model_module
from . import prompts, report, sandbox, source

PREFIX = "\x1eSPOTRUN "
SECRET_ENV = ("SPOTRUN_API_KEY", "SPOTRUN_MODEL", "SPOTRUN_BASE_URL", "SPOTRUN_PROVIDER")


class ToolError(Exception):
    """A problem to report to the agent as the tool's (error) result."""


class Question(object):
    """A fake needs a concrete value and the calling agent is asked for it."""

    def __init__(self, need, known, target, case=None):
        self.need = need
        self.known = known
        self.target = target
        self.case = case


class Target(object):
    def __init__(self, file, qualname, root, python, text, function, box):
        self.file = file
        self.qualname = qualname
        self.root = root
        self.python = python
        self.text = text
        self.function = function
        self.sandbox = box
        self.relative = os.path.relpath(file, root) if file.startswith(root + os.sep) else file


def main_script():
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "spotrun_main.py")


def find_root(file, cwd):
    """The project folder a file belongs to: the repository, else the package project, else its folder."""
    directory = os.path.dirname(file)
    project = None
    current = directory
    while True:
        if os.path.exists(os.path.join(current, ".git")):
            return current
        if project is None and any(os.path.exists(os.path.join(current, m)) for m in ("pyproject.toml", "setup.py", "setup.cfg")):
            project = current
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    if project:
        return project
    cwd = os.path.abspath(cwd)
    if file.startswith(cwd + os.sep):
        return cwd
    return directory


def _on_path(name, env, skip):
    """Like shutil.which, but ignoring one folder."""
    for folder in (env.get("PATH") or os.defpath).split(os.pathsep):
        if not folder or os.path.realpath(folder) == skip:
            continue
        for suffix in ("", ".exe") if os.name == "nt" else ("",):
            candidate = os.path.join(folder, name + suffix)
            if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                return candidate
    return None


def find_python(root, env):
    """The interpreter that has the project's dependencies.

    The server usually runs in an environment of its own (uvx, pipx) whose
    interpreter comes first on PATH and has none of the project's packages,
    so that environment is never picked unless nothing else exists.
    """
    bin_dir, exe = ("Scripts", "python.exe") if os.name == "nt" else ("bin", "python")
    explicit = env.get("SPOTRUN_PYTHON")
    if explicit:
        found = explicit if os.path.isfile(explicit) else shutil.which(explicit, path=env.get("PATH"))
        if not found:
            raise ToolError("SPOTRUN_PYTHON is set to %r, which was not found." % explicit)
        return found
    own = os.path.realpath(sys.prefix)
    for folder in (os.path.join(root, ".venv"), os.path.join(root, "venv"), env.get("VIRTUAL_ENV")):
        if folder and os.path.realpath(folder) != own:
            candidate = os.path.join(folder, bin_dir, exe)
            if os.path.isfile(candidate):
                return candidate
    own_bin = os.path.realpath(os.path.join(sys.prefix, bin_dir))
    for name in ("python3", "python"):
        found = _on_path(name, env, own_bin)
        if found:
            return found
    return sys.executable


# ------------------------------------------------------------ one process


def execute(request, answer, target, timeout, env):
    """Runs the runtime once. A generator: yields whatever ``answer`` yields, returns the result message."""
    scratch = sandbox.make_scratch()
    command = target.sandbox.wrap([target.python, "-u", main_script()], target.root, scratch)
    child_env = {k: v for k, v in env.items() if k not in SECRET_ENV}
    child_env.update(sandbox.scratch_env(scratch))
    child_env.update({"PYTHONIOENCODING": "utf-8", "PYTHONDONTWRITEBYTECODE": "1"})
    try:
        proc = subprocess.Popen(
            command, cwd=target.root, env=child_env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )
    except OSError as exc:
        shutil.rmtree(scratch, ignore_errors=True)
        raise ToolError("Could not start Python (%s): %s" % (target.python, exc))

    lines = queue.Queue()
    stderr = []

    def read_stdout():
        for raw in proc.stdout:
            lines.put(raw)
        lines.put(None)

    def read_stderr():
        for raw in proc.stderr:
            if sum(len(chunk) for chunk in stderr) < 20000:
                stderr.append(raw.decode("utf-8", "replace"))

    threading.Thread(target=read_stdout, daemon=True).start()
    threading.Thread(target=read_stderr, daemon=True).start()

    def send(message):
        try:
            proc.stdin.write((json.dumps(message) + "\n").encode("utf-8"))
            proc.stdin.flush()
        except OSError:
            pass

    stray = []
    try:
        send(request)
        deadline = time.monotonic() + timeout
        while True:
            try:
                raw = lines.get(timeout=max(0.05, deadline - time.monotonic()))
            except queue.Empty:
                raise ToolError("The run was stopped after %d s without finishing." % round(timeout))
            if raw is None:
                proc.wait(timeout=5)
                detail = "\n".join(part for part in ("".join(stderr).strip(), "".join(stray).strip()) if part)
                raise ToolError("Python exited with code %s before reporting a result.\n%s" % (proc.returncode, detail[-3000:]))
            line = raw.decode("utf-8", "replace").rstrip("\r\n")
            if not line.startswith(PREFIX):
                stray.append(line + "\n")
                continue
            try:
                message = json.loads(line[len(PREFIX) :])
            except ValueError:
                stray.append(line + "\n")
                continue
            kind = message.get("type")
            if kind == "result":
                return message
            if kind in ("need_args", "need_value"):
                reply = yield from answer(message)
                deadline = time.monotonic() + timeout
                send(reply)
    finally:
        if proc.poll() is None:
            proc.kill()
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            try:
                stream.close()
            except OSError:
                pass
        shutil.rmtree(scratch, ignore_errors=True)


def absorb(data, result):
    """Folds what a run learned back into the data. Returns True when a retry can get further."""
    if result.get("fatal"):
        return False
    for record in result.get("resolutions") or []:
        if record.get("source") == "llm" and record.get("expr"):
            data["fakes"][record["key"]] = record["expr"]
    arguments = result.get("args") or []
    if any(a.get("source") == "llm" and a.get("expr") for a in arguments):
        data["imports"] = list(result.get("imports") or [])
        data["args"] = {a["name"]: a["expr"] for a in arguments if a.get("source") in ("llm", "cache") and a.get("expr")}
    retry = False
    hint = result.get("retry") or {}
    if hint.get("patch") and hint["patch"] not in data["patches"]:
        data["patches"].append(hint["patch"])
        retry = True
    if hint.get("eager"):
        key = json.dumps([hint["eager"].get("line"), hint["eager"].get("paths")])
        if not any(json.dumps([e.get("line"), e.get("paths")]) == key for e in data["eager"]):
            data["eager"].append(hint["eager"])
            retry = True
    return retry


# ---------------------------------------------------------------- engine


class Engine(object):
    def __init__(self, env=None, cwd=None):
        self.env = dict(os.environ if env is None else env)
        self.cwd = cwd or os.getcwd()
        self.model = model_module.from_environment(self.env)
        mode = (self.env.get("SPOTRUN_SANDBOX") or "required").strip().lower()
        self.sandbox_mode = mode if mode in ("required", "auto", "off") else "required"
        self.timeout = self._number("SPOTRUN_TIMEOUT", 30.0)
        self.max_cases = int(self._number("SPOTRUN_MAX_CASES", 10))
        self.max_calls = int(self._number("SPOTRUN_MAX_MODEL_CALLS", 30))
        self.max_questions = int(self._number("SPOTRUN_MAX_QUESTIONS", 12))
        self.extra_paths = [p for p in (self.env.get("SPOTRUN_EXTRA_PATHS") or "").split(os.pathsep) if p]
        self.store = {}

    def _number(self, name, default):
        try:
            return float(self.env.get(name) or default)
        except ValueError:
            return default

    def describe_setup(self):
        if self.model is not None:
            who = "A small model is configured (%s) and invents inputs and fake values." % self.model.label
        else:
            who = "No small model is configured: you supply arguments, and you are asked for fake values through answer_value."
        return "%s Sandbox mode: %s." % (who, self.sandbox_mode)

    # ------------------------------------------------------------ targets

    def prepare(self, file, function, root=None):
        if not isinstance(file, str) or not file.strip():
            raise ToolError("`file` is required: the path of the Python file.")
        if not isinstance(function, str) or not function.strip():
            raise ToolError("`function` is required: the function name, or Class.method.")
        file = os.path.abspath(os.path.join(self.cwd, os.path.expanduser(file.strip())))
        if not os.path.isfile(file):
            raise ToolError("File not found: %s" % file)
        try:
            with open(file, "r", encoding="utf-8") as handle:
                text = handle.read()
        except (OSError, UnicodeDecodeError) as exc:
            raise ToolError("Could not read %s: %s" % (file, exc))
        qualname = function.strip()
        try:
            found = source.find_function(text, qualname)
        except SyntaxError as exc:
            raise ToolError("%s has a syntax error on line %s: %s" % (file, exc.lineno, exc.msg))
        if found is None:
            names = source.function_names(text)
            listing = ", ".join(names[:40]) if names else "(none)"
            raise ToolError("No function %r in %s. Functions in this file: %s" % (qualname, file, listing))
        root = os.path.abspath(os.path.join(self.cwd, os.path.expanduser(root))) if root else find_root(file, self.cwd)
        # The interpreter is the server owner's choice (SPOTRUN_PYTHON), never the caller's.
        interpreter = find_python(root, self.env)
        box = sandbox.detect(interpreter, self.sandbox_mode)
        if box.kind == "none" and self.sandbox_mode == "required":
            raise ToolError(
                "Refusing to run without an OS sandbox: %s.\n"
                "Spot Run executes the project's code, so by default it only runs inside a sandbox with no network and "
                "read-only files. On Linux install bubblewrap (the bwrap command). To run with the in-process guard "
                "alone, the person who configured this server can set SPOTRUN_SANDBOX=auto in its environment. "
                "Do not try to work around this from the agent side." % box.reason
            )
        return Target(file, qualname, root, interpreter, text, found, box)

    def _entry(self, target, fresh=False):
        key = (target.file, target.qualname)
        entry = self.store.get(key)
        if entry is None or fresh or entry["signature"] != target.function.signature:
            entry = {"signature": target.function.signature, "patches": [], "eager": [], "variants": {}}
            self.store[key] = entry
        return entry

    @staticmethod
    def _remember(entry, key, data):
        variants = entry["variants"]
        variants.pop(key, None)
        variants[key] = {"args": data["args"], "imports": data["imports"], "fakes": data["fakes"]}
        while len(variants) > 30:
            variants.pop(next(iter(variants)))

    def _mode(self, values):
        if values == "guess":
            return "guess"
        return "model" if self.model is not None else "agent"

    # ------------------------------------------------------------ answers

    def _answerer(self, target, data, mode, notes, case=None):
        known = []
        view = {"args": list((data.get("args") or {}).items())}
        asked = {"count": 0}
        sources = {}

        def source_at(file, line):
            if not file or not line:
                return target.function.source
            try:
                if os.path.abspath(file) == target.file:
                    text = target.text
                else:
                    if file not in sources:
                        with open(file, "r", encoding="utf-8") as handle:
                            sources[file] = handle.read()
                    text = sources[file]
                return source.enclosing_source(text, line) or target.function.source
            except (OSError, UnicodeDecodeError):
                return target.function.source

        def answer(message):
            if message["type"] == "need_args":
                parsed = None
                if mode == "model":
                    prompt = prompts.build_args_prompt(
                        target.relative,
                        target.qualname,
                        source.build_context(target.text, target.function),
                        message,
                        data.get("instructions"),
                    )
                    try:
                        reply = self.model.ask(prompt)
                        parsed = prompts.parse_args_reply(reply)
                        if parsed is None:
                            notes.append("The model's reply for the arguments was not usable; they were guessed from names and type hints.")
                    except model_module.ModelError as exc:
                        notes.append("Arguments were guessed because the model call failed: %s" % exc)
                if parsed:
                    view["args"] = list(parsed.items())
                return {"type": "args", "args": parsed, "imports": []}

            expr = None
            if mode == "model":
                prompt = prompts.build_value_prompt(
                    target.qualname, source_at(message.get("file"), message.get("line")), message, known, view["args"], data.get("instructions")
                )
                try:
                    expr = prompts.parse_value_reply(self.model.ask(prompt))
                except model_module.ModelError as exc:
                    note = "Some fake values were guessed because the model call failed: %s" % exc
                    if note not in notes:
                        notes.append(note)
            elif mode == "agent":
                if asked["count"] < self.max_questions:
                    asked["count"] += 1
                    given = yield Question(message, list(known), target, case)
                    expr = prompts.as_expression(given if given is not None else prompts._MISSING)
                elif asked["count"] == self.max_questions:
                    asked["count"] += 1
                    notes.append("After %d questions the remaining fake values were guessed." % self.max_questions)
            if expr:
                known.append((message.get("path"), expr))
            return {"type": "value", "expr": expr}

        return answer

    def _run(self, target, data, mode, notes, case=None, max_attempts=4):
        """Runs with retries. A generator returning (result, attempts)."""
        answer = self._answerer(target, data, mode, notes, case)
        result = None
        attempts = 0
        while attempts < max_attempts:
            attempts += 1
            request = {
                "type": "start",
                "file": target.file,
                "qualname": target.qualname,
                "root": target.root,
                "llm": mode != "guess",
                "args": data["args"],
                "pins": {"args": {}, "fakes": {}},
                "cache": data["fakes"],
                "extra_patches": data["patches"],
                "eager": data["eager"],
                "imports": data["imports"],
                "scope": "workspace",
                "limits": {"max_llm_calls": self.max_calls},
                "extra_paths": self.extra_paths,
            }
            result = yield from execute(request, answer, target, self.timeout, self.env)
            if not absorb(data, result):
                break
        return result, attempts

    def _how(self, target, mode):
        if mode == "model":
            who = "values from %s" % self.model.label
        elif mode == "agent":
            who = "values from you"
        else:
            who = "values guessed without a model"
        return "%s; %s; interpreter %s" % (target.sandbox.label, who, target.python)

    # -------------------------------------------------------------- flows

    def run_flow(self, target, args=None, imports=None, describe=None, values=None, fresh=False):
        """A generator that yields Questions (agent mode only) and returns the report text."""
        mode = self._mode(values)
        entry = self._entry(target, fresh)
        describe = describe.strip() if isinstance(describe, str) and describe.strip() else None
        notes = []
        if describe and mode != "model":
            notes.append("`describe` was ignored: it is only used when a small model is configured. Pass `args` instead.")
            describe = None
        key = json.dumps([describe, args], sort_keys=True)
        variant = entry["variants"].get(key) or {}
        data = {
            "args": dict(args) if args is not None else variant.get("args"),
            "imports": list(imports or variant.get("imports") or []),
            "fakes": dict(variant.get("fakes") or {}),
            "patches": entry["patches"],
            "eager": entry["eager"],
            "instructions": [describe] if describe else [],
        }
        if args is None and mode == "agent" and target.function.node.args.args:
            notes.append("No `args` were given, so the arguments were guessed from names and type hints. Pass `args` for meaningful inputs.")
        result, attempts = yield from self._run(target, data, mode, notes)
        if not result.get("fatal"):
            self._remember(entry, key, data)
        return report.full(target, result, attempts, notes, self._how(target, mode), "you" if mode == "agent" else "model")

    def cases_flow(self, target, cases=None, maximum=None, values=None, fresh=False):
        mode = self._mode(values)
        entry = self._entry(target, fresh)
        limit = max(1, min(25, int(maximum or self.max_cases)))
        notes = []
        if cases is not None:
            chosen = prompts.clean_cases(cases, limit)
            if not chosen:
                raise ToolError("`cases` held no usable case. Each needs a title and args: {\"title\": ..., \"args\": {name: expression}}.")
        elif self.model is None:
            raise ToolError(
                "No small model is configured, so the cases have to come from you. Call find_edge_cases again with `cases`: "
                'a list of {"title": "<2 to 5 words>", "args": {"<parameter>": "<python expression>"}}. Start with the '
                "typical case, then one case per branch, early return, boundary value, empty input and failure this function "
                "can tell apart."
            )
        else:
            prompt = prompts.build_cases_prompt(
                target.relative, target.qualname, source.build_context(target.text, target.function), target.function.source, limit
            )
            try:
                reply = self.model.ask(prompt)
            except model_module.ModelError as exc:
                raise ToolError("The model call for the edge cases failed: %s" % exc)
            chosen = prompts.parse_cases_reply(reply, limit)
            if not chosen:
                raise ToolError("The model did not return usable edge cases. Its reply began: %s" % (reply or "(empty)")[:300])
        runs = []
        for case in chosen:
            key = "case:" + json.dumps([case["title"], case["args"], case["scenario"]], sort_keys=True)
            variant = entry["variants"].get(key) or {}
            data = {
                "args": dict(case["args"]),
                "imports": [],
                "fakes": dict(variant.get("fakes") or {}),
                "patches": entry["patches"],
                "eager": entry["eager"],
                "instructions": [case["scenario"]] if case["scenario"] else [],
            }
            try:
                result, _attempts = yield from self._run(target, data, mode, notes, case)
            except ToolError as exc:
                result = {"type": "result", "fatal": str(exc)}
            if not result.get("fatal"):
                self._remember(entry, key, data)
            runs.append((case, result))
        return report.cases(target, runs, notes, self._how(target, mode), proposed_by_model=cases is None)
