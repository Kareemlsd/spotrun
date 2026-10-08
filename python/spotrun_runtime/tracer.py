"""Line-level recorder.

Records one step per executed line in the user's own code. Each step stores
only what the line changed (its writes), so the full variable state at any
step is rebuilt on the extension side by accumulating writes per frame.
That keeps traces small and makes stepping backwards free.
"""

import os
import sys

from .values import describe

_SKIP_NAMES = frozenset(["<module>", "<listcomp>", "<dictcomp>", "<setcomp>", "<genexpr>", "<lambda>"])
_SKIP_DIRS = frozenset(["site-packages", "dist-packages", "node_modules", "venv", "env", "__pypackages__", "build", "dist"])


def make_scope(root, target_file, mode):
    """Predicate deciding whether a source file counts as the user's code."""
    target = os.path.normcase(os.path.abspath(target_file))
    root = os.path.normcase(os.path.abspath(root)) if root else os.path.dirname(target)
    runtime = os.path.normcase(os.path.dirname(os.path.abspath(__file__)))
    cache = {}

    def check(filename):
        if not filename or filename.startswith("<"):
            return False
        full = os.path.normcase(os.path.abspath(filename))
        if full == target:
            return True
        if mode != "workspace":
            return False
        if full.startswith(runtime + os.sep) or not full.startswith(root + os.sep):
            return False
        parts = full[len(root) + 1 :].split(os.sep)[:-1]
        return not any(p in _SKIP_DIRS or p.startswith(".") for p in parts)

    def in_scope(filename):
        result = cache.get(filename)
        if result is None:
            result = cache[filename] = check(filename)
        return result

    return in_scope


class Recorder(object):
    def __init__(self, in_scope, limits, only_code=None):
        self.in_scope = in_scope
        self.only_code = only_code
        self.max_steps = int(limits.get("max_steps", 20000))
        self.max_line_hits = int(limits.get("max_line_hits", 200))
        self.limit = int(limits.get("max_repr", 200))
        self.files = []
        self._file_index = {}
        self.frames = []
        self.steps = []
        self.truncated = False
        self.skipped = 0
        self._by_frame = {}
        self._code_ok = {}
        self._hits = {}
        self._active = False

    # -- public -------------------------------------------------------------

    def step_count(self):
        return len(self.steps)

    def start(self):
        self._active = True
        sys.settrace(self._global)

    def stop(self):
        self._active = False
        sys.settrace(None)
        self._by_frame.clear()

    def export(self):
        return {
            "files": self.files,
            "frames": self.frames,
            "steps": self.steps,
            "truncated": self.truncated,
            "skipped": self.skipped,
        }

    # -- tracing ------------------------------------------------------------

    def _wanted(self, code):
        ok = self._code_ok.get(code)
        if ok is None:
            if self.only_code is not None:
                ok = code is self.only_code
            else:
                ok = code.co_name not in _SKIP_NAMES and self.in_scope(code.co_filename)
            self._code_ok[code] = ok
        return ok

    def _global(self, frame, event, arg):
        if event != "call" or not self._active:
            return None
        if not self._wanted(frame.f_code):
            return None
        state = self._by_frame.get(frame)
        if state is None:
            state = self._open_frame(frame)
        return self._local

    def _open_frame(self, frame):
        code = frame.f_code
        filename = code.co_filename
        index = self._file_index.get(filename)
        if index is None:
            index = self._file_index[filename] = len(self.files)
            self.files.append(os.path.abspath(filename))
        parent = -1
        depth = 0
        back = frame.f_back
        while back is not None:
            parent_state = self._by_frame.get(back)
            if parent_state is not None:
                parent = parent_state["rec"]["id"]
                depth = parent_state["rec"]["depth"] + 1
                break
            back = back.f_back
        rec = {
            "id": len(self.frames),
            "file": index,
            "name": getattr(code, "co_qualname", code.co_name),
            "line": code.co_firstlineno,
            "parent": parent,
            "depth": depth,
            "args": {},
        }
        self.frames.append(rec)
        state = {"rec": rec, "snap": {}, "last": None, "gap": 0, "raising": False}
        self._by_frame[frame] = state
        self._flush(state, frame)
        return state

    def _flush(self, state, frame):
        snap = state["snap"]
        writes = None
        limit = self.limit
        for name, value in frame.f_locals.items():
            if name.startswith("."):
                continue
            text = describe(value, limit)
            if snap.get(name) != text:
                snap[name] = text
                if writes is None:
                    writes = {}
                writes[name] = text
        if writes:
            last = state["last"]
            if last is None:
                state["rec"]["args"].update(writes)
            else:
                existing = last.get("w")
                if existing is None:
                    last["w"] = writes
                else:
                    existing.update(writes)

    def _local(self, frame, event, arg):
        state = self._by_frame.get(frame)
        if state is None or not self._active:
            return None
        if event == "line":
            state["raising"] = False
            key = (frame.f_code, frame.f_lineno)
            hits = self._hits.get(key, 0) + 1
            self._hits[key] = hits
            if hits > self.max_line_hits:
                state["gap"] += 1
                self.skipped += 1
                return self._local
            if len(self.steps) >= self.max_steps:
                self.truncated = True
                self._active = False
                sys.settrace(None)
                return None
            self._flush(state, frame)
            step = {"f": state["rec"]["id"], "l": frame.f_lineno}
            if state["gap"]:
                step["gap"] = state["gap"]
                state["gap"] = 0
            self.steps.append(step)
            state["last"] = step
        elif event == "return":
            self._flush(state, frame)
            last = state["last"]
            if last is not None and not state["raising"]:
                last["ret"] = describe(arg, self.limit)
                state["rec"]["ret"] = last["ret"]
            state["rec"]["end"] = len(self.steps)
        elif event == "exception":
            last = state["last"]
            exc_type, exc, _tb = arg
            if exc_type is not StopIteration and exc_type is not GeneratorExit:
                state["raising"] = True
                if last is not None:
                    try:
                        message = str(exc) if exc is not None else ""
                    except Exception:
                        message = ""
                    if len(message) > 300:
                        message = message[:297] + "..."
                    last["exc"] = "%s: %s" % (exc_type.__name__, message) if message else exc_type.__name__
        return self._local
