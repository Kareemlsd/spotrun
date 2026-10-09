# Changelog

## MCP server 0.1.0

- New: `spotrun-mcp`, the engine as an MCP server for coding agents, in `python/`. Tools: `run_function`, `find_edge_cases`, `answer_value`. Inputs and fake values come from a configured small model, from the calling agent, or from guesses. Runs require an OS sandbox by default. The extension itself is unchanged at 0.7.1.

## 0.7.1

- Marked as a preview: verified on Linux with a scripted model; run **Spot Run: Self-Check** on your own setup.
- Added this changelog. No change in behaviour.

## 0.7.0

- Runs go through an operating-system sandbox when one works on the machine: `bubblewrap` on Linux, `sandbox-exec` on macOS. No network, read-only files outside a scratch folder. `spotrun.sandbox` can require it or turn it off. The panel shows which containment was active.
- After an edit ends a replay, saving the file runs the same function or edge case again with the same inputs (`spotrun.rerunOnSave`).
- **Spot Run: Self-Check** verifies the interpreter, the runtime, the guard, the sandbox and the language model on your machine.
- A **Get started with Spot Run** walkthrough with recorded demos, and a rewritten README.

## 0.6.0

- **Write tests**: turns the runs you approved into test functions. The model picks the file from the project's test layout and conventions; nothing existing is overwritten. The new tests are run once with `pytest` under a guard that refuses real side effects, and corrected once if they fail.

## 0.5.0

- **Edge cases**: the model proposes the cases a function treats differently (ten at most by default), each is run once, and a list shows what returned and what raised. `Ctrl+Alt+]` and `Ctrl+Alt+[` move between cases.

## 0.4.2

- A missing module of your own is searched for across the whole workspace folder.
- `spotrun.extraPaths`, `python.analysis.extraPaths` and `PYTHONPATH` from the workspace `.env` file are added to the import path.

## 0.4.1

- Files are imported from more project layouts: packages without `__init__.py` that use relative imports, and source roots below the workspace folder.
- A required environment variable read while the module is imported gets an invented value.
- Import failures state the actual reason and the interpreter used.

## 0.4.0

- **Dig deep**: opt-in. The model may search and read the workspace before proposing inputs, and can use types from other modules through imports.

## 0.3.0

- The language model is chosen from the status bar. The default is automatic: the smallest fast model available, GitHub Copilot first.

## 0.2.0

- **Describe inputs**: a small conversation under the function where you say what the data should look like. Follow-ups refine the previous inputs.

## 0.1.0

- First version: run a Python function with model-generated inputs, lazy fakes for external dependencies, a guard against real side effects, and a step-through replay in the editor.
