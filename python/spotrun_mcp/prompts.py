"""Prompts for the small model and parsers for its replies.

These mirror src/core/prompts.ts in the VS Code extension. A change to the
wording there should be made here too.
"""

import json
import math
import re

HELPERS = "datetime, date, timedelta, timezone, Decimal, Path, UUID, math, json, re, np (numpy), pd (pandas)"


def _scenario(instructions, for_value):
    if not instructions:
        return []
    latest = instructions[-1]
    earlier = instructions[:-1]
    if for_value:
        lines = ["The user described the scenario this run should test. Where it says something about this value, follow it:"]
    else:
        lines = [
            "The user described the inputs to test with. Follow the description exactly; "
            "it takes priority over the rules about the main path and realistic defaults:"
        ]
    if earlier:
        lines.append("Earlier requests, still in force unless the latest one changes them:")
        lines.extend("- %s" % text for text in earlier)
        lines.append("Latest request:")
    lines.extend(['"""%s"""' % latest, ""])
    return lines


def build_args_prompt(relative_path, qualname, context, need, instructions=None):
    params = []
    for p in need.get("params") or []:
        if p.get("kind") in ("VAR_POSITIONAL", "VAR_KEYWORD"):
            continue
        kind = ": %s" % p["annotation"] if p.get("annotation") else ""
        if p.get("is_self"):
            params.append("- %s (the %s instance the method runs on; optional)" % (p["name"], need.get("class_name") or "class"))
        elif p.get("has_default"):
            params.append("- %s%s (optional, default %s)" % (p["name"], kind, p.get("default")))
        else:
            params.append("- %s%s (required)" % (p["name"], kind))
    lines = [
        "You generate sample inputs so that one Python function can be executed and inspected line by line.",
        "",
        "File: %s" % relative_path,
        "```python",
        context,
        "```",
        "",
        "Function to run: `%s`" % qualname,
        "Parameters:",
        "\n".join(params) if params else "(none)",
        "",
    ]
    lines.extend(_scenario(instructions, False))
    lines.extend(
        [
            "Reply with one JSON object and nothing else:",
            '{"args": {"<parameter name>": "<python expression>", ...}}',
            "",
            "Rules:",
            "- Each value is a single Python expression written as a JSON string. It is evaluated inside the module, "
            "so every name defined or imported there can be used, for example to construct its dataclasses or enums. "
            "Also available: %s." % HELPERS,
            "- Choose small, realistic values that take the function down its main path: non-empty collections of 2 or 3 "
            "elements, values that pass the function's own validation, values that reach the interesting branch.",
            "- For a parameter that is a connection, session, client, socket, open file, logger, or any other object that "
            "talks to the outside world or is impractical to construct, use the bare name FAKE. A FAKE accepts any "
            "attribute access and any call; the values it yields are filled in later.",
            "- Leave out optional parameters unless a different value makes the run more informative.",
            "- For a method's `self`, either give an expression that constructs the instance (use FAKE for effectful "
            "constructor arguments) or leave it out to have one built automatically.",
            "- No imports, no statements, no comments, no markdown.",
        ]
    )
    return "\n".join(lines)


OP_HINTS = {
    "iter": "It is iterated, so give a list (or dict if the loop uses .items()) with 2 or 3 elements shaped the way the loop body reads them.",
    "len": "Its length is taken, so give a sized collection.",
    "contains": "A membership test is run against it, so give a collection.",
    "bool": "It is used in a truth test. Give the real value it would hold, not just True or False, if later lines use it as more than a flag.",
    "eq": "It is compared for equality. Give the value it would actually hold.",
    "cmp": "It is ordered against another value. Give a value of the same type.",
    "num": "It is used as a number (or concatenated). Give a value of the matching type.",
    "index": "It is used as an integer index or count. Give an int.",
    "str": "It is turned into text. Give the string, or a value whose str() is realistic.",
    "any": "A concrete value is required at this point. If it truly has to stay an opaque object whose methods are "
    "called next (a client, a response object), answer FAKE.",
}


def build_value_prompt(qualname, function_source, need, known, args, instructions=None):
    lines = [
        "A Python function is being executed with fake stand-ins for its external dependencies (databases, HTTP, files, clients).",
        "One of those stand-ins is now used as a concrete value. Invent a realistic value for it.",
        "",
        "Function: `%s`" % qualname,
        "```python",
        function_source,
        "```",
        "",
    ]
    if args:
        lines.append("Arguments of this run:")
        lines.extend("- %s = %s" % (name, value) for name, value in args)
        lines.append("")
    if known:
        lines.append("Values already invented in this run (stay consistent with them):")
        lines.extend("- %s = %s" % (path, expr) for path, expr in known[-10:])
        lines.append("")
    lines.extend(_scenario(instructions, True))
    lines.extend(
        [
            "Current line: `%s`" % need["text"] if need.get("text") else "The function has just returned.",
            "Expression that needs a value: `%s`" % need.get("path"),
            "How it is used: %s" % (need.get("detail") or "as a value"),
            OP_HINTS.get(need.get("op"), ""),
            "",
            "Reply with one JSON object and nothing else:",
            '{"value": "<python expression>"}',
            "",
            "Rules:",
            "- A single Python expression written as a JSON string. Prefer literals: numbers, strings, lists, dicts, None, "
            "True, False. Names from the module may be used, for example to build model instances, plus %s." % HELPERS,
            "- Match how the rest of the function uses it: the keys it reads, the attributes it accesses, the types it compares against.",
            "- Prefer the value that lets execution continue along the main path, such as a success status or a non-empty result.",
            "- No imports, no statements, no comments, no markdown.",
        ]
    )
    return "\n".join(lines)


def build_cases_prompt(relative_path, qualname, context, function_source, maximum):
    return "\n".join(
        [
            "You design a small set of input cases for one Python function so that a developer can step through each and see how the function behaves.",
            "",
            "File: %s" % relative_path,
            "```python",
            context,
            "```",
            "",
            "Function under test: `%s`" % qualname,
            "```python",
            function_source,
            "```",
            "",
            "Give at most %d cases. Start with the typical case, then the edge cases this particular code can tell apart: "
            "each branch and early return, empty and single-element collections, boundary values of its comparisons, None "
            "or a missing key where the code allows or forgets it, values that make it raise, and external dependencies "
            "that fail or return nothing. Every case must make the function behave differently from the others. Fewer "
            "good cases are better than padding up to the limit." % maximum,
            "",
            "Reply with one JSON object and nothing else:",
            '{"cases": [{"title": "<2 to 5 words>", "args": {"<parameter name>": "<python expression>", ...}, "scenario": "<optional, one sentence>"}, ...]}',
            "",
            "Rules:",
            '- title: short and specific, naming what is special about the case, such as "Empty price list" or "API returns 404". No numbering.',
            "- args: every required parameter, each value a single Python expression written as a JSON string and evaluated "
            "inside the module, so its own names can be used. Also available: %s." % HELPERS,
            "- For a parameter that is a connection, session, client, open file or similar, use the bare name FAKE.",
            "- scenario: only when the case depends on what a fake or an external call returns. Say it in one sentence, for "
            'example "the HTTP request answers 404" or "the query returns no rows". It is used to invent those values.',
            "- For a method, leave out self.",
            "- No imports, no statements, no comments, no markdown.",
        ]
    )


# ------------------------------------------------------------------ parsing


def _matching_brace(text, start):
    depth = 0
    in_string = False
    escaped = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return i
    return -1


def extract_json(text):
    """The first JSON object in a model reply, tolerating code fences and prose."""
    cleaned = re.sub(r"```(?:json|python)?", "", text or "", flags=re.I).strip()
    start = cleaned.find("{")
    while start != -1:
        end = _matching_brace(cleaned, start)
        if end != -1:
            try:
                return json.loads(cleaned[start : end + 1])
            except ValueError:
                pass
        start = cleaned.find("{", start + 1)
    return None


def to_python_literal(value):
    """Python literal for a JSON value, for answers given as raw JSON instead of an expression string."""
    if value is None:
        return "None"
    if isinstance(value, bool):
        return "True" if value else "False"
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            return "float('nan')"
        return repr(value)
    if isinstance(value, str):
        return json.dumps(value)
    if isinstance(value, list):
        return "[%s]" % ", ".join(to_python_literal(v) for v in value)
    if isinstance(value, dict):
        return "{%s}" % ", ".join("%s: %s" % (json.dumps(str(k)), to_python_literal(v)) for k, v in value.items())
    return repr(value)


_MISSING = object()


def as_expression(value):
    if value is _MISSING:
        return None
    if isinstance(value, str):
        return value.strip() or None
    return to_python_literal(value)


def expressions(mapping, skip_self=False):
    """A {name: expression} dict from model or agent input; values may be raw JSON."""
    out = {}
    for name, value in (mapping or {}).items():
        expr = as_expression(value)
        if expr is not None and not (skip_self and name == "self"):
            out[str(name)] = expr
    return out


def parse_args_reply(text):
    parsed = extract_json(text)
    if not isinstance(parsed, dict):
        return None
    source = parsed["args"] if isinstance(parsed.get("args"), dict) else parsed
    return expressions(source)


def parse_value_reply(text):
    parsed = extract_json(text)
    if not isinstance(parsed, dict) or "value" not in parsed:
        return None
    return as_expression(parsed["value"])


def clean_cases(entries, maximum):
    """Normalises a list of cases, from the model or from the calling agent."""
    cases = []
    seen = set()
    for raw in entries if isinstance(entries, list) else []:
        if not isinstance(raw, dict):
            continue
        if isinstance(raw.get("args"), dict):
            args = expressions(raw["args"], skip_self=True)
        elif raw.get("args") is None:
            args = {}
        else:
            continue
        title = re.sub(r"\s+", " ", raw["title"]).strip() if isinstance(raw.get("title"), str) else ""
        title = re.sub(r"^\d+[.):]\s*", "", title)[:60] or "Case %d" % (len(cases) + 1)
        while title.lower() in seen:
            title += " (2)"
        seen.add(title.lower())
        scenario = raw.get("scenario")
        scenario = scenario.strip()[:300] if isinstance(scenario, str) and scenario.strip() else None
        cases.append({"title": title, "args": args, "scenario": scenario})
        if len(cases) >= maximum:
            break
    return cases


def parse_cases_reply(text, maximum):
    parsed = extract_json(text)
    if not isinstance(parsed, dict):
        return []
    return clean_cases(parsed.get("cases"), maximum)
