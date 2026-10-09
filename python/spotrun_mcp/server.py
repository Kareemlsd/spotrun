"""MCP server over stdio. Standard library only.

Messages are JSON-RPC 2.0, one per line on stdin and stdout. Nothing else may
be written to stdout, so ``sys.stdout`` is pointed at stderr for the lifetime
of the server and the protocol keeps its own handle.
"""

import atexit
import json
import sys
import time
import traceback

from . import __version__, report
from .engine import Engine, Question, ToolError

PROTOCOLS = ("2025-06-18", "2025-03-26", "2024-11-05")
PAUSE_LIMIT_SECONDS = 600
MAX_PAUSED = 8

INSTRUCTIONS = (
    "Spot Run executes one Python function of the project with invented inputs, inside a sandbox, with its external "
    "dependencies (HTTP, databases, files, subprocesses, cloud clients) replaced by fakes. Use it to check how a "
    "function behaves, for example right after changing it, without writing a test or touching real services. "
    "It reports the outcome, the lines that ran and did not run, and the values that were invented. Those values are "
    "plausible, not real: do not present a run as proof that the code works against real systems."
)

EXPRESSIONS = (
    "Each value is a single Python expression as a string, evaluated inside the function's module, so the module's own "
    "classes and imports can be used (for example \"Order(id=1, items=[])\"). Plain JSON values are accepted too. Use the "
    "bare name FAKE for a parameter that is a connection, session, client, open file or similar."
)

TOOLS = [
    {
        "name": "run_function",
        "description": (
            "Run one Python function with invented inputs and report what happened: the return value or the exception "
            "and its line, which lines ran and which did not, the final variables, and what was faked. Network, "
            "subprocesses and file changes do not really happen; calls to them return fakes whose values are invented "
            "only when the code uses them. Use this to check a function's behaviour, for instance after editing it. "
            "Pass `args` when you know what inputs you want to see. Without a configured small model the run can pause "
            "and ask you for a fake's value; answer with answer_value."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "file": {"type": "string", "description": "Path of the Python file, absolute or relative to the server's working directory."},
                "function": {"type": "string", "description": "Function name, or Class.method for a method."},
                "args": {
                    "type": "object",
                    "description": "Arguments by parameter name. " + EXPRESSIONS + " Leave out `self`. Parameters left out get their default or a guessed value.",
                    "additionalProperties": True,
                },
                "imports": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Import statements the argument expressions need beyond what the module already imports, such as \"from shop.models import Order\".",
                },
                "describe": {
                    "type": "string",
                    "description": "Plain words for the scenario, such as \"the API answers 404\". Used by the small model to invent the arguments and fake values. Ignored when no small model is configured.",
                },
                "values": {
                    "type": "string",
                    "enum": ["ask", "guess"],
                    "description": "\"ask\" (default): fake values come from the small model, or from you when none is configured. \"guess\": never ask, use simple guesses from names and types.",
                },
                "root": {"type": "string", "description": "Project folder used for imports. Default: the repository or project that contains the file."},
                "fresh": {"type": "boolean", "description": "Forget values remembered from earlier runs of this function."},
            },
            "required": ["file", "function"],
        },
    },
    {
        "name": "find_edge_cases",
        "description": (
            "Run one Python function on several named cases and report each outcome plus the lines no case reached. "
            "With a configured small model the cases are proposed for you. Otherwise pass `cases` yourself: the typical "
            "case, then one per branch, early return, boundary, empty input and failure the function can tell apart. "
            "Same sandbox and fakes as run_function."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "file": {"type": "string", "description": "Path of the Python file."},
                "function": {"type": "string", "description": "Function name, or Class.method."},
                "cases": {
                    "type": "array",
                    "description": "Cases to run. " + EXPRESSIONS,
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": {"type": "string", "description": "2 to 5 words naming what is special about the case."},
                            "args": {"type": "object", "additionalProperties": True},
                            "scenario": {"type": "string", "description": "One sentence on what the external dependencies do in this case, such as \"the query returns no rows\"."},
                        },
                        "required": ["title", "args"],
                    },
                },
                "max": {"type": "integer", "description": "Upper limit on the number of cases (default 10, at most 25)."},
                "values": {"type": "string", "enum": ["ask", "guess"]},
                "root": {"type": "string"},
                "fresh": {"type": "boolean"},
            },
            "required": ["file", "function"],
        },
    },
    {
        "name": "answer_value",
        "description": (
            "Continue a paused run by giving the value of a faked dependency. Only call this after run_function or "
            "find_edge_cases returned a run_id with a question."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "run_id": {"type": "string"},
                "value": {
                    "description": "A single Python expression as a string (preferably a literal), a plain JSON value, or FAKE to keep the object opaque.",
                },
            },
            "required": ["run_id", "value"],
        },
    },
]


class Server(object):
    def __init__(self, engine=None, stdin=None, stdout=None):
        self.engine = engine or Engine()
        self.stdin = stdin or sys.stdin.buffer
        self.stdout = stdout or sys.stdout.buffer
        self.paused = {}
        self.counter = 0
        atexit.register(self.close)

    # -------------------------------------------------------------- wire

    def send(self, message):
        self.stdout.write((json.dumps(message, ensure_ascii=False) + "\n").encode("utf-8"))
        self.stdout.flush()

    def serve(self):
        while True:
            raw = self.stdin.readline()
            if not raw:
                break
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except ValueError:
                self.send({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}})
                continue
            for item in message if isinstance(message, list) else [message]:
                reply = self.handle(item)
                if reply is not None:
                    self.send(reply)
        self.close()

    def handle(self, message):
        if not isinstance(message, dict):
            return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid request"}}
        method = message.get("method")
        if method is None or "id" not in message:
            return None  # a response or a notification: nothing to answer
        ident = message["id"]
        params = message.get("params") or {}
        try:
            if method == "initialize":
                wanted = params.get("protocolVersion")
                result = {
                    "protocolVersion": wanted if wanted in PROTOCOLS else PROTOCOLS[0],
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "spotrun", "title": "Spot Run", "version": __version__},
                    "instructions": INSTRUCTIONS + " " + self.engine.describe_setup(),
                }
            elif method == "ping":
                result = {}
            elif method == "tools/list":
                result = {"tools": TOOLS}
            elif method == "tools/call":
                result = self.call(params.get("name"), params.get("arguments") or {})
            elif method in ("resources/list", "prompts/list", "resources/templates/list"):
                result = {method.split("/")[0] if "templates" not in method else "resourceTemplates": []}
            else:
                return {"jsonrpc": "2.0", "id": ident, "error": {"code": -32601, "message": "Method not found: %s" % method}}
        except Exception:  # noqa: BLE001 - the server must keep serving
            return {"jsonrpc": "2.0", "id": ident, "error": {"code": -32603, "message": traceback.format_exc()[-2000:]}}
        return {"jsonrpc": "2.0", "id": ident, "result": result}

    # ------------------------------------------------------------- tools

    @staticmethod
    def _text(text, error=False):
        return {"content": [{"type": "text", "text": text}], "isError": bool(error)}

    def call(self, name, arguments):
        self.expire()
        try:
            if not isinstance(arguments, dict):
                raise ToolError("Tool arguments must be an object.")
            if name == "run_function":
                target = self.engine.prepare(arguments.get("file"), arguments.get("function"), arguments.get("root"))
                args = arguments.get("args")
                if args is not None and not isinstance(args, dict):
                    raise ToolError("`args` must be an object mapping parameter names to Python expressions.")
                from .prompts import expressions

                imports = [i for i in arguments.get("imports") or [] if isinstance(i, str)]
                flow = self.engine.run_flow(
                    target,
                    expressions(args, skip_self=True) if args is not None else None,
                    imports,
                    arguments.get("describe"),
                    arguments.get("values"),
                    bool(arguments.get("fresh")),
                )
                return self.advance(flow, None, first=True)
            if name == "find_edge_cases":
                target = self.engine.prepare(arguments.get("file"), arguments.get("function"), arguments.get("root"))
                cases = arguments.get("cases")
                if cases is not None and not isinstance(cases, list):
                    raise ToolError("`cases` must be a list.")
                flow = self.engine.cases_flow(target, cases, arguments.get("max"), arguments.get("values"), bool(arguments.get("fresh")))
                return self.advance(flow, None, first=True)
            if name == "answer_value":
                run_id = str(arguments.get("run_id") or "")
                entry = self.paused.pop(run_id, None)
                if entry is None:
                    raise ToolError(
                        "There is no paused run %r. Paused runs are dropped after %d minutes; start again with run_function."
                        % (run_id, PAUSE_LIMIT_SECONDS // 60)
                    )
                if "value" not in arguments:
                    self.paused[run_id] = entry
                    raise ToolError("`value` is required.")
                return self.advance(entry[0], arguments["value"], first=False, run_id=run_id)
            raise ToolError("Unknown tool: %s" % name)
        except ToolError as exc:
            return self._text(str(exc), error=True)

    def advance(self, flow, value, first, run_id=None):
        try:
            asked = next(flow) if first else flow.send(value)
        except StopIteration as done:
            return self._text(done.value)
        except ToolError:
            flow.close()
            raise
        if not isinstance(asked, Question):  # pragma: no cover - defensive
            flow.close()
            raise ToolError("Internal error: unexpected pause.")
        if run_id is None:
            self.counter += 1
            run_id = "run-%d" % self.counter
        self.paused[run_id] = (flow, time.monotonic())
        while len(self.paused) > MAX_PAUSED:
            oldest = min(self.paused, key=lambda k: self.paused[k][1])
            self.paused.pop(oldest)[0].close()
        return self._text(report.question(run_id, asked))

    def expire(self):
        now = time.monotonic()
        for run_id in [k for k, (_flow, since) in self.paused.items() if now - since > PAUSE_LIMIT_SECONDS]:
            self.paused.pop(run_id)[0].close()

    def close(self):
        for run_id in list(self.paused):
            try:
                self.paused.pop(run_id)[0].close()
            except Exception:  # noqa: BLE001
                pass


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if "--version" in argv:
        print("spotrun-mcp %s" % __version__)
        return 0
    if "--help" in argv or "-h" in argv:
        print(
            "spotrun-mcp %s: MCP server (stdio) that runs Python functions with invented inputs.\n\n"
            "Environment:\n"
            "  SPOTRUN_MODEL       small model that invents inputs and fake values (optional)\n"
            "  SPOTRUN_BASE_URL    its endpoint, any OpenAI-compatible URL (default: OpenAI, or Anthropic for claude models)\n"
            "  SPOTRUN_API_KEY     its key (falls back to OPENAI_API_KEY / ANTHROPIC_API_KEY)\n"
            "  SPOTRUN_PROVIDER    openai | anthropic\n"
            "  SPOTRUN_SANDBOX     required (default) | auto | off\n"
            "  SPOTRUN_PYTHON      interpreter with the project's dependencies\n"
            "  SPOTRUN_EXTRA_PATHS extra import folders, separated like PATH\n"
            "  SPOTRUN_TIMEOUT     seconds a run may take (default 30)" % __version__
        )
        return 0
    protocol_out = sys.stdout.buffer
    sys.stdout = sys.stderr
    Server(stdout=protocol_out).serve()
    return 0


if __name__ == "__main__":
    sys.exit(main())
