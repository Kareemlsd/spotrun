"""Turns a recorded run into the text an agent reads."""

import os

from . import prompts

CAVEAT = "Inputs and fake values are invented: this shows behaviour on plausible data, not that real services return such data."

SOURCES = {"llm": "model", "cache": "given", "pin": "pinned", "heuristic": "guessed", "default": "default"}


def short(text, limit):
    text = str(text)
    return text if len(text) <= limit else text[: limit - 1] + "…"


def outcome(result):
    if result.get("fatal"):
        return "could not be run"
    exc = result.get("exception")
    if exc:
        return "raised %s: %s" % (exc.get("type"), short(exc.get("message") or "", 300))
    return "returned %s" % short(result.get("return") if result.get("return") is not None else "None", 600)


def ranges(numbers):
    numbers = sorted(numbers)
    parts = []
    index = 0
    while index < len(numbers):
        end = index
        while end + 1 < len(numbers) and numbers[end + 1] == numbers[end] + 1:
            end += 1
        parts.append(str(numbers[index]) if end == index else "%d-%d" % (numbers[index], numbers[end]))
        index = end + 1
    return ", ".join(parts)


def _target_frames(target, result):
    files = result.get("files") or []
    function = target.function
    ids = set()
    for frame in result.get("frames") or []:
        index = frame.get("file", -1)
        file = files[index] if 0 <= index < len(files) else None
        same = file is not None and os.path.abspath(file) == target.file
        if same and frame.get("name") == function.name and function.start <= frame.get("line", 0) <= function.node.lineno:
            ids.add(frame["id"])
    return ids


def executed_lines(target, result):
    ids = _target_frames(target, result)
    return {step["l"] for step in result.get("steps") or [] if step.get("f") in ids}


def missed_lines(target, result):
    return target.function.statement_lines() - executed_lines(target, result)


def _line_listing(target, numbers, limit=12):
    text = target.text.splitlines()
    out = []
    for number in sorted(numbers)[:limit]:
        out.append("  %d: %s" % (number, short(text[number - 1].strip(), 110) if 0 < number <= len(text) else ""))
    if len(numbers) > limit:
        out.append("  … and %d more: %s" % (len(numbers) - limit, ranges(sorted(numbers)[limit:])))
    return out


def _where(target, file, line):
    if not file:
        return "line %s" % line
    file = os.path.abspath(file)
    if file == target.file:
        return "line %s" % line
    name = os.path.relpath(file, target.root) if file.startswith(target.root + os.sep) else file
    return "%s:%s" % (name, line)


def _label(source, asker):
    if source == "llm":
        return asker
    return SOURCES.get(source, source or "?")


def _arguments(result, asker):
    lines = []
    for arg in result.get("args") or []:
        label = _label(arg.get("source"), asker)
        value = arg.get("expr") if arg.get("expr") and arg.get("source") != "heuristic" else arg.get("value") or arg.get("expr")
        line = "  %s = %s  [%s]" % (arg["name"], short(value, 220), label)
        if arg.get("note"):
            line += " (%s)" % arg["note"]
        lines.append(line)
        if arg.get("rejected"):
            lines.append(
                "  ! %s: the expression %s was rejected (%s); its default or a guessed value was used instead"
                % (arg["name"], short(arg["rejected"], 120), short(arg.get("error") or "", 200))
            )
        elif arg.get("error"):
            lines.append("  ! %s: %s" % (arg["name"], short(arg["error"], 200)))
    return lines


def _resolutions(target, result, asker, limit=20):
    lines = []
    records = result.get("resolutions") or []
    for record in records[:limit]:
        label = _label(record.get("source"), asker)
        if record.get("error"):
            lines.append("  ! %s: %s was rejected (%s); a default was used" % (record.get("path"), short(record.get("expr"), 120), short(record["error"], 160)))
            continue
        lines.append(
            "  %s = %s  [%s, %s, %s]"
            % (short(record.get("path"), 120), short(record.get("expr") or record.get("value"), 220), label, _where(target, record.get("file"), record.get("line")), record.get("op"))
        )
    if len(records) > limit:
        lines.append("  … and %d more" % (len(records) - limit))
    return lines


def _unique(items, key, limit):
    seen = set()
    out = []
    for item in items:
        marker = key(item)
        if marker not in seen:
            seen.add(marker)
            out.append(item)
    return out[:limit], max(0, len(out) - limit)


def _final_locals(target, result, limit=15):
    ids = sorted(_target_frames(target, result))
    if not ids:
        return []
    first = ids[0]
    frame = next(f for f in result["frames"] if f["id"] == first)
    state = dict(frame.get("args") or {})
    for step in result.get("steps") or []:
        if step.get("f") == first and "w" in step:
            state.update(step["w"])
    lines = ["  %s = %s" % (name, short(value, 160)) for name, value in list(state.items())[:limit]]
    if len(state) > limit:
        lines.append("  … and %d more" % (len(state) - limit))
    return lines


def full(target, result, attempts, notes, how, asker="model"):
    head = "%s in %s (line %d)" % (target.qualname, target.relative, target.function.node.lineno)
    if result.get("fatal"):
        return "\n".join([head, "", "Could not run:", short(result["fatal"].strip(), 4000), "", "How this ran: %s" % how])
    out = [head, "", "Outcome: %s" % outcome(result)]
    exc = result.get("exception")
    if exc:
        for frame in (exc.get("frames") or [])[-5:]:
            out.append("  at %s in %s: %s" % (_where(target, frame.get("file"), frame.get("line")), frame.get("name"), short(frame.get("text") or "", 120)))
        if exc.get("blocked"):
            out.append("  This is a real side effect that Spot Run refused, not a bug in the function.")

    arguments = _arguments(result, asker)
    if arguments:
        out.extend(["", "Arguments:"] + arguments)
    for error in result.get("import_errors") or []:
        out.append("  ! import failed: %s" % short(error, 200))

    resolved = _resolutions(target, result, asker)
    if resolved:
        out.extend(["", "Values invented for faked dependencies:"] + resolved)

    effects, more = _unique(result.get("effects") or [], lambda e: (e.get("kind"), e.get("what")), 10)
    if effects:
        out.extend(["", "Side effects that did not really happen:"])
        out.extend("  %s: %s (%s)" % (_where(target, e.get("file"), e.get("line")), short(e.get("what"), 140), e.get("kind")) for e in effects)
        if more:
            out.append("  … and %d more" % more)
    blocked, more = _unique(result.get("blocked") or [], lambda b: (b.get("event"), b.get("what")), 6)
    if blocked:
        out.extend(["", "Refused by the guard:"])
        out.extend("  %s: %s" % (_where(target, b.get("file"), b.get("line")), short(b.get("what"), 160)) for b in blocked)

    ran = executed_lines(target, result)
    missed = target.function.statement_lines() - ran
    out.extend(["", "Lines that ran: %s" % (ranges(ran) or "(none)")])
    if missed:
        out.append("Lines that did not run:")
        out.extend(_line_listing(target, missed))
    else:
        out.append("Every statement of the function ran.")
    if result.get("truncated") or result.get("skipped"):
        out.append("(The recording skipped repeated loop iterations, so this list can be incomplete.)")

    final = _final_locals(target, result)
    if final:
        out.extend(["", "Variables at the end:"] + final)

    printed = "".join(chunk[2] for chunk in result.get("outputs") or [] if len(chunk) == 3)
    if printed.strip():
        out.extend(["", "Printed output:", short(printed.rstrip(), 1500)])

    if notes:
        out.extend(["", "Notes:"] + ["  - %s" % note for note in notes])
    out.extend(
        [
            "",
            "How this ran: %s; %d attempt%s, %d value question%s."
            % (how, attempts, "" if attempts == 1 else "s", result.get("llm_calls") or 0, "" if result.get("llm_calls") == 1 else "s"),
            CAVEAT,
        ]
    )
    return "\n".join(out)


def cases(target, runs, notes, how, proposed_by_model):
    head = "%s in %s (line %d): %d case%s%s" % (
        target.qualname,
        target.relative,
        target.function.node.lineno,
        len(runs),
        "" if len(runs) == 1 else "s",
        ", proposed by the model" if proposed_by_model else "",
    )
    out = [head]
    reached = set()
    for index, (case, result) in enumerate(runs, 1):
        out.extend(["", "%d. %s" % (index, case["title"])])
        given = ", ".join("%s=%s" % (name, short(expr, 100)) for name, expr in case["args"].items())
        out.append("   args: %s" % (given or "(none)"))
        if case.get("scenario"):
            out.append("   scenario: %s" % case["scenario"])
        if result.get("fatal"):
            out.append("   could not be run: %s" % short(result["fatal"].strip().splitlines()[-1], 300))
            continue
        out.append("   outcome: %s" % outcome(result))
        exc = result.get("exception")
        if exc and exc.get("frames"):
            frame = exc["frames"][-1]
            out.append("   at %s: %s" % (_where(target, frame.get("file"), frame.get("line")), short(frame.get("text") or "", 110)))
        for arg in result.get("args") or []:
            if arg.get("rejected"):
                out.append("   ! %s: %s was rejected (%s); its default or a guessed value was used" % (arg["name"], short(arg["rejected"], 80), short(arg.get("error") or "", 120)))
        for record in (result.get("resolutions") or [])[:6]:
            if not record.get("error"):
                out.append("   invented: %s = %s" % (short(record.get("path"), 90), short(record.get("expr") or record.get("value"), 140)))
        ran = executed_lines(target, result)
        reached |= ran
        out.append("   lines: %s" % (ranges(ran) or "(none)"))
    never = target.function.statement_lines() - reached
    out.append("")
    if never:
        out.append("Lines no case reached:")
        out.extend(_line_listing(target, never))
    else:
        out.append("Together the cases ran every statement of the function.")
    if notes:
        out.extend(["", "Notes:"] + ["  - %s" % note for note in notes])
    out.extend(["", "How this ran: %s." % how, CAVEAT])
    return "\n".join(out)


def question(run_id, asked):
    need = asked.need
    target = asked.target
    out = ["The run is paused. A faked dependency is now used as a concrete value, and you decide what it is."]
    if asked.case:
        out.append("Case: %s%s" % (asked.case["title"], " (%s)" % asked.case["scenario"] if asked.case.get("scenario") else ""))
    out.extend(
        [
            "",
            "run_id: %s" % run_id,
            "Expression: %s" % need.get("path"),
            "Used at %s: %s" % (_where(target, need.get("file"), need.get("line")), need.get("text") or "(the function has returned)"),
            "How it is used: %s" % (need.get("detail") or "as a value"),
        ]
    )
    hint = prompts.OP_HINTS.get(need.get("op"))
    if hint:
        out.append(hint)
    if asked.known:
        out.extend(["", "Values you already gave in this run:"] + ["  %s = %s" % (path, short(expr, 160)) for path, expr in asked.known[-8:]])
    out.extend(
        [
            "",
            "Call answer_value with this run_id and `value`: a single Python expression, preferably a literal. Names defined "
            "in the module can be used. Match how the function reads it (keys, attributes, types). Answer FAKE to keep it "
            "an opaque object. The run continues from this line and may pause again.",
        ]
    )
    return "\n".join(out)
