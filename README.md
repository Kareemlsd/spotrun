# Spot Run

Run any Python function on the spot and step through it, without writing a test, a launch configuration or a harness.

Put the cursor in a function and press `Ctrl+Alt+Enter` (`Cmd+Alt+Enter` on macOS), or click **Spot Run** above the `def`. The extension:

1. asks a small language model (GitHub Copilot through the VS Code Language Model API) for realistic arguments,
2. runs the real function in a subprocess where databases, HTTP, subprocesses and file writes are replaced by lazy fakes,
3. records every executed line and shows the result in the editor the way the debugger does: current line highlighted, values inline, hover for variables.

Stepping is a replay of the recording, so it is instant and works backwards.

| Key | Action |
| --- | --- |
| `Ctrl+Alt+Enter` | Run the function at the cursor |
| `Ctrl+Alt+Shift+Enter` | Describe the inputs in your own words, then run |
| `F10` | Step over |
| `F11` | Step into (functions in your workspace are recorded too) |
| `Shift+F11` | Step out |
| `Shift+F10` | Step back |
| `Esc` | Leave the replay |

The keys are only bound while a replay is showing and no debug session is active. Editing the file ends the replay.

## How it works

### Inputs

The model receives the file (or, for large files, its imports, the classes the signature refers to and the function), the parameter list, and up to three existing calls found in test files. It answers with one Python expression per parameter. Expressions are evaluated inside the module's namespace, so they can construct your own dataclasses and enums. For parameters that are sessions, clients or other handles the model answers `FAKE`.

Generated arguments are remembered per function and reused until the signature changes, so a second run makes no model request.

Without a model (no Copilot, consent declined, `spotrun.useLanguageModel` off) the runtime falls back to values derived from type hints and parameter names, and to fakes for everything else. The tool stays usable, the data is just less realistic.

### Dig deep

For functions whose signature says little about the data (untyped parameters, dicts with a particular shape, objects defined elsewhere), click **Dig deep** above a function that has been run, or use the command **Spot Run: Dig Deep**. The model may then look through your workspace before it proposes inputs: it can search, read parts of files, fetch a definition, or list call sites. It answers with arguments, the imports those arguments need for types from other modules, and a short note on the data shapes it found, which is reused when fake values are invented. The Spot Run panel lists every lookup under **Dug deep**.

This is opt-in because it costs more. Each lookup is one more model request (eight at most by default, `spotrun.digDeep.maxLookups`), and parts of the files it reads are sent to the model. The first use asks for confirmation. Dependencies, hidden folders, large files and anything whose name looks like a secret (`.env`, `secrets.*`, key files) are never read. The result is cached like any other inputs, so later runs cost nothing. Set `spotrun.digDeep.always` to dig every time inputs are generated.

### Choosing the model

While a Python file is open, the status bar shows the model in use, for example `Spot Run: GPT-4o mini`. Click it, or run **Spot Run: Select Language Model**, to pick from the models VS Code currently offers (GitHub Copilot's and any other registered provider's), or choose Automatic or None. The choice is stored in your user settings. If a replay is showing, the function runs again with fresh inputs from the new model.

### Describing the inputs

Click **Describe inputs** above a function that has been run, or press `Ctrl+Alt+Shift+Enter` (`Cmd+Alt+Shift+Enter`) in any function. A small conversation opens under the `def` line. Say what the data should look like, for example "one negative price and no tax" or "the API answers 404", and the function runs with inputs built to that description. Follow-ups refine the previous inputs ("make it three prices"). The description steers the fake values as well as the arguments, is remembered for the function, and is used again by **New inputs**. The action in the conversation's title bar clears it. Pinned values still win. This needs a language model.

The conversation uses VS Code's comment threads, so the extension sets the default of `comments.openView` to `never` to keep the Comments panel from opening on its own. Set it back in your settings if you rely on that panel for pull request reviews.

### Lazy fakes

A fake accepts any attribute access, item access or call and returns another fake that remembers the expression that produced it, for example `requests.get('https://shop.test/items').json()['items']`. No model request is made for any of that.

A value is only needed when your code uses a fake as one: iterating it, testing its truth, comparing it, doing arithmetic, formatting it. At that moment the model is asked a narrow question with the expression, the kind of use, the current line and the function source. Its answer is cached per call site. Results that are never used (`session.commit()`) cost nothing.

When a fake reaches code that needs a concrete type (`json.loads(response.text)`), the resulting `TypeError` is used as a hint: the run is repeated and that fake is resolved up front.

### Isolation

Two layers, both independent of the model:

- A fixed table of effectful entry points is patched before your module is imported: `requests`, `httpx`, `urllib`, `aiohttp`, `subprocess`, `os.system`, `smtplib`, `ftplib`, `sqlite3` (files only, `:memory:` is real), `psycopg`, `pymysql`, `pyodbc`, `asyncpg`, SQLAlchemy sessions and engines, `pandas.read_sql`, `pymongo`, `redis`, `boto3`, Google Cloud and Azure storage clients, `openai`, `anthropic`, `paramiko`, `kafka`, `pika`, `elasticsearch`, `docker`, `input()`. `time.sleep` is skipped. File writes go to memory; deletes, renames, copies and `mkdir` are recorded and skipped. The function sees a consistent view of all that through `open`, `os.stat`, `os.path.exists` and `os.listdir`, so a file it wrote can be read back and a file it deleted is gone. Writes under the temp directory are real. A missing required environment variable (`os.environ["KEY"]`) gets an invented value, while `os.environ.get` keeps its default.
- An audit hook is armed while the function runs. Anything that would still open a socket, start a process or modify a file raises `EffectBlocked`, which derives from `BaseException` so that `except Exception` does not swallow it. If the effect came from a library function your code called, that function is patched and the run is repeated automatically.

Every intercepted call is listed in the Spot Run panel.

### Panel

The **Spot Run** section in the Explorer sidebar (click the status bar entry to reveal it) shows the outcome, the inputs, the invented values, intercepted effects, variables at the current step, the call stack and captured output. Inputs and invented values have an edit action: enter a Python expression to pin a value. Pins are never overwritten by the model. This is the way to supply real state the model cannot invent, such as a loaded mesh.

**Open This Run in the Debugger** starts a real `debugpy` session on the same function with the same inputs and cached fake values, stopped at the first line.

## When importing the file fails

The function is imported from its file before it can run, so anything that goes wrong at module level stops the run with "Importing x.py failed: ..." and the reason on the same line. The usual causes:

- **A package is not found.** Spot Run is using a different interpreter than your project. Select the interpreter in the Python extension or set `spotrun.pythonPath`. The message names the interpreter that was used.
- **The file does real work on import**, such as reading a config file, parsing command-line arguments or connecting to something. That code has to succeed first. A missing required environment variable is given an invented value.
- **A circular import** that only works when the file is reached through another module.

- **One of your own modules is not found.** A module anywhere inside the workspace folder is located and its folder added to the import path automatically. For code outside the workspace, list the folder in `spotrun.extraPaths`. `python.analysis.extraPaths` and `PYTHONPATH` from the workspace `.env` file are used as well.

Layouts that are handled automatically: regular packages, packages without `__init__.py` that use relative imports, a `src/` folder, and source roots below the workspace folder (a file in `backend/app/` that says `from app.x import y`).

## Limits you should know

- Fakes return plausible data, not true data. This shows how your logic behaves on reasonable inputs. It does not tell you whether a query is correct against the real schema.
- The guard sees what goes through the Python layer. A C extension that opens files or sockets on its own (HDF5, some database drivers not in the table) is not intercepted. Add such libraries to `PATCHES` in `python/spotrun_runtime/guard.py`.
- Module-level code runs for real when the module is imported. The patch table is active at that point, the audit hook is not.
- `x is None` on a fake is always false, and `isinstance` only works for fakes created from an annotated parameter or a patched class.
- Long loops are recorded for the first 200 passes of each line, 20,000 steps in total. The function still runs to the end.
- Generated expressions are evaluated with the guard armed, but they are model output executed in your interpreter. The same trust applies as to any Copilot suggestion you run.
- Model requests count against your Copilot quota. A first run typically makes one request for the arguments and one per fake value actually used.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `spotrun.useLanguageModel` | `true` | Use a model for inputs and fake values |
| `spotrun.model` | `""` | Model family, id or name. Empty picks the smallest fast model, Copilot first. Set it from the status bar |
| `spotrun.pythonPath` | `""` | Interpreter. Empty uses the Python extension's selection |
| `spotrun.extraPaths` | `[]` | Extra import folders, for your own code outside the workspace |
| `spotrun.scope` | `workspace` | What is recorded for stepping into: `workspace`, `file` or `function` |
| `spotrun.startAt` | `first` | Start the replay on the first line or at the end |
| `spotrun.timeoutSeconds` | `20` | Model wait time excluded |
| `spotrun.maxModelCalls` | `30` | Per run, for fake values |
| `spotrun.digDeep.always` | `false` | Read the workspace every time inputs are generated |
| `spotrun.digDeep.maxLookups` | `8` | Searches and file reads per Dig deep, one model request each |
| `spotrun.codeLens` | `true` | Show the action above functions |
| `spotrun.saveBeforeRun` | `true` | The function is imported from disk |

## Requirements

VS Code 1.95 or later and Python 3.9 or later. GitHub Copilot (or another provider registered with the VS Code Language Model API) for generated values. The Python and Python Debugger extensions are optional: the first supplies the selected interpreter, the second is needed for the debugger hand-off.

## Development

```
npm install
npm run build          # bundle to dist/
npm test               # type check, unit tests, runtime tests
npm run package        # build the .vsix
```

`e2e/run.mjs` installs the packaged extension into a real workbench (code-server), drives it with Playwright and checks what the editor shows. `e2e/fake-lm` is a test-only language model provider with canned answers, so the model path runs without Copilot. It needs three paths:

```
CODE_SERVER=.../code-server/out/node/entry.js \
PLAYWRIGHT=.../node_modules/playwright-core \
CHROMIUM=.../chrome \
npm run test:e2e            # add -- --no-model for the fallback path
```

Layout:

- `python/spotrun_runtime/` is the runtime, standard library only. `fakes.py` has the lazy fake, `guard.py` the patch table and audit hook, `tracer.py` the recorder, `runner.py` the orchestration and the JSON-lines protocol with the extension.
- `src/core/` is editor-independent TypeScript: the function parser, the replay model, the prompts, the process bridge and the retry loop. It is covered by `test/core.test.ts`, which also drives the real runtime.
- `src/*.ts` is the VS Code layer: commands, decorations, the panel, the Language Model API bridge.
- `tests/` holds the pytest suite for the runtime and its sample modules.
