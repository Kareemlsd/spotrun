# spotrun-mcp

An MCP server that lets a coding agent run one Python function with invented inputs and read what happened, without writing a test and without touching real services.

It is the engine of the [Spot Run](https://github.com/Kareemlsd/spotrun) VS Code extension behind three tools. Standard library only, Python 3.9 or newer.

## What the agent gets

| Tool | What it does |
| --- | --- |
| `run_function` | Runs a function and reports the return value or the exception and its line, the lines that ran and did not run, the final variables, and everything that was faked. |
| `find_edge_cases` | Runs several named cases and reports each outcome plus the lines no case reached. |
| `answer_value` | Continues a run that paused to ask what a faked dependency should be. |

Calls to the network, databases, subprocesses and file writes do not really happen. They return fakes, and a fake only gets a concrete value when the code uses it: iterates it, compares it, formats it.

A report looks like this:

```
fetch_prices in shop/api.py (line 10)

Outcome: returned []

Arguments:
  base_url = 'https://x.test'  [given]
  min_price = 5.0  [default]

Values invented for faked dependencies:
  requests.get('https://x.test/items').status_code = 404  [you, line 12, eq]

Side effects that did not really happen:
  line 11: requests.get('https://x.test/items') (faked)

Lines that ran: 11-13
Lines that did not run:
  14: data = response.json()
  ...
```

## Install

The package is not on PyPI yet. Run it straight from the repository with [uv](https://docs.astral.sh/uv/):

```
uvx --from "git+https://github.com/Kareemlsd/spotrun#subdirectory=python" spotrun-mcp
```

or install it with pip:

```
pip install "git+https://github.com/Kareemlsd/spotrun#subdirectory=python"
spotrun-mcp --help
```

On Linux install [bubblewrap](https://github.com/containers/bubblewrap) (`apt install bubblewrap`). macOS has `sandbox-exec` built in.

## Connect it to an agent

Claude Code:

```
claude mcp add spotrun -- uvx --from "git+https://github.com/Kareemlsd/spotrun#subdirectory=python" spotrun-mcp
```

VS Code (GitHub Copilot agent mode), in `.vscode/mcp.json`:

```json
{
  "servers": {
    "spotrun": {
      "command": "uvx",
      "args": ["--from", "git+https://github.com/Kareemlsd/spotrun#subdirectory=python", "spotrun-mcp"]
    }
  }
}
```

Cursor and other clients that use the `mcpServers` format:

```json
{
  "mcpServers": {
    "spotrun": {
      "command": "uvx",
      "args": ["--from", "git+https://github.com/Kareemlsd/spotrun#subdirectory=python", "spotrun-mcp"]
    }
  }
}
```

## Who invents the values

There are three sources, and the server uses the first that applies.

**A small model.** Set `SPOTRUN_MODEL` and the server calls that model for arguments, fake values and edge cases. The large agent only says which function to run, optionally with a description such as "the API answers 404". Any OpenAI-compatible endpoint works, and so does the Anthropic API.

```json
"env": {
  "SPOTRUN_MODEL": "qwen2.5-coder:7b",
  "SPOTRUN_BASE_URL": "http://localhost:11434/v1"
}
```

```json
"env": { "SPOTRUN_MODEL": "gpt-4.1-nano", "SPOTRUN_API_KEY": "sk-..." }
```

```json
"env": { "SPOTRUN_MODEL": "claude-haiku-4-5", "SPOTRUN_API_KEY": "sk-ant-..." }
```

**The agent itself.** Without `SPOTRUN_MODEL` nothing needs configuring. The agent passes the arguments, and when a fake needs a value the run pauses and returns a question with a `run_id`. The agent answers through `answer_value` and the run continues from the same line. Answers are remembered, so running the same inputs again does not ask again.

**Guesses.** With `values: "guess"` nothing is asked. Values come from parameter names and type hints. Useful for pure functions.

## Settings

All through the environment of the server.

| Variable | Default | |
| --- | --- | --- |
| `SPOTRUN_MODEL` | | Small model for inputs and fake values |
| `SPOTRUN_BASE_URL` | OpenAI, or Anthropic for `claude` models | Endpoint of that model |
| `SPOTRUN_API_KEY` | `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` | Its key |
| `SPOTRUN_PROVIDER` | detected | `openai` or `anthropic` |
| `SPOTRUN_SANDBOX` | `required` | `required`, `auto` (fall back to the guard alone) or `off` |
| `SPOTRUN_PYTHON` | the project's `.venv`, else `python3` | Interpreter that has the project's dependencies |
| `SPOTRUN_EXTRA_PATHS` | | Extra import folders, separated like `PATH` |
| `SPOTRUN_TIMEOUT` | `30` | Seconds a run may take |
| `SPOTRUN_MAX_CASES` | `10` | Edge cases per call |
| `SPOTRUN_MAX_QUESTIONS` | `12` | Questions to the agent per run before the rest is guessed |
| `SPOTRUN_MAX_MODEL_CALLS` | `30` | Fake values the small model may invent per run |

## Safety

The server executes the project's code, and an agent calls it without anyone watching. So the default is strict:

- The function runs in a separate process inside an OS sandbox with no network and a read-only filesystem: bubblewrap on Linux, `sandbox-exec` on macOS. If no sandbox works on the machine the tools refuse to run. `SPOTRUN_SANDBOX=auto` relaxes that, and on Windows it is the only way to use the server.
- Inside the process a guard replaces effectful libraries with fakes and refuses sockets, subprocesses and file changes that get past them.
- The model settings and key are removed from the environment of the process that runs the function.
- With a small model configured, the source of the function and of the file around it is sent to that model's provider.

## Limits

- Fakes return plausible data, not true data. A run shows how the logic behaves on reasonable inputs. It does not show that a query matches the real schema or that an API returns that shape. The tool descriptions say this to the agent, and every report ends with it.
- `x is None` on a fake is always false.
- Long loops are recorded for the first 200 passes of each line, so the list of executed lines can be incomplete for them. The report says when that happened.
- Developed and tested on Linux, with a scripted model endpoint and the official MCP client library. Not yet run against real model providers, on macOS or on Windows.
