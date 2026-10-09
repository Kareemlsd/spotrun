import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { buildArgsPrompt, buildCasesPrompt, buildContext, buildValuePrompt, extractJson, parseArgsReply, parseCasesReply, parseValueReply, toPythonLiteral } from "../src/core/prompts";
import { findByQualname, functionAt, parsePythonFunctions, signatureOf, sourceOf } from "../src/core/pythonFunctions";
import { formatWrites, ReplayModel } from "../src/core/replayModel";
import { createFsHost, dig, parseDigReply, runLookup } from "../src/core/dig";
import { Handlers } from "../src/core/runtimeProcess";
import { absorb, runWithRetries, RunSpec } from "../src/core/session";
import { emptyFunctionData, RunResult } from "../src/core/types";

const SOURCE = `import os

@decorator
def top(a, b=2):
    """Doc with def fake(): inside
    and more
    """
    x = {
        "def": 1,
    }
    def inner(z):
        return z
    return inner(a)


class Basket:
    limit = 3

    def add(self, item: str,
            qty: int = 1) -> int:
        return qty  # def not_a_function():

    @staticmethod
    async def fetch(url):
        return url

    class Nested:
        def deep(self):
            pass

text = '''
def in_string():
    pass
'''

def last(): return 1
`;

test("parser finds definitions with qualified names and extents", () => {
  const fns = parsePythonFunctions(SOURCE);
  assert.deepEqual(
    fns.map((f) => [f.qualname, f.runnable]),
    [
      ["top", true],
      ["top.inner", false],
      ["Basket.add", true],
      ["Basket.fetch", true],
      ["Basket.Nested.deep", true],
      ["last", true],
    ],
  );
  const top = fns[0];
  assert.equal(top.line, 3);
  assert.equal(SOURCE.split("\n")[top.endLine].trim(), "return inner(a)");
  const add = findByQualname(fns, "Basket.add")!;
  assert.equal(add.headerEnd, add.line + 1);
  assert.equal(add.className, "Basket");
  assert.equal(signatureOf(SOURCE, add), "def add(self, item: str, qty: int = 1) -> int:");
  assert.ok(fns[3].isAsync);
  assert.equal(findByQualname(fns, "top.inner"), undefined);
});

test("cursor maps to the enclosing runnable function", () => {
  const fns = parsePythonFunctions(SOURCE);
  const lines = SOURCE.split("\n");
  const lineOf = (needle: string) => lines.findIndex((l) => l.includes(needle));
  assert.equal(functionAt(fns, lineOf("return z"))!.qualname, "top");
  assert.equal(functionAt(fns, lineOf("return qty"))!.qualname, "Basket.add");
  assert.equal(functionAt(fns, lineOf("limit = 3")), undefined);
  assert.equal(functionAt(fns, lineOf("def in_string")), undefined);
  assert.equal(functionAt(fns, lineOf("def last"))!.qualname, "last");
});

test("function source includes decorators and is dedented", () => {
  const fns = parsePythonFunctions(SOURCE);
  assert.ok(sourceOf(SOURCE, fns[0]).startsWith("@decorator\ndef top(a, b=2):"));
  const fetch = sourceOf(SOURCE, findByQualname(fns, "Basket.fetch")!);
  assert.equal(fetch, "@staticmethod\nasync def fetch(url):\n    return url");
});

function trace(): RunResult {
  // def outer(a):        line 1
  //     x = helper(a)    line 2
  //     return x + 1     line 3
  // def helper(n):       line 5
  //     y = n * 2        line 6
  //     return y         line 7
  return {
    type: "result",
    qualname: "outer",
    file: "/w/m.py",
    args: [],
    is_async: false,
    return: "7",
    files: ["/w/m.py"],
    frames: [
      { id: 0, file: 0, name: "outer", line: 1, parent: -1, depth: 0, args: { a: "3" }, ret: "7" },
      { id: 1, file: 0, name: "helper", line: 5, parent: 0, depth: 1, args: { n: "3" }, ret: "6" },
    ],
    steps: [
      { f: 0, l: 2, w: { x: "6" } },
      { f: 1, l: 6, w: { y: "6" } },
      { f: 1, l: 7, ret: "6" },
      { f: 0, l: 3, ret: "7" },
    ],
    truncated: false,
    skipped: 0,
    exception: null,
    outputs: [
      [1, "out", "in helper\n"],
      [3, "out", "done\n"],
    ],
    resolutions: [],
    effects: [],
    blocked: [],
    retry: null,
    llm_calls: 0,
    written_files: [],
  };
}

test("replay steps over, into, out and back", () => {
  const model = new ReplayModel(trace());
  assert.equal(model.index, 0);
  model.stepOver();
  assert.equal(model.index, 3, "step over skips the call");
  model.stepBack();
  assert.equal(model.index, 0);
  model.stepInto();
  assert.equal(model.index, 1);
  assert.deepEqual(
    model.stack().map((v) => [v.frame.name, v.line]),
    [
      ["outer", 2],
      ["helper", 6],
    ],
  );
  model.stepOut();
  assert.equal(model.index, 3);
  model.stepOver();
  assert.ok(model.atEnd);
  assert.equal(model.stepOver(), false);
  model.stepBack();
  assert.equal(model.index, 3);
});

test("an assignment from a call is visible only after the call returns", () => {
  const model = new ReplayModel(trace());
  model.goTo(1);
  let outer = model.stack()[0];
  assert.deepEqual(outer.locals, { a: "3" });
  assert.deepEqual(outer.annotations.get(2)!.writes, {});
  model.goTo(2);
  const helper = model.stack()[1];
  assert.deepEqual(helper.locals, { n: "3", y: "6" });
  model.goTo(3);
  outer = model.stack()[0];
  assert.deepEqual(outer.locals, { a: "3", x: "6" });
  assert.equal(model.stack().length, 1);
  model.goTo(4);
  outer = model.stack()[0];
  assert.equal(outer.line, undefined);
  assert.equal(outer.annotations.get(3)!.ret, "7");
  assert.equal(model.outcome(), "→ 7");
});

test("output follows the position", () => {
  const model = new ReplayModel(trace());
  assert.equal(model.output().length, 0);
  model.goTo(1);
  assert.equal(model.output().length, 1);
  model.goTo(4);
  assert.equal(model.output().length, 2);
});

test("failing index is the innermost raising step", () => {
  const t = trace();
  t.steps[1].exc = "ValueError: bad";
  t.steps[0].exc = "ValueError: bad";
  delete t.steps[0].w;
  t.steps = t.steps.slice(0, 2);
  t.exception = { type: "ValueError", message: "bad", blocked: false, frames: [] };
  const model = new ReplayModel(t);
  assert.equal(model.failingIndex(), 1);
  assert.equal(model.outcome(), "ValueError: bad");
});

test("writes are formatted and truncated", () => {
  assert.equal(formatWrites({ a: "1", b: "'x'" }), "a = 1, b = 'x'");
  assert.equal(formatWrites({ a: "x".repeat(300) }, 20).length, 20);
});

test("model replies are parsed leniently", () => {
  assert.deepEqual(extractJson('Sure!\n```json\n{"args": {"a": "1"}}\n```'), { args: { a: "1" } });
  assert.deepEqual(parseArgsReply('{"args": {"a": "[1, 2]", "b": 3, "c": {"k": true, "n": null}, "d": ""}}'), {
    a: "[1, 2]",
    b: "3",
    c: '{"k": True, "n": None}',
  });
  assert.equal(parseValueReply('{"value": "[{\'id\': 1}]"}'), "[{'id': 1}]");
  assert.equal(parseValueReply('{"value": [1, "a", false]}'), '[1, "a", False]');
  assert.equal(parseValueReply('text with {braces} and more {"value": "FAKE"}'), "FAKE");
  assert.equal(parseValueReply('{"value": "a}b"}'), "a}b");
  assert.equal(parseValueReply("no json"), undefined);
  assert.equal(toPythonLiteral({ a: [1.5, null] }), '{"a": [1.5, None]}');
});

test("prompts carry the function, the parameters and the use site", () => {
  const args = buildArgsPrompt({
    relativePath: "shop/basket.py",
    qualname: "Basket.add",
    context: "class Basket: ...",
    need: {
      type: "need_args",
      class_name: "Basket",
      names: [],
      params: [
        { name: "self", kind: "POSITIONAL_OR_KEYWORD", annotation: null, has_default: false, default: null, is_self: true },
        { name: "item", kind: "POSITIONAL_OR_KEYWORD", annotation: "str", has_default: false, default: null, is_self: false },
        { name: "qty", kind: "POSITIONAL_OR_KEYWORD", annotation: "int", has_default: true, default: "1", is_self: false },
        { name: "extra", kind: "VAR_KEYWORD", annotation: null, has_default: false, default: null, is_self: false },
      ],
    },
    usages: ["basket.add('pen', 2)"],
  });
  assert.match(args, /- item: str \(required\)/);
  assert.match(args, /- qty: int \(optional, default 1\)/);
  assert.match(args, /Basket instance/);
  assert.doesNotMatch(args, /- extra/);
  assert.match(args, /basket\.add\('pen', 2\)/);

  const value = buildValuePrompt({
    qualname: "fetch",
    functionSource: "def fetch(): ...",
    need: { type: "need_value", path: "requests.get('u').json()['items']", op: "iter", detail: "iterated over", file: "/w/m.py", line: 4, text: "for item in data['items']:" },
    known: [{ path: "requests.get('u').status_code", expr: "200" }],
    args: [{ name: "url", value: "'u'" }],
  });
  assert.match(value, /Expression that needs a value: `requests\.get\('u'\)\.json\(\)\['items'\]`/);
  assert.match(value, /Current line: `for item in data\['items'\]:`/);
  assert.match(value, /status_code = 200/);
  assert.match(value, /give a list/);
});

test("large files are reduced to imports, referenced classes and the function", () => {
  const filler = Array.from({ length: 800 }, (_, i) => `def filler_${i}():\n    return ${i}\n`).join("\n");
  const text = `import os\nfrom typing import List\n\nclass Order:\n    id: int\n    total: float\n\n${filler}\ndef bill(order: Order):\n    return order.total\n`;
  const context = buildContext(text, "def bill(order: Order):\n    return order.total", "def bill(order: Order):", null);
  assert.ok(context.length < 2000);
  assert.match(context, /import os/);
  assert.match(context, /class Order:\n {4}id: int/);
  assert.match(context, /def bill/);
  assert.doesNotMatch(context, /filler_5/);
});

test("absorb keeps model answers and recovery hints", () => {
  const data = emptyFunctionData("def f(a):");
  const result = trace();
  result.args = [{ name: "a", expr: "3", source: "llm" }];
  result.resolutions = [
    { key: "p|iter|line", path: "p", op: "iter", expr: "[1]", source: "llm", value: "[1]", file: null, line: 1, text: "line", step: 0 },
    { key: "q|num|line", path: "q", op: "num", expr: "1", source: "heuristic", value: "1", file: null, line: 1, text: "line", step: 0 },
  ];
  result.retry = { patch: "lib:Client.fetch" };
  const first = absorb(data, result);
  assert.deepEqual(first.data.args, { a: "3" });
  assert.deepEqual(first.data.fakes, { "p|iter|line": "[1]" });
  assert.deepEqual(first.data.patches, ["lib:Client.fetch"]);
  assert.equal(first.retry, true);
  const second = absorb(first.data, result);
  assert.equal(second.retry, false, "the same hint is not retried twice");
  assert.equal(data.args, null, "input is not mutated");
});

// ----------------------------------------------------------- real runtime

const ROOT = path.resolve(__dirname, "..", "..");
const SAMPLES = path.join(ROOT, "tests", "samples");
const options = {
  python: process.env.SPOTRUN_PYTHON ?? "python3",
  mainScript: path.join(ROOT, "python", "spotrun_main.py"),
  cwd: SAMPLES,
  timeoutMs: 20000,
  env: { PYTHONPATH: path.join(ROOT, "tests", "libs") },
};
const spec = (file: string, qualname: string, llm: boolean): RunSpec => ({ file: path.join(SAMPLES, file), qualname, root: SAMPLES, scope: "workspace", llm, limits: {} });
const silent: Handlers = { needArgs: async () => undefined, needValue: async () => undefined };

test("runtime: plain function without a model", async () => {
  const outcome = await runWithRetries(spec("pure.py", "total", false), emptyFunctionData(""), silent, options);
  assert.equal(outcome.result.return, "3.6");
  assert.equal(outcome.attempts, 1);
  const model = new ReplayModel(outcome.result);
  model.goTo(model.length);
  assert.equal(model.stack()[0].locals.subtotal, "3.0");
});

test("runtime: model answers are asked once, cached, and reused", async () => {
  const asked: string[] = [];
  const handlers: Handlers = {
    needArgs: async () => {
      asked.push("args");
      return { args: { base_url: "'https://shop.test'", min_price: "10" } };
    },
    needValue: async (need) => {
      asked.push(need.path);
      if (need.path.endsWith(".status_code")) {
        return "200";
      }
      return "[{'name': 'pen', 'price': 2.5}, {'name': 'desk', 'price': 120.0}]";
    },
  };
  const first = await runWithRetries(spec("effects.py", "fetch_prices", true), emptyFunctionData(""), handlers, options);
  assert.equal(first.result.return, "['desk']");
  assert.equal(asked.length, 3);
  assert.deepEqual(first.data.args, { base_url: "'https://shop.test'", min_price: "10" });
  assert.equal(Object.keys(first.data.fakes).length, 2);

  const second = await runWithRetries(spec("effects.py", "fetch_prices", true), first.data, handlers, options);
  assert.equal(second.result.return, "['desk']");
  assert.equal(asked.length, 3, "nothing new was asked");
});

test("runtime: a blocked library call is patched and the run repeated", async () => {
  const outcome = await runWithRetries(spec("effects.py", "via_library", false), emptyFunctionData(""), silent, options);
  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.result.exception, null);
  assert.deepEqual(outcome.data.patches, ["fakelib:Client.fetch"]);
});

test("runtime: a hanging function is stopped by the timeout", async () => {
  const hanging = path.join(SAMPLES, "hang.py");
  require("node:fs").writeFileSync(hanging, "def spin():\n    while True:\n        pass\n");
  try {
    await assert.rejects(
      runWithRetries({ ...spec("hang.py", "spin", false), limits: { max_steps: 50 } }, emptyFunctionData(""), silent, { ...options, timeoutMs: 1500 }),
      /stopped after/,
    );
  } finally {
    require("node:fs").unlinkSync(hanging);
  }
});

test("runtime: a missing interpreter is reported", async () => {
  await assert.rejects(
    runWithRetries(spec("pure.py", "total", false), emptyFunctionData(""), silent, { ...options, python: "/no/such/python" }),
    /Could not start Python/,
  );
});

test("a described scenario is carried into both prompts", () => {
  const need = {
    type: "need_args" as const,
    class_name: null,
    names: [],
    params: [{ name: "prices", kind: "POSITIONAL_OR_KEYWORD", annotation: "list[float]", has_default: false, default: null, is_self: false }],
  };
  const plain = buildArgsPrompt({ relativePath: "m.py", qualname: "total", context: "", need, usages: [], previousArgs: { prices: "[1.0]" } });
  assert.doesNotMatch(plain, /described the inputs/);
  assert.doesNotMatch(plain, /previous run/);

  const first = buildArgsPrompt({ relativePath: "m.py", qualname: "total", context: "", need, usages: [], instructions: ["one negative price"] });
  assert.match(first, /described the inputs to test with/);
  assert.match(first, /"""one negative price"""/);
  assert.doesNotMatch(first, /Earlier requests/);

  const followUp = buildArgsPrompt({
    relativePath: "m.py",
    qualname: "total",
    context: "",
    need,
    usages: [],
    instructions: ["one negative price", "make it three prices"],
    previousArgs: { prices: "[-5.0]" },
  });
  assert.match(followUp, /Earlier requests[^]*- one negative price[^]*Latest request:\n"""make it three prices"""/);
  assert.match(followUp, /previous run[^]*- prices = \[-5\.0\]/);
  assert.ok(followUp.indexOf("Latest request") < followUp.indexOf("Reply with one JSON object"));

  const value = buildValuePrompt({
    qualname: "fetch",
    functionSource: "def fetch(): ...",
    need: { type: "need_value", path: "r.status_code", op: "eq", detail: null, file: null, line: 1, text: "if r.status_code != 200:" },
    known: [],
    args: [],
    instructions: ["the API answers 404"],
  });
  assert.match(value, /"""the API answers 404"""/);
});

// ----------------------------------------------------------------- dig deep

function tempWorkspace(): string {
  const fsn = require("node:fs") as typeof import("node:fs");
  const dir = fsn.mkdtempSync(path.join(require("node:os").tmpdir(), "spotrun-dig-"));
  for (const name of ["deep.py", "deep_models.py", "deep_caller.py"]) {
    fsn.copyFileSync(path.join(SAMPLES, name), path.join(dir, name));
  }
  fsn.mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
  fsn.writeFileSync(path.join(dir, "node_modules", "pkg", "settle.py"), "settle(1)\n");
  fsn.mkdirSync(path.join(dir, ".git"));
  fsn.writeFileSync(path.join(dir, ".git", "config.py"), "settle(2)\n");
  fsn.writeFileSync(path.join(dir, ".env"), "API_KEY=topsecret\n");
  fsn.writeFileSync(path.join(dir, "secrets.json"), '{"password": "hunter2"}\n');
  fsn.writeFileSync(path.join(dir, "config.yaml"), "rates:\n  EUR: 1.0\n");
  return dir;
}

test("dig: lookups read the workspace but not dependencies, hidden folders or secrets", async () => {
  const dir = tempWorkspace();
  const host = createFsHost(dir);
  assert.deepEqual(await host.listFiles(), ["config.yaml", "deep.py", "deep_caller.py", "deep_models.py"]);
  assert.equal(await host.readFile(".env"), undefined);
  assert.equal(await host.readFile("secrets.json"), undefined);
  assert.equal(await host.readFile("../outside.py"), undefined);
  assert.equal(await host.readFile("/etc/passwd"), undefined);
  assert.equal(await host.readFile("node_modules/pkg/settle.py"), undefined);

  const usages = await runLookup(host, { action: "usages", name: "settle" });
  assert.equal(usages.label, "usages settle");
  assert.match(usages.text, /# deep_caller\.py:12/);
  assert.match(usages.text, /"kind": "invoice"/);
  assert.doesNotMatch(usages.text, /node_modules|\.git/);

  const definition = await runLookup(host, { action: "definition", name: "Policy" });
  assert.match(definition.text, /# deep_models\.py:\d+\n@dataclass\nclass Policy:\n {4}allowed: tuple/);
  assert.match((await runLookup(host, { action: "definition", name: "rate" })).text, /def rate\(self, currency\)/);

  const search = await runLookup(host, { action: "search", query: "EUR" });
  assert.match(search.text, /config\.yaml:2/);
  assert.doesNotMatch(search.text, /topsecret|hunter2/);
  assert.match((await runLookup(host, { action: "search", query: "Ledger(" })).text, /deep_caller\.py:6/, "an invalid regex is treated as literal text");

  const read = await runLookup(host, { action: "read", file: "deep_models.py", start: 4, end: 6 });
  assert.equal(read.label, "read deep_models.py:4-6");
  assert.match(read.text, / {3}4 {2}class Ledger:/);
  assert.match((await runLookup(host, { action: "read", file: ".env" })).text, /Cannot read/);
  assert.match((await runLookup(host, { action: "list" })).text, /deep_models\.py/);
  assert.match((await runLookup(host, { action: "delete", file: "deep.py" })).text, /Unknown action/);
});

test("dig: replies are told apart", () => {
  assert.deepEqual(parseDigReply('```json\n{"action": "search", "query": "x"}\n```'), { kind: "action", action: { action: "search", query: "x" } });
  assert.deepEqual(parseDigReply('{"args": {"a": 1, "b": "[1]"}, "imports": ["from m import T", 3], "notes": "n"}'), {
    kind: "final",
    answer: { args: { a: "1", b: "[1]" }, imports: ["from m import T"], notes: "n" },
  });
  assert.equal(parseDigReply("let me think"), undefined);
});

test("dig: the loop feeds results back, respects the budget and ends on the final answer", async () => {
  const host = createFsHost(tempWorkspace());
  const seen: string[] = [];
  const script = ['{"action": "usages", "name": "settle"}', "not json at all", '{"action": "definition", "name": "Ledger"}', '{"action": "list"}', '{"args": {"policy": "Policy(allowed=(\'invoice\',))"}, "imports": ["from deep_models import Policy"], "notes": "entries are dicts"}'];
  const steps: string[] = [];
  const outcome = await dig({
    host,
    prompt: "BASE PROMPT",
    maxSteps: 2,
    send: async (messages) => {
      seen.push(messages[messages.length - 1].text);
      return script.shift();
    },
    onStep: (step, label) => steps.push(`${step} ${label}`),
  });
  assert.match(seen[0], /^BASE PROMPT\n[^]*DIG DEEP IS ON[^]*up to 2 lookups/);
  assert.match(seen[1], /deep_caller\.py:12[^]*1 lookup left/);
  assert.match(seen[2], /not a single JSON object/);
  assert.match(seen[3], /class Ledger[^]*That was the last lookup/);
  assert.match(seen[4], /No lookups left/, "a lookup past the budget is refused, not run");
  assert.deepEqual(steps, ["1 usages settle", "2 definition Ledger"]);
  assert.deepEqual(outcome, {
    args: { policy: "Policy(allowed=('invoice',))" },
    imports: ["from deep_models import Policy"],
    notes: "entries are dicts",
    lookups: ["usages settle", "definition Ledger"],
  });
});

test("dig: gives up when the model keeps answering without JSON or stops answering", async () => {
  const host = createFsHost(tempWorkspace());
  assert.equal(await dig({ host, prompt: "p", maxSteps: 3, send: async () => "no" }), undefined);
  assert.equal(await dig({ host, prompt: "p", maxSteps: 3, send: async () => undefined }), undefined);
  assert.equal(await dig({ host, prompt: "p", maxSteps: 1, send: async () => '{"action": "list"}' }), undefined, "never answering ends after the budget");
});

test("runtime: dug-up arguments with imports run and are remembered", async () => {
  const handlers: Handlers = {
    needArgs: async () => ({
      args: {
        ledger: "Ledger({'EUR': 1.0, 'USD': 0.9})",
        entries: "[{'ref': 'A-1', 'kind': 'invoice', 'amount': 100.0, 'currency': 'USD'}]",
        policy: "Policy(allowed=('invoice',))",
      },
      imports: ["from deep_models import Ledger, Policy"],
    }),
    needValue: async () => undefined,
  };
  const first = await runWithRetries(spec("deep.py", "settle", true), emptyFunctionData(""), handlers, options);
  assert.equal(first.result.return, "(90.0, [])");
  assert.deepEqual(first.data.imports, ["from deep_models import Ledger, Policy"]);
  const second = await runWithRetries(spec("deep.py", "settle", true), first.data, { ...handlers, needArgs: async () => assert.fail("asked again") }, options);
  assert.equal(second.result.return, "(90.0, [])");
});

// --------------------------------------------------------------- edge cases

test("edge cases: the prompt states the limit and the reply is cleaned up", () => {
  const prompt = buildCasesPrompt({ relativePath: "m.py", qualname: "total", context: "CTX", functionSource: "def total(prices, tax=0.2): ...", max: 4, notes: "prices are floats" });
  assert.match(prompt, /Give at most 4 cases/);
  assert.match(prompt, /def total\(prices, tax=0\.2\)/);
  assert.match(prompt, /prices are floats/);

  const reply = `Here:
{"cases": [
  {"title": "1. Typical  basket", "args": {"prices": "[1.0, 2.0]", "tax": 0.2}},
  {"title": "Empty price list", "args": {"prices": []}, "scenario": " nothing external "},
  {"title": "empty price list", "args": {"prices": "[]"}},
  {"title": "", "args": {"self": "X()", "prices": "None"}},
  "junk",
  {"title": "No args key"},
  {"title": "Bad args", "args": "oops"},
  {"title": "Over the limit", "args": {}}
]}`;
  const cases = parseCasesReply(reply, 5);
  assert.deepEqual(cases, [
    { title: "Typical basket", args: { prices: "[1.0, 2.0]", tax: "0.2" }, scenario: undefined },
    { title: "Empty price list", args: { prices: "[]" }, scenario: "nothing external" },
    { title: "empty price list (2)", args: { prices: "[]" }, scenario: undefined },
    { title: "Case 4", args: { prices: "None" }, scenario: undefined },
    { title: "No args key", args: {}, scenario: undefined },
  ]);
  assert.deepEqual(parseCasesReply("nothing", 5), []);
  assert.deepEqual(parseCasesReply('{"cases": "x"}', 5), []);
});

test("runtime: each edge case runs with its own inputs and no argument request", async () => {
  const cases = [
    { title: "Typical", args: { prices: "[10.0, 20.0]", tax: "0.5" } },
    { title: "Empty", args: { prices: "[]" } },
    { title: "Text", args: { prices: "['a']" } },
  ];
  const never: Handlers = { needArgs: async () => assert.fail("arguments were requested"), needValue: async () => undefined };
  const outcomes: string[] = [];
  for (const edge of cases) {
    const data = { ...emptyFunctionData(""), args: edge.args };
    const { result } = await runWithRetries(spec("pure.py", "total", true), data, never, options);
    outcomes.push(result.exception ? result.exception.type : (result.return ?? ""));
  }
  assert.deepEqual(outcomes, ["45.0", "0.0", "TypeError"]);
});
