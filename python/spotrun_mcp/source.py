"""Finds functions in a source file and prepares the text shown to the model."""

import ast
import re


class Function(object):
    def __init__(self, node, class_name, text_lines):
        self.node = node
        self.name = node.name
        self.class_name = class_name
        self.start = min([node.lineno] + [d.lineno for d in node.decorator_list])
        self.end = getattr(node, "end_lineno", node.lineno)
        self.source = "\n".join(text_lines[self.start - 1 : self.end])
        try:
            self.signature = "%s(%s)" % (node.name, ast.unparse(node.args))
        except Exception:
            self.signature = text_lines[node.lineno - 1].strip()

    def statement_lines(self):
        """Lines on which a statement of this function starts, nested definitions' bodies excluded."""
        lines = set()

        def visit(statements, first):
            for index, stmt in enumerate(statements):
                docstring = (
                    first
                    and index == 0
                    and isinstance(stmt, ast.Expr)
                    and isinstance(getattr(stmt, "value", None), ast.Constant)
                    and isinstance(stmt.value.value, str)
                )
                if not docstring and not isinstance(stmt, (ast.Global, ast.Nonlocal)):
                    lines.add(stmt.lineno)
                if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    continue
                for field in ("body", "orelse", "finalbody"):
                    visit(getattr(stmt, field, None) or [], False)
                for handler in getattr(stmt, "handlers", None) or []:
                    visit(handler.body, False)
                for case in getattr(stmt, "cases", None) or []:
                    visit(case.body, False)

        visit(self.node.body, True)
        return lines


_DEFS = (ast.FunctionDef, ast.AsyncFunctionDef)


def find_function(text, qualname):
    """The function named by a dotted qualname (``Class.method``), or None."""
    tree = ast.parse(text)
    lines = text.splitlines()
    body = tree.body
    class_name = None
    parts = qualname.split(".")
    for index, part in enumerate(parts):
        last = index == len(parts) - 1
        found = None
        for node in body:
            if isinstance(node, _DEFS + (ast.ClassDef,)) and node.name == part:
                found = node
        if found is None:
            return None
        if last:
            return Function(found, class_name, lines) if isinstance(found, _DEFS) else None
        class_name = found.name if isinstance(found, ast.ClassDef) else None
        body = found.body
    return None


def function_names(text):
    """Qualnames of the functions and methods in a file, for error messages."""
    names = []

    def visit(body, prefix, depth):
        for node in body:
            if isinstance(node, _DEFS):
                names.append(prefix + node.name)
            elif isinstance(node, ast.ClassDef) and depth < 3:
                visit(node.body, prefix + node.name + ".", depth + 1)

    try:
        visit(ast.parse(text).body, "", 0)
    except SyntaxError:
        pass
    return names


def enclosing_source(text, line):
    """Source of the innermost function containing a line, or None."""
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return None
    best = None
    for node in ast.walk(tree):
        if isinstance(node, _DEFS) and node.lineno <= line <= getattr(node, "end_lineno", node.lineno):
            if best is None or node.lineno >= best.lineno:
                best = node
    if best is None:
        return None
    return Function(best, None, text.splitlines()).source


def build_context(text, function, limit=12000):
    """The whole file when small, otherwise its imports, the classes the
    signature refers to, the enclosing class, and the function itself."""
    if len(text) <= limit:
        return text
    lines = text.splitlines()
    out = [line for line in lines if re.match(r"^(import |from \S+ import )", line)]
    wanted = set(re.findall(r"[A-Z][A-Za-z0-9_]*", function.signature))
    if function.class_name:
        wanted.add(function.class_name)
    for i, line in enumerate(lines):
        match = re.match(r"^class\s+([A-Za-z_]\w*)", line)
        if not match or match.group(1) not in wanted:
            continue
        out.append("")
        start = i
        while start > 0 and lines[start - 1].startswith("@"):
            start -= 1
        for taken, j in enumerate(range(start, len(lines))):
            if taken >= 60 or (j > i and re.match(r"^\S", lines[j]) and not lines[j].startswith("#")):
                break
            out.append(lines[j])
    out.extend(["", "# ... (rest of the file omitted) ...", "", function.source])
    return "\n".join(out)[: limit * 2]
