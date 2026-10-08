"""Drives the runtime the same way the extension does."""

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MAIN = os.path.join(HERE, "..", "python", "spotrun_main.py")
SAMPLES = os.path.join(HERE, "samples")
PREFIX = "\x1eSPOTRUN "


def run_once(request, llm=None, python=None, env=None):
    request = dict(request)
    request.setdefault("type", "start")
    request.setdefault("root", SAMPLES)
    request["llm"] = llm is not None
    full_env = dict(os.environ)
    full_env["PYTHONPATH"] = os.path.join(HERE, "libs")
    full_env.update(env or {})
    proc = subprocess.Popen(
        [python or sys.executable, MAIN],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=full_env,
    )
    proc.stdin.write((json.dumps(request) + "\n").encode())
    proc.stdin.flush()
    asked = []
    result = None
    stray = []
    for raw in proc.stdout:
        line = raw.decode("utf-8", "replace")
        if not line.startswith(PREFIX):
            stray.append(line)
            continue
        message = json.loads(line[len(PREFIX):])
        if message["type"] == "result":
            result = message
            break
        asked.append(message)
        reply = llm(message) if llm else {}
        proc.stdin.write((json.dumps(reply or {}) + "\n").encode())
        proc.stdin.flush()
    proc.stdin.close()
    stderr = proc.stderr.read().decode("utf-8", "replace")
    proc.wait(timeout=30)
    assert result is not None, "no result. stderr:\n%s\nstray:\n%s" % (stderr, "".join(stray))
    result["_asked"] = asked
    result["_stderr"] = stderr
    return result


def spot(sample, qualname, llm=None, max_attempts=4, **extra):
    """Run with the extension's retry loop (patch blocked effects, eager fakes)."""
    request = {"file": os.path.join(SAMPLES, sample), "qualname": qualname}
    request.update(extra)
    request.setdefault("extra_patches", [])
    request.setdefault("eager", [])
    request.setdefault("cache", {})
    seen = set()
    attempts = []
    for _ in range(max_attempts):
        result = run_once(request, llm)
        attempts.append(result)
        if result.get("fatal"):
            break
        for record in result.get("resolutions", []):
            if record["source"] == "llm" and record.get("expr"):
                request["cache"][record["key"]] = record["expr"]
        llm_args = {a["name"]: a["expr"] for a in result.get("args", []) if a.get("source") in ("llm", "cache") and a.get("expr")}
        if llm_args and request.get("args") is None:
            request["args"] = llm_args
        retry = result.get("retry")
        if not retry:
            break
        marker = json.dumps(retry, sort_keys=True)
        if marker in seen:
            break
        seen.add(marker)
        if retry.get("patch"):
            request["extra_patches"].append(retry["patch"])
        if retry.get("eager"):
            request["eager"].append(retry["eager"])
    result["_attempts"] = attempts
    result["_request"] = request
    return result


def locals_at_end(result, frame_id=0):
    """Final variable state of a frame, rebuilt from writes."""
    state = dict(result["frames"][frame_id]["args"])
    for step in result["steps"]:
        if step["f"] == frame_id and "w" in step:
            state.update(step["w"])
    return state


def lines(result, frame_id=0):
    return [s["l"] for s in result["steps"] if s["f"] == frame_id]
