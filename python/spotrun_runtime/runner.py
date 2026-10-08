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
from .values import FAKE, build_namespace, describe, evaluate, expression_for, guess

_IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


class Fatal(Exception):
    """A problem that prevents the run from starting, shown to the user."""


# --------------------------------------------------------------------------
# Locating the target
# --------------------------------------------------------------------------


def import_target(file, root):
    file = os.path.abspath(file)
    directory = os.path.dirname(file)
    stem = os.path.splitext(os.path.basename(file))[0]
    parts = [stem]
    top = directory
    while os.path.isfile(os.path.join(top, "__init__.py")) and os.path.dirname(top) != top:
        parts.insert(0, os.path.basename(top))
        top = os.path.dirname(top)
    if stem == "__init__" and len(parts) > 1:
        parts.pop()
    search = [top]
    if root:
        search.append(os.path.abspath(root))
        source_dir = os.path.join(os.path.abspath(root), "src")
        if os.path.isdir(source_dir):
            search.append(source_dir)
    for entry in reversed(search):
        if entry in sys.path:
            sys.path.remove(entry)
        sys.path.insert(0, entry)

    name = ".".join(parts)
    module = None
    try:
        module = importlib.import_module(name)
    except ImportError as exc:
        if getattr(exc, "name", None) not in (name, parts[0]):
            raise
    if module is not None:
        found = getattr(module, "__file__", None)
        try:
            if found and os.path.samefile(found, file):
                return module
        except OSError:
            pass
        sys.modules.pop(name, None)

    # The dotted name resolved to something else (name clash with an
    # installed package) or could not be imported: load straight from the path.
    unique = stem if stem not in sys.modules else "spotrun_target_%s" % stem
    spec = importlib.util.spec_from_file_location(unique, file)
    if spec is None or spec.loader is None:
        raise Fatal("Cannot load %s as a Python module." % file)
    module = importlib.util.module_from_spec(spec)
    sys.modules[unique] = module
    spec.loader.exec_module(module)
    return module


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

    try:
        module = import_target(file, root)
    except Fatal:
        raise
    except BaseException as exc:
        if isinstance(exc, (KeyboardInterrupt,)):
            raise
        raise Fatal("Importing %s failed.\n\n%s" % (os.path.basename(file), "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)[-12:])))

    function, cls, needs_self, raw = find_target(module, request["qualname"])
    namespace = build_namespace(module)
    resolver.namespace = namespace
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


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
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
