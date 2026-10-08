"""JSON-lines channel between the runtime and the extension.

Protocol messages share stdout with nothing else: the runtime duplicates
the real stdout descriptor for itself and replaces ``sys.stdout`` with a
capture object, so prints from the function under test never corrupt the
stream. Every protocol line carries a prefix so that stray C-level writes
to descriptor 1 can still be told apart by the reader.
"""

import json
import os
import sys

PREFIX = "\x1eSPOTRUN "


class Channel:
    """Line-delimited JSON over the process's original stdin/stdout."""

    interactive = True

    def __init__(self):
        out_fd = os.dup(sys.__stdout__.fileno())
        self._out = os.fdopen(out_fd, "w", encoding="utf-8", newline="\n")
        self._in = sys.__stdin__.buffer

    def send(self, message):
        self._out.write(PREFIX + json.dumps(message, ensure_ascii=True, default=str) + "\n")
        self._out.flush()

    def recv(self):
        line = self._in.readline()
        if not line:
            raise EOFError("extension closed the channel")
        return json.loads(line.decode("utf-8"))

    def ask(self, message):
        self.send(message)
        return self.recv()


class NullChannel:
    """Used when the runtime is started from a request file (debug mode)."""

    interactive = False

    def send(self, message):
        pass

    def recv(self):
        raise EOFError("no channel")

    def ask(self, message):
        return {}


class Capture:
    """Replacement for sys.stdout / sys.stderr that records chunks with the
    index of the trace step that was current when they were written."""

    encoding = "utf-8"
    errors = "replace"

    limit = 200000
    _total = [0]

    def __init__(self, kind, sink, step_counter):
        self._kind = kind
        self._sink = sink
        self._steps = step_counter

    def write(self, text):
        if not isinstance(text, str):
            text = str(text)
        if text and Capture._total[0] < Capture.limit:
            Capture._total[0] += len(text)
            if Capture._total[0] >= Capture.limit:
                text += "\n... output truncated by Spot Run ...\n"
            self._sink.append([self._steps(), self._kind, text])
        return len(text)

    def writelines(self, lines):
        for line in lines:
            self.write(line)

    def flush(self):
        pass

    def isatty(self):
        return False

    def fileno(self):
        raise OSError("captured stream has no file descriptor")

    @property
    def buffer(self):
        return _BinaryCapture(self)


class _BinaryCapture:
    def __init__(self, text_capture):
        self._text = text_capture

    def write(self, data):
        self._text.write(bytes(data).decode("utf-8", "replace"))
        return len(data)

    def flush(self):
        pass
