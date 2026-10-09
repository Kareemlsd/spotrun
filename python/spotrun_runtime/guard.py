"""Side-effect isolation.

Two layers:

1. A fixed table of effectful entry points (HTTP clients, database drivers,
   subprocess, mail, cloud SDKs, filesystem mutation) is patched so that the
   call returns a lazy fake or is recorded and skipped. This layer needs no
   model and is installed before the user's module is imported.

2. An audit hook that is armed while the function under test runs. Anything
   that would still open a socket, spawn a process or modify a file outside
   scratch locations raises ``EffectBlocked``. The hook also reports which
   library function the user's code called, so the next run can patch that
   function and continue past it.
"""

import builtins
import importlib.abc
import inspect
import io
import os
import sys
import tempfile

from .fakes import Fake, _format_call, make_fake, make_file_fake, short


class EffectBlocked(BaseException):
    """Raised instead of performing a real side effect.

    Derives from BaseException so that ``except Exception`` blocks in the
    code under test do not swallow it and carry on down a wrong path.
    """


class _State(object):
    armed = False
    importing = False
    bypass = 0
    blocked = []
    effects = []
    files = {}
    dirs = set()
    removed = set()
    in_scope = staticmethod(lambda filename: False)
    current_step = staticmethod(lambda: 0)
    installed = False


STATE = _State()


def arm():
    STATE.armed = True


def disarm():
    STATE.armed = False


class _Bypass(object):
    def __enter__(self):
        STATE.bypass += 1

    def __exit__(self, *exc):
        STATE.bypass -= 1
        return False


bypass = _Bypass()

# --------------------------------------------------------------------------
# Scratch locations where real writes are allowed
# --------------------------------------------------------------------------


def _allowed_roots():
    roots = [tempfile.gettempdir(), os.path.realpath(tempfile.gettempdir())]
    home = os.path.expanduser("~")
    for relative in (".cache", ".config", ".local/share", "Library/Caches", "AppData/Local", ".matplotlib", ".ipython", ".keras", ".torch", ".numba_cache", ".julia"):
        roots.append(os.path.join(home, relative))
    for variable in ("XDG_CACHE_HOME", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR", "MPLCONFIGDIR"):
        if os.environ.get(variable):
            roots.append(os.environ[variable])
    return tuple(sorted(set(os.path.normcase(os.path.abspath(r)) for r in roots)))


_ROOTS = None


def path_allowed(path):
    global _ROOTS
    if isinstance(path, int):
        return True
    try:
        text = os.fsdecode(os.fspath(path))
    except TypeError:
        return False
    if "__pycache__" in text or text.endswith((".pyc", ".pyo")):
        return True
    if text in (os.devnull, "/dev/null", "/dev/tty", "nul", "NUL") or text.startswith(("/dev/", "/proc/")):
        return True
    if _ROOTS is None:
        _ROOTS = _allowed_roots()
    full = os.path.normcase(os.path.abspath(text))
    return any(full == root or full.startswith(root + os.sep) for root in _ROOTS)


# --------------------------------------------------------------------------
# Recording
# --------------------------------------------------------------------------


def _user_site():
    """(file, line) of the innermost frame that belongs to the user's code."""
    frame = sys._getframe(1)
    while frame is not None:
        if STATE.in_scope(frame.f_code.co_filename):
            return frame.f_code.co_filename, frame.f_lineno
        frame = frame.f_back
    return None, 0


def record_effect(kind, what):
    file, line = _user_site()
    STATE.effects.append({"kind": kind, "what": what, "step": STATE.current_step(), "file": file, "line": line})


# --------------------------------------------------------------------------
# Audit hook
# --------------------------------------------------------------------------

_WRITE_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC


def _check_open(args):
    path = args[0] if args else None
    flags = args[2] if len(args) > 2 else 0
    mode = args[1] if len(args) > 1 else None
    writing = bool(isinstance(flags, int) and flags & _WRITE_FLAGS)
    if not writing and isinstance(mode, str):
        writing = any(c in mode for c in "wax+")
    if not writing or path_allowed(path):
        return None
    return "write to file %s" % short(path, 120)


def _check_path(verb):
    def check(args):
        paths = [a for a in args[:2] if isinstance(a, (str, bytes, os.PathLike))]
        if paths and all(path_allowed(p) for p in paths):
            return None
        return "%s %s" % (verb, ", ".join(short(p, 120) for p in paths) or "a file")

    return check


def _always(text):
    def check(args):
        detail = ""
        if args:
            detail = " " + short(args[-1] if text.startswith("network") else args[0], 120)
        return text + detail

    return check


def _check_connect(args):
    address = args[1] if len(args) > 1 else None
    if isinstance(address, (str, bytes)):
        # Unix domain socket: local IPC, not a network effect worth blocking
        # for asyncio's own wake-up pipes, but still a real connection.
        return "connect to local socket %s" % short(address, 120)
    return "network connection to %s" % short(address, 120)


_EVENTS = {
    "open": _check_open,
    "os.remove": _check_path("delete"),
    "os.rmdir": _check_path("remove directory"),
    "os.rename": _check_path("rename"),
    "os.mkdir": _check_path("create directory"),
    "os.chmod": _check_path("chmod"),
    "os.chown": _check_path("chown"),
    "os.truncate": _check_path("truncate"),
    "os.link": _check_path("link"),
    "os.symlink": _check_path("symlink"),
    "shutil.rmtree": _check_path("delete tree"),
    "shutil.move": _check_path("move"),
    "shutil.copyfile": _check_path("copy file"),
    "shutil.copytree": _check_path("copy tree"),
    "shutil.make_archive": _check_path("create archive"),
    "shutil.unpack_archive": _check_path("unpack archive"),
    "socket.connect": _check_connect,
    "socket.bind": _always("bind a network socket"),
    "socket.getaddrinfo": _always("DNS lookup for"),
    "socket.gethostbyname": _always("DNS lookup for"),
    "socket.sendto": _always("send network data"),
    "subprocess.Popen": _always("start process"),
    "os.system": _always("run shell command"),
    "os.exec": _always("replace process with"),
    "os.posix_spawn": _always("spawn process"),
    "os.spawn": _always("spawn process"),
    "os.startfile": _always("open with the system handler"),
    "os.kill": _always("send signal to process"),
    "ftplib.connect": _always("FTP connection"),
    "smtplib.connect": _always("SMTP connection"),
    "imaplib.open": _always("IMAP connection"),
    "poplib.connect": _always("POP3 connection"),
    "nntplib.connect": _always("NNTP connection"),
    "telnetlib.Telnet.open": _always("Telnet connection"),
    "http.client.connect": _always("HTTP connection to"),
    "urllib.Request": _always("HTTP request to"),
    "webbrowser.open": _always("open browser at"),
    "sqlite3.connect": None,  # replaced below
    "winreg.CreateKey": _always("write registry key"),
    "winreg.SetValue": _always("write registry value"),
    "winreg.DeleteKey": _always("delete registry key"),
    "winreg.DeleteValue": _always("delete registry value"),
}


def _check_sqlite(args):
    target = args[0] if args else None
    if target in (":memory:", b":memory:", "") or path_allowed(target):
        return None
    return "open SQLite database %s" % short(target, 120)


_EVENTS["sqlite3.connect"] = _check_sqlite


def _find_qualname(frame):
    """module:qualname of the function running in ``frame`` if it can be
    looked up again from module level, else None."""
    code = frame.f_code
    module_name = frame.f_globals.get("__name__")
    module = sys.modules.get(module_name)
    if module is None:
        return None
    qualname = getattr(code, "co_qualname", None)
    if qualname and "<locals>" not in qualname and _resolve(module, qualname) is not None:
        return "%s:%s" % (module_name, qualname)
    for name, obj in list(vars(module).items()):
        if getattr(obj, "__code__", None) is code:
            return "%s:%s" % (module_name, name)
        if isinstance(obj, type) and obj.__module__ == module_name:
            for attr, member in list(vars(obj).items()):
                member = getattr(member, "__func__", member)
                member = getattr(member, "fget", member) or member
                if getattr(member, "__code__", None) is code:
                    return "%s:%s.%s" % (module_name, name, attr)
    return None


def _resolve(module, qualname):
    target = module
    for part in qualname.split("."):
        try:
            target = inspect.getattr_static(target, part)
        except AttributeError:
            return None
        target = getattr(target, "__func__", target)
    return target


def _boundary():
    """Find where the user's code handed control to library code."""
    frame = sys._getframe(1)
    callee = None
    while frame is not None:
        if frame.f_globals.get("__name__", "").startswith("spotrun_runtime"):
            frame = frame.f_back
            continue
        filename = frame.f_code.co_filename
        if STATE.in_scope(filename):
            info = {"file": filename, "line": frame.f_lineno, "target": None}
            if callee is not None:
                info["target"] = _find_qualname(callee)
            return info
        callee = frame
        frame = frame.f_back
    return {"file": None, "line": 0, "target": None}


def block(event, what):
    """Record a blocked effect and raise."""
    STATE.bypass += 1
    try:
        info = _boundary()
        info["event"] = event
        info["what"] = what
        info["step"] = STATE.current_step()
        STATE.blocked.append(info)
    finally:
        STATE.bypass -= 1
    raise EffectBlocked("Spot Run blocked a real side effect: %s" % what)


def _audit(event, args):
    if not STATE.armed or STATE.bypass:
        return
    check = _EVENTS.get(event)
    if check is None:
        return
    STATE.bypass += 1
    try:
        what = check(args)
    finally:
        STATE.bypass -= 1
    if what is not None:
        block(event, what)


# --------------------------------------------------------------------------
# Virtual filesystem view
#
# Writes, deletes and renames that were kept off the disk are remembered so
# that the function under test sees a consistent picture afterwards: a file
# it wrote exists and can be read back, a file it deleted is gone.
# --------------------------------------------------------------------------


def _key(path):
    try:
        return os.path.abspath(os.fsdecode(os.fspath(path)))
    except TypeError:
        return None


def _is_removed(key):
    if key in STATE.removed:
        return True
    return any(key.startswith(gone + os.sep) for gone in STATE.removed)


def _virtual_kind(path):
    """'file', 'dir', 'gone' or None when the real filesystem decides."""
    if isinstance(path, int) or not (STATE.files or STATE.dirs or STATE.removed):
        return None
    key = _key(path)
    if key is None:
        return None
    if key in STATE.files:
        return "file"
    if key in STATE.dirs:
        return "dir"
    if _is_removed(key):
        return "gone"
    return None


def _read_real(path, limit=20 * 1024 * 1024):
    try:
        with bypass:
            if os.path.isfile(path) and os.path.getsize(path) <= limit:
                with builtins.open(path, "rb") as handle:
                    return handle.read()
    except OSError:
        pass
    return b""


def _content_of(key):
    if key in STATE.files:
        return STATE.files[key]
    return _read_real(key)


def _virtual_apply(name, args):
    """Mirror a skipped filesystem call in the virtual view."""
    paths = [_key(a) for a in args[:2] if isinstance(a, (str, bytes, os.PathLike))]
    paths = [p for p in paths if p]
    if not paths:
        return
    first = paths[0]
    if name in ("remove", "unlink", "rmdir", "removedirs", "rmtree"):
        STATE.files.pop(first, None)
        STATE.dirs.discard(first)
        for key in [k for k in STATE.files if k.startswith(first + os.sep)]:
            del STATE.files[key]
        STATE.removed.add(first)
    elif name in ("mkdir", "makedirs"):
        STATE.removed.discard(first)
        STATE.dirs.add(first)
        if name == "makedirs":
            parent = os.path.dirname(first)
            while parent and parent != os.path.dirname(parent) and not os.path.isdir(parent):
                STATE.dirs.add(parent)
                parent = os.path.dirname(parent)
    elif name == "touch":
        STATE.removed.discard(first)
        STATE.files.setdefault(first, _read_real(first))
    elif name in ("rename", "renames", "replace", "move", "copy", "copy2", "copyfile") and len(paths) > 1:
        target = paths[1]
        if target in STATE.dirs or (target not in STATE.files and os.path.isdir(target)):
            target = os.path.join(target, os.path.basename(first))
        STATE.files[target] = _content_of(first)
        STATE.removed.discard(target)
        if not name.startswith("copy"):
            STATE.files.pop(first, None)
            STATE.removed.add(first)


def _install_virtual_view():
    import errno
    import stat as stat_module

    real_stat = os.stat
    real_exists, real_isfile, real_isdir = os.path.exists, os.path.isfile, os.path.isdir
    real_listdir = os.listdir

    def spotrun_stat(path, *args, **kwargs):
        if STATE.armed and not STATE.bypass:
            kind = _virtual_kind(path)
            if kind == "gone":
                raise FileNotFoundError(errno.ENOENT, os.strerror(errno.ENOENT), os.fspath(path))
            if kind is not None:
                content = STATE.files.get(_key(path), b"")
                size = len(content.encode("utf-8")) if isinstance(content, str) else len(content)
                mode = (stat_module.S_IFDIR | 0o755) if kind == "dir" else (stat_module.S_IFREG | 0o644)
                return os.stat_result((mode, 0, 0, 1, os.getuid() if hasattr(os, "getuid") else 0, 0, 0 if kind == "dir" else size, 0, 0, 0))
        return real_stat(path, *args, **kwargs)

    def checker(real, answers):
        def check(path):
            if STATE.armed and not STATE.bypass:
                kind = _virtual_kind(path)
                if kind is not None:
                    return answers[kind]
            return real(path)

        check.__name__ = real.__name__
        check.__spotrun_original__ = real
        return check

    def spotrun_listdir(path="."):
        if not STATE.armed or STATE.bypass or isinstance(path, int):
            return real_listdir(path)
        key = _key(path)
        kind = _virtual_kind(path)
        if kind == "gone":
            raise FileNotFoundError(errno.ENOENT, os.strerror(errno.ENOENT), os.fspath(path))
        names = [] if kind == "dir" else list(real_listdir(path))
        if key is not None and (STATE.files or STATE.dirs or STATE.removed):
            names = [n for n in names if not _is_removed(os.path.join(key, os.fsdecode(n)))]
            seen = set(os.fsdecode(n) for n in names)
            for entry in list(STATE.files) + list(STATE.dirs):
                if os.path.dirname(entry) == key and os.path.basename(entry) not in seen:
                    seen.add(os.path.basename(entry))
                    names.append(os.path.basename(entry))
        return names

    spotrun_stat.__spotrun_original__ = real_stat
    spotrun_listdir.__spotrun_original__ = real_listdir
    os.stat = spotrun_stat
    os.listdir = spotrun_listdir
    os.path.exists = checker(real_exists, {"file": True, "dir": True, "gone": False})
    os.path.isfile = checker(real_isfile, {"file": True, "dir": False, "gone": False})
    os.path.isdir = checker(real_isdir, {"file": False, "dir": True, "gone": False})


# --------------------------------------------------------------------------
# In-memory files
# --------------------------------------------------------------------------


class _MemText(io.StringIO):
    def __init__(self, name, initial=""):
        io.StringIO.__init__(self, initial)
        self.name = name
        self.mode = "w"

    def close(self):
        if not self.closed:
            STATE.files[self.name] = self.getvalue()
            STATE.removed.discard(self.name)
        io.StringIO.close(self)


class _MemBytes(io.BytesIO):
    def __init__(self, name, initial=b""):
        io.BytesIO.__init__(self, initial)
        self.name = name
        self.mode = "wb"

    def close(self):
        if not self.closed:
            STATE.files[self.name] = self.getvalue()
            STATE.removed.discard(self.name)
        io.BytesIO.close(self)


def _make_open(real_open):
    def spotrun_open(file, mode="r", *args, **kwargs):
        if not STATE.armed or STATE.bypass or isinstance(file, int):
            return real_open(file, mode, *args, **kwargs)
        try:
            name = os.fsdecode(os.fspath(file))
        except TypeError:
            return real_open(file, mode, *args, **kwargs)
        key = os.path.abspath(name)
        binary = "b" in mode
        writing = any(c in mode for c in "wax+")
        if writing:
            if path_allowed(name):
                return real_open(file, mode, *args, **kwargs)
            initial = None
            if "a" in mode or "+" in mode and "w" not in mode:
                initial = STATE.files.get(key)
                if initial is None and not _is_removed(key):
                    data = _read_real(name)
                    initial = data if binary else data.decode("utf-8", "replace")
            record_effect("file", "write %s" % name)
            if isinstance(initial, str) and binary:
                initial = initial.encode("utf-8")
            elif isinstance(initial, bytes) and not binary:
                initial = initial.decode("utf-8", "replace")
            if binary:
                handle = _MemBytes(key, initial or b"")
            else:
                handle = _MemText(key, initial or "")
            STATE.files[key] = initial or (b"" if binary else "")
            STATE.removed.discard(key)
            if "a" in mode:
                handle.seek(0, io.SEEK_END)
            return handle
        if key in STATE.files:
            content = STATE.files[key]
            if binary:
                return io.BytesIO(content if isinstance(content, bytes) else content.encode("utf-8"))
            return io.StringIO(content if isinstance(content, str) else content.decode("utf-8", "replace"))
        if _is_removed(key):
            import errno

            raise FileNotFoundError(errno.ENOENT, os.strerror(errno.ENOENT), name)
        with bypass:
            on_disk = os.path.exists(name)
        if on_disk:
            return real_open(file, mode, *args, **kwargs)
        record_effect("file", "read missing file %s" % name)
        return make_file_fake("open(%s)" % short(name, 120))

    spotrun_open.__name__ = "open"
    spotrun_open.__qualname__ = "open"
    return spotrun_open


# --------------------------------------------------------------------------
# Patches
# --------------------------------------------------------------------------


def _label_default(display):
    def label(args, kwargs):
        return "%s(%s)" % (display, _format_call(args, kwargs))

    return label


def _label_http(prefix):
    def label(args, kwargs):
        rest = list(args)
        method = kwargs.get("method")
        url = kwargs.get("url")
        if method is None and rest:
            method = rest.pop(0)
        if url is None and rest:
            url = rest.pop(0)
        verb = str(method or "request").lower()
        return "%s.%s(%s)" % (prefix, verb, short(url, 160))

    return label


def _fake_callable(display, kind, original, skip_self, label=None):
    label = label or _label_default(display)

    def describe(args, kwargs):
        return label(args[1:] if skip_self else args, kwargs)

    if kind == "noop":

        def replacement(*args, **kwargs):
            if not STATE.armed or STATE.bypass:
                return original(*args, **kwargs)
            paths = [a for a in args[:2] if isinstance(a, (str, bytes, os.PathLike))]
            if paths and all(path_allowed(p) for p in paths):
                return original(*args, **kwargs)
            if skip_self and paths[:1] == list(args[:1]):
                record_effect("skipped", "%s(%s)" % (display, _format_call(args, kwargs)))
            else:
                record_effect("skipped", describe(args, kwargs))
            _virtual_apply(display.split(".")[-1], args)
            return None

    elif kind == "drop":

        def replacement(*args, **kwargs):
            if STATE.bypass:
                return original(*args, **kwargs)
            record_effect("skipped", describe(args, kwargs))
            return None

    elif kind == "skip":

        def replacement(*args, **kwargs):
            if STATE.bypass:
                return original(*args, **kwargs)
            return None

    elif kind == "async":

        async def replacement(*args, **kwargs):
            if STATE.bypass:
                return await original(*args, **kwargs)
            text = describe(args, kwargs)
            record_effect("faked", text)
            return make_fake(text)

    elif kind == "block":

        def replacement(*args, **kwargs):
            if not STATE.armed or STATE.bypass:
                return original(*args, **kwargs)
            shown = args[1:] if skip_self else args
            block(display, "%s %s" % (display, _format_call(shown, kwargs)))

    elif kind == "input":

        def replacement(*args, **kwargs):
            if STATE.bypass:
                return original(*args, **kwargs)
            text = describe(args, kwargs)
            return str(Fake(text)._spotrun_need("str", "the text a user types at the prompt"))

    else:

        def replacement(*args, **kwargs):
            if STATE.bypass:
                return original(*args, **kwargs)
            text = describe(args, kwargs)
            record_effect("faked", text)
            return make_fake(text)

    replacement.__name__ = getattr(original, "__name__", "replacement")
    replacement.__qualname__ = getattr(original, "__qualname__", replacement.__name__)
    replacement.__doc__ = getattr(original, "__doc__", None)
    replacement.__spotrun_original__ = original
    return replacement


class _FakeClassObject(object):
    """Fallback replacement for a class that cannot be subclassed."""

    def __init__(self, display, original):
        self._display = display
        self.__spotrun_original__ = original
        self.__name__ = getattr(original, "__name__", display)

    def __call__(self, *args, **kwargs):
        if STATE.bypass:
            return self.__spotrun_original__(*args, **kwargs)
        text = "%s(%s)" % (self._display, _format_call(args, kwargs))
        record_effect("faked", text)
        return make_fake(text)

    def __getattr__(self, name):
        return getattr(self.__spotrun_original__, name)

    def __instancecheck__(self, instance):
        return isinstance(instance, self.__spotrun_original__)


def _fake_class(display, original):
    """Replacement for a client class.

    Instantiating it yields a fake instead of a connected client. It is a
    real subclass of the original so that isinstance checks, class-level
    constructors such as ``from_url`` and third-party subclasses keep
    working.
    """
    if not isinstance(original, type):
        return _FakeClassObject(display, original)

    def __new__(cls, *args, **kwargs):
        if cls is replacement and not STATE.bypass:
            text = "%s(%s)" % (display, _format_call(args, kwargs))
            record_effect("faked", text)
            return make_fake(text, original)
        if original.__new__ is object.__new__:
            return object.__new__(cls)
        return original.__new__(cls, *args, **kwargs)

    namespace = {
        "__new__": __new__,
        "__module__": original.__module__,
        "__qualname__": original.__qualname__,
        "__doc__": original.__doc__,
        "__spotrun_original__": original,
    }
    try:
        replacement = type(original)(original.__name__, (original,), namespace)
    except Exception:
        return _FakeClassObject(display, original)
    return replacement


def _sqlite_connect(original):
    def connect(database=":memory:", *args, **kwargs):
        if STATE.bypass or database in (":memory:", "") or path_allowed(database):
            return original(database, *args, **kwargs)
        text = "sqlite3.connect(%s)" % short(database, 120)
        record_effect("faked", text)
        return make_fake(text)

    connect.__spotrun_original__ = original
    return connect


# module -> list of (attribute path, kind, display name or None, labeler or None)
_F, _N, _C, _A, _D = "fake", "noop", "class", "async", "drop"

PATCHES = {
    "builtins": [("input", "input", "input", None)],
    "time": [("sleep", "skip", None, None)],
    "os": [(n, _N, "os." + n, None) for n in ("remove", "unlink", "rmdir", "removedirs", "rename", "renames", "replace", "mkdir", "makedirs", "chmod", "chown", "truncate", "symlink", "link")]
    + [("system", _F, "os.system", None), ("popen", _F, "os.popen", None)],
    "shutil": [(n, _N, "shutil." + n, None) for n in ("rmtree", "move", "copy", "copy2", "copyfile", "copytree", "copymode", "copystat", "make_archive", "unpack_archive")],
    "pathlib": [("Path." + n, _N, "Path." + n, None) for n in ("unlink", "rmdir", "mkdir", "rename", "replace", "touch", "chmod", "symlink_to")],
    "subprocess": [(n, _F, "subprocess." + n, None) for n in ("run", "call", "check_call", "check_output", "getoutput", "getstatusoutput")],
    # The interpreter resolves host names before it raises the audit event for
    # connect, so sockets are stopped one level earlier.
    "socket": [
        ("create_connection", _F, "socket.create_connection", None),
        ("socket.connect", "block", "network connection to", None),
        ("socket.connect_ex", "block", "network connection to", None),
        ("socket.bind", "block", "bind a network socket", None),
        ("socket.sendto", "block", "send network data", None),
        ("getaddrinfo", "block", "DNS lookup for", None),
        ("gethostbyname", "block", "DNS lookup for", None),
        ("gethostbyname_ex", "block", "DNS lookup for", None),
        ("gethostbyaddr", "block", "DNS lookup for", None),
    ],
    "webbrowser": [(n, _D, "webbrowser." + n, None) for n in ("open", "open_new", "open_new_tab")],
    "urllib.request": [("urlopen", _F, "urlopen", None), ("urlretrieve", _F, "urlretrieve", None)],
    "smtplib": [("SMTP", _C, "smtplib.SMTP", None), ("SMTP_SSL", _C, "smtplib.SMTP_SSL", None), ("LMTP", _C, "smtplib.LMTP", None)],
    "ftplib": [("FTP", _C, "ftplib.FTP", None), ("FTP_TLS", _C, "ftplib.FTP_TLS", None)],
    "imaplib": [("IMAP4", _C, "imaplib.IMAP4", None), ("IMAP4_SSL", _C, "imaplib.IMAP4_SSL", None)],
    "poplib": [("POP3", _C, "poplib.POP3", None), ("POP3_SSL", _C, "poplib.POP3_SSL", None)],
    "http.client": [("HTTPConnection.request", _D, "HTTPConnection.request", None), ("HTTPConnection.getresponse", _F, "HTTPConnection.getresponse", None)],
    "sqlite3": [("connect", "sqlite", None, None)],
    "requests.sessions": [("Session.request", _F, None, _label_http("requests")), ("Session.send", _F, "requests.Session.send", None)],
    "httpx": [
        ("Client.request", _F, None, _label_http("httpx")),
        ("Client.send", _F, "httpx.Client.send", None),
        ("Client.stream", _F, None, _label_http("httpx.stream")),
        ("AsyncClient.request", _A, None, _label_http("httpx")),
        ("AsyncClient.send", _A, "httpx.AsyncClient.send", None),
    ],
    "urllib3.poolmanager": [("PoolManager.urlopen", _F, None, _label_http("urllib3")), ("PoolManager.request", _F, None, _label_http("urllib3"))],
    "urllib3.connectionpool": [("HTTPConnectionPool.urlopen", _F, None, _label_http("urllib3"))],
    "aiohttp.client": [("ClientSession._request", _A, None, _label_http("aiohttp"))],
    "websockets": [("connect", _F, "websockets.connect", None)],
    "psycopg2": [("connect", _F, "psycopg2.connect", None)],
    "psycopg": [("connect", _F, "psycopg.connect", None)],
    "pymysql": [("connect", _F, "pymysql.connect", None)],
    "MySQLdb": [("connect", _F, "MySQLdb.connect", None)],
    "mysql.connector": [("connect", _F, "mysql.connector.connect", None)],
    "pyodbc": [("connect", _F, "pyodbc.connect", None)],
    "pymssql": [("connect", _F, "pymssql.connect", None)],
    "oracledb": [("connect", _F, "oracledb.connect", None)],
    "cx_Oracle": [("connect", _F, "cx_Oracle.connect", None)],
    "asyncpg": [("connect", _A, "asyncpg.connect", None), ("create_pool", _F, "asyncpg.create_pool", None)],
    "aiosqlite": [("connect", _F, "aiosqlite.connect", None)],
    "snowflake.connector": [("connect", _F, "snowflake.connector.connect", None)],
    "databricks.sql": [("connect", _F, "databricks.sql.connect", None)],
    "sqlalchemy.engine.base": [("Engine.connect", _F, "engine.connect", None), ("Engine.begin", _F, "engine.begin", None), ("Engine.raw_connection", _F, "engine.raw_connection", None)],
    "sqlalchemy.orm.session": [
        ("Session." + n, _F, "session." + n, None)
        for n in ("execute", "scalars", "scalar", "get", "query", "merge", "connection", "get_bind")
    ]
    + [("Session." + n, _D, "session." + n, None) for n in ("commit", "flush", "refresh", "rollback", "close", "add", "add_all", "delete", "expire", "expunge")],
    "sqlalchemy.ext.asyncio.session": [
        ("AsyncSession." + n, _A, "session." + n, None)
        for n in ("execute", "scalars", "scalar", "get", "merge", "connection", "commit", "flush", "refresh", "rollback", "close", "delete", "stream")
    ]
    + [("AsyncSession." + n, _D, "session." + n, None) for n in ("add", "add_all", "expire", "expunge")],
    "sqlalchemy.ext.asyncio.engine": [("AsyncEngine.connect", _F, "engine.connect", None), ("AsyncEngine.begin", _F, "engine.begin", None)],
    "pandas": [(n, _F, "pd." + n, None) for n in ("read_sql", "read_sql_query", "read_sql_table", "read_gbq")],
    "pandas.core.generic": [("NDFrame.to_sql", _D, "DataFrame.to_sql", None)],
    "pymongo": [("MongoClient", _C, "MongoClient", None)],
    "motor.motor_asyncio": [("AsyncIOMotorClient", _C, "AsyncIOMotorClient", None)],
    "redis": [("Redis", _C, "Redis", None), ("StrictRedis", _C, "Redis", None), ("from_url", _F, "redis.from_url", None)],
    "redis.asyncio": [("Redis", _C, "Redis", None), ("from_url", _F, "redis.asyncio.from_url", None)],
    "boto3": [("client", _F, "boto3.client", None), ("resource", _F, "boto3.resource", None)],
    "boto3.session": [("Session.client", _F, "boto3.client", None), ("Session.resource", _F, "boto3.resource", None)],
    "botocore.client": [("BaseClient._make_api_call", _F, "aws_api_call", None)],
    "google.cloud.storage": [("Client", _C, "storage.Client", None)],
    "google.cloud.bigquery": [("Client", _C, "bigquery.Client", None)],
    "google.cloud.firestore": [("Client", _C, "firestore.Client", None)],
    "google.cloud.pubsub_v1": [("PublisherClient", _C, "PublisherClient", None), ("SubscriberClient", _C, "SubscriberClient", None)],
    "azure.storage.blob": [("BlobServiceClient", _C, "BlobServiceClient", None), ("BlobClient", _C, "BlobClient", None), ("ContainerClient", _C, "ContainerClient", None)],
    "openai": [("OpenAI", _C, "OpenAI", None), ("AsyncOpenAI", _C, "AsyncOpenAI", None), ("AzureOpenAI", _C, "AzureOpenAI", None)],
    "anthropic": [("Anthropic", _C, "Anthropic", None), ("AsyncAnthropic", _C, "AsyncAnthropic", None)],
    "paramiko": [("SSHClient", _C, "SSHClient", None)],
    "kafka": [("KafkaProducer", _C, "KafkaProducer", None), ("KafkaConsumer", _C, "KafkaConsumer", None)],
    "pika": [("BlockingConnection", _C, "pika.BlockingConnection", None)],
    "elasticsearch": [("Elasticsearch", _C, "Elasticsearch", None)],
    "docker": [("from_env", _F, "docker.from_env", None), ("DockerClient", _C, "DockerClient", None)],
    "smbclient": [("open_file", _F, "smbclient.open_file", None)],
    "grpc": [("insecure_channel", _F, "grpc.insecure_channel", None), ("secure_channel", _F, "grpc.secure_channel", None)],
}

_applied = set()
_pending = {}


def _apply_one(module, path, kind, display, labeler):
    key = (module.__name__, path)
    if key in _applied:
        return
    parts = path.split(".")
    parent = module
    for part in parts[:-1]:
        parent = getattr(parent, part, None)
        if parent is None:
            return
    name = parts[-1]
    try:
        static = inspect.getattr_static(parent, name)
    except AttributeError:
        return
    if getattr(static, "__spotrun_original__", None) is not None:
        return
    original = getattr(parent, name)
    display = display or "%s.%s" % (module.__name__, path)
    if kind == "auto":
        if isinstance(original, type):
            kind = _C
        elif name in ("__init__", "__new__") and isinstance(parent, type):
            # Faking a constructor means faking the class it belongs to.
            owner_path = ".".join(parts[:-1])
            _apply_one(module, owner_path, _C, "%s.%s" % (module.__name__.split(".")[-1], owner_path), None)
            _applied.add(key)
            return
        elif inspect.iscoroutinefunction(original):
            kind = _A
        else:
            kind = _F
    if kind == _C:
        replacement = _fake_class(display, original)
    elif kind == "sqlite":
        replacement = _sqlite_connect(original)
    else:
        is_method = isinstance(parent, type) and not isinstance(static, (staticmethod, classmethod))
        replacement = _fake_callable(display, kind, original, is_method, labeler)
        if isinstance(static, staticmethod):
            replacement = staticmethod(replacement)
        elif isinstance(static, classmethod):
            inner = _fake_callable(display, kind, static.__func__, True, labeler)
            replacement = classmethod(inner)
    try:
        setattr(parent, name, replacement)
        _applied.add(key)
    except (AttributeError, TypeError):
        pass


def _apply_module(name):
    module = sys.modules.get(name)
    entries = _pending.get(name)
    if module is None or not entries:
        return
    STATE.bypass += 1
    try:
        for path, kind, display, labeler in entries:
            try:
                _apply_one(module, path, kind, display, labeler)
            except Exception:
                pass
    finally:
        STATE.bypass -= 1


class _PatchLoader(importlib.abc.Loader):
    def __init__(self, loader, name):
        self._loader = loader
        self._name = name

    def create_module(self, spec):
        return self._loader.create_module(spec)

    def exec_module(self, module):
        self._loader.exec_module(module)
        _apply_module(self._name)

    def __getattr__(self, item):
        return getattr(self._loader, item)


class _PatchFinder(importlib.abc.MetaPathFinder):
    """Applies patches as soon as a listed module finishes importing."""

    def find_spec(self, fullname, path, target=None):
        if fullname not in _pending or fullname in sys.modules:
            return None
        for finder in sys.meta_path:
            if finder is self or not hasattr(finder, "find_spec"):
                continue
            try:
                spec = finder.find_spec(fullname, path, target)
            except Exception:
                spec = None
            if spec is not None:
                if spec.loader is not None and hasattr(spec.loader, "exec_module"):
                    spec.loader = _PatchLoader(spec.loader, fullname)
                return spec
        return None


def _patch_environ():
    """A required environment variable that is not set (os.environ["KEY"])
    gets an invented value. Optional lookups (get, getenv, in) keep their
    real behaviour so that defaults still apply."""
    cls = type(os.environ)
    original = cls.__getitem__
    missing = object()

    def lookup(self, key):
        try:
            return original(self, key)
        except KeyError:
            return missing

    def __getitem__(self, key):
        value = lookup(self, key)
        if value is not missing:
            return value
        if not (STATE.armed or STATE.importing) or STATE.bypass or self is not os.environ:
            raise KeyError(key)
        text = "os.environ[%s]" % short(key)
        record_effect("faked", text)
        return str(Fake(text)._spotrun_need("str", "a required environment variable that is not set"))

    def get(self, key, default=None):
        value = lookup(self, key)
        return default if value is missing else value

    def __contains__(self, key):
        return lookup(self, key) is not missing

    def pop(self, key, *default):
        value = lookup(self, key)
        if value is missing:
            if default:
                return default[0]
            raise KeyError(key)
        del self[key]
        return value

    try:
        cls.__getitem__ = __getitem__
        cls.get = get
        cls.__contains__ = __contains__
        cls.pop = pop
    except (AttributeError, TypeError):
        pass


def add_patch(spec):
    """Register a patch given as 'module:attr.path' (from a blocked effect)."""
    if ":" not in spec:
        return
    module_name, path = spec.split(":", 1)
    display = "%s.%s" % (module_name.split(".")[-1], path)
    _pending.setdefault(module_name, []).append((path, "auto", display, None))
    _apply_module(module_name)


def install_strict():
    """Guard for running the user's own tests: nothing is faked, but real
    network connections, child processes and file changes outside scratch
    locations are refused, so a test whose mocks are incomplete fails
    instead of reaching the outside world."""
    global _ROOTS
    if STATE.installed:
        return
    STATE.installed = True
    _ROOTS = _allowed_roots()
    sys.dont_write_bytecode = True
    for module_name, entries in PATCHES.items():
        blocking = [entry for entry in entries if entry[1] == "block"]
        if blocking:
            _pending.setdefault(module_name, []).extend(blocking)
    sys.meta_path.insert(0, _PatchFinder())
    for module_name in list(_pending):
        if module_name in sys.modules:
            _apply_module(module_name)
    sys.addaudithook(_audit)


def install(in_scope, current_step, extra_patches=()):
    """Install the patch table, the import hook and the audit hook."""
    STATE.in_scope = in_scope
    STATE.current_step = current_step
    STATE.blocked = []
    STATE.effects = []
    STATE.files = {}
    STATE.dirs = set()
    STATE.removed = set()
    if STATE.installed:
        return
    STATE.installed = True
    # Resolve scratch locations now: tempfile probes the filesystem under a
    # lock the first time, which must not happen from inside a patched call.
    global _ROOTS
    _ROOTS = _allowed_roots()
    sys.dont_write_bytecode = True

    real_open = builtins.open
    replacement = _make_open(real_open)
    replacement.__spotrun_original__ = real_open
    builtins.open = replacement
    io.open = replacement

    _patch_environ()
    _install_virtual_view()

    for module_name, entries in PATCHES.items():
        _pending.setdefault(module_name, []).extend(entries)
    for spec in extra_patches:
        if ":" in spec:
            module_name, path = spec.split(":", 1)
            display = "%s.%s" % (module_name.split(".")[-1], path)
            _pending.setdefault(module_name, []).append((path, "auto", display, None))
    sys.meta_path.insert(0, _PatchFinder())
    for module_name in list(_pending):
        if module_name in sys.modules:
            _apply_module(module_name)
    sys.addaudithook(_audit)
