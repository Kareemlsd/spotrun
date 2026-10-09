import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { createFsHost, dig } from "./core/dig";
import { buildArgsPrompt, buildCasesPrompt, buildContext, buildValuePrompt, parseArgsReply, parseCasesReply, parseValueReply } from "./core/prompts";
import { findByQualname, functionAt, parsePythonFunctions, PyFunction, signatureOf, sourceOf } from "./core/pythonFunctions";
import { ReplayModel, truncate } from "./core/replayModel";
import { Handlers, RunError } from "./core/runtimeProcess";
import { detectSandbox, makeScratch, Sandbox, SandboxMode, scratchEnv } from "./core/sandbox";
import { buildRequest, runWithRetries, RunSpec } from "./core/session";
import { buildTestsPrompt, gatherRepoContext, mergeTests, parseTestsReply, scenarioFromResult, TestScenario, validateTestPath } from "./core/tests";
import { EdgeCase, emptyFunctionData, FunctionData, NeedArgs, NeedValue, RunResult } from "./core/types";
import { InputChat } from "./inputChat";
import { resolvePython } from "./interpreter";
import { LanguageModel } from "./llm";
import { ReplayView, sameFile } from "./replayView";
import { Node, PanelProvider } from "./views";

interface Target {
  uri: vscode.Uri;
  qualname: string;
}

interface Current {
  target: Target;
  key: string;
  spec: RunSpec;
  data: FunctionData;
  model: ReplayModel;
  python: string;
  /** Index of the edge case being shown, when it is one. */
  caseIndex?: number;
}

interface PendingRerun {
  target: Target;
  caseIndex?: number;
}

/** A finished run of an edge case, kept in memory so switching between cases is instant. */
interface CaseRun {
  spec: RunSpec;
  python: string;
  data: FunctionData;
  model: ReplayModel;
}

function outcomeOf(result: RunResult): string {
  return result.exception ? `${result.exception.type}: ${result.exception.message}` : `→ ${result.return ?? "None"}`;
}

class Controller implements vscode.Disposable {
  private readonly llm: LanguageModel;
  private readonly view: ReplayView;
  private readonly panel = new PanelProvider();
  private readonly status: vscode.StatusBarItem;
  private readonly tree: vscode.TreeView<Node>;
  private readonly modelStatus: vscode.StatusBarItem;
  private readonly chat = new InputChat();
  private readonly caseRuns = new Map<string, CaseRun>();
  private batch: vscode.CancellationTokenSource | undefined;
  private chatName = "";
  private containment = "";
  /** What to run again when the edited file is saved. */
  private pendingRerun: PendingRerun | undefined;
  private readonly lensChanged = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  private current: Current | undefined;
  private lastTarget: Target | undefined;
  private running: AbortController | undefined;
  private runCount = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.OutputChannel,
  ) {
    this.llm = new LanguageModel(log);
    this.view = new ReplayView(context);
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.status.command = "spotrun.showPanel";
    this.modelStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.modelStatus.command = "spotrun.selectModel";
    this.tree = vscode.window.createTreeView("spotrun.panel", { treeDataProvider: this.panel });

    const register = (command: string, handler: (...args: any[]) => unknown) =>
      this.disposables.push(vscode.commands.registerCommand(command, handler));

    register("spotrun.run", (uri?: vscode.Uri, qualname?: string) => this.runCommand(uri, qualname, false));
    register("spotrun.regenerate", (uri?: vscode.Uri, qualname?: string) => this.runCommand(uri, qualname, true));
    register("spotrun.stepOver", () => this.move((m) => m.stepOver()));
    register("spotrun.stepInto", () => this.move((m) => m.stepInto()));
    register("spotrun.stepOut", () => this.move((m) => m.stepOut()));
    register("spotrun.stepBack", () => this.move((m) => m.stepBack()));
    register("spotrun.restart", () => this.move((m) => m.goTo(0)));
    register("spotrun.toEnd", () => this.move((m) => m.goTo(m.length)));
    register("spotrun.stop", () => this.stop());
    register("spotrun.debug", () => this.debug());
    register("spotrun.editValue", (node?: Node) => this.editValue(node));
    register("spotrun.unpin", (node?: Node) => this.unpin(node));
    register("spotrun.forget", () => this.forget());
    register("spotrun.selfCheck", () => this.selfCheck());
    register("spotrun.writeTests", () => this.guarded(() => this.writeTests()));
    register("spotrun.edgeCases", (uri?: vscode.Uri, qualname?: string) => this.edgeCases(uri, qualname));
    register("spotrun.showEdgeCase", (index: number) => this.guarded(() => this.showCase(index)));
    register("spotrun.nextEdgeCase", () => this.guarded(() => this.stepCase(1)));
    register("spotrun.previousEdgeCase", () => this.guarded(() => this.stepCase(-1)));
    register("spotrun.digDeep", (uri?: vscode.Uri, qualname?: string) => this.digDeep(uri, qualname));
    register("spotrun.describe", (uri?: vscode.Uri, qualname?: string) => this.describe(uri, qualname));
    register("spotrun.submitInstruction", (reply: vscode.CommentReply) => this.submitInstruction(reply));
    register("spotrun.clearInstruction", (thread: vscode.CommentThread) => this.clearInstruction(thread));
    register("spotrun.selectModel", () => this.selectModel());
    register("spotrun.showLog", () => this.log.show());
    register("spotrun.showPanel", () => this.showPanel());
    register("spotrun.openLocation", (file: string, line: number) => this.openLocation(file, line));

    this.disposables.push(
      this.llm,
      this.chat,
      this.view,
      this.status,
      this.lensChanged,
      this.tree,
      vscode.languages.registerCodeLensProvider(
        { language: "python", scheme: "file" },
        { onDidChangeCodeLenses: this.lensChanged.event, provideCodeLenses: (document) => this.lenses(document) },
      ),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (this.current && event.contentChanges.length > 0 && event.document.uri.scheme === "file" && this.view.covers(event.document.uri.fsPath)) {
          // The recording no longer matches the text. Drop it, and remember
          // what was showing so that saving the file brings it back.
          const pending: PendingRerun = { target: this.current.target, caseIndex: this.current.caseIndex };
          this.clearReplay();
          this.pendingRerun = pending;
          if (vscode.workspace.getConfiguration("spotrun", event.document.uri).get<boolean>("rerunOnSave", true)) {
            this.status.text = `$(history) ${pending.target.qualname} · save to run again`;
            this.status.tooltip = "The replay ended because the file changed. Saving runs the function again with the same inputs. Esc cancels.";
            this.status.show();
            void this.setContext(false, false, true);
          }
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        const pending = this.pendingRerun;
        if (!pending || this.running || document.languageId !== "python") {
          return;
        }
        if (!vscode.workspace.getConfiguration("spotrun", document.uri).get<boolean>("rerunOnSave", true)) {
          return;
        }
        this.pendingRerun = undefined;
        void this.guarded(async () => {
          if (pending.caseIndex !== undefined && this.casesOf(pending.target)[pending.caseIndex]) {
            await this.run(pending.target, false, undefined, false, { index: pending.caseIndex, quiet: false });
          } else {
            await this.run(pending.target, false);
          }
        });
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("spotrun")) {
          this.lensChanged.fire();
          void this.updateModelStatus();
        }
      }),
      this.modelStatus,
      vscode.window.onDidChangeActiveTextEditor(() => void this.updateModelStatus()),
      vscode.lm?.onDidChangeChatModels?.(() => void this.updateModelStatus()) ?? new vscode.Disposable(() => undefined),
    );
    void this.updateModelStatus();
  }

  /** The model in use, shown while a Python file is active. Click to change it. */
  private async updateModelStatus(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "python") {
      this.modelStatus.hide();
      return;
    }
    const label = await this.llm.label();
    this.modelStatus.text = `$(sparkle) Spot Run: ${label}`;
    this.modelStatus.tooltip = "Language model Spot Run uses to invent inputs and fake values. Click to choose another.";
    this.modelStatus.show();
  }

  private async selectModel(): Promise<void> {
    const changed = await this.llm.choose();
    await this.updateModelStatus();
    const current = this.current;
    if (changed && current) {
      // Show what the newly chosen model produces for the function on screen.
      await this.guarded(() => this.run(current.target, true));
    }
  }

  dispose(): void {
    this.running?.abort();
    this.disposables.forEach((d) => d.dispose());
  }

  /** Snapshot for tests and other extensions. */
  state() {
    const current = this.current;
    return {
      running: !!this.running,
      runCount: this.runCount,
      active: !!current,
      qualname: current?.target.qualname,
      index: current?.model.index,
      length: current?.model.length,
      result: current?.model.result,
      data: current?.data,
    };
  }

  // ---------------------------------------------------------------- lenses

  private lenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration("spotrun", document.uri).get<boolean>("codeLens", true)) {
      return [];
    }
    const lenses: vscode.CodeLens[] = [];
    const active = this.current && sameFile(this.current.target.uri.fsPath, document.uri.fsPath) ? this.current.target.qualname : undefined;
    for (const fn of parsePythonFunctions(document.getText())) {
      if (!fn.runnable) {
        continue;
      }
      const range = new vscode.Range(fn.line, 0, fn.line, 0);
      lenses.push(
        new vscode.CodeLens(range, {
          title: "$(play) Spot Run",
          tooltip: "Run this function now with generated inputs and step through it",
          command: "spotrun.run",
          arguments: [document.uri, fn.qualname],
        }),
      );
      if (active === fn.qualname) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: "$(comment) Describe inputs",
            tooltip: "Say in your own words what data the function should be tested with",
            command: "spotrun.describe",
            arguments: [document.uri, fn.qualname],
          }),
          new vscode.CodeLens(range, {
            title: "$(beaker) Edge cases",
            tooltip: "Find the cases this function treats differently, run each, and pick one to step through",
            command: "spotrun.edgeCases",
            arguments: [document.uri, fn.qualname],
          }),
          new vscode.CodeLens(range, {
            title: "$(telescope) Dig deep",
            tooltip: "Let the model read through your codebase before proposing inputs. Better inputs for complicated functions, more tokens.",
            command: "spotrun.digDeep",
            arguments: [document.uri, fn.qualname],
          }),
          new vscode.CodeLens(range, { title: "$(refresh) New inputs", command: "spotrun.regenerate", arguments: [document.uri, fn.qualname] }),
          new vscode.CodeLens(range, {
            title: "$(checklist) Write tests",
            tooltip: "Turn the runs you have looked at into test functions in your codebase",
            command: "spotrun.writeTests",
          }),
          new vscode.CodeLens(range, { title: "$(debug-stop) Stop", command: "spotrun.stop" }),
        );
      }
    }
    return lenses;
  }

  // ------------------------------------------------------------------- run

  /** The function a command refers to: explicit arguments, else the one at the cursor. */
  private targetAtCursor(uri: vscode.Uri | undefined, qualname: string | undefined): Target | undefined {
    if (uri instanceof vscode.Uri && typeof qualname === "string") {
      return { uri, qualname };
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "python") {
      return undefined;
    }
    const functions = parsePythonFunctions(editor.document.getText());
    let line = editor.selection.active.line;
    let fn = functionAt(functions, line);
    // A cursor on a decorator belongs to the definition below it.
    while (!fn && line < editor.document.lineCount - 1 && editor.document.lineAt(line).text.trim().startsWith("@")) {
      line += 1;
      fn = functionAt(functions, line);
    }
    return fn ? { uri: editor.document.uri, qualname: fn.qualname } : undefined;
  }

  private async runCommand(uri: vscode.Uri | undefined, qualname: string | undefined, regenerate: boolean): Promise<void> {
    let target: Target | undefined;
    if (uri instanceof vscode.Uri && typeof qualname === "string") {
      target = { uri, qualname };
    } else if (regenerate && this.current) {
      // "New inputs" during a replay refers to the function being replayed.
      target = this.current.target;
    } else {
      target = this.targetAtCursor(uri, qualname) ?? (regenerate ? this.lastTarget : undefined);
    }
    if (!target) {
      void vscode.window.showInformationMessage("Spot Run: put the cursor inside a Python function first.");
      return;
    }
    await this.guarded(() => this.run(target, regenerate));
  }

  private async guarded(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.log.appendLine(`Unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      this.status.hide();
      void vscode.window.showErrorMessage(`Spot Run failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // --------------------------------------------------------------- dig deep

  private async digDeep(uri: vscode.Uri | undefined, qualname: string | undefined): Promise<void> {
    const explicit = uri instanceof vscode.Uri && typeof qualname === "string";
    const target = this.targetAtCursor(uri, qualname) ?? (explicit ? undefined : (this.current?.target ?? this.lastTarget));
    if (!target) {
      void vscode.window.showInformationMessage("Spot Run: put the cursor inside a Python function first.");
      return;
    }
    if (!(await this.llm.pick())) {
      void vscode.window.showWarningMessage("Spot Run: Dig deep needs a language model, and none is available.");
      return;
    }
    if (!this.context.globalState.get<boolean>("spotrun.digDeepExplained")) {
      const choice = await vscode.window.showInformationMessage(
        "Dig deep lets the model search and read files in this workspace before it proposes inputs. Parts of those files are sent to the model, and a run uses several requests instead of one.",
        { modal: true },
        "Dig Deep",
      );
      if (choice !== "Dig Deep") {
        return;
      }
      await this.context.globalState.update("spotrun.digDeepExplained", true);
    }
    await this.guarded(() => this.run(target, true, undefined, true));
  }

  // ------------------------------------------------------- described inputs

  private async describe(uri: vscode.Uri | undefined, qualname: string | undefined): Promise<void> {
    const explicit = uri instanceof vscode.Uri && typeof qualname === "string";
    const target = this.targetAtCursor(uri, qualname) ?? (explicit ? undefined : this.current?.target);
    if (!target) {
      void vscode.window.showInformationMessage("Spot Run: put the cursor inside a Python function first.");
      return;
    }
    const document = await vscode.workspace.openTextDocument(target.uri);
    const fn = findByQualname(parsePythonFunctions(document.getText()), target.qualname);
    if (!fn) {
      return;
    }
    const stored = this.context.workspaceState.get<FunctionData>(this.storeKey(target));
    const thread = this.chat.open(target, fn.headerEnd, stored?.instructions ?? []);
    const editor = await vscode.window.showTextDocument(document, { preserveFocus: false });
    editor.revealRange(new vscode.Range(fn.line, 0, fn.line, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    // Put the caret in the reply box where the editor supports it.
    try {
      await (thread as unknown as { reveal?: (options: unknown) => Thenable<void> }).reveal?.({ focus: 1 });
    } catch {
      // Not available in this version: the box is one click away.
    }
  }

  private async submitInstruction(reply: vscode.CommentReply): Promise<void> {
    const text = reply?.text?.trim();
    const target = reply ? this.chat.targetOf(reply.thread) : undefined;
    if (!text || !target) {
      return;
    }
    const thread = reply.thread;
    this.chat.say(thread, "You", text);
    if (!(await this.llm.pick())) {
      this.chat.say(thread, "Spot Run", "Described inputs need a language model, and none is available. Sign in to GitHub Copilot or pick a model with **Spot Run: Select Language Model**.");
      return;
    }
    const before = this.current;
    await this.guarded(() =>
      this.run(target, false, (data) => ({
        ...data,
        // New description, new data: drop generated arguments and fake values, keep pins.
        previousArgs: data.args,
        args: null,
        fakes: {},
        instructions: [...(data.instructions ?? []), text].slice(-5),
      })),
    );
    const current = this.current;
    if (!current || current === before || current.target.qualname !== target.qualname) {
      this.chat.say(thread, "Spot Run", "The run did not finish. See **Spot Run: Show Log**.");
      return;
    }
    const result = current.model.result;
    const generated = result.args.some((a) => a.source === "llm");
    const summary = new vscode.MarkdownString();
    const shown = result.args.filter((a) => a.source !== "default");
    summary.appendMarkdown(shown.length > 0 ? shown.map((a) => `\`${a.name} = ${truncate(a.expr ?? a.value ?? "", 120).replace(/`/g, "'")}\``).join("  \n") : "No arguments.");
    summary.appendMarkdown(`\n\n${result.exception ? `Raised \`${truncate(`${result.exception.type}: ${result.exception.message}`, 160).replace(/`/g, "'")}\`` : `Returned \`${truncate(result.return ?? "None", 160).replace(/`/g, "'")}\``}`);
    if (!generated && result.args.some((a) => a.source === "heuristic")) {
      summary.appendMarkdown("\n\nThe model's answer could not be used, so these are built-in sample values. See **Spot Run: Show Log**.");
    }
    const rejected = result.args.filter((a) => a.error);
    if (rejected.length > 0) {
      summary.appendMarkdown(`\n\nRejected: ${rejected.map((a) => `\`${a.name}\` (${truncate(a.error ?? "", 80)})`).join(", ")}`);
    }
    this.chat.say(thread, "Spot Run", summary);
  }

  private async clearInstruction(thread: vscode.CommentThread | undefined): Promise<void> {
    const target = thread ? this.chat.targetOf(thread) : undefined;
    if (!target) {
      return;
    }
    const key = this.storeKey(target);
    const stored = this.context.workspaceState.get<FunctionData>(key);
    if (stored) {
      await this.context.workspaceState.update(key, { ...stored, instructions: [], args: null, fakes: {} });
    }
    this.chat.close(target);
  }

  private storeKey(target: Target): string {
    return `spotrun.fn:${vscode.workspace.asRelativePath(target.uri, true)}::${target.qualname}`;
  }

  private async run(
    target: Target,
    regenerate: boolean,
    patch?: (data: FunctionData) => FunctionData,
    digDeep = false,
    edge?: { index: number; quiet: boolean },
  ): Promise<void> {
    if (target.uri.scheme !== "file") {
      void vscode.window.showWarningMessage("Spot Run works on files saved to disk.");
      return;
    }
    const document = await vscode.workspace.openTextDocument(target.uri);
    const config = vscode.workspace.getConfiguration("spotrun", target.uri);
    if (document.isDirty && config.get<boolean>("saveBeforeRun", true)) {
      await document.save();
    }
    const text = document.getText();
    const functions = parsePythonFunctions(text);
    const fn = findByQualname(functions, target.qualname);
    if (!fn) {
      void vscode.window.showWarningMessage(`Spot Run: cannot find ${target.qualname} in ${path.basename(target.uri.fsPath)}.`);
      return;
    }
    const signature = signatureOf(text, fn);
    const key = this.storeKey(target);
    let data = this.context.workspaceState.get<FunctionData>(key) ?? emptyFunctionData(signature);
    data = { ...emptyFunctionData(signature), ...data, pins: { args: { ...data.pins?.args }, fakes: { ...data.pins?.fakes } } };
    if (data.signature !== signature) {
      data = { ...data, signature, args: null, cases: undefined };
    }
    if (regenerate) {
      data = { ...data, args: null, fakes: {} };
    }
    if (patch) {
      data = patch(data);
    }
    // An edge case runs with its own inputs and fake values; everything else
    // about the function (patches, pinned fakes) is shared with the normal run.
    const stored = data;
    const edgeCase = edge ? stored.cases?.[edge.index] : undefined;
    if (edge && !edgeCase) {
      return;
    }
    if (edgeCase) {
      data = {
        ...stored,
        args: edgeCase.args,
        imports: edgeCase.imports ?? [],
        fakes: edgeCase.fakes ?? {},
        instructions: edgeCase.scenario ? [edgeCase.scenario] : [],
        pins: { args: {}, fakes: stored.pins.fakes },
        lookups: undefined,
      };
    }

    const file = target.uri.fsPath;
    const root = vscode.workspace.getWorkspaceFolder(target.uri)?.uri.fsPath ?? path.dirname(file);
    const python = await resolvePython(target.uri, this.log);
    const chat = await this.llm.pick();
    const spec: RunSpec = {
      file,
      qualname: target.qualname,
      root,
      scope: config.get<string>("scope", "workspace"),
      llm: !!chat,
      limits: { max_llm_calls: config.get<number>("maxModelCalls", 30) },
      extraPaths: this.extraPaths(target.uri, root),
    };

    this.running?.abort();
    this.pendingRerun = undefined;
    const abort = new AbortController();
    this.running = abort;
    const cancel = new vscode.CancellationTokenSource();
    abort.signal.addEventListener("abort", () => cancel.cancel());
    this.lastTarget = target;
    if (!edge?.quiet) {
      this.status.text = `$(loading~spin) Spot Run: ${target.qualname}`;
      this.status.tooltip = "Running. Use Spot Run: Stop to cancel.";
      this.status.show();
    }
    this.chatName = chat?.name ?? "";
    this.log.appendLine(`\n── ${target.qualname}${edgeCase ? ` · edge case “${edgeCase.title}”` : ""} (${vscode.workspace.asRelativePath(target.uri)}) with ${python}`);

    const useDig = digDeep || config.get<boolean>("digDeep.always", false);
    const digSteps = Math.max(1, Math.min(30, config.get<number>("digDeep.maxLookups", 8)));
    const handlers = this.handlers(target, fn, text, signature, data, cancel.token, useDig ? { root, maxSteps: digSteps } : undefined);
    const started = Date.now();
    const sandbox = await this.sandboxFor(python, target.uri);
    if (!sandbox) {
      this.running = undefined;
      cancel.dispose();
      this.updateStatus();
      return;
    }
    const scratch = sandbox.kind === "none" ? undefined : makeScratch();
    try {
      const outcome = await runWithRetries(spec, data, handlers, {
        python,
        mainScript: this.mainScript(),
        cwd: root,
        timeoutMs: Math.max(1, config.get<number>("timeoutSeconds", 20)) * 1000,
        signal: abort.signal,
        log: (line) => this.log.appendLine(line),
        env: scratch ? scratchEnv(scratch) : undefined,
        wrap: scratch ? (command, args) => sandbox.wrap(command, args, root, scratch) : undefined,
      });
      if (abort.signal.aborted) {
        return;
      }
      if (handlers.generated.asked) {
        // New arguments were generated in this run: record how.
        outcome.data.lookups = handlers.generated.lookups;
        outcome.data.notes = handlers.generated.notes ?? (handlers.generated.lookups ? undefined : outcome.data.notes);
      }
      const result = outcome.result;
      let shown = outcome.data;
      if (edgeCase && edge) {
        const cases = [...(stored.cases ?? [])];
        cases[edge.index] = {
          ...edgeCase,
          fakes: outcome.data.fakes,
          outcome: result.fatal ? "could not be run" : outcomeOf(result),
          failed: !!result.fatal || !!result.exception,
          rejected: (result.args ?? []).some((a) => !!a.error),
        };
        await this.context.workspaceState.update(key, { ...stored, patches: outcome.data.patches, eager: outcome.data.eager, cases });
        shown = { ...outcome.data, cases };
      } else {
        await this.context.workspaceState.update(key, outcome.data);
      }
      for (const problem of result.import_errors ?? []) {
        this.log.appendLine(`   import rejected: ${problem}`);
      }
      this.runCount += 1;
      if (result.fatal) {
        this.log.appendLine(result.fatal);
        if (edge?.quiet) {
          return;
        }
        this.status.hide();
        const first = result.fatal.split("\n").find((l) => l.trim() !== "") ?? "The function could not be started.";
        const choice = await vscode.window.showErrorMessage(`Spot Run: ${first}`, "Show Log");
        if (choice) {
          this.log.show();
        }
        return;
      }
      this.log.appendLine(
        `   ${result.exception ? `raised ${result.exception.type}: ${result.exception.message}` : `returned ${result.return}`}` +
          ` · ${result.steps.length} steps · ${outcome.attempts} attempt${outcome.attempts === 1 ? "" : "s"} · ${result.llm_calls} model call${result.llm_calls === 1 ? "" : "s"} · ${Date.now() - started} ms`,
      );
      for (const arg of result.args) {
        if (arg.error) {
          this.log.appendLine(`   argument ${arg.name}: generated expression ${arg.rejected} rejected (${arg.error})`);
        }
      }

      const model = new ReplayModel(result);
      if (edge) {
        this.caseRuns.set(`${key}#${edge.index}`, { spec, python, data: shown, model });
        if (edge.quiet) {
          return;
        }
      }
      await this.present(target, key, { spec, python, data: shown, model }, edge?.index);
      if (!this.context.globalState.get<boolean>("spotrun.panelIntroduced")) {
        // The section starts collapsed in the Explorer. Open it once so it is
        // found; after that VS Code remembers how the user left it.
        await this.context.globalState.update("spotrun.panelIntroduced", true);
        await this.showPanel().catch(() => undefined);
      }
      if (result.exception?.blocked) {
        const what = result.blocked[0]?.what ?? result.exception.message;
        void vscode.window.showWarningMessage(`Spot Run stopped the function before a real side effect: ${what}. Nothing was executed against the outside world.`);
      }
    } catch (error) {
      if (error instanceof RunError) {
        if (error.kind === "cancelled") {
          return;
        }
        this.log.appendLine(`${error.message}\n${error.detail}`);
        if (edge?.quiet) {
          return;
        }
        this.status.hide();
        const choice = await vscode.window.showErrorMessage(`Spot Run: ${error.message}`, "Show Log");
        if (choice) {
          this.log.show();
        }
        return;
      }
      throw error;
    } finally {
      cancel.dispose();
      if (scratch) {
        void fs.promises.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
      }
      if (this.running === abort) {
        this.running = undefined;
        if (!this.current && !edge?.quiet) {
          this.status.hide();
        }
      }
    }
  }

  /** Puts a finished run on screen: replay position, inline values, panel, status. */
  private async present(target: Target, key: string, run: CaseRun, caseIndex?: number): Promise<void> {
    const config = vscode.workspace.getConfiguration("spotrun", target.uri);
    const model = run.model;
    if (model.result.exception) {
      model.goTo(model.failingIndex() ?? model.length);
    } else {
      model.goTo(config.get<string>("startAt", "first") === "end" ? model.length : 0);
    }
    this.current = { target, key, spec: run.spec, data: run.data, model, python: run.python, caseIndex };
    await this.setContext(true, true);
    this.view.setModel(model);
    this.panel.update(model, run.data, this.chatName, caseIndex, this.containment);
    this.tree.description = caseIndex === undefined ? target.qualname : `${target.qualname} · ${run.data.cases?.[caseIndex]?.title ?? ""}`;
    this.lensChanged.fire();
    await this.view.reveal();
    this.updateStatus();
  }

  // ------------------------------------------------------------ self-check

  /**
   * Verifies the whole chain on this machine: interpreter, runtime, guard,
   * OS sandbox and the language model. Meant for the first run after
   * installing and for reporting problems.
   */
  private async selfCheck(): Promise<{ name: string; ok: boolean; detail: string }[]> {
    const results: { name: string; ok: boolean; detail: string }[] = [];
    const note = (name: string, ok: boolean, detail: string) => {
      results.push({ name, ok, detail });
      this.log.appendLine(`  ${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
    };
    const sampleDir = path.join(this.context.extensionPath, "python", "selfcheck");
    const sample = path.join(sampleDir, "spotrun_selfcheck_sample.py");
    const uri = vscode.window.activeTextEditor?.document.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(sample);
    this.log.appendLine(`\n── Self-check (${process.platform}, VS Code ${vscode.version})`);
    this.status.text = "$(loading~spin) Spot Run: self-check";
    this.status.show();
    const silent: Handlers = { needArgs: async () => undefined, needValue: async () => undefined };
    const spec = (qualname: string, llm: boolean): RunSpec => ({ file: sample, qualname, root: sampleDir, scope: "file", llm, limits: {} });
    try {
      const python = await resolvePython(uri, this.log);
      const version = await this.runPython(python, ["-c", "import sys; print('%d.%d.%d' % sys.version_info[:3]); sys.exit(0 if sys.version_info >= (3, 9) else 3)"], sampleDir, undefined, 20000);
      note("Python interpreter", version.code === 0, version.code === 0 ? `${python} (${version.output.trim()})` : `${python}: ${version.output.trim() || "could not be started"}${version.code === 3 ? " — Python 3.9 or later is needed" : ""}`);
      if (version.code !== 0) {
        return results;
      }
      const base = { python, mainScript: this.mainScript(), cwd: sampleDir, timeoutMs: 20000 };

      try {
        const plain = await runWithRetries(spec("discounted", false), emptyFunctionData(""), silent, base);
        const ok = !plain.result.fatal && !plain.result.exception && plain.result.steps.length === 2;
        note("Runtime runs and records a function", ok, ok ? `returned ${plain.result.return} in ${plain.result.steps.length} steps` : (plain.result.fatal ?? plain.result.exception?.message ?? "unexpected trace"));
      } catch (error) {
        note("Runtime runs and records a function", false, error instanceof Error ? error.message : String(error));
      }

      try {
        const blocked = await runWithRetries(spec("calls_out", false), emptyFunctionData(""), silent, base);
        const ok = !!blocked.result.exception?.blocked;
        note("Guard refuses a real network connection", ok, ok ? blocked.result.exception!.message : `not blocked: ${blocked.result.fatal ?? blocked.result.exception?.message ?? blocked.result.return}`);
      } catch (error) {
        note("Guard refuses a real network connection", false, error instanceof Error ? error.message : String(error));
      }

      const mode = vscode.workspace.getConfiguration("spotrun", uri).get<SandboxMode>("sandbox", "auto");
      const sandbox = await detectSandbox(python, mode);
      if (sandbox.kind === "none") {
        note("Operating-system sandbox", mode !== "required", `not active: ${sandbox.reason}. Runs rely on the in-process guard.`);
      } else {
        const scratch = makeScratch();
        try {
          const inside = await runWithRetries(spec("discounted", false), emptyFunctionData(""), silent, {
            ...base,
            env: scratchEnv(scratch),
            wrap: (command, args) => sandbox.wrap(command, args, sampleDir, scratch),
          });
          note("Operating-system sandbox", !inside.result.fatal && !inside.result.exception, `${sandbox.label}; a run inside it returned ${inside.result.return}`);
        } catch (error) {
          note("Operating-system sandbox", false, `${sandbox.kind}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          void fs.promises.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
        }
      }

      const chat = await this.llm.pick();
      if (!chat) {
        note("Language model", false, this.llm.enabled() ? "no model is available. Sign in to GitHub Copilot or install a model provider." : "turned off in the settings (spotrun.useLanguageModel or model None)");
        return results;
      }
      const cancel = new vscode.CancellationTokenSource();
      try {
        const reply = await this.llm.ask('Reply with exactly this JSON object and nothing else: {"value": "42"}', cancel.token, 30000);
        const value = reply === undefined ? undefined : parseValueReply(reply);
        note("Language model answers", value === "42", value === "42" ? `${chat.name} (${chat.vendor}/${chat.family})` : `${chat.name}: ${reply === undefined ? "the request failed, see above in this log" : `unexpected reply: ${truncate(reply, 120)}`}`);

        let asked = false;
        const handlers: Handlers = {
          needArgs: async (need: NeedArgs) => {
            asked = true;
            const answer = await this.llm.ask(
              buildArgsPrompt({ relativePath: "spotrun_selfcheck_sample.py", qualname: "discounted", context: fs.readFileSync(sample, "utf8"), need, usages: [] }),
              cancel.token,
            );
            const parsed = answer === undefined ? undefined : parseArgsReply(answer);
            return parsed ? { args: parsed } : undefined;
          },
          needValue: async () => undefined,
        };
        const full = await runWithRetries(spec("discounted", true), emptyFunctionData(""), handlers, base);
        const generated = (full.result.args ?? []).filter((a) => a.source === "llm");
        const rejected = (full.result.args ?? []).filter((a) => a.error);
        const ok = asked && generated.length > 0 && rejected.length === 0 && !full.result.exception;
        note(
          "Model-generated inputs run",
          ok,
          ok
            ? `discounted(${generated.map((a) => `${a.name}=${a.expr}`).join(", ")}) returned ${full.result.return}`
            : rejected.length > 0
              ? `the model's expression was rejected: ${rejected[0].rejected} (${rejected[0].error})`
              : "the model's reply could not be used as arguments",
        );
      } finally {
        cancel.dispose();
      }
      return results;
    } finally {
      this.updateStatus();
      if (!this.current) {
        this.status.hide();
      }
      const passed = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok);
      const message = `Spot Run self-check: ${passed} of ${results.length} passed.${failed.length > 0 ? ` Failed: ${failed.map((f) => f.name).join("; ")}.` : ""}`;
      void (failed.length > 0 ? vscode.window.showWarningMessage(message, "Show Log") : vscode.window.showInformationMessage(message, "Show Log")).then((choice) => {
        if (choice) {
          this.log.show();
        }
      });
    }
  }

  // ----------------------------------------------------------- write tests

  /** Runs a short Python command and returns its combined output. */
  private runPython(python: string, args: string[], cwd: string, input?: string, timeoutMs = 120000, sandbox?: Sandbox): Promise<{ code: number | null; output: string }> {
    return new Promise((resolve) => {
      const scratch = sandbox && sandbox.kind !== "none" ? makeScratch() : undefined;
      const launch = scratch ? sandbox!.wrap(python, args, cwd, scratch) : { command: python, args };
      const child = spawn(launch.command, launch.args, {
        cwd,
        env: { ...process.env, ...(scratch ? scratchEnv(scratch) : {}), PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" },
        windowsHide: true,
      });
      if (scratch) {
        child.on("close", () => void fs.promises.rm(scratch, { recursive: true, force: true }).catch(() => undefined));
      }
      let output = "";
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ code: null, output: String(error) });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, output });
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(input ?? "");
    });
  }

  private async writeTests(): Promise<void> {
    const current = this.current;
    if (!current) {
      void vscode.window.showInformationMessage("Spot Run: run a function first. The tests are written from the runs you have looked at.");
      return;
    }
    if (!(await this.llm.pick())) {
      void vscode.window.showWarningMessage("Spot Run: writing tests needs a language model, and none is available.");
      return;
    }
    const { target, key, spec, python } = current;
    const root = spec.root;

    // Which runs become tests: the edge cases when there are any, else the run on screen.
    type Candidate = { title: string; result: RunResult };
    const candidates: Candidate[] = [];
    const cases = this.casesOf(target);
    if (cases.length > 0) {
      this.status.text = `$(loading~spin) Spot Run: ${target.qualname} · preparing cases`;
      for (let index = 0; index < cases.length; index++) {
        if (!this.caseRuns.has(`${key}#${index}`)) {
          await this.run(target, false, undefined, false, { index, quiet: true });
        }
        const run = this.caseRuns.get(`${key}#${index}`);
        if (run) {
          candidates.push({ title: cases[index].title, result: run.model.result });
        }
      }
      this.updateStatus();
    }
    if (current.caseIndex === undefined) {
      candidates.unshift({ title: cases.length > 0 ? "Normal run" : "Typical case", result: current.model.result });
    }
    const usable: { title: string; scenario: TestScenario; result: RunResult }[] = [];
    const unusable: string[] = [];
    for (const candidate of candidates) {
      const scenario = scenarioFromResult(candidate.title, candidate.result);
      if (typeof scenario === "string") {
        unusable.push(`${candidate.title} (${scenario})`);
      } else {
        usable.push({ title: candidate.title, scenario, result: candidate.result });
      }
    }
    if (usable.length === 0) {
      void vscode.window.showWarningMessage(`Spot Run: none of the runs can become a test: ${unusable.join(", ")}.`);
      return;
    }
    let chosen = usable;
    if (usable.length > 1) {
      const picked = await vscode.window.showQuickPick(
        usable.map((u) => ({ label: u.title, description: truncate(outcomeOf(u.result), 70), picked: true, entry: u })),
        { canPickMany: true, title: `Write tests for ${target.qualname}`, placeHolder: "Each selected run becomes one test that asserts what you saw" },
      );
      if (!picked || picked.length === 0) {
        return;
      }
      chosen = picked.map((p) => p.entry);
    }

    const document = await vscode.workspace.openTextDocument(target.uri);
    const text = document.getText();
    const fn = findByQualname(parsePythonFunctions(text), target.qualname);
    if (!fn) {
      return;
    }
    const relativePath = path.relative(root, target.uri.fsPath).split(path.sep).join("/");
    this.batch?.cancel();
    const batch = new vscode.CancellationTokenSource();
    this.batch = batch;
    this.status.text = `$(loading~spin) Spot Run: ${target.qualname} · writing tests`;
    this.status.show();
    try {
      const host = createFsHost(root);
      const repo = await gatherRepoContext(host, relativePath, fn.name);
      const prompt = buildTestsPrompt({
        relativePath,
        module: current.model.result.module,
        qualname: target.qualname,
        functionSource: sourceOf(text, fn),
        scenarios: chosen.map((c) => c.scenario),
        repo,
      });
      this.log.appendLine(`\n── ${target.qualname}: writing ${chosen.length} test${chosen.length === 1 ? "" : "s"} (${repo.testFiles.length} existing test files seen${repo.related ? `, ${repo.related.path} already covers this module` : ""})`);

      let original: string | undefined;
      let fileUri: vscode.Uri | undefined;
      let summary = "";
      let passed = false;
      let merged: ReturnType<typeof mergeTests> | undefined;
      let relative = "";
      let conversation = [{ role: "user" as const, text: prompt }] as { role: "user" | "assistant"; text: string }[];

      for (let attempt = 0; attempt < 2; attempt++) {
        const reply = await this.llm.converse(conversation, batch.token, 90000);
        if (batch.token.isCancellationRequested) {
          return;
        }
        const answer = reply === undefined ? undefined : parseTestsReply(reply);
        const valid = answer ? validateTestPath(answer.file) : undefined;
        if (!answer || !valid) {
          this.log.appendLine(`   the model's reply was not usable: ${truncate(reply ?? "(no reply)", 400)}`);
          if (attempt === 0) {
            void vscode.window.showWarningMessage("Spot Run: the model did not return usable tests. See Spot Run: Show Log.");
            return;
          }
          break;
        }
        if (attempt === 0) {
          relative = valid;
          fileUri = vscode.Uri.file(path.join(root, ...relative.split("/")));
          try {
            original = (await vscode.workspace.openTextDocument(fileUri)).getText();
          } catch {
            original = undefined;
          }
          this.log.appendLine(`   target file: ${relative}${original === undefined ? " (new)" : " (existing, appending)"}${answer.reason ? ` · ${answer.reason}` : ""}`);
        }
        const candidate = mergeTests(original, answer.imports, answer.code);
        const syntax = await this.runPython(python, ["-c", "import ast, sys; ast.parse(sys.stdin.read())"], root, candidate.text, 20000);
        if (syntax.code !== 0) {
          this.log.appendLine(`   the generated tests are not valid Python:\n${syntax.output.trim().split("\n").slice(-4).join("\n")}`);
          if (attempt === 0) {
            conversation = [...conversation, { role: "assistant", text: reply ?? "" }, { role: "user", text: `That code is not valid Python:\n${syntax.output.slice(-800)}\nReply with the corrected JSON, same format and same file.` }];
            continue;
          }
          break;
        }
        merged = candidate;

        // Write, then check the new tests under a guard that refuses real side effects.
        const edit = new vscode.WorkspaceEdit();
        if (original === undefined) {
          edit.createFile(fileUri!, { ignoreIfExists: true });
        }
        await vscode.workspace.applyEdit(edit);
        const testDocument = await vscode.workspace.openTextDocument(fileUri!);
        const replace = new vscode.WorkspaceEdit();
        replace.replace(fileUri!, new vscode.Range(0, 0, testDocument.lineCount, 0), merged.text);
        await vscode.workspace.applyEdit(replace);
        await testDocument.save();

        const selector = merged.names.join(" or ");
        const extra = (spec.extraPaths ?? []).flatMap((p) => ["--path", p]);
        const run = await this.runPython(
          python,
          [this.mainScript(), "--pytest", fileUri!.fsPath, "--root", root, ...extra, ...(selector ? ["-k", selector] : [])],
          root,
          undefined,
          120000,
          await detectSandbox(python, vscode.workspace.getConfiguration("spotrun", target.uri).get<SandboxMode>("sandbox", "auto")),
        );
        const lines = run.output.trim().split("\n");
        if (run.output.includes("SPOTRUN_PYTEST_MISSING")) {
          summary = "not checked, because pytest is not installed in this interpreter";
          passed = true;
          break;
        }
        summary = lines.filter((l) => /\b(passed|failed|error|errors)\b/.test(l) && /\bin [\d.]+s/.test(l)).pop()?.replace(/=+/g, "").trim() ?? "could not be run";
        passed = /SPOTRUN_PYTEST_EXIT 0\b/.test(run.output);
        this.log.appendLine(`   check ${attempt + 1}: ${summary}`);
        if (passed) {
          break;
        }
        this.log.appendLine(run.output.trim().split("\n").slice(-60).join("\n"));
        if (attempt === 0) {
          this.status.text = `$(loading~spin) Spot Run: ${target.qualname} · fixing tests`;
          conversation = [
            ...conversation,
            { role: "assistant", text: reply ?? "" },
            {
              role: "user",
              text: `Running those tests gave:\n${run.output.slice(-3500)}\n\nThe observed runs are correct, so the tests are wrong (usually a mock that is incomplete or patched in the wrong place; a real network or file access is refused). Reply with the corrected JSON, same format and same file.`,
            },
          ];
        }
      }

      if (!merged || !fileUri) {
        void vscode.window.showWarningMessage("Spot Run: the model did not produce valid test code. Nothing was written. See Spot Run: Show Log.");
        return;
      }
      const editor = await vscode.window.showTextDocument(fileUri, { preview: false, viewColumn: vscode.ViewColumn.Beside });
      const line = Math.min(merged.line, editor.document.lineCount - 1);
      editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.AtTop);
      editor.selection = new vscode.Selection(line, 0, line, 0);
      const count = merged.names.length;
      const where = `${merged.created ? "new file " : ""}${relative}`;
      const skipped = unusable.length > 0 ? ` Left out: ${unusable.join(", ")}.` : "";
      if (passed) {
        void vscode.window.showInformationMessage(`Spot Run wrote ${count} test${count === 1 ? "" : "s"} to ${where}: ${summary}.${skipped}`);
      } else {
        const choice = await vscode.window.showWarningMessage(
          `Spot Run wrote ${count} test${count === 1 ? "" : "s"} to ${where}, but they do not all pass yet: ${summary}. They assert what you observed, so the usual cause is an incomplete mock.${skipped}`,
          "Show Log",
        );
        if (choice) {
          this.log.show();
        }
      }
    } finally {
      if (this.batch === batch) {
        this.batch = undefined;
      }
      batch.dispose();
      this.updateStatus();
    }
  }

  // ------------------------------------------------------------ edge cases

  private casesOf(target: Target): EdgeCase[] {
    return this.context.workspaceState.get<FunctionData>(this.storeKey(target))?.cases ?? [];
  }

  private async edgeCases(uri: vscode.Uri | undefined, qualname: string | undefined): Promise<void> {
    const explicit = uri instanceof vscode.Uri && typeof qualname === "string";
    const target = this.targetAtCursor(uri, qualname) ?? (explicit ? undefined : (this.current?.target ?? this.lastTarget));
    if (!target) {
      void vscode.window.showInformationMessage("Spot Run: put the cursor inside a Python function first.");
      return;
    }
    await this.guarded(async () => {
      const document = await vscode.workspace.openTextDocument(target.uri);
      const fn = findByQualname(parsePythonFunctions(document.getText()), target.qualname);
      const stored = this.context.workspaceState.get<FunctionData>(this.storeKey(target));
      const fresh = fn && stored?.cases?.length && stored.signature === signatureOf(document.getText(), fn);
      if (fresh) {
        await this.pickCase(target);
      } else {
        await this.findCases(target);
      }
    });
  }

  /** Asks the model for the cases, runs each once, then offers the list. */
  private async findCases(target: Target): Promise<void> {
    if (!(await this.llm.pick())) {
      void vscode.window.showWarningMessage("Spot Run: Edge cases need a language model, and none is available.");
      return;
    }
    const document = await vscode.workspace.openTextDocument(target.uri);
    const config = vscode.workspace.getConfiguration("spotrun", target.uri);
    if (document.isDirty && config.get<boolean>("saveBeforeRun", true)) {
      await document.save();
    }
    const text = document.getText();
    const fn = findByQualname(parsePythonFunctions(text), target.qualname);
    if (!fn) {
      return;
    }
    const signature = signatureOf(text, fn);
    const functionSource = sourceOf(text, fn);
    const key = this.storeKey(target);
    const max = Math.max(1, Math.min(25, config.get<number>("edgeCases.max", 10)));
    const stored = { ...emptyFunctionData(signature), ...(this.context.workspaceState.get<FunctionData>(key) ?? {}) };

    this.batch?.cancel();
    const batch = new vscode.CancellationTokenSource();
    this.batch = batch;
    this.lastTarget = target;
    this.status.text = `$(loading~spin) Spot Run: ${target.qualname} · finding edge cases`;
    this.status.tooltip = "Use Spot Run: Stop to cancel.";
    this.status.show();
    try {
      const reply = await this.llm.ask(
        buildCasesPrompt({
          relativePath: vscode.workspace.asRelativePath(target.uri),
          qualname: target.qualname,
          context: buildContext(text, functionSource, signature, fn.className),
          functionSource,
          max,
          notes: stored.notes,
        }),
        batch.token,
        60000,
      );
      if (batch.token.isCancellationRequested) {
        return;
      }
      const cases = reply === undefined ? [] : parseCasesReply(reply, max);
      if (cases.length === 0) {
        this.log.appendLine(`   edge cases: the model's reply was not usable: ${truncate(reply ?? "(no reply)", 300)}`);
        this.updateStatus();
        void vscode.window.showWarningMessage("Spot Run: the model did not return usable edge cases. See Spot Run: Show Log.");
        return;
      }
      for (const stale of [...this.caseRuns.keys()].filter((k) => k.startsWith(`${key}#`))) {
        this.caseRuns.delete(stale);
      }
      await this.context.workspaceState.update(key, { ...stored, signature, cases });
      this.log.appendLine(`\n── ${target.qualname}: ${cases.length} edge case${cases.length === 1 ? "" : "s"}: ${cases.map((c) => c.title).join(" · ")}`);
      for (let index = 0; index < cases.length; index++) {
        if (batch.token.isCancellationRequested) {
          return;
        }
        this.status.text = `$(loading~spin) Spot Run: ${target.qualname} · case ${index + 1}/${cases.length} · ${truncate(cases[index].title, 40)}`;
        await this.run(target, false, undefined, false, { index, quiet: true });
      }
      if (batch.token.isCancellationRequested) {
        return;
      }
      this.lensChanged.fire();
      this.updateStatus();
      await this.pickCase(target);
    } finally {
      if (this.batch === batch) {
        this.batch = undefined;
      }
      batch.dispose();
      if (!this.current) {
        this.status.hide();
      }
    }
  }

  private async pickCase(target: Target): Promise<void> {
    const cases = this.casesOf(target);
    type Item = vscode.QuickPickItem & { action?: "new" | "normal"; index?: number };
    const shownIndex = this.current && this.current.target.qualname === target.qualname ? this.current.caseIndex : undefined;
    const items: Item[] = cases.map((c, index) => ({
      label: `$(${c.outcome === undefined ? "circle-outline" : c.failed ? "error" : "pass"}) ${c.title}`,
      description: `${index === shownIndex ? "showing · " : ""}${truncate(c.outcome ?? "not run yet", 70)}`,
      detail: truncate(
        Object.entries(c.args)
          .map(([name, expr]) => `${name} = ${expr}`)
          .join(", ") + (c.scenario ? `  ·  ${c.scenario}` : "") + (c.rejected ? "  ·  some inputs were replaced by sample values" : ""),
        160,
      ),
      index,
    }));
    items.push(
      { label: "", kind: vscode.QuickPickItemKind.Separator },
      { label: "$(play) Normal run", description: "the ordinary inputs for this function", action: "normal" },
      { label: "$(refresh) Find edge cases again", description: "one model request, then each case is run", action: "new" },
    );
    const failed = cases.filter((c) => c.failed).length;
    const picked = await vscode.window.showQuickPick(items, {
      title: `Edge cases for ${target.qualname}: ${cases.length - failed} returned, ${failed} raised`,
      placeHolder: "Pick a case to step through it",
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) {
      return;
    }
    if (picked.action === "new") {
      await this.findCases(target);
    } else if (picked.action === "normal") {
      await this.run(target, false);
    } else if (picked.index !== undefined) {
      await this.showCase(picked.index, target);
    }
  }

  private async showCase(index: number, target: Target | undefined = this.current?.target ?? this.lastTarget): Promise<void> {
    if (!target || !this.casesOf(target)[index]) {
      return;
    }
    const key = this.storeKey(target);
    const run = this.caseRuns.get(`${key}#${index}`);
    if (run) {
      // Other cases may have run since: show the latest outcomes in the panel.
      await this.present(target, key, { ...run, data: { ...run.data, cases: this.casesOf(target) } }, index);
    } else {
      await this.run(target, false, undefined, false, { index, quiet: false });
    }
  }

  private async stepCase(delta: number): Promise<void> {
    const target = this.current?.target ?? this.lastTarget;
    if (!target) {
      return;
    }
    const count = this.casesOf(target).length;
    if (count === 0) {
      await this.findCases(target);
      return;
    }
    const from = this.current?.caseIndex ?? (delta > 0 ? -1 : 0);
    await this.showCase((((from + delta) % count) + count) % count, target);
  }

  /**
   * Folders to add to the import path: Spot Run's own setting, the ones the
   * Python extension is configured with, and PYTHONPATH from the workspace
   * .env file, so that imports resolve the way they do elsewhere in the editor.
   */
  private extraPaths(uri: vscode.Uri, root: string): string[] {
    const expand = (value: string) => value.replace(/\$\{workspaceFolder\}/g, root).trim();
    const paths: string[] = [];
    const add = (values: unknown) => {
      if (Array.isArray(values)) {
        for (const value of values) {
          if (typeof value === "string" && value.trim()) {
            paths.push(expand(value));
          }
        }
      }
    };
    add(vscode.workspace.getConfiguration("spotrun", uri).get("extraPaths"));
    const python = vscode.workspace.getConfiguration("python", uri);
    add(python.get("analysis.extraPaths"));
    add(python.get("autoComplete.extraPaths"));
    try {
      const envFile = expand(python.get<string>("envFile") || "${workspaceFolder}/.env");
      const match = /^\s*(?:export\s+)?PYTHONPATH\s*=\s*(.*)$/m.exec(fs.readFileSync(envFile, "utf8"));
      if (match) {
        add(
          match[1]
            .trim()
            .replace(/^["']|["']$/g, "")
            .split(path.delimiter),
        );
      }
    } catch {
      // No .env file, or not readable.
    }
    return [...new Set(paths)];
  }

  /** The OS sandbox for this interpreter, or undefined (with a message shown) when one is required but missing. */
  private async sandboxFor(python: string, uri: vscode.Uri): Promise<Sandbox | undefined> {
    const mode = vscode.workspace.getConfiguration("spotrun", uri).get<SandboxMode>("sandbox", "auto");
    const sandbox = await detectSandbox(python, mode);
    if (sandbox.kind === "none" && mode === "required") {
      void vscode.window.showErrorMessage(`Spot Run: spotrun.sandbox is set to "required", but ${sandbox.reason}. Nothing was run.`);
      return undefined;
    }
    if (this.containment !== sandbox.label) {
      this.log.appendLine(`Containment: ${sandbox.label}${sandbox.reason ? ` (${sandbox.reason})` : ""}`);
    }
    this.containment = sandbox.label;
    return sandbox;
  }

  private mainScript(): string {
    return path.join(this.context.extensionPath, "python", "spotrun_main.py");
  }

  private handlers(
    target: Target,
    fn: PyFunction,
    text: string,
    signature: string,
    data: FunctionData,
    token: vscode.CancellationToken,
    digOptions?: { root: string; maxSteps: number },
  ): Handlers & { generated: { asked: boolean; lookups?: string[]; notes?: string } } {
    const generated: { asked: boolean; lookups?: string[]; notes?: string } = { asked: false };
    let notes = data.notes;
    const functionSource = sourceOf(text, fn);
    const known: { path: string; expr: string }[] = [];
    let args: { name: string; value: string }[] = Object.entries({ ...(data.args ?? {}), ...data.pins.args }).map(([name, value]) => ({ name, value }));
    const sources = new Map<string, string>();

    const sourceAt = (file: string | null, line: number): string => {
      if (!file || line <= 0) {
        return functionSource;
      }
      try {
        let content = sameFile(file, target.uri.fsPath) ? text : sources.get(file);
        if (content === undefined) {
          content = fs.readFileSync(file, "utf8");
          sources.set(file, content);
        }
        const all = parsePythonFunctions(content);
        let best: PyFunction | undefined;
        for (const candidate of all) {
          if (line - 1 >= candidate.line && line - 1 <= candidate.endLine && (!best || candidate.line >= best.line)) {
            best = candidate;
          }
        }
        return best ? sourceOf(content, best) : functionSource;
      } catch {
        return functionSource;
      }
    };

    return {
      generated,
      needArgs: async (need: NeedArgs) => {
        generated.asked = true;
        const usages = await this.findUsages(fn.name, target.uri);
        const prompt = buildArgsPrompt({
          relativePath: vscode.workspace.asRelativePath(target.uri),
          qualname: target.qualname,
          context: buildContext(text, functionSource, signature, fn.className),
          need,
          usages,
          instructions: data.instructions,
          previousArgs: data.previousArgs,
        });
        if (digOptions) {
          this.log.appendLine(`   dig deep: up to ${digOptions.maxSteps} lookups in ${digOptions.root}`);
          const outcome = await dig({
            host: createFsHost(digOptions.root),
            prompt,
            maxSteps: digOptions.maxSteps,
            send: (messages) => this.llm.converse(messages, token),
            onStep: (step, label) => {
              this.log.appendLine(`   dig deep ${step}/${digOptions.maxSteps}: ${label}`);
              this.status.text = `$(loading~spin) Spot Run: ${target.qualname} · digging ${step}/${digOptions.maxSteps} · ${truncate(label, 40)}`;
            },
          });
          this.status.text = `$(loading~spin) Spot Run: ${target.qualname}`;
          if (outcome) {
            generated.lookups = outcome.lookups;
            generated.notes = outcome.notes || undefined;
            notes = generated.notes;
            if (outcome.notes) {
              this.log.appendLine(`   dig deep notes: ${outcome.notes}`);
            }
            args = Object.entries({ ...outcome.args, ...data.pins.args }).map(([name, value]) => ({ name, value }));
            return { args: outcome.args, imports: outcome.imports };
          }
          this.log.appendLine("   dig deep gave no usable answer; asking once without it.");
        }
        const reply = await this.llm.ask(prompt, token);
        if (reply === undefined) {
          return undefined;
        }
        const parsed = parseArgsReply(reply);
        if (!parsed) {
          this.log.appendLine(`   the model's reply for the arguments was not usable: ${truncate(reply, 300)}`);
          return undefined;
        }
        args = Object.entries({ ...parsed, ...data.pins.args }).map(([name, value]) => ({ name, value }));
        return { args: parsed };
      },
      needValue: async (need: NeedValue) => {
        const prompt = buildValuePrompt({
          qualname: target.qualname,
          functionSource: sourceAt(need.file, need.line),
          need,
          known,
          args,
          instructions: data.instructions,
          notes,
        });
        const reply = await this.llm.ask(prompt, token);
        if (reply === undefined) {
          return undefined;
        }
        const expr = parseValueReply(reply);
        if (expr === undefined) {
          this.log.appendLine(`   the model's reply for ${need.path} was not usable: ${truncate(reply, 300)}`);
          return undefined;
        }
        known.push({ path: need.path, expr });
        return expr;
      },
    };
  }

  /** Existing calls of the function in test files, as examples for the model. */
  private async findUsages(name: string, origin: vscode.Uri): Promise<string[]> {
    const search = async (): Promise<string[]> => {
      const files = await vscode.workspace.findFiles(
        "**/{test_*.py,*_test.py,tests/**/*.py,test/**/*.py}",
        "**/{node_modules,.venv,venv,env,site-packages,.git,build,dist}/**",
        40,
      );
      const pattern = new RegExp(`\\b${name.replace(/[^\w]/g, "")}\\(`);
      const snippets: string[] = [];
      for (const file of files) {
        if (snippets.length >= 3 || file.fsPath === origin.fsPath) {
          continue;
        }
        let content: string;
        try {
          const stat = await fs.promises.stat(file.fsPath);
          if (stat.size > 200_000) {
            continue;
          }
          content = await fs.promises.readFile(file.fsPath, "utf8");
        } catch {
          continue;
        }
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length && snippets.length < 3; i++) {
          if (pattern.test(lines[i]) && !/^\s*(async\s+)?def\s/.test(lines[i])) {
            snippets.push(
              lines
                .slice(Math.max(0, i - 2), i + 2)
                .join("\n")
                .slice(0, 600),
            );
            break;
          }
        }
      }
      return snippets;
    };
    try {
      return await Promise.race([search(), new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 700))]);
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------- replay

  private async setContext(replayActive: boolean, hasResult: boolean, waitingForSave = false): Promise<void> {
    await vscode.commands.executeCommand("setContext", "spotrun.replayActive", replayActive);
    await vscode.commands.executeCommand("setContext", "spotrun.hasResult", hasResult);
    await vscode.commands.executeCommand("setContext", "spotrun.waitingForSave", waitingForSave);
  }

  private updateStatus(): void {
    const current = this.current;
    if (!current) {
      this.status.hide();
      return;
    }
    const model = current.model;
    const position = model.atEnd ? "end" : `${model.index + 1}/${model.length}`;
    const failed = !!model.result.exception;
    const caseTitle = current.caseIndex === undefined ? undefined : current.data.cases?.[current.caseIndex]?.title;
    this.status.text = `$(${failed ? "error" : "debug-alt-small"}) ${current.target.qualname}${caseTitle ? ` · “${truncate(caseTitle, 30)}”` : ""} · ${position} · ${truncate(model.outcome(), 60)}`;
    this.status.tooltip = new vscode.MarkdownString(
      "**Spot Run** replay\n\nF10 step over · F11 step into · Shift+F11 step out · Shift+F10 step back · Esc stop\n\nClick to show the Spot Run section in the Explorer.",
    );
    this.status.show();
  }

  private async move(action: (model: ReplayModel) => boolean): Promise<void> {
    const current = this.current;
    if (!current) {
      return;
    }
    action(current.model);
    await this.view.reveal();
    this.panel.refresh();
    this.updateStatus();
  }

  private clearReplay(): void {
    // Recordings no longer match the text or are no longer wanted.
    this.caseRuns.clear();
    this.current = undefined;
    this.view.setModel(undefined);
    this.panel.update(undefined);
    this.status.hide();
    this.lensChanged.fire();
    void this.setContext(false, false);
  }

  private stop(): void {
    this.batch?.cancel();
    this.pendingRerun = undefined;
    this.running?.abort();
    this.running = undefined;
    this.clearReplay();
  }

  private async showPanel(): Promise<void> {
    const first = this.panel.first();
    if (first) {
      // Revealing a node opens the Explorer sidebar and expands the view.
      await this.tree.reveal(first, { select: false, focus: false });
    } else {
      await vscode.commands.executeCommand("spotrun.panel.focus");
    }
  }

  private async openLocation(file: string, line: number): Promise<void> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const editor = await vscode.window.showTextDocument(document, { preview: true });
    const position = new vscode.Position(Math.max(0, line - 1), 0);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    editor.selection = new vscode.Selection(position, position);
  }

  // ------------------------------------------------------------------ pins

  private async editValue(node: Node | undefined): Promise<void> {
    const current = this.current;
    if (!current || !node || (node.kind !== "arg" && node.kind !== "fake")) {
      return;
    }
    const isArg = node.kind === "arg";
    const label = isArg ? node.arg.name : node.resolution.path;
    const initial = isArg ? (node.arg.expr ?? "") : (node.resolution.expr ?? "");
    const expr = await vscode.window.showInputBox({
      title: `Pin a value for ${truncate(label, 80)}`,
      prompt: "A Python expression, evaluated inside the module. Use FAKE for a lazy stand-in object. The function runs again with this value.",
      value: initial,
      valueSelection: [0, initial.length],
      validateInput: (value) => (value.trim() === "" ? "Enter an expression, or press Escape to cancel." : undefined),
    });
    if (expr === undefined) {
      return;
    }
    await this.run(current.target, false, (data) => {
      const pins = { args: { ...data.pins.args }, fakes: { ...data.pins.fakes } };
      if (isArg) {
        pins.args[node.arg.name] = expr.trim();
      } else {
        pins.fakes[node.pinKey] = expr.trim();
      }
      return { ...data, pins };
    });
  }

  private async unpin(node: Node | undefined): Promise<void> {
    const current = this.current;
    if (!current || !node || (node.kind !== "arg" && node.kind !== "fake")) {
      return;
    }
    await this.run(current.target, false, (data) => {
      const pins = { args: { ...data.pins.args }, fakes: { ...data.pins.fakes } };
      if (node.kind === "arg") {
        delete pins.args[node.arg.name];
      } else {
        delete pins.fakes[node.pinKey];
        delete pins.fakes[node.resolution.path];
      }
      return { ...data, pins };
    });
  }

  private async forget(): Promise<void> {
    const target = this.current?.target ?? this.lastTarget;
    if (!target) {
      return;
    }
    await this.context.workspaceState.update(this.storeKey(target), undefined);
    this.chat.close(target);
    this.clearReplay();
    void vscode.window.showInformationMessage(`Spot Run forgot the inputs, invented values and pins for ${target.qualname}.`);
  }

  // ----------------------------------------------------------------- debug

  private async debug(): Promise<void> {
    const current = this.current;
    if (!current) {
      return;
    }
    const result = current.model.result;
    const args: Record<string, string> = {};
    for (const arg of result.args) {
      if (arg.expr && (arg.source === "llm" || arg.source === "cache" || arg.source === "pin")) {
        args[arg.name] = arg.expr;
      }
    }
    const request = { ...buildRequest(current.spec, current.data), args, llm: false, trace: false };
    const requestFile = path.join(os.tmpdir(), `spotrun-request-${process.pid}.json`);
    await fs.promises.writeFile(requestFile, JSON.stringify(request), "utf8");

    const firstLine = current.model.steps.find((s) => s.f === 0)?.l;
    let added: vscode.SourceBreakpoint | undefined;
    if (firstLine) {
      const position = new vscode.Position(firstLine - 1, 0);
      const exists = vscode.debug.breakpoints.some(
        (b) => b instanceof vscode.SourceBreakpoint && sameFile(b.location.uri.fsPath, current.target.uri.fsPath) && b.location.range.start.line === position.line,
      );
      if (!exists) {
        added = new vscode.SourceBreakpoint(new vscode.Location(current.target.uri, position));
        vscode.debug.addBreakpoints([added]);
      }
    }
    const name = `Spot Run: ${current.target.qualname}`;
    const folder = vscode.workspace.getWorkspaceFolder(current.target.uri);
    const target = current.target;
    this.clearReplay();
    this.lastTarget = target;
    const started = await vscode.debug.startDebugging(folder, {
      type: "debugpy",
      request: "launch",
      name,
      program: this.mainScript(),
      args: ["--request", requestFile],
      cwd: current.spec.root,
      python: current.python,
      console: "internalConsole",
      justMyCode: true,
    });
    const cleanup = () => {
      if (added) {
        vscode.debug.removeBreakpoints([added]);
      }
      void fs.promises.unlink(requestFile).catch(() => undefined);
    };
    if (!started) {
      cleanup();
      void vscode.window.showWarningMessage("Spot Run could not start the debugger. The Python Debugger extension (ms-python.debugpy) is required for this.");
      return;
    }
    const listener = vscode.debug.onDidTerminateDebugSession((session) => {
      if (session.name === name) {
        cleanup();
        listener.dispose();
      }
    });
    this.disposables.push(listener);
  }
}

export function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel("Spot Run");
  const controller = new Controller(context, log);
  context.subscriptions.push(log, controller);
  if (!context.globalState.get<boolean>("spotrun.walkthroughShown")) {
    void context.globalState.update("spotrun.walkthroughShown", true);
    if (vscode.workspace.getConfiguration("spotrun").get<boolean>("showWalkthroughOnInstall", true)) {
      void vscode.commands.executeCommand("workbench.action.openWalkthrough", `${context.extension.id}#start`, false);
    }
  }
  return { state: () => controller.state() };
}

export function deactivate(): void {
  // Subscriptions registered on the context are disposed by VS Code.
}
