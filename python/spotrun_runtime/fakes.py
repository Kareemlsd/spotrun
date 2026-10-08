"""Lazy fakes.

A ``Fake`` stands in for anything the function under test should not touch
for real: a database session, an HTTP response, a client object, a file
that does not exist. Attribute access, item access and calls on a fake are
free and return further fakes that remember the expression that produced
them (``requests.get('https://x').json()['items']``).

A fake only needs a concrete value when the code under test uses it as one:
iterating it, testing its truth, comparing it, doing arithmetic, formatting
it. At that moment it asks the resolver (pins, cache, then the language
model) for a value, with the expression path and the kind of use as
context. Without an answer it falls back to a deterministic default so the
run always continues.
"""

import operator
import re
import reprlib

_MISSING = object()

# Uses that should not fix the fake's value when only a heuristic answered.
_SOFT_OPS = frozenset(["bool", "eq"])


class Hooks:
    """Wiring points filled in by the runner."""

    resolver = None  # (path, op, detail) -> (found, value)
    eager = None  # (path) -> None or a reason string
    report = None  # (path, op, value) -> None, called for heuristic answers


class _State(object):
    __slots__ = (
        "path",
        "spec",
        "resolved",
        "value",
        "attrs",
        "items",
        "overrides",
        "call_op",
        "method_ops",
        "iterator",
    )

    def __init__(self, path, spec):
        self.path = path
        self.spec = spec
        self.resolved = False
        self.value = None
        self.attrs = {}
        self.items = {}
        self.overrides = {}
        self.call_op = None
        self.method_ops = None
        self.iterator = None


def _st(fake):
    return object.__getattribute__(fake, "_spotrun_state")


def is_fake(value):
    return isinstance(type(value), type) and issubclass(type(value), Fake)


def unwrap(value):
    """Concrete value of a resolved fake, anything else unchanged."""
    if is_fake(value):
        st = _st(value)
        if st.resolved:
            return st.value
    return value


def fake_path(fake):
    return _st(fake).path


_ADDR = re.compile(r" at 0x[0-9a-fA-F]+")
_short_repr = reprlib.Repr()
_short_repr.maxlevel = 2
_short_repr.maxlist = 4
_short_repr.maxtuple = 4
_short_repr.maxdict = 3
_short_repr.maxset = 4
_short_repr.maxstring = 60
_short_repr.maxother = 60
_short_repr.maxlong = 30


def short(value, limit=60):
    """Compact, deterministic text for a value inside a fake's path."""
    try:
        if is_fake(value):
            st = _st(value)
            text = short(st.value, limit) if st.resolved else st.path
        elif value is None or isinstance(value, (bool, int, float, str, bytes)):
            text = _short_repr.repr(value)
        elif (getattr(type(value), "__module__", "") or "").startswith("sqlalchemy"):
            text = " ".join(str(value).split())
            limit = max(limit, 300)
        elif isinstance(value, (list, tuple, dict, set, frozenset)):
            text = _ADDR.sub("", _short_repr.repr(value))
        else:
            text = repr(value)
            if " at 0x" in text or len(text) > limit:
                text = "<%s>" % type(value).__name__
    except Exception:
        text = "<%s>" % type(value).__name__
    if len(text) > limit:
        text = text[: limit - 3] + "..."
    return text


def _format_call(args, kwargs):
    parts = [short(a) for a in args]
    parts.extend("%s=%s" % (k, short(v)) for k, v in kwargs.items())
    text = ", ".join(parts)
    if len(text) > 400:
        text = text[:397] + "..."
    return text


_TAIL = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)[^A-Za-z_]*$")


_KEY_TAIL = re.compile(r"\[['\"]([A-Za-z_][A-Za-z0-9_]*)['\"]\]$")


def _tail(path):
    """Last identifier in a path, used to label placeholder strings."""
    keyed = _KEY_TAIL.search(path)
    if keyed:
        return keyed.group(1)
    cleaned = re.sub(r"\([^()]*\)|\[[^\[\]]*\]", "", path)
    match = _TAIL.search(cleaned) or _TAIL.search(path)
    return match.group(1) if match else "value"


def _compatible(op, value):
    if op in ("iter", "contains"):
        return hasattr(value, "__iter__") or hasattr(value, "__contains__")
    if op == "len":
        return hasattr(value, "__len__")
    if op == "index":
        return hasattr(value, "__index__")
    if op == "num":
        return not isinstance(value, (type(None), dict))
    return True


async def _immediate(value):
    return value


async def _async_iter(items):
    for item in items:
        yield item


class Fake(object):
    """Stand-in object. See the module docstring."""

    __slots__ = ("_spotrun_state", "__weakref__")

    def __init__(self, path, spec=None):
        object.__setattr__(self, "_spotrun_state", _State(path, spec))

    # -- identity -----------------------------------------------------------

    @property
    def __class__(self):
        spec = _st(self).spec
        return spec if isinstance(spec, type) else Fake

    def __repr__(self):
        st = _st(self)
        if st.resolved:
            return "<fake: %s>" % short(st.value, 200)
        # The end of the path identifies the value; the start is usually a
        # long call that is the same for every fake derived from it.
        path = st.path
        if len(path) > 64:
            path = "\u2026" + path[-63:]
        return "<fake %s>" % path

    def __hash__(self):
        return id(self)

    def __dir__(self):
        return []

    def __copy__(self):
        return self

    def __deepcopy__(self, memo):
        return self

    def __reduce__(self):
        raise TypeError("a Spot Run fake cannot be pickled: %s" % _st(self).path)

    # -- resolution ---------------------------------------------------------

    def _spotrun_need(self, op, detail=None, other=_MISSING):
        st = _st(self)
        if st.resolved and _compatible(op, st.value):
            return st.value
        found, value = False, None
        if Hooks.resolver is not None:
            found, value = Hooks.resolver(st.path, op, detail)
        if found and not is_fake(value) and _compatible(op, value):
            st.resolved = True
            st.value = value
            return value
        if op == "any":
            return self
        value = self._spotrun_default(op, other)
        if op in _SOFT_OPS:
            return value
        st.resolved = True
        st.value = value
        if Hooks.report is not None:
            Hooks.report(st.path, op, value)
        return value

    def _spotrun_default(self, op, other):
        st = _st(self)
        other = unwrap(other)
        if op in ("iter", "len", "contains"):
            return [self[0], self[1]]
        if op == "bool":
            return True
        if op == "eq":
            return other
        if op == "index":
            return 0
        if op == "cmp":
            if other is _MISSING or is_fake(other):
                return 1
            return other
        if op == "num":
            if isinstance(other, bool):
                return True
            if isinstance(other, float):
                return 1.5
            if isinstance(other, str):
                return "<%s>" % _tail(st.path)
            if isinstance(other, bytes):
                return b"<fake>"
            if isinstance(other, (list, tuple, dict, set, frozenset)):
                return type(other)()
            return 1
        return "<%s>" % _tail(st.path)

    def _spotrun_derive(self, path):
        child = Fake(path)
        if Hooks.eager is not None:
            why = Hooks.eager(path)
            if why is not None:
                return child._spotrun_need("any", why)
        return child

    # -- structure: free, never resolves ------------------------------------

    def __getattr__(self, name):
        if name.startswith("__") and name.endswith("__"):
            raise AttributeError(name)
        st = _st(self)
        if name in st.overrides:
            return st.overrides[name]
        if st.resolved:
            try:
                return getattr(st.value, name)
            except AttributeError:
                pass
        if name in st.attrs:
            return st.attrs[name]
        child = self._spotrun_derive(st.path + "." + name)
        if is_fake(child) and st.method_ops and name in st.method_ops:
            _st(child).call_op = st.method_ops[name]
        st.attrs[name] = child
        return child

    def __setattr__(self, name, value):
        _st(self).overrides[name] = value

    def __delattr__(self, name):
        _st(self).overrides.pop(name, None)

    def __getitem__(self, key):
        st = _st(self)
        key = unwrap(key)
        if st.resolved:
            try:
                return st.value[key]
            except (KeyError, IndexError, TypeError):
                pass
        if isinstance(key, slice):
            label = "%s:%s" % (
                "" if key.start is None else short(key.start),
                "" if key.stop is None else short(key.stop),
            )
        else:
            label = short(key)
        if label in st.items:
            return st.items[label]
        child = self._spotrun_derive("%s[%s]" % (st.path, label))
        st.items[label] = child
        return child

    def __setitem__(self, key, value):
        st = _st(self)
        key = unwrap(key)
        if st.resolved:
            try:
                st.value[key] = value
                return
            except Exception:
                pass
        st.items[short(key)] = value

    def __delitem__(self, key):
        st = _st(self)
        if st.resolved:
            try:
                del st.value[unwrap(key)]
                return
            except Exception:
                pass
        st.items.pop(short(unwrap(key)), None)

    def __call__(self, *args, **kwargs):
        st = _st(self)
        if st.resolved and callable(st.value):
            return st.value(*args, **kwargs)
        path = "%s(%s)" % (st.path, _format_call(args, kwargs))
        if st.call_op is not None:
            return Fake(path)._spotrun_need(st.call_op)
        return self._spotrun_derive(path)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    def __await__(self):
        return _immediate(self).__await__()

    # -- value uses: these resolve -------------------------------------------

    def __bool__(self):
        st = _st(self)
        if st.resolved:
            try:
                return bool(st.value)
            except Exception:
                return True
        return bool(self._spotrun_need("bool", "used in a truth test (if / while / not / and / or)"))

    def __iter__(self):
        return iter(self._spotrun_need("iter", "iterated over (for loop, comprehension, list(...), unpacking)"))

    def __aiter__(self):
        return _async_iter(self._spotrun_need("iter", "iterated over with async for"))

    def __next__(self):
        st = _st(self)
        if st.iterator is None:
            st.iterator = iter(self._spotrun_need("iter", "advanced with next(...)"))
        return next(st.iterator)

    def __len__(self):
        return len(self._spotrun_need("len", "passed to len(...)"))

    def __contains__(self, item):
        item = unwrap(item)
        container = self._spotrun_need("contains", "tested with: %s in ..." % short(item))
        try:
            return item in container
        except TypeError:
            return False

    def __eq__(self, other):
        st = _st(self)
        other = unwrap(other)
        if st.resolved:
            return st.value == other
        if is_fake(other):
            return self is other
        value = self._spotrun_need("eq", "compared with == %s" % short(other), other)
        return value == other

    def __ne__(self, other):
        st = _st(self)
        other = unwrap(other)
        if st.resolved:
            return st.value != other
        if is_fake(other):
            return self is not other
        value = self._spotrun_need("eq", "compared with != %s" % short(other), other)
        return value != other

    def _spotrun_compare(self, symbol, func, other):
        other = unwrap(other)
        if is_fake(other):
            other = other._spotrun_need("num", "compared with %s" % symbol)
        value = self._spotrun_need("cmp", "compared: ... %s %s" % (symbol, short(other)), other)
        try:
            return func(value, other)
        except TypeError:
            return func(other, other)

    def __lt__(self, other):
        return self._spotrun_compare("<", operator.lt, other)

    def __le__(self, other):
        return self._spotrun_compare("<=", operator.le, other)

    def __gt__(self, other):
        return self._spotrun_compare(">", operator.gt, other)

    def __ge__(self, other):
        return self._spotrun_compare(">=", operator.ge, other)

    def __str__(self):
        return str(self._spotrun_need("str", "converted to text (str(...), f-string, print)"))

    def __format__(self, spec):
        if spec and spec[-1] in "bcdeEfFgGnoxX%":
            value = self._spotrun_need("num", "formatted as a number with format spec %r" % spec, 1.5)
        else:
            value = self._spotrun_need("str", "formatted into a string")
        try:
            return format(value, spec)
        except (TypeError, ValueError):
            return format(str(value), "" if spec and spec[-1] in "bcdeEfFgGnoxX%" else spec)

    def __fspath__(self):
        return str(self._spotrun_need("str", "used as a filesystem path"))

    def __bytes__(self):
        value = self._spotrun_need("str", "converted to bytes")
        return value if isinstance(value, bytes) else str(value).encode("utf-8")

    def __int__(self):
        return int(self._spotrun_need("num", "converted with int(...)", 1))

    def __float__(self):
        return float(self._spotrun_need("num", "converted with float(...)", 1.5))

    def __complex__(self):
        return complex(self._spotrun_need("num", "converted with complex(...)", 1.5))

    def __index__(self):
        return operator.index(self._spotrun_need("index", "used as an integer index or count"))

    def __neg__(self):
        return -self._spotrun_need("num", "negated", 1)

    def __pos__(self):
        return +self._spotrun_need("num", "used as a number", 1)

    def __abs__(self):
        return abs(self._spotrun_need("num", "passed to abs(...)", 1))

    def __invert__(self):
        return ~self._spotrun_need("num", "bitwise inverted", 1)

    def __round__(self, ndigits=None):
        value = self._spotrun_need("num", "passed to round(...)", 1.5)
        return round(value) if ndigits is None else round(value, ndigits)

    def __trunc__(self):
        return int(self._spotrun_need("num", "truncated", 1.5))

    def __floor__(self):
        import math

        return math.floor(self._spotrun_need("num", "passed to math.floor", 1.5))

    def __ceil__(self):
        import math

        return math.ceil(self._spotrun_need("num", "passed to math.ceil", 1.5))


def _install_binary(name, symbol, func):
    def forward(self, other):
        other = unwrap(other)
        if is_fake(other):
            other = other._spotrun_need("num", "used with operator %s" % symbol, 1)
        value = self._spotrun_need("num", "used in arithmetic: ... %s %s" % (symbol, short(other)), other)
        return func(value, other)

    def reflected(self, other):
        other = unwrap(other)
        value = self._spotrun_need("num", "used in arithmetic: %s %s ..." % (short(other), symbol), other)
        return func(other, value)

    forward.__name__ = "__%s__" % name
    reflected.__name__ = "__r%s__" % name
    setattr(Fake, forward.__name__, forward)
    setattr(Fake, reflected.__name__, reflected)


for _name, _symbol, _func in [
    ("add", "+", operator.add),
    ("sub", "-", operator.sub),
    ("mul", "*", operator.mul),
    ("truediv", "/", operator.truediv),
    ("floordiv", "//", operator.floordiv),
    ("mod", "%", operator.mod),
    ("pow", "**", operator.pow),
    ("matmul", "@", operator.matmul),
    ("and", "&", operator.and_),
    ("or", "|", operator.or_),
    ("xor", "^", operator.xor),
    ("lshift", "<<", operator.lshift),
    ("rshift", ">>", operator.rshift),
]:
    _install_binary(_name, _symbol, _func)


def make_fake(path, spec=None):
    """Create a root fake, honouring eager resolution for its path."""
    fake = Fake(path, spec)
    if Hooks.eager is not None:
        why = Hooks.eager(path)
        if why is not None:
            return fake._spotrun_need("any", why)
    return fake


def make_file_fake(path):
    """Fake for a file opened for reading that does not exist on disk."""
    fake = Fake(path)
    _st(fake).method_ops = {"read": "str", "readline": "str", "readlines": "iter", "getvalue": "str"}
    return fake


class FakeSentinel(Fake):
    """The ``FAKE`` name available to generated expressions."""

    __slots__ = ()
