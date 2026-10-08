"""Value helpers: display text for the trace, evaluation of generated
expressions, and type-directed defaults when no model is available."""

import dataclasses
import datetime as _datetime
import decimal
import enum
import inspect
import pathlib
import re
import reprlib
import typing
import uuid

from .fakes import Fake, FakeSentinel, is_fake, make_fake, _st

_MISSING = object()

# --------------------------------------------------------------------------
# Display
# --------------------------------------------------------------------------


class _Describer(reprlib.Repr):
    def __init__(self, limit):
        reprlib.Repr.__init__(self)
        self.maxlevel = 3
        self.maxlist = 8
        self.maxtuple = 8
        self.maxset = 8
        self.maxfrozenset = 8
        self.maxdict = 8
        self.maxdeque = 8
        self.maxarray = 8
        self.maxstring = limit
        self.maxlong = 80
        self.maxother = limit
        self.limit = limit

    def repr_Fake(self, value, level):
        return repr(value)

    repr_FakeSentinel = repr_Fake

    def repr_ndarray(self, value, level):
        try:
            import numpy as np

            body = np.array2string(value, threshold=6, edgeitems=2, precision=4, max_line_width=10000)
            body = " ".join(body.split())
            return "ndarray%s %s %s" % (tuple(value.shape), value.dtype, body)
        except Exception:
            return self.repr_instance(value, level)

    def repr_DataFrame(self, value, level):
        try:
            columns = [str(c) for c in list(value.columns)[:8]]
            more = ", ..." if len(value.columns) > 8 else ""
            head = value.head(2).to_dict("records")
            return "DataFrame %dx%d [%s%s] head=%s" % (
                value.shape[0],
                value.shape[1],
                ", ".join(columns),
                more,
                self.repr1(head, level - 1),
            )
        except Exception:
            return self.repr_instance(value, level)

    def repr_Series(self, value, level):
        try:
            return "Series(%d) %s %s" % (len(value), value.dtype, self.repr1(value.head(5).tolist(), level - 1))
        except Exception:
            return self.repr_instance(value, level)

    def repr_instance(self, value, level):
        try:
            cls = type(value)
            if cls.__repr__ is object.__repr__:
                if cls.__str__ is not object.__str__:
                    # No repr of its own but a meaningful str, e.g. a
                    # SQLAlchemy statement that renders as SQL.
                    text = "<%s: %s>" % (cls.__name__, " ".join(str(value).split()))
                else:
                    text = self._plain_object(value, level)
            else:
                text = repr(value)
        except Exception as exc:
            return "<%s (repr failed: %s)>" % (type(value).__name__, type(exc).__name__)
        if len(text) > self.limit:
            keep = max(self.limit - 3, 8)
            text = text[: keep * 2 // 3] + "..." + text[len(text) - keep // 3 :]
        return text

    def _plain_object(self, value, level):
        name = type(value).__name__
        try:
            fields = vars(value)
        except TypeError:
            fields = {s: getattr(value, s) for s in getattr(type(value), "__slots__", ()) if hasattr(value, s)}
        public = {k: v for k, v in fields.items() if not str(k).startswith("_")}
        fields = public or fields
        if not fields or level <= 0:
            return "<%s>" % name
        parts = []
        for index, (key, item) in enumerate(fields.items()):
            if index >= 6:
                parts.append("...")
                break
            parts.append("%s=%s" % (key, self.repr1(item, level - 1)))
        return "%s(%s)" % (name, ", ".join(parts))


_describers = {}


def describe(value, limit=200):
    """Short, safe text for a value. Never raises, never resolves a fake."""
    describer = _describers.get(limit)
    if describer is None:
        describer = _describers[limit] = _Describer(limit)
    try:
        return describer.repr(value)
    except Exception as exc:
        return "<%s (repr failed: %s)>" % (type(value).__name__, type(exc).__name__)


# --------------------------------------------------------------------------
# Evaluating generated expressions
# --------------------------------------------------------------------------


class _DatetimeName(object):
    """Lets generated code write either datetime(2024, 1, 1) or
    datetime.datetime(2024, 1, 1) when the module did not import it."""

    def __call__(self, *args, **kwargs):
        return _datetime.datetime(*args, **kwargs)

    def __getattr__(self, name):
        if hasattr(_datetime, name):
            return getattr(_datetime, name)
        return getattr(_datetime.datetime, name)


FAKE = FakeSentinel("fake")


def _helpers():
    import json
    import math

    return {
        "FAKE": FAKE,
        "datetime": _DatetimeName(),
        "date": _datetime.date,
        "time": _datetime.time,
        "timedelta": _datetime.timedelta,
        "timezone": _datetime.timezone,
        "Decimal": decimal.Decimal,
        "Path": pathlib.Path,
        "UUID": uuid.UUID,
        "uuid": uuid,
        "math": math,
        "json": json,
        "re": re,
    }


_OPTIONAL_IMPORTS = [
    (re.compile(r"\b(np|numpy)\."), ("np", "numpy"), "numpy"),
    (re.compile(r"\b(pd|pandas)\."), ("pd", "pandas"), "pandas"),
]


def build_namespace(module):
    namespace = _helpers()
    if module is not None:
        namespace.update(vars(module))
        namespace["FAKE"] = FAKE
    return namespace


def evaluate(expr, namespace):
    """Evaluate a generated Python expression in the module's namespace."""
    for pattern, names, modname in _OPTIONAL_IMPORTS:
        if pattern.search(expr) and not any(n in namespace for n in names):
            try:
                mod = __import__(modname)
            except Exception:
                continue
            for n in names:
                namespace.setdefault(n, mod)
    return eval(compile(expr.strip(), "<spotrun expression>", "eval"), namespace)


def apply_imports(namespace, statements):
    """Run import statements proposed with generated arguments, so that
    expressions can use types defined in other modules of the workspace.
    Anything that is not a plain import is refused. Returns error strings."""
    import ast

    errors = []
    for statement in statements or []:
        if not isinstance(statement, str) or not statement.strip():
            continue
        try:
            tree = ast.parse(statement.strip())
            if not tree.body or not all(isinstance(node, (ast.Import, ast.ImportFrom)) for node in tree.body):
                raise ValueError("only import statements are allowed")
            exec(compile(tree, "<spotrun import>", "exec"), namespace)
        except BaseException as exc:
            if isinstance(exc, (KeyboardInterrupt, SystemExit)):
                raise
            errors.append("%s: %s: %s" % (statement.strip(), type(exc).__name__, exc))
    return errors


def round_trips(value):
    """True when repr(value) is a usable expression for the same value."""
    if value is None or isinstance(value, (bool, int, float, str, bytes)):
        return True
    if isinstance(value, (list, tuple, set, frozenset)):
        return all(round_trips(v) for v in value)
    if isinstance(value, dict):
        return all(round_trips(k) and round_trips(v) for k, v in value.items())
    return False


# --------------------------------------------------------------------------
# Defaults by name and type hint
# --------------------------------------------------------------------------

_NAME_RULES = [
    (re.compile(r"(^|_)(email|e_mail)($|_)"), "user@example.com"),
    (re.compile(r"(^|_)(url|uri|endpoint|link)($|_)"), "https://example.com/api"),
    (re.compile(r"(^|_)(path|file|filename|filepath|dir|directory|folder)($|_)"), "example.txt"),
    (re.compile(r"(^|_)(name|title|label|text|msg|message|key|word|query|description|prefix|suffix|token)($|_)"), None),
    (re.compile(r"^(is|has|should|can|use|enable|with|allow)_|^(flag|verbose|debug|strict|enabled|dry_run)$"), True),
    (re.compile(r"(^|_)(count|size|num|number|length|limit|offset|page|index|idx|id|n|k|depth|steps|retries|year|age|qty|quantity)($|_)"), 3),
    (re.compile(r"(^|_)(price|amount|total|rate|ratio|factor|weight|score|scale|tol|tolerance|alpha|beta|gamma|dt|eps|epsilon|threshold|lr)($|_)"), 1.5),
    (re.compile(r"(^|_)(items|values|numbers|nums|xs|ys|arr|array|lst|list|data|seq|sequence|elements|samples)($|_)"), [1, 2, 3]),
    (re.compile(r"(^|_)(names|words|keys|labels|tags|lines|strings|tokens)($|_)"), ["alpha", "beta", "gamma"]),
]


def _by_name(name):
    lowered = name.lower()
    for pattern, value in _NAME_RULES:
        if pattern.search(lowered):
            if value is None:
                return True, "example %s" % lowered.replace("_", " ")
            return True, list(value) if isinstance(value, list) else value
    return False, None


def _origin(tp):
    try:
        return typing.get_origin(tp)
    except Exception:
        return getattr(tp, "__origin__", None)


def _args(tp):
    try:
        return typing.get_args(tp)
    except Exception:
        return getattr(tp, "__args__", ()) or ()


def guess(name, annotation, module, depth=0):
    """Best-effort value for a parameter when nothing better is known.

    Unknown or hard-to-build types become lazy fakes, which keeps the run
    going and lets the use site decide what the value should look like.
    """
    path = name
    if depth > 4:
        return make_fake(path)
    if annotation is inspect.Parameter.empty or annotation is None or annotation is typing.Any:
        hit, value = _by_name(name)
        return value if hit else make_fake(path)
    if isinstance(annotation, str):
        try:
            annotation = eval(annotation, dict(vars(typing), **(vars(module) if module else {})))
        except Exception:
            hit, value = _by_name(name)
            return value if hit else make_fake(path)

    tp = annotation
    origin = _origin(tp)
    args = _args(tp)

    if origin is typing.Union or type(tp).__name__ == "UnionType":
        choices = [a for a in args if a is not type(None)]
        return guess(name, choices[0], module, depth + 1) if choices else None
    if origin is getattr(typing, "Literal", _MISSING):
        return args[0] if args else None
    if getattr(tp, "__metadata__", None) is not None and args:  # Annotated[T, ...]
        return guess(name, args[0], module, depth + 1)
    if hasattr(tp, "__supertype__"):  # NewType
        return guess(name, tp.__supertype__, module, depth + 1)

    if tp is bool:
        return True
    if tp is int:
        hit, value = _by_name(name)
        return value if hit and isinstance(value, int) and not isinstance(value, bool) else 3
    if tp is float:
        hit, value = _by_name(name)
        return value if hit and isinstance(value, float) else 1.5
    if tp is complex:
        return complex(1.0, 0.5)
    if tp is str:
        hit, value = _by_name(name)
        return value if hit and isinstance(value, str) else "example %s" % name.replace("_", " ")
    if tp is bytes:
        return b"example"
    if tp is type(None):
        return None
    if tp is _datetime.datetime:
        return _datetime.datetime(2024, 1, 15, 12, 0, 0)
    if tp is _datetime.date:
        return _datetime.date(2024, 1, 15)
    if tp is _datetime.time:
        return _datetime.time(12, 0, 0)
    if tp is _datetime.timedelta:
        return _datetime.timedelta(hours=1)
    if tp is decimal.Decimal:
        return decimal.Decimal("9.99")
    if tp is uuid.UUID:
        return uuid.UUID("12345678-1234-5678-1234-567812345678")
    if isinstance(tp, type) and issubclass(tp, pathlib.PurePath):
        return pathlib.Path("example.txt")

    if tp is list or origin is list:
        if args:
            return [guess("%s_%d" % (name, i), args[0], module, depth + 1) for i in range(2)]
        hit, value = _by_name(name)
        return value if hit and isinstance(value, list) else [1, 2, 3]
    if tp is tuple or origin is tuple:
        if args and args[-1] is not Ellipsis:
            return tuple(guess("%s_%d" % (name, i), a, module, depth + 1) for i, a in enumerate(args))
        if args:
            return tuple(guess("%s_%d" % (name, i), args[0], module, depth + 1) for i in range(2))
        return (1, 2)
    if tp is set or origin is set or tp is frozenset or origin is frozenset:
        item = guess(name, args[0], module, depth + 1) if args else 1
        try:
            return (frozenset if (tp is frozenset or origin is frozenset) else set)([item])
        except TypeError:
            return set()
    if tp is dict or origin is dict:
        if len(args) == 2:
            key = guess("key", args[0], module, depth + 1)
            try:
                return {key: guess("%s_value" % name, args[1], module, depth + 1)}
            except TypeError:
                return {}
        return {"key": "value"}
    origin_name = getattr(origin, "__name__", "") or ""
    if origin_name in ("Sequence", "Iterable", "Collection", "MutableSequence", "Iterator"):
        item_type = args[0] if args else int
        return [guess("%s_%d" % (name, i), item_type, module, depth + 1) for i in range(2)]
    if origin_name in ("Mapping", "MutableMapping"):
        if len(args) == 2:
            return {guess("key", args[0], module, depth + 1): guess("%s_value" % name, args[1], module, depth + 1)}
        return {"key": "value"}

    if isinstance(tp, type):
        if issubclass(tp, enum.Enum):
            members = list(tp)
            return members[0] if members else make_fake(path, tp)
        if dataclasses.is_dataclass(tp):
            return _build_dataclass(name, tp, module, depth)
        if _is_typed_dict(tp):
            hints = _hints(tp, module)
            return {k: guess(k, v, module, depth + 1) for k, v in hints.items()}
        if _is_named_tuple(tp):
            hints = _hints(tp, module)
            try:
                return tp(**{k: guess(k, v, module, depth + 1) for k, v in hints.items()})
            except Exception:
                return make_fake(path, tp)
        if _is_pydantic(tp):
            built = _build_pydantic(name, tp, module, depth)
            if built is not None:
                return built
        qualified = "%s.%s" % (getattr(tp, "__module__", ""), tp.__name__)
        if qualified == "numpy.ndarray":
            try:
                import numpy as np

                return np.linspace(0.0, 1.0, 5)
            except Exception:
                return [0.0, 0.25, 0.5, 0.75, 1.0]
        if qualified.endswith("frame.DataFrame") and qualified.startswith("pandas"):
            try:
                import pandas as pd

                return pd.DataFrame({"a": [1, 2, 3], "b": [1.5, 2.5, 3.5]})
            except Exception:
                pass
        return make_fake(path, tp)

    return make_fake(path)


def _hints(tp, module):
    try:
        return typing.get_type_hints(tp)
    except Exception:
        return dict(getattr(tp, "__annotations__", {}))


def _is_typed_dict(tp):
    return isinstance(tp, type) and issubclass(tp, dict) and hasattr(tp, "__annotations__") and hasattr(tp, "__total__")


def _is_named_tuple(tp):
    return isinstance(tp, type) and issubclass(tp, tuple) and hasattr(tp, "_fields")


def _is_pydantic(tp):
    return any(
        base.__name__ == "BaseModel" and (base.__module__ or "").startswith("pydantic") for base in getattr(tp, "__mro__", ())
    )


def _build_dataclass(name, tp, module, depth):
    hints = _hints(tp, module)
    kwargs = {}
    for field in dataclasses.fields(tp):
        if not field.init:
            continue
        has_default = field.default is not dataclasses.MISSING or field.default_factory is not dataclasses.MISSING
        if has_default:
            continue
        kwargs[field.name] = guess(field.name, hints.get(field.name, field.type), module, depth + 1)
    try:
        return tp(**kwargs)
    except Exception:
        return make_fake(name, tp)


def _build_pydantic(name, tp, module, depth):
    fields = getattr(tp, "model_fields", None) or getattr(tp, "__fields__", None)
    if not fields:
        return None
    hints = _hints(tp, module)
    kwargs = {}
    for field_name, field in fields.items():
        required = getattr(field, "is_required", None)
        required = required() if callable(required) else getattr(field, "required", True)
        if not required:
            continue
        kwargs[field_name] = guess(field_name, hints.get(field_name), module, depth + 1)
    try:
        return tp(**kwargs)
    except Exception:
        try:
            construct = getattr(tp, "model_construct", None) or getattr(tp, "construct")
            return construct(**kwargs)
        except Exception:
            return None


def expression_for(value):
    """Expression text shown to the user for a heuristic value."""
    if is_fake(value) and not _st(value).resolved:
        return "FAKE"
    if round_trips(value):
        return repr(value)
    return None


__all__ = [
    "FAKE",
    "apply_imports",
    "Fake",
    "build_namespace",
    "describe",
    "evaluate",
    "expression_for",
    "guess",
    "round_trips",
]
