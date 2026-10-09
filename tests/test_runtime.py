import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from helper import SAMPLES, locals_at_end, lines, run_once, spot  # noqa: E402


def no_llm(message):
    return {}


# ---------------------------------------------------------------- pure code


def test_typed_function_traces_lines_and_writes():
    r = spot("pure.py", "total")
    assert r["return"] == "3.6"
    assert r["exception"] is None
    assert r["frames"][0]["args"] == {"prices": "[1.5, 1.5]", "tax": "0.2"}
    assert r["steps"][0] == {"f": 0, "l": 20, "w": {"subtotal": "0.0"}}
    assert r["steps"][-1]["ret"] == "3.6"
    assert locals_at_end(r)["result"].startswith("3.5999")


def test_dataclass_and_enum_arguments_and_step_into():
    r = spot("pure.py", "discount")
    assert r["frames"][0]["args"]["customer"].startswith("Customer(name=")
    assert "Tier.BASIC" in r["frames"][0]["args"]["customer"]
    assert [f["name"] for f in r["frames"]] == ["discount", "helper_apply"]
    assert r["frames"][1]["parent"] == 0 and r["frames"][1]["depth"] == 1
    assert r["return"] == r["frames"][1]["ret"]


def test_untyped_parameters_fall_back_to_names_then_fakes():
    r = spot("pure.py", "untyped")
    sources = {a["name"]: (a["source"], a["expr"]) for a in r["args"]}
    assert sources["items"] == ("heuristic", "[1, 2, 3]")
    assert sources["flag"] == ("heuristic", "True")
    assert sources["mystery"] == ("heuristic", "FAKE")
    assert r["return"] == "([2, 4, 6], 'got <mystery>')"
    assert [x["path"] for x in r["resolutions"]] == ["mystery"]
    assert r["resolutions"][0]["source"] == "heuristic"


def test_exception_is_reported_with_user_frames():
    r = spot("pure.py", "fails")
    assert r["exception"]["type"] == "IndexError"
    assert r["exception"]["frames"][-1]["text"] == "return values[n + 10]"
    assert r["steps"][-1]["exc"].startswith("IndexError")
    assert "ret" not in r["steps"][-1]
    assert r["retry"] is None


def test_long_loops_are_capped_but_finish():
    r = spot("pure.py", "long_loop")
    assert r["return"] == str(sum(range(5000)))
    assert len(r["steps"]) < 500
    assert r["skipped"] > 9000
    assert any("gap" in s for s in r["steps"])
    assert not r["truncated"]


def test_generator_is_consumed():
    r = spot("pure.py", "gen")
    assert r["return"] == "[0, 1, 4]"


def test_stdout_and_stderr_are_captured_with_step_index():
    r = spot("pure.py", "prints")
    kinds = [(k, t) for _, k, t in r["outputs"]]
    assert ("out", "hello") in kinds and ("err", "warn") in kinds
    assert r["outputs"][0][0] >= 1
    assert r["_stderr"] == ""


def test_method_builds_instance_through_constructor():
    r = spot("pure.py", "Basket.add")
    assert r["return"] == "1"
    self_arg = r["args"][0]
    assert self_arg["name"] == "self" and "constructor" in self_arg["note"]
    assert r["frames"][0]["args"]["self"].startswith("Basket(owner=")


def test_static_class_and_property():
    assert spot("pure.py", "Basket.static_sum")["return"] == "6"
    assert spot("pure.py", "Basket.make")["return"].startswith("Basket(owner=")
    assert spot("pure.py", "Basket.size")["return"] == "0"


def test_pins_override_arguments():
    r = spot("pure.py", "total", pins={"args": {"prices": "[10.0, 20.0]", "tax": "0.5"}})
    assert r["return"] == "45.0"
    assert {a["name"]: a["source"] for a in r["args"]} == {"prices": "pin", "tax": "pin"}


def test_bad_argument_expression_falls_back():
    r = spot("pure.py", "total", args={"prices": "undefined_name + 1"})
    entry = r["args"][0]
    assert entry["source"] == "heuristic" and "NameError" in entry["error"]
    assert r["return"] == "3.6"


def test_function_scope_does_not_step_into_helpers():
    r = spot("pure.py", "discount", scope="function")
    assert [f["name"] for f in r["frames"]] == ["discount"]


def test_package_relative_imports_and_cross_file_steps():
    r = spot(os.path.join("pkg", "core.py"), "quadruple")
    assert r["return"] == "12"
    assert len(r["files"]) == 2 and r["files"][1].endswith("util.py")
    assert [f["name"] for f in r["frames"]] == ["quadruple", "double", "double"]


def test_missing_function_is_a_fatal_message():
    r = spot("pure.py", "nope")
    assert "no attribute" in r["fatal"]


def test_numpy_argument_and_repr():
    r = spot("numeric.py", "normalise")
    assert r["frames"][0]["args"]["x"].startswith("ndarray(5,) float64 [0. 0.25")
    assert r["return"].startswith("ndarray(5,) float64")


# ------------------------------------------------------------------ effects


def test_http_call_is_faked_and_lazily_resolved_without_llm():
    r = spot("effects.py", "fetch_prices")
    assert r["exception"] is None
    assert r["blocked"] == []
    assert [e["what"] for e in r["effects"]] == ["requests.get('example base url/items')"] or r["effects"][0]["what"].startswith("requests.get(")
    paths = [x["path"] for x in r["resolutions"]]
    assert any(p.endswith(".json()['items']") for p in paths)
    assert r["return"].startswith("[")


def test_http_call_with_llm_values():
    asked = []

    def llm(message):
        asked.append(message)
        if message["type"] == "need_args":
            return {"args": {"base_url": "'https://shop.test'", "min_price": "10"}}
        if message["path"].endswith(".status_code"):
            return {"expr": "200"}
        if message["path"].endswith(".json()['items']"):
            return {"expr": "[{'name': 'pen', 'price': 2.5}, {'name': 'desk', 'price': 120.0}]"}
        return {}

    r = spot("effects.py", "fetch_prices", llm=llm)
    assert r["return"] == "['desk']"
    kinds = [m["type"] for m in asked]
    assert kinds[0] == "need_args" and kinds.count("need_value") == 2
    status = [m for m in asked if m.get("path", "").endswith(".status_code")][0]
    assert status["op"] == "eq" and "!= 200" in status["detail"]
    assert status["text"] == "if response.status_code != 200:"
    assert "requests.get('https://shop.test/items')" in status["path"]
    assert {x["source"] for x in r["resolutions"]} == {"llm"}

    # Second run from cache: the model is not asked again.
    cache = {x["key"]: x["expr"] for x in r["resolutions"]}
    args = {a["name"]: a["expr"] for a in r["args"]}
    again = run_once(
        {"file": os.path.join(SAMPLES, "effects.py"), "qualname": "fetch_prices", "cache": cache, "args": args},
        llm=lambda m: pytest.fail("model asked despite cache: %r" % (m,)),
    )
    assert again["return"] == "['desk']"
    assert {x["source"] for x in again["resolutions"]} == {"cache"}


def test_fake_pin_wins_over_cache_and_llm():
    def llm(message):
        if message["type"] == "need_args":
            return {"args": {"base_url": "'https://shop.test'"}}
        return {"expr": "200"} if message["path"].endswith("status_code") else {"expr": "[]"}

    pins = {"fakes": {"requests.get('https://shop.test/items').json()['items']": "[{'name': 'x', 'price': 9}]"}}
    r = spot("effects.py", "fetch_prices", llm=llm, pins=pins)
    assert r["return"] == "['x']"


def test_type_error_on_fake_triggers_eager_rerun():
    def llm(message):
        if message["type"] == "need_args":
            return {"args": {"url": "'https://api.test'"}}
        if message["op"] == "any" and message["path"].endswith(".text"):
            assert "json.loads" in message["detail"]
            return {"expr": "'{\"count\": 41}'"}
        return {}

    r = spot("effects.py", "parse_body", llm=llm)
    assert len(r["_attempts"]) == 2
    assert r["_attempts"][0]["exception"]["type"] == "TypeError"
    assert r["exception"] is None and r["return"] == "42"


def test_type_error_on_inline_fake_triggers_eager_line():
    def llm(message):
        if message["type"] == "need_args":
            return {"args": {"url": "'https://api.test'"}}
        if message["op"] == "any":
            return {"expr": "'{\"count\": 4}'"} if message["path"].endswith(".text") else {"expr": "FAKE"}
        return {}

    r = spot("effects.py", "parse_inline", llm=llm)
    assert r["exception"] is None and r["return"] == "8"


def test_file_writes_stay_in_memory(tmp_path):
    r = spot("effects.py", "write_report")
    assert r["exception"] is None
    assert r["return"] == repr("3\n3\n")
    assert not os.path.exists(os.path.join(SAMPLES, "reports_out"))
    whats = [e["what"] for e in r["effects"]]
    assert any(w.startswith("os.makedirs(") for w in whats)
    assert any(w.startswith("write ") for w in whats)
    assert any(w.startswith("os.remove(") for w in whats)
    # Written, read back, then deleted: nothing is left in the virtual view.
    assert r["written_files"] == []


def test_missing_file_read_is_faked():
    r = spot("effects.py", "read_config")
    assert r["exception"] is None
    assert r["return"] == "'<READ>'"
    r = spot("effects.py", "read_config", llm=lambda m: {"expr": "'debug = true'"} if m["type"] == "need_value" else {})
    assert r["return"] == "'DEBUG = TRUE'"


def test_subprocess_and_sleep_are_skipped():
    import time

    start = time.time()
    r = spot("effects.py", "shell")
    assert time.time() - start < 10
    assert r["exception"] is None
    assert any(e["what"].startswith("subprocess.run(") for e in r["effects"])


def test_raw_socket_is_blocked_and_reported():
    r = spot("effects.py", "raw_socket")
    assert r["exception"]["blocked"] is True
    assert "network connection" in r["exception"]["message"]
    assert r["blocked"][0]["target"] is None
    assert r["blocked"][0]["line"] == r["exception"]["frames"][-1]["line"]


def test_block_cannot_be_swallowed_by_except_exception():
    r = spot("effects.py", "swallow")
    assert r["exception"]["blocked"] is True


def test_blocked_library_call_is_patched_on_rerun():
    r = spot("effects.py", "via_library")
    assert len(r["_attempts"]) == 2
    first = r["_attempts"][0]
    assert first["exception"]["blocked"] and first["retry"] == {"patch": "fakelib:Client.fetch"}
    assert r["exception"] is None
    assert any(e["what"].startswith("fakelib.Client.fetch(") for e in r["effects"])


def test_constructor_with_side_effects_falls_back():
    r = spot("effects.py", "Service.lookup")
    assert r["exception"] is None
    assert any(e["what"].startswith("socket.create_connection(") for e in r["effects"])


def test_unconstructable_class_gets_lazy_instance():
    r = spot("effects.py", "Heavy.compute")
    assert r["exception"] is None
    assert "without running __init__" in r["args"][0]["note"]
    assert r["return"] == "4"


def test_required_env_var_is_invented_optional_keeps_default():
    r = spot("effects.py", "uses_env")
    assert r["exception"] is None, r["exception"]
    assert r["return"] == "('<SPOTRUN_MISSING_API_KEY>', 'eu-west-1', False, None)"
    r = spot("effects.py", "uses_env", llm=lambda m: {"expr": "'sk-test-123'"} if m["type"] == "need_value" else {})
    assert r["return"].startswith("('sk-test-123', 'eu-west-1'")


# ----------------------------------------------------------------- database


def test_sqlalchemy_session_parameter_is_a_fake():
    def llm(message):
        if message["type"] == "need_args":
            return {"args": {"session": "FAKE", "domain": "'@boskalis.com'"}}
        if message["op"] == "iter":
            assert "SELECT users.id" in message["path"]
            return {"expr": "[User(id=1, email='a@boskalis.com'), User(id=2, email='b@other.org')]"}
        return {}

    r = spot("db.py", "active_emails", llm=llm)
    assert r["exception"] is None, r["exception"]
    assert r["return"] == "['a@boskalis.com']"


def test_sqlalchemy_session_without_llm():
    r = spot("db.py", "active_emails")
    assert r["exception"] is None, r["exception"]
    assert r["blocked"] == []


def test_real_session_on_real_engine_is_intercepted():
    r = spot("db.py", "with_engine")
    assert r["exception"] is None, r["exception"]
    assert any(e["what"].startswith("session.scalar(") for e in r["effects"])
    assert not os.path.exists("/definitely/not/here/prod.db")


def test_sqlite_file_is_faked_memory_is_real():
    r = spot("db.py", "raw_sqlite")
    assert r["exception"] is None, r["exception"]
    assert any(e["what"].startswith("sqlite3.connect(") for e in r["effects"])
    r = spot("db.py", "memory_sqlite")
    assert r["return"] == "42" and r["effects"] == []


# -------------------------------------------------------------------- async


def test_async_function_with_httpx():
    def llm(message):
        if message["type"] == "need_args":
            return {"args": {"user_id": "7"}}
        return {"expr": "'Kareem'"}

    r = spot("asyncy.py", "fetch_user", llm=llm)
    assert r["exception"] is None, r["exception"]
    assert r["is_async"] and r["return"] == "'Kareem'"
    assert r["effects"][0]["what"] == "httpx.get('https://api.example.com/users/7')"


def test_async_generator():
    r = spot("asyncy.py", "agen")
    assert r["return"] == "[1, 2, 3]"


# ---------------------------------------------------------------- debug mode


def test_request_file_mode_runs_without_channel(tmp_path):
    import json
    import subprocess

    from helper import MAIN

    request = {"file": os.path.join(SAMPLES, "pure.py"), "qualname": "total", "root": SAMPLES, "pins": {"args": {"prices": "[1.0]"}}}
    path = tmp_path / "request.json"
    path.write_text(json.dumps(request))
    done = subprocess.run([sys.executable, MAIN, "--request", str(path)], capture_output=True, text=True, timeout=30)
    assert done.returncode == 0, done.stderr
    assert "Spot Run: total returned 1.2" in done.stdout


# ------------------------------------------------------------ write isolation


def _snapshot():
    return sorted(os.listdir(SAMPLES))


def test_common_writers_do_not_touch_the_workspace():
    before = _snapshot()
    r = spot("writers.py", "many_writers")
    assert _snapshot() == before
    assert r["exception"] is None, r["exception"]
    assert r["return"] == "['hello', (2, 1)]"
    assert len(r["written_files"]) >= 7
    whats = " | ".join(e["what"] for e in r["effects"])
    for expected in ("shutil.copy(", "os.rename(", "Path.mkdir(", "Path.unlink("):
        assert expected in whats, whats


def test_low_level_open_is_blocked():
    before = _snapshot()
    r = spot("writers.py", "low_level_write")
    assert _snapshot() == before
    assert r["exception"]["blocked"] is True
    assert "write to file" in r["exception"]["message"]


def test_temp_directory_is_left_alone():
    r = spot("writers.py", "temp_files_are_real")
    assert r["exception"] is None, r["exception"]
    assert r["return"] == "('real', False)"


# ---------------------------------------------------------------- imports


DEEP_ARGS = {
    "ledger": "Ledger({'EUR': 1.0, 'USD': 0.9})",
    "entries": "[{'ref': 'A-1', 'kind': 'invoice', 'amount': 100.0, 'currency': 'USD'}, {'ref': 'A-2', 'kind': 'transfer', 'amount': 40.0, 'currency': 'EUR'}]",
    "policy": "Policy(allowed=('invoice', 'refund'))",
}


def test_arguments_can_use_types_from_other_modules_through_imports():
    def llm(message):
        if message["type"] == "need_args":
            return {"args": DEEP_ARGS, "imports": ["from deep_models import Ledger, Policy"]}
        return {}

    r = spot("deep.py", "settle", llm=llm)
    assert r["exception"] is None, r["exception"]
    assert r["return"] == "(90.0, ['A-2'])"
    assert r["imports"] == ["from deep_models import Ledger, Policy"] and r["import_errors"] == []

    # Cached run: the imports travel with the request.
    again = run_once({"file": os.path.join(SAMPLES, "deep.py"), "qualname": "settle", "args": DEEP_ARGS, "imports": r["imports"]})
    assert again["return"] == "(90.0, ['A-2'])"


def test_without_the_import_the_expression_is_rejected_and_falls_back():
    r = spot("deep.py", "settle", args=DEEP_ARGS)
    assert "NameError" in r["args"][0]["error"]


def test_only_import_statements_are_accepted():
    marker = os.path.join(SAMPLES, "imports_ran.txt")
    r = spot("deep.py", "settle", args={}, imports=["open(%r, 'w').write('x')" % marker, "import no_such_module_xyz", "import json"])
    assert not os.path.exists(marker)
    assert len(r["import_errors"]) == 2
    assert "only import statements" in r["import_errors"][0] and "no_such_module_xyz" in r["import_errors"][1]


# ---------------------------------------------------------- project layouts


def test_package_without_init_files_supports_relative_imports():
    r = spot(os.path.join("layouts", "ns", "sub", "mod.py"), "f")
    assert r.get("fatal") is None, r.get("fatal")
    assert r["return"] == "6"


def test_source_root_below_the_workspace_is_found():
    # backend/ is the import root: the file says "from app.helpers import ...".
    r = spot(os.path.join("layouts", "backend", "app", "core.py"), "g")
    assert r.get("fatal") is None, r.get("fatal")
    assert r["return"] == "6"
    assert len(r["frames"]) == 2, "the helper in the sibling module is recorded too"


def test_required_env_var_read_at_import_is_invented():
    r = spot(os.path.join("layouts", "cfg", "settings.py"), "h")
    assert r.get("fatal") is None, r.get("fatal")
    assert r["return"] == "('<SPOTRUN_NOT_SET_KEY>', 3)"


def test_missing_dependency_is_explained_with_the_interpreter():
    r = spot(os.path.join("layouts", "missing.py"), "k")
    first = r["fatal"].splitlines()[0]
    assert first == "Importing missing.py failed: ModuleNotFoundError: No module named 'not_installed_pkg_xyz'"
    assert sys.executable in r["fatal"] and "spotrun.pythonPath" in r["fatal"]


def test_own_module_elsewhere_in_the_workspace_is_found():
    # sim/run.py imports sim_config, which lives in settings_dir/deep/.
    r = spot(os.path.join("layouts", "sim", "run.py"), "steps")
    assert r.get("fatal") is None, r.get("fatal")
    assert r["return"] == "1.5"


def test_module_outside_the_workspace_needs_extra_paths():
    sample = os.path.join("layouts", "sim", "uses_outside.py")
    r = spot(sample, "val")
    first = r["fatal"].splitlines()[0]
    assert first == "Importing uses_outside.py failed: ModuleNotFoundError: No module named 'outside_only_mod'"
    assert "spotrun.extraPaths" in r["fatal"]
    outside = os.path.join(os.path.dirname(SAMPLES), "libs", "outside_dir")
    r = spot(sample, "val", extra_paths=[outside])
    assert r.get("fatal") is None, r.get("fatal")
    assert r["return"] == "7"
    r = spot(sample, "val", extra_paths=[os.path.relpath(outside, SAMPLES)])
    assert r["return"] == "7", "paths relative to the workspace folder work too"


# ------------------------------------------------- guarded test verification


def _guarded_pytest(tmp_path, body, k=None):
    import subprocess

    from helper import MAIN

    (tmp_path / "mod.py").write_text("import socket\n\n\ndef fetch(host):\n    s = socket.socket()\n    s.connect((host, 9))\n    return 1\n\n\ndef add(a, b):\n    return a + b\n")
    test_file = tmp_path / "test_mod.py"
    test_file.write_text(body)
    command = [sys.executable, MAIN, "--pytest", str(test_file), "--root", str(tmp_path)]
    if k:
        command += ["-k", k]
    done = subprocess.run(command, capture_output=True, text=True, timeout=60)
    return done.stdout + done.stderr


def test_written_tests_run_under_a_guard_that_refuses_real_effects(tmp_path):
    body = (
        "from unittest import mock\n"
        "from mod import add, fetch\n\n\n"
        "def test_add():\n    assert add(1, 2) == 3\n\n\n"
        "def test_fetch_mocked():\n"
        "    with mock.patch('mod.socket.socket') as sock:\n        assert fetch('db.internal') == 1\n    sock.return_value.connect.assert_called_once()\n\n\n"
        "def test_fetch_unmocked():\n    assert fetch('10.255.255.1') == 1\n\n\n"
        "def test_writes_outside_scratch():\n    open(LEFT_BEHIND, 'w').write('x')\n\n\n"
        "def test_tmp_path_is_fine(tmp_path):\n    (tmp_path / 'ok.txt').write_text('x')\n"
    )
    body = body.replace("LEFT_BEHIND", repr(os.path.join(SAMPLES, "left_behind.txt")))
    out = _guarded_pytest(tmp_path, body)
    assert "SPOTRUN_PYTEST_EXIT 1" in out, out
    assert "3 passed" in out and "2 failed" in out, out
    assert "test_fetch_unmocked" in out and "blocked a real side effect: network connection" in out
    assert not os.path.exists(os.path.join(SAMPLES, "left_behind.txt"))

    out = _guarded_pytest(tmp_path, body, k="test_add or test_fetch_mocked")
    assert "SPOTRUN_PYTEST_EXIT 0" in out and "2 passed" in out, out


def test_result_names_the_module_for_test_imports():
    assert spot("pure.py", "total")["module"] == "pure"
    assert spot(os.path.join("pkg", "core.py"), "quadruple")["module"] == "pkg.core"
