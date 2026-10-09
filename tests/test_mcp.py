"""Drives the MCP server over stdio the way an agent's client does."""

import json
import os
import re
import shutil
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
PYTHON_DIR = os.path.join(HERE, "..", "python")
SAMPLES = os.path.join(HERE, "samples")
sys.path.insert(0, PYTHON_DIR)

from spotrun_mcp import prompts, source  # noqa: E402
from spotrun_mcp.model import from_environment  # noqa: E402


class Client(object):
    def __init__(self, env=None, cwd=None):
        full = {k: v for k, v in os.environ.items() if not k.startswith("SPOTRUN_")}
        full["PYTHONPATH"] = os.pathsep.join([PYTHON_DIR, os.path.join(HERE, "libs")])
        full["SPOTRUN_SANDBOX"] = "auto"
        full["SPOTRUN_PYTHON"] = sys.executable
        full.update(env or {})
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "spotrun_mcp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=full, cwd=cwd or SAMPLES
        )
        self.ident = 0
        self.initialized = self.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "0"}})
        self.notify("notifications/initialized")

    def write(self, message):
        self.proc.stdin.write((json.dumps(message) + "\n").encode())
        self.proc.stdin.flush()

    def notify(self, method, params=None):
        self.write({"jsonrpc": "2.0", "method": method, "params": params or {}})

    def rpc(self, method, params=None):
        self.ident += 1
        self.write({"jsonrpc": "2.0", "id": self.ident, "method": method, "params": params or {}})
        line = self.proc.stdout.readline()
        assert line, "server closed: %s" % self.proc.stderr.read().decode()
        reply = json.loads(line)
        assert reply["id"] == self.ident
        return reply

    def call(self, name, **arguments):
        reply = self.rpc("tools/call", {"name": name, "arguments": arguments})
        result = reply["result"]
        assert [part["type"] for part in result["content"]] == ["text"]
        return result["content"][0]["text"], result["isError"]

    def ok(self, name, **arguments):
        text, error = self.call(name, **arguments)
        assert not error, text
        return text

    def fails(self, name, **arguments):
        text, error = self.call(name, **arguments)
        assert error, text
        return text

    def close(self):
        self.proc.stdin.close()
        self.proc.wait(timeout=10)
        self.proc.stdout.close()
        self.proc.stderr.close()


@pytest.fixture
def client():
    made = []

    def make(env=None, cwd=None):
        made.append(Client(env, cwd))
        return made[-1]

    yield make
    for one in made:
        one.close()


class ScriptedModel(object):
    """A local chat completions endpoint that answers from a function of the prompt."""

    def __init__(self, reply):
        self.requests = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                prompt = body["messages"][0]["content"]
                outer.requests.append({"path": self.path, "headers": dict(self.headers), "body": body, "prompt": prompt})
                answer = reply(prompt)
                if answer is None:
                    self.send_response(500)
                    self.end_headers()
                    self.wfile.write(b"scripted failure")
                    return
                if self.path.endswith("/messages"):
                    payload = {"content": [{"type": "text", "text": answer}]}
                else:
                    payload = {"choices": [{"message": {"role": "assistant", "content": answer}}]}
                data = json.dumps(payload).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = "http://127.0.0.1:%d/v1" % self.server.server_address[1]

    def env(self, **extra):
        env = {"SPOTRUN_MODEL": "tiny-test", "SPOTRUN_BASE_URL": self.url, "SPOTRUN_API_KEY": "sk-test-secret"}
        env.update(extra)
        return env

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def scripted():
    made = []

    def make(reply):
        made.append(ScriptedModel(reply))
        return made[-1]

    yield make
    for one in made:
        one.close()


def prices_model(prompt):
    if '{"cases"' in prompt:
        return json.dumps(
            {
                "cases": [
                    {"title": "Two cheap items", "args": {"base_url": "'https://shop.test'", "min_price": 2.0}},
                    {"title": "API answers 500", "args": {"base_url": "'https://shop.test'"}, "scenario": "the HTTP request answers 500"},
                ]
            }
        )
    if '{"args"' in prompt:
        low = "min_price" in prompt and "nothing is cheap" in prompt
        return "```json\n%s\n```" % json.dumps({"args": {"base_url": "'https://shop.test'", "min_price": "100.0" if low else "2.0"}})
    path = re.search(r"Expression that needs a value: `(.*)`", prompt).group(1)
    if path.endswith("status_code"):
        return json.dumps({"value": "500" if "answers 500" in prompt else "200"})
    if path.endswith("['items']"):
        return json.dumps({"value": [{"name": "pen", "price": 3.0}, {"name": "ink", "price": 1.0}]})
    return json.dumps({"value": "FAKE"})


# ------------------------------------------------------------- protocol


def test_handshake_lists_the_tools(client):
    c = client()
    result = c.initialized["result"]
    assert result["protocolVersion"] == "2025-06-18"
    assert result["serverInfo"]["name"] == "spotrun"
    assert result["capabilities"] == {"tools": {}}
    assert "No small model is configured" in result["instructions"]
    tools = c.rpc("tools/list")["result"]["tools"]
    assert [t["name"] for t in tools] == ["run_function", "find_edge_cases", "answer_value"]
    for tool in tools:
        assert tool["inputSchema"]["type"] == "object" and tool["description"]
    assert c.rpc("ping")["result"] == {}
    assert c.rpc("no/such")["error"]["code"] == -32601


def test_older_protocol_is_echoed_and_unknown_falls_back(client):
    c = client()
    assert c.rpc("initialize", {"protocolVersion": "2024-11-05"})["result"]["protocolVersion"] == "2024-11-05"
    assert c.rpc("initialize", {"protocolVersion": "1999-01-01"})["result"]["protocolVersion"] == "2025-06-18"


def test_garbage_on_stdin_does_not_stop_the_server(client):
    c = client()
    c.proc.stdin.write(b"this is not json\n")
    c.proc.stdin.flush()
    assert json.loads(c.proc.stdout.readline())["error"]["code"] == -32700
    assert c.rpc("ping")["result"] == {}


# ------------------------------------------------------- agent-given args


def test_run_with_given_arguments(client):
    text = client().ok("run_function", file="pure.py", function="total", args={"prices": "[10.0, 5.0]", "tax": 0.1})
    assert "Outcome: returned 16.5" in text
    assert "prices = [10.0, 5.0]  [given]" in text
    assert "Every statement of the function ran." in text
    assert "subtotal = 15.0" in text
    assert "values from you" in text


def test_lines_that_did_not_run_are_listed_with_their_text(client):
    text = client().ok("run_function", file="pure.py", function="discount", args={"customer": "Customer(name='a', tier=Tier.GOLD, age=70)", "amount": 100})
    assert "Outcome: returned 80.0" in text
    assert "Lines that ran: 28-29, 34" in text
    assert "  31: rate = 0.1" in text and "  33: rate = 0.0" in text


def test_exception_is_reported_with_its_line(client):
    text = client().ok("run_function", file="pure.py", function="fails", args={"n": 1})
    assert "Outcome: raised IndexError: list index out of range" in text
    assert "at line 53 in fails: return values[n + 10]" in text


def test_method_and_printed_output(client):
    c = client()
    text = c.ok("run_function", file="pure.py", function="Basket.add", args={"item": "'pen'", "qty": 2})
    assert "Basket.add in " in text and "pure.py (line 81)" in text and "Outcome: returned" in text
    assert "Printed output:" in c.ok("run_function", file="pure.py", function="prints", args={"name": "'Ada'"})


def test_rejected_expression_is_reported(client):
    text = client().ok("run_function", file="pure.py", function="total", args={"prices": "[1, 2]", "tax": "nope("})
    assert "! tax: the expression nope( was rejected (SyntaxError" in text


def test_imports_for_argument_expressions(client):
    c = client()
    assert "NameError" in c.ok("run_function", file="pure.py", function="total", args={"prices": "[float(Fraction(1, 2))]"})
    text = c.ok("run_function", file="pure.py", function="total", args={"prices": "[float(Fraction(1, 2))]"}, imports=["from fractions import Fraction"])
    assert "Outcome: returned 0.6" in text and "NameError" not in text


def test_bad_requests_are_tool_errors_not_crashes(client):
    c = client()
    assert "No function 'nope'" in c.fails("run_function", file="pure.py", function="nope")
    assert "Functions in this file: total, discount" in c.fails("run_function", file="pure.py", function="nope")
    assert "File not found" in c.fails("run_function", file="nowhere.py", function="f")
    assert "`file` is required" in c.fails("run_function", function="f")
    assert "must be an object" in c.fails("run_function", file="pure.py", function="total", args=[1])
    assert "Unknown tool" in c.fails("launch_rockets")
    assert "no paused run" in c.fails("answer_value", run_id="run-99", value=1)
    assert c.rpc("ping")["result"] == {}


def test_syntax_error_in_the_file(client, tmp_path):
    (tmp_path / "broken.py").write_text("def f(:\n    pass\n")
    assert "syntax error on line 1" in client().fails("run_function", file=str(tmp_path / "broken.py"), function="f")


def test_import_failure_is_explained(client):
    text = client().ok("run_function", file="layouts/missing.py", function=source.function_names(open(os.path.join(SAMPLES, "layouts", "missing.py")).read())[0])
    assert "Could not run:" in text and "SPOTRUN_PYTHON" in text


# --------------------------------------------------- the agent as the model


def run_id_of(text):
    return re.search(r"run_id: (\S+)", text).group(1)


def test_run_pauses_for_fake_values_and_continues(client):
    c = client()
    text = c.ok("run_function", file="effects.py", function="fetch_prices", args={"base_url": "'https://x.test'"})
    assert "The run is paused" in text
    assert "Expression: requests.get('https://x.test/items').status_code" in text
    assert "Used at line 12: if response.status_code != 200:" in text
    text = c.ok("answer_value", run_id=run_id_of(text), value=200)
    assert "The run is paused" in text and ".json()['items']" in text
    assert "Values you already gave in this run:" in text
    text = c.ok("answer_value", run_id=run_id_of(text), value=[{"name": "pen", "price": 9.5}, {"name": "ink", "price": 1.0}])
    assert "Outcome: returned ['pen']" in text
    assert ".status_code = 200  [you, line 12, eq]" in text
    assert "requests.get('https://x.test/items') (faked)" in text
    assert "2 value questions" in text
    # The same run again reuses the answers instead of asking.
    again = c.ok("run_function", file="effects.py", function="fetch_prices", args={"base_url": "'https://x.test'"})
    assert "Outcome: returned ['pen']" in again and "The run is paused" not in again
    # ... unless asked to start fresh.
    assert "The run is paused" in c.ok("run_function", file="effects.py", function="fetch_prices", args={"base_url": "'https://x.test'"}, fresh=True)


def test_an_answer_can_send_the_run_down_another_branch(client):
    c = client()
    text = c.ok("run_function", file="effects.py", function="fetch_prices", args={"base_url": "'https://x.test'"})
    text = c.ok("answer_value", run_id=run_id_of(text), value="404")
    assert "Outcome: returned []" in text
    assert "  14: data = response.json()" in text


def test_a_paused_run_can_only_be_answered_once(client):
    c = client()
    first = run_id_of(c.ok("run_function", file="effects.py", function="fetch_prices", args={"base_url": "'https://x.test'"}))
    c.ok("answer_value", run_id=first, value="404")
    assert "no paused run" in c.fails("answer_value", run_id=first, value="404")


def test_guess_mode_never_pauses(client):
    text = client().ok("run_function", file="effects.py", function="fetch_prices", values="guess")
    assert "The run is paused" not in text
    assert "base_url = 'https://example.com/api'  [guessed]" in text
    assert "values guessed without a model" in text


def test_missing_arguments_are_guessed_and_said_so(client):
    text = client().ok("run_function", file="pure.py", function="total")
    assert "No `args` were given" in text and "[guessed]" in text


def test_describe_without_a_model_is_flagged(client):
    text = client().ok("run_function", file="pure.py", function="total", describe="empty list")
    assert "`describe` was ignored" in text


def test_question_limit_then_guesses(client):
    c = client({"SPOTRUN_MAX_QUESTIONS": "1"})
    text = c.ok("run_function", file="effects.py", function="fetch_prices", args={"base_url": "'https://x.test'"})
    text = c.ok("answer_value", run_id=run_id_of(text), value=200)
    assert "The run is paused" not in text
    assert "After 1 questions the remaining fake values were guessed." in text


def test_cases_from_the_agent(client):
    c = client()
    text = c.ok(
        "find_edge_cases",
        file="pure.py",
        function="discount",
        cases=[
            {"title": "Gold customer", "args": {"customer": "Customer(name='a', tier=Tier.GOLD, age=30)", "amount": 100}},
            {"title": "Basic and young", "args": {"customer": "Customer(name='a', tier=Tier.BASIC, age=30)", "amount": 100}},
        ],
    )
    assert "pure.py (line 27): 2 cases" in text
    assert "1. Gold customer" in text and "outcome: returned 80.0" in text
    assert "2. Basic and young" in text and "outcome: returned 100.0" in text
    assert "Lines no case reached:" in text and "  31: rate = 0.1" in text
    assert "  33: rate = 0.0" not in text


def test_cases_without_a_model_need_cases(client):
    c = client()
    assert "the cases have to come from you" in c.fails("find_edge_cases", file="pure.py", function="discount")
    assert "no usable case" in c.fails("find_edge_cases", file="pure.py", function="discount", cases=["x"])


def test_cases_can_pause_too(client):
    c = client()
    text = c.ok(
        "find_edge_cases",
        file="effects.py",
        function="fetch_prices",
        cases=[
            {"title": "Server error", "args": {"base_url": "'https://x.test'"}, "scenario": "the request answers 500"},
            {"title": "No arguments needed", "args": {"base_url": "'https://y.test'", "min_price": 0}},
        ],
    )
    assert "Case: Server error (the request answers 500)" in text
    text = c.ok("answer_value", run_id=run_id_of(text), value=500)
    assert "Case: No arguments needed" in text
    text = c.ok("answer_value", run_id=run_id_of(text), value=200)
    text = c.ok("answer_value", run_id=run_id_of(text), value="[{'name': 'pen', 'price': 1}]")
    assert "1. Server error" in text and "outcome: returned []" in text
    assert "outcome: returned ['pen']" in text
    assert "Together the cases ran every statement of the function." in text


# ------------------------------------------------------ a configured model


def test_small_model_invents_arguments_and_values(client, scripted):
    model = scripted(prices_model)
    c = client(model.env())
    assert "A small model is configured (tiny-test (127.0.0.1" in c.initialized["result"]["instructions"]
    text = c.ok("run_function", file="effects.py", function="fetch_prices")
    assert "Outcome: returned ['pen']" in text
    assert "base_url = 'https://shop.test'  [model]" in text
    assert ".status_code = 200  [model, line 12, eq]" in text
    assert "values from tiny-test (127.0.0.1" in text and "The run is paused" not in text
    first = model.requests[0]
    assert first["path"] == "/v1/chat/completions"
    assert first["headers"]["Authorization"] == "Bearer sk-test-secret"
    assert first["body"]["model"] == "tiny-test"
    assert "Function to run: `fetch_prices`" in first["prompt"] and "- base_url: str (required)" in first["prompt"]
    assert "for item in data[\"items\"]:" in model.requests[-1]["prompt"]
    assert len(model.requests) == 3
    # A second run is free: arguments and values are remembered.
    assert "Outcome: returned ['pen']" in c.ok("run_function", file="effects.py", function="fetch_prices")
    assert len(model.requests) == 3


def test_describe_reaches_the_model(client, scripted):
    model = scripted(prices_model)
    text = client(model.env()).ok("run_function", file="effects.py", function="fetch_prices", describe="nothing is cheap enough")
    assert "min_price = 100.0  [model]" in text and "Outcome: returned []" in text
    assert '"""nothing is cheap enough"""' in model.requests[0]["prompt"]
    assert '"""nothing is cheap enough"""' in model.requests[1]["prompt"]


def test_given_arguments_skip_the_argument_call(client, scripted):
    model = scripted(prices_model)
    text = client(model.env()).ok("run_function", file="effects.py", function="fetch_prices", args={"base_url": "'https://mine.test'"})
    assert "base_url = 'https://mine.test'  [given]" in text
    assert all('{"args"' not in r["prompt"] for r in model.requests) and len(model.requests) == 2


def test_model_proposes_edge_cases(client, scripted):
    model = scripted(prices_model)
    text = client(model.env()).ok("find_edge_cases", file="effects.py", function="fetch_prices", max=5)
    assert "2 cases, proposed by the model" in text
    assert "1. Two cheap items" in text and "outcome: returned ['pen']" in text
    assert "2. API answers 500" in text and "scenario: the HTTP request answers 500" in text and "outcome: returned []" in text
    assert "Together the cases ran every statement of the function." in text
    assert "Give at most 5 cases" in model.requests[0]["prompt"]


def test_model_failure_falls_back_to_guesses(client, scripted):
    model = scripted(lambda prompt: None)
    text = client(model.env()).ok("run_function", file="effects.py", function="fetch_prices")
    assert "Arguments were guessed because the model call failed: tiny-test" in text and "HTTP 500" in text
    assert "Outcome: returned" in text
    assert len(model.requests) == 3, "stops calling after three failures in a row"
    assert "The model call for the edge cases failed" in client(model.env()).fails("find_edge_cases", file="pure.py", function="total")


def test_unusable_model_reply(client, scripted):
    model = scripted(lambda prompt: "I am sorry, I cannot do that.")
    c = client(model.env())
    assert "was not usable" in c.ok("run_function", file="pure.py", function="total")
    assert "did not return usable edge cases" in c.fails("find_edge_cases", file="pure.py", function="total")


def test_anthropic_request_shape(client, scripted):
    model = scripted(prices_model)
    env = model.env(SPOTRUN_PROVIDER="anthropic", SPOTRUN_BASE_URL=model.url[: -len("/v1")])
    assert "Outcome: returned ['pen']" in client(env).ok("run_function", file="effects.py", function="fetch_prices")
    first = model.requests[0]
    assert first["path"] == "/v1/messages"
    headers = {name.lower(): value for name, value in first["headers"].items()}
    assert headers["x-api-key"] == "sk-test-secret" and headers["anthropic-version"]
    assert first["body"]["max_tokens"] > 0


def test_model_settings_do_not_reach_the_function(client, scripted, tmp_path):
    (tmp_path / "leak.py").write_text("import os\n\n\ndef leak():\n    return sorted(k for k in os.environ.keys() if k.startswith('SPOTRUN_'))\n")
    model = scripted(prices_model)
    text = client(model.env()).ok("run_function", file=str(tmp_path / "leak.py"), function="leak")
    assert "sk-test-secret" not in text
    for name in ("SPOTRUN_API_KEY", "SPOTRUN_MODEL", "SPOTRUN_BASE_URL"):
        assert name not in text


def test_model_configuration_from_environment():
    assert from_environment({}) is None
    openai = from_environment({"SPOTRUN_MODEL": "gpt-x", "OPENAI_API_KEY": "k1"})
    assert (openai.provider, openai.base_url, openai.key) == ("openai", "https://api.openai.com/v1", "k1")
    claude = from_environment({"SPOTRUN_MODEL": "claude-haiku", "ANTHROPIC_API_KEY": "k2"})
    assert (claude.provider, claude.base_url, claude.key) == ("anthropic", "https://api.anthropic.com", "k2")
    local = from_environment({"SPOTRUN_MODEL": "qwen", "SPOTRUN_BASE_URL": "http://localhost:11434/v1/"})
    assert (local.provider, local.base_url, local.key) == ("openai", "http://localhost:11434/v1", "")


# ------------------------------------------------------------------ sandbox


@pytest.mark.skipif(not sys.platform.startswith("linux") or not shutil.which("bwrap"), reason="needs bubblewrap")
def test_runs_inside_the_sandbox_by_default(client, tmp_path):
    (tmp_path / "net.py").write_text(
        "import ctypes, os\n\n\ndef raw_write(path: str):\n"
        "    libc = ctypes.CDLL(None, use_errno=True)\n"
        "    fd = libc.open(path.encode(), 0o101, 0o644)\n"
        "    return fd\n"
    )
    target = tmp_path / "escaped.txt"
    c = client({"SPOTRUN_SANDBOX": "required"})
    text = c.ok("run_function", file=str(tmp_path / "net.py"), function="raw_write", args={"path": json.dumps(str(target))})
    assert "OS sandbox (bubblewrap)" in text
    assert "Outcome: returned -1" in text, "a write that bypasses Python is refused by the operating system"
    assert not target.exists()


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="simulates a Linux machine without bubblewrap")
def test_refuses_to_run_without_a_sandbox_by_default(client, tmp_path):
    c = client({"SPOTRUN_SANDBOX": "required", "PATH": str(tmp_path)})
    text = c.fails("run_function", file="pure.py", function="total")
    assert "Refusing to run without an OS sandbox: bubblewrap (bwrap) is not installed" in text
    assert "SPOTRUN_SANDBOX=auto" in text
    relaxed = client({"SPOTRUN_SANDBOX": "auto", "PATH": str(tmp_path)})
    assert "guard only, no OS sandbox" in relaxed.ok("run_function", file="pure.py", function="total")


def test_timeout_stops_a_run(client, tmp_path):
    (tmp_path / "slow.py").write_text("def spin():\n    while True:\n        pass\n")
    text = client({"SPOTRUN_TIMEOUT": "2"}).fails("run_function", file=str(tmp_path / "slow.py"), function="spin")
    assert "stopped after 2 s" in text


# --------------------------------------------------------------- units


def test_interpreter_choice_skips_the_servers_own_environment(tmp_path, monkeypatch):
    from spotrun_mcp import engine

    def interpreter(*parts):
        path = tmp_path.joinpath(*parts)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("#!/bin/sh\n")
        path.chmod(0o755)
        return str(path)

    own = interpreter("own", "bin", "python3")
    interpreter("own", "bin", "python")
    system = interpreter("system", "bin", "python3")
    project = tmp_path / "project"
    project.mkdir()
    monkeypatch.setattr(engine.sys, "prefix", str(tmp_path / "own"))
    env = {"PATH": os.pathsep.join([os.path.dirname(own), os.path.dirname(system)]), "VIRTUAL_ENV": str(tmp_path / "own")}
    assert engine.find_python(str(project), env) == system
    venv = interpreter("project", ".venv", "bin", "python")
    assert engine.find_python(str(project), env) == venv
    assert engine.find_python(str(project), dict(env, SPOTRUN_PYTHON=own)) == own
    with pytest.raises(engine.ToolError):
        engine.find_python(str(project), dict(env, SPOTRUN_PYTHON="/no/such/python"))


def test_reply_parsing():
    assert prompts.parse_args_reply('Sure:\n```json\n{"args": {"a": "[1]", "b": 2, "c": null, "d": {"k": true}}}\n```') == {
        "a": "[1]",
        "b": "2",
        "c": "None",
        "d": '{"k": True}',
    }
    assert prompts.parse_value_reply('{"value": [1, "x"]}') == '[1, "x"]'
    assert prompts.parse_value_reply("no json here") is None
    cases = prompts.clean_cases([{"title": "1. Empty", "args": {"self": "x", "a": 1}}, {"title": "empty", "args": {}}, "junk", {"title": "bad", "args": 3}], 10)
    assert [c["title"] for c in cases] == ["Empty", "empty (2)"]
    assert cases[0]["args"] == {"a": "1"}


def test_function_lookup_and_statement_lines():
    text = (
        "class A:\n"
        "    @staticmethod\n"
        "    def f(x):\n"
        '        """doc"""\n'
        "        if x:\n"
        "            return 1\n"
        "        try:\n"
        "            y = 2\n"
        "        except ValueError:\n"
        "            y = 3\n"
        "        def inner():\n"
        "            return 9\n"
        "        return y\n"
    )
    found = source.find_function(text, "A.f")
    assert (found.start, found.end, found.class_name) == (2, 13, "A")
    assert found.statement_lines() == {5, 6, 7, 8, 10, 11, 13}
    assert source.find_function(text, "A") is None and source.find_function(text, "A.g") is None
    assert source.enclosing_source(text, 12).startswith("        def inner():")
