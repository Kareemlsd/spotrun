"""Runs one function and reports a trace.

Started by the extension as a subprocess. Reads a single ``start`` request,
may ask the extension for generated arguments and fake values while it
runs, and finishes with one ``result`` message.
"""

import asyncio
import importlib
import importlib.util
import inspect
import itertools
import json
import linecache
import os
import re
import sys
import traceback
import typing

from . import guard
from .fakes import Hooks, is_fake, make_fake, _st
from .protocol import Capture, Channel, NullChannel
from .tracer import Recorder, make_scope
from .values import FAKE, apply_imports, build_namespace, describe, evaluate, expression_for, guess

_IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


class Fatal(Exception):
    """A problem that prevents the run from starting, shown to the user."""


# --------------------------------------------------------------------------
# Locating the target
# --------------------------------------------------------------------------


def _ancestors(directory, root):
    """Directories from ``directory`` up to and including ``root``."""
    out = []
    current = directory
    while True:
        out.append(current)
        parent = os.path.dirname(current)
        if os.path.normcase(current) == os.path.normcase(root) or parent == current:
            break
        if not os.path.normcase(current).startswith(os.path.normcase(root)):
            break
        current = parent
    return out


def _is_about(exc, names):
    """True when an ImportError says one of ``names`` itself is missing."""
    missing = getattr(exc, "name", None)
    return missing is not None and any(missing == n or n.startswith(missing + ".") for n in names)


_WALK_SKIP = frozenset(["node_modules", "site-packages", "dist-packages", "venv", "env", "build", "dist", "__pycache__", "__pypackages__"])


def _find_in_workspace(root, name, limit=20000):
    """Folders anywhere in the workspace that contain module or package
    ``name``, nearest to the root first."""
    homes = []
    seen = 0
    for current, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if not d.startswith(".") and d not in _WALK_SKIP)
        seen += len(dirs) + len(files)
        if name + ".py" in files or name in dirs:
            homes.append(current)
        if seen > limit or len(homes) >= 5:
            break
    homes.sort(key=lambda p: (p.count(os.sep), p))
    return homes


def import_target(file, root, extra_paths=()):
    """Import the module that defines the function.

    Projects are laid out in many ways, so several module names are tried:
    the regular package the file belongs to, then the file as part of a
    package without __init__.py seen from each folder between it and the
    workspace root. When the module's own imports name a top-level package
    that lives in one of those folders (a source root such as ``backend/``),
    that folder is added to the import path and the import repeated.
    """
    file = os.path.abspath(file)
    root = os.path.abspath(root) if root else os.path.dirname(file)
    directory = os.path.dirname(file)
    stem = os.path.splitext(os.path.basename(file))[0]
    is_init = stem == "__init__"

    parts = [stem]
    top = directory
    while os.path.isfile(os.path.join(top, "__init__.py")) and os.path.dirname(top) != top:
        parts.insert(0, os.path.basename(top))
        top = os.path.dirname(top)
    if is_init and len(parts) > 1:
        parts.pop()

    ancestors = _ancestors(directory, root)
    candidates = [(top, ".".join(parts))]
    for base in ancestors:
        relative = os.path.relpath(file, base)
        pieces = os.path.splitext(relative)[0].split(os.sep)
        if is_init and len(pieces) > 1:
            pieces.pop()
        if all(p.isidentifier() for p in pieces) and (base, ".".join(pieces)) not in candidates:
            candidates.append((base, ".".join(pieces)))

    def put_first(entry):
        if entry in sys.path:
            sys.path.remove(entry)
        sys.path.insert(0, entry)

    source_dir = os.path.join(root, "src")
    configured = [os.path.abspath(os.path.join(root, os.path.expanduser(p))) for p in extra_paths if isinstance(p, str) and p.strip()]
    for entry in list(reversed(configured)) + ([source_dir] if os.path.isdir(source_dir) else []) + [root]:
        put_first(entry)

    def is_target(module):
        found = getattr(module, "__file__", None)
        try:
            return bool(found) and os.path.samefile(found, file)
        except OSError:
            return False

    def forget(name):
        prefix = name.split(".")[0]
        for loaded in [m for m in sys.modules if m == prefix or m.startswith(prefix + ".")]:
            module = sys.modules.get(loaded)
            origin = getattr(module, "__file__", None) or ""
            if not origin or os.path.normcase(os.path.abspath(origin)).startswith(os.path.normcase(root)):
                sys.modules.pop(loaded, None)

    added = set()
    first_error = None
    for base, name in candidates:
        put_first(base)
        for _attempt in range(6):
            try:
                module = importlib.import_module(name)
            except ImportError as exc:
                forget(name)
                if _is_about(exc, [name]) or "relative import" in str(exc):
                    # This spelling of the module name does not fit; try the next.
                    first_error = first_error or exc
                    break
                missing = (getattr(exc, "name", None) or "").split(".")[0]
                home = None
                if missing:
                    for folder in ancestors:
                        if folder not in added and (
                            os.path.isdir(os.path.join(folder, missing)) or os.path.isfile(os.path.join(folder, missing + ".py"))
                        ):
                            home = folder
                            break
                    if home is None:
                        # Not next to the file or above it: look through the
                        # whole workspace for a module of that name.
                        for folder in _find_in_workspace(root, missing):
                            if folder not in added:
                                home = folder
                                break
                if home is None:
                    raise
                # A sibling top-level package: its folder is a source root.
                added.add(home)
                put_first(home)
                put_first(base)
                continue
            if is_target(module):
                return module
            forget(name)
            break

    # No dotted name fits (for example a name clash with an installed
    # package): load straight from the path.
    put_first(directory)
    unique = stem if stem not in sys.modules else "spotrun_target_%s" % stem
    spec = importlib.util.spec_from_file_location(unique, file)
    if spec is None or spec.loader is None:
        raise Fatal("Cannot load %s as a Python module." % file)
    module = importlib.util.module_from_spec(spec)
    sys.modules[unique] = module
    try:
        spec.loader.exec_module(module)
    except ImportError as exc:
        sys.modules.pop(unique, None)
        if "relative import" in str(exc) and first_error is not None:
            raise first_error
        raise
    return module


def _installed_elsewhere_hint(name):
    """True when the name looks like a third-party distribution rather than
    project code (used only to word the hint)."""
    return name.lower() in (
        "numpy", "pandas", "scipy", "matplotlib", "requests", "torch", "tensorflow", "sklearn", "yaml", "pydantic",
        "sqlalchemy", "fastapi", "flask", "django", "httpx", "boto3", "jax", "xarray", "h5py", "netCDF4".lower(), "pytest",
    )


def explain_import_failure(file, exc):
    """First line says what went wrong and what to do; the traceback follows."""
    name = os.path.basename(file)
    summary = "%s: %s" % (type(exc).__name__, exc)
    missing = (getattr(exc, "name", None) or "").split(".")[0]
    if isinstance(exc, ModuleNotFoundError) and missing and not _installed_elsewhere_hint(missing):
        hint = (
            "No module or package named %s exists in this workspace either, and the interpreter Spot Run used (%s) does not have it. "
            "If it is your own code outside the workspace folder, add its folder to the spotrun.extraPaths setting. "
            "If it is an installed package, select your project's interpreter in the Python extension or set spotrun.pythonPath."
            % (missing, sys.executable)
        )
    elif isinstance(exc, ModuleNotFoundError):
        hint = (
            "The interpreter Spot Run used (%s) cannot find that module. If it is a package you installed, "
            "Spot Run is probably using a different interpreter than your project: select the right one in the "
            "Python extension or set spotrun.pythonPath. If it is your own code, its folder is not on the import path."
            % sys.executable
        )
    elif isinstance(exc, ImportError):
        hint = "An import inside the file failed (interpreter: %s). A circular import shows up here when the file is normally imported through another module first." % sys.executable
    elif isinstance(exc, guard.EffectBlocked):
        hint = "The file does this at module level, while it is being imported, so it happens before any function can run."
    else:
        hint = "The file raised this at module level, while it was being imported, before any function could run. Code that runs on import (reading config, connecting, parsing arguments) has to succeed first."
    trace = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)[-12:])
    return "Importing %s failed: %s\n\n%s\n\n%s" % (name, summary, hint, trace)


def find_target(module, qualname):
    """Returns (callable, owner class or None, needs_self, raw function)."""
    owner = None
    obj = module
    static = module
    for part in qualname.split("."):
        owner = obj
        try:
            static = inspect.getattr_static(owner, part)
        except AttributeError:
            raise Fatal("%s has no attribute %r (looking for %s)." % (getattr(owner, "__name__", owner), part, qualname))
        obj = getattr(owner, part) if not isinstance(static, property) else static
    cls = owner if isinstance(owner, type) else None

    if cls is not None:
        if isinstance(static, staticmethod):
            return obj, cls, False, static.__func__
        if isinstance(static, classmethod):
            return obj, cls, False, static.__func__
        if isinstance(static, property):
            return static.fget, cls, True, static.fget
        if inspect.isfunction(static):
            return static, cls, True, static
        func = _unwrap_callable(static)
        return func, cls, inspect.isfunction(func), func

    if inspect.isfunction(obj) or inspect.isbuiltin(obj):
        return obj, None, False, obj
    func = _unwrap_callable(obj)
    return func, None, False, func


def _unwrap_callable(obj):
    """Framework decorators (click, celery, typer, functools) often replace
    the function with an object. Find the plain function inside."""
    seen = set()
    current = obj
    while id(current) not in seen:
        seen.add(id(current))
        if inspect.isfunction(current):
            return current
        for attr in ("callback", "__wrapped__", "func", "fn", "fget", "run", "__func__"):
            inner = getattr(current, attr, None)
            if inner is not None and callable(inner) and inner is not current:
                current = inner
                break
        else:
            break
    if callable(current):
        return current
    raise Fatal("%r is not callable." % (obj,))


# --------------------------------------------------------------------------
# Resolving fake values
# --------------------------------------------------------------------------


class Resolver(object):
    def __init__(self, channel, request, in_scope, step_count):
        self.channel = channel
        self.in_scope = in_scope
        self.step_count = step_count
        self.llm = bool(request.get("llm")) and channel.interactive
        pins = request.get("pins") or {}
        self.pins = pins.get("fakes") or {}
        self.cache = request.get("cache") or {}
        self.max_calls = int((request.get("limits") or {}).get("max_llm_calls", 30))
        self.calls = 0
        self.namespace = {}
        self.records = []
        self._seen = {}
        self.eager_paths = {}
        self.eager_lines = {}
        for entry in request.get("eager") or []:
            why = entry.get("why") or "needed as a concrete value"
            for path in entry.get("paths") or []:
                self.eager_paths[path] = why
            if entry.get("line"):
                self.eager_lines[entry["line"]] = why

    def site(self):
        frame = sys._getframe(1)
        while frame is not None:
            filename = frame.f_code.co_filename
            if self.in_scope(filename):
                text = linecache.getline(filename, frame.f_lineno).strip()
                return filename, frame.f_lineno, text
            frame = frame.f_back
        return None, 0, ""

    def eager(self, path):
        if not self.eager_paths and not self.eager_lines:
            return None
        why = self.eager_paths.get(path)
        if why is not None:
            return why
        if self.eager_lines:
            _file, _line, text = self.site()
            return self.eager_lines.get(text)
        return None

    def _record(self, key, path, op, expr, source, value, site, error=None):
        record = {
            "key": key,
            "path": path,
            "op": op,
            "expr": expr,
            "source": source,
            "value": describe(value, 300) if error is None else None,
            "file": site[0],
            "line": site[1],
            "text": site[2],
            "step": self.step_count(),
        }
        if error:
            record["error"] = error
        index = self._seen.get(key)
        if index is None:
            self._seen[key] = len(self.records)
            self.records.append(record)
        else:
            self.records[index] = record

    def resolve(self, path, op, detail):
        site = self.site()
        text = site[2]
        key = "%s|%s|%s" % (path, op, text)
        pin_key = "%s|%s" % (path, text)
        expr, source = None, None
        if pin_key in self.pins:
            expr, source = self.pins[pin_key], "pin"
        elif path in self.pins:
            expr, source = self.pins[path], "pin"
        elif key in self.cache:
            expr, source = self.cache[key], "cache"
        elif self.llm and self.calls < self.max_calls:
            self.calls += 1
            reply = self.channel.ask(
                {
                    "type": "need_value",
                    "path": path,
                    "op": op,
                    "detail": detail,
                    "file": site[0],
                    "line": site[1],
                    "text": text,
                }
            )
            expr = reply.get("expr")
            source = "llm"
        if not isinstance(expr, str) or not expr.strip():
            return False, None
        try:
            value = evaluate(expr, self.namespace)
        except guard.EffectBlocked:
            raise
        except Exception as exc:
            self._record(key, path, op, expr, source, None, site, "%s: %s" % (type(exc).__name__, exc))
            return False, None
        if is_fake(value):
            # The model chose to keep this opaque. Remember the choice so the
            # question is not asked again, and let the default take over.
            self._record(key, path, op, "FAKE", source, value, site)
            return False, None
        self._record(key, path, op, expr, source, value, site)
        return True, value

    def report(self, path, op, value):
        site = self.site()
        key = "%s|%s|%s" % (path, op, site[2])
        if key in self._seen:
            return
        self._record(key, path, op, expression_for(value), "heuristic", value, site)


# --------------------------------------------------------------------------
# Arguments
# --------------------------------------------------------------------------


def _annotation_text(annotation):
    if annotation is inspect.Parameter.empty:
        return None
    if isinstance(annotation, str):
        return annotation
    if isinstance(annotation, type):
        return annotation.__name__
    return str(annotation).replace("typing.", "")


def lazy_instance(cls):
    """Instance of ``cls`` created without running __init__. Attributes that
    were never set come back as lazy fakes."""

    def __getattr__(self, name):
        if name.startswith("__") and name.endswith("__"):
            raise AttributeError(name)
        value = make_fake("self." + name)
        try:
            object.__setattr__(self, name, value)
        except Exception:
            pass
        return value

    namespace = {"__getattr__": __getattr__, "__module__": cls.__module__, "__qualname__": cls.__qualname__}
    try:
        sub = type(cls)(cls.__name__, (cls,), namespace)
        try:
            sub.__abstractmethods__ = frozenset()
        except Exception:
            pass
        return object.__new__(sub)
    except Exception:
        return make_fake("self", cls)


def build_self(cls, module):
    """Construct the instance a method runs on. Tries the real constructor
    with generated arguments, then falls back to a lazy instance."""
    try:
        signature = inspect.signature(cls.__init__)
        try:
            hints = typing.get_type_hints(cls.__init__)
        except Exception:
            hints = {}
        args, kwargs = [], {}
        for index, parameter in enumerate(signature.parameters.values()):
            if index == 0 or parameter.kind in (parameter.VAR_POSITIONAL, parameter.VAR_KEYWORD):
                continue
            if parameter.default is not parameter.empty:
                continue
            value = guess(parameter.name, hints.get(parameter.name, parameter.annotation), module)
            if parameter.kind is parameter.POSITIONAL_ONLY:
                args.append(value)
            else:
                kwargs[parameter.name] = value
        return cls(*args, **kwargs), "constructed"
    except BaseException as exc:
        if isinstance(exc, (KeyboardInterrupt, SystemExit)):
            raise
        return lazy_instance(cls), "lazy"


def build_arguments(function, cls, needs_self, module, namespace, request, channel):
    try:
        signature = inspect.signature(function)
    except (TypeError, ValueError):
        return [], {}, []
    try:
        hints = typing.get_type_hints(function)
    except Exception:
        hints = {}
    parameters = list(signature.parameters.values())
    pins = (request.get("pins") or {}).get("args") or {}
    provided = request.get("args")
    provided_source = "cache"

    if provided is None and request.get("llm") and channel.interactive and parameters:
        described = []
        for index, parameter in enumerate(parameters):
            described.append(
                {
                    "name": parameter.name,
                    "kind": parameter.kind.name,
                    "annotation": _annotation_text(parameter.annotation),
                    "has_default": parameter.default is not parameter.empty,
                    "default": None if parameter.default is parameter.empty else describe(parameter.default, 80),
                    "is_self": bool(needs_self and index == 0),
                }
            )
        reply = channel.ask(
            {
                "type": "need_args",
                "params": described,
                "class_name": cls.__name__ if cls is not None else None,
                "names": sorted(n for n in vars(module) if not n.startswith("_"))[:200],
            }
        )
        provided = reply.get("args")
        provided_source = "llm"
        if isinstance(reply.get("imports"), list):
            request["imports"] = reply["imports"]
            request["_import_errors"] = apply_imports(namespace, reply["imports"])
    if not isinstance(provided, dict):
        provided = {}

    args, kwargs, info = [], {}, []
    for index, parameter in enumerate(parameters):
        name = parameter.name
        is_self = bool(needs_self and index == 0)
        variadic = parameter.kind in (parameter.VAR_POSITIONAL, parameter.VAR_KEYWORD)
        entry = {"name": name, "expr": None, "source": None}
        expr, source = None, None
        if name in pins:
            expr, source = pins[name], "pin"
        elif isinstance(provided.get(name), str) and provided[name].strip():
            expr, source = provided[name], provided_source

        value, have = None, False
        if expr is not None:
            try:
                value = evaluate(expr, namespace)
                if value is FAKE:
                    value = make_fake(name, _spec_for(hints.get(name)))
                have = True
                entry["expr"], entry["source"] = expr, source
            except guard.EffectBlocked as exc:
                entry["error"] = str(exc)
            except Exception as exc:
                entry["error"] = "%s: %s" % (type(exc).__name__, exc)
                entry["rejected"] = expr

        if not have:
            if variadic:
                continue
            if is_self:
                value, how = build_self(cls, module)
                entry["source"] = "heuristic"
                entry["expr"] = None
                entry["note"] = (
                    "built with generated constructor arguments" if how == "constructed" else "created without running __init__; missing attributes are fakes"
                )
            elif parameter.default is not parameter.empty:
                entry["source"] = "default"
                entry["expr"] = describe(parameter.default, 200)
                entry["value"] = entry["expr"]
                info.append(entry)
                continue
            else:
                value = guess(name, hints.get(name, parameter.annotation), module)
                entry["source"] = "heuristic"
                entry["expr"] = expression_for(value)

        entry["value"] = describe(value, 300)
        info.append(entry)
        if parameter.kind is parameter.VAR_POSITIONAL:
            args.extend(value if isinstance(value, (list, tuple)) else [value])
        elif parameter.kind is parameter.VAR_KEYWORD:
            if isinstance(value, dict):
                kwargs.update(value)
        elif parameter.kind is parameter.KEYWORD_ONLY:
            kwargs[name] = value
        else:
            args.append(value)
    return args, kwargs, info


def _spec_for(hint):
    return hint if isinstance(hint, type) else None


# --------------------------------------------------------------------------
# Running
# --------------------------------------------------------------------------


async def _collect_async(generator, limit):
    items = []
    async for item in generator:
        items.append(item)
        if len(items) >= limit:
            break
    return items


def _run_async(awaitable):
    with guard.bypass:
        loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(awaitable)
    finally:
        with guard.bypass:
            try:
                loop.close()
            except Exception:
                pass


def invoke(function, args, kwargs, limit):
    result = function(*args, **kwargs)
    if inspect.iscoroutine(result):
        result = _run_async(result)
    elif inspect.isasyncgen(result):
        result = _run_async(_collect_async(result, limit))
    elif inspect.isgenerator(result):
        result = list(itertools.islice(result, limit))
    return result


def _exception_info(exc, in_scope):
    frames = []
    tb = exc.__traceback__
    innermost = None
    while tb is not None:
        filename = tb.tb_frame.f_code.co_filename
        if in_scope(filename):
            text = linecache.getline(filename, tb.tb_lineno).strip()
            frames.append({"file": os.path.abspath(filename), "line": tb.tb_lineno, "name": tb.tb_frame.f_code.co_name, "text": text})
            innermost = tb
        tb = tb.tb_next
    message = ""
    try:
        message = str(exc)
    except Exception:
        pass
    info = {
        "type": type(exc).__name__,
        "message": message[:2000],
        "frames": frames,
        "blocked": isinstance(exc, guard.EffectBlocked),
    }
    return info, innermost


def _eager_hint(exc, innermost, resolver):
    """After a TypeError, find the unresolved fakes the failing line used so
    the next run can ask for their concrete values up front."""
    if innermost is None or not isinstance(exc, (TypeError, ValueError)):
        return None
    frame = innermost.tb_frame
    text = linecache.getline(frame.f_code.co_filename, innermost.tb_lineno).strip()
    if not text:
        return None
    paths = []
    for name in set(_IDENT.findall(text)):
        value = frame.f_locals.get(name, frame.f_globals.get(name))
        if is_fake(value) and not _st(value).resolved:
            paths.append(_st(value).path)
    message = str(exc)
    if not paths and "Fake" not in message and "fake" not in message:
        return None
    return {
        "line": text,
        "paths": sorted(paths),
        "why": "a concrete value is required here; a previous attempt failed on the line `%s` with %s: %s"
        % (text, type(exc).__name__, message[:300]),
    }


def run(request, channel):
    file = os.path.abspath(request["file"])
    root = os.path.abspath(request.get("root") or os.path.dirname(file))
    limits = request.get("limits") or {}
    tracing = request.get("trace", True)
    scope_mode = request.get("scope") or "workspace"

    os.chdir(root)
    in_scope = make_scope(root, file, "workspace" if scope_mode == "function" else scope_mode)
    recorder = Recorder(in_scope, limits)
    outputs = []
    if channel.interactive:
        sys.stdout = Capture("out", outputs, recorder.step_count)
        sys.stderr = Capture("err", outputs, recorder.step_count)

    resolver = Resolver(channel, request, in_scope, recorder.step_count)
    guard.install(in_scope, recorder.step_count, request.get("extra_patches") or ())
    Hooks.resolver = resolver.resolve
    Hooks.eager = resolver.eager
    Hooks.report = resolver.report

    # While the module is imported, a required environment variable that is
    # not set gets an invented value, as it would inside the function.
    guard.STATE.importing = True
    try:
        module = import_target(file, root, request.get("extra_paths") or ())
    except Fatal:
        raise
    except BaseException as exc:
        if isinstance(exc, (KeyboardInterrupt,)):
            raise
        raise Fatal(explain_import_failure(file, exc))
    finally:
        guard.STATE.importing = False

    function, cls, needs_self, raw = find_target(module, request["qualname"])
    namespace = build_namespace(module)
    resolver.namespace = namespace
    guard.arm()
    try:
        request["_import_errors"] = apply_imports(namespace, request.get("imports"))
    finally:
        guard.disarm()
    if scope_mode == "function" and getattr(raw, "__code__", None) is not None:
        recorder.only_code = raw.__code__

    guard.arm()
    try:
        args, kwargs, arg_info = build_arguments(function, cls, needs_self, module, namespace, request, channel)
    finally:
        guard.disarm()

    result = {
        "type": "result",
        "qualname": request["qualname"],
        "file": os.path.abspath(file),
        "args": arg_info,
        "is_async": inspect.iscoroutinefunction(raw) or inspect.isasyncgenfunction(raw),
        "imports": [i for i in (request.get("imports") or []) if isinstance(i, str)],
        "import_errors": request.get("_import_errors") or [],
        "module": getattr(module, "__name__", None),
    }

    if not tracing:
        guard.arm()
        value = invoke(function, args, kwargs, int(limits.get("max_items", 100)))
        guard.disarm()
        print("Spot Run: %s returned %s" % (request["qualname"], describe(value, 2000)))
        return result

    exc_info, retry = None, None
    guard.arm()
    recorder.start()
    try:
        value = invoke(function, args, kwargs, int(limits.get("max_items", 100)))
        recorder.stop()
        if is_fake(value) and not _st(value).resolved:
            # A fake that was only passed through still deserves a value.
            value = value._spotrun_need("any", "returned from the function as its result")
        result["return"] = describe(value, int(limits.get("max_return", 2000)))
    except BaseException as exc:  # noqa: BLE001 - the function under test may raise anything
        recorder.stop()
        guard.disarm()
        exc_info, innermost = _exception_info(exc, in_scope)
        retry = _eager_hint(exc, innermost, resolver)
        if retry is not None:
            retry = {"eager": retry}
    finally:
        recorder.stop()
        guard.disarm()

    blocked = guard.STATE.blocked
    for item in blocked:
        if item.get("target"):
            retry = {"patch": item["target"]}
            break

    result.update(recorder.export())
    result["exception"] = exc_info
    result["outputs"] = outputs
    result["resolutions"] = resolver.records
    result["effects"] = guard.STATE.effects
    result["blocked"] = blocked
    result["retry"] = retry
    result["llm_calls"] = resolver.calls
    result["written_files"] = sorted(guard.STATE.files)
    return result


def run_tests(argv):
    """Run pytest on tests Spot Run wrote, with real side effects refused.

    usage: --pytest <test file> --root <folder> [--path <folder>]... [-k <expression>]
    """

    def value(flag):
        return argv[argv.index(flag) + 1] if flag in argv else None

    test_file = os.path.abspath(value("--pytest"))
    root = os.path.abspath(value("--root") or os.path.dirname(test_file))
    extra = [argv[i + 1] for i, a in enumerate(argv[:-1]) if a == "--path"]
    os.chdir(root)
    entries = [root]
    if os.path.isdir(os.path.join(root, "src")):
        entries.append(os.path.join(root, "src"))
    entries.extend(os.path.abspath(os.path.join(root, os.path.expanduser(p))) for p in extra)
    for entry in reversed(entries):
        if entry not in sys.path:
            sys.path.insert(0, entry)
    try:
        import pytest
    except ImportError:
        print("SPOTRUN_PYTEST_MISSING")
        return 0
    guard.install_strict()
    arguments = [test_file, "-q", "--no-header", "-p", "no:cacheprovider", "--tb=short", "-rfE"]
    if value("-k"):
        arguments.extend(["-k", value("-k")])
    guard.arm()
    try:
        code = pytest.main(arguments)
    finally:
        guard.disarm()
    print("SPOTRUN_PYTEST_EXIT %d" % int(code))
    return 0


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if "--pytest" in argv:
        return run_tests(argv)
    if "--request" in argv:
        path = argv[argv.index("--request") + 1]
        with open(path, "r", encoding="utf-8") as handle:
            request = json.load(handle)
        request["llm"] = False
        request["trace"] = False
        run(request, NullChannel())
        return 0

    channel = Channel()
    try:
        request = channel.recv()
        result = run(request, channel)
    except Fatal as exc:
        result = {"type": "result", "fatal": str(exc)}
    except BaseException as exc:  # noqa: BLE001
        result = {
            "type": "result",
            "fatal": "Spot Run runtime error.\n\n%s" % "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
        }
    channel.send(result)
    return 0
