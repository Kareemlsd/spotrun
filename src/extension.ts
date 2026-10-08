import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { buildArgsPrompt, buildContext, buildValuePrompt, parseArgsReply, parseValueReply } from "./core/prompts";
import { findByQualname, functionAt, parsePythonFunctions, PyFunction, signatureOf, sourceOf } from "./core/pythonFunctions";
import { ReplayModel, truncate } from "./core/replayModel";
import { Handlers, RunError } from "./core/runtimeProcess";
import { buildRequest, runWithRetries, RunSpec } from "./core/session";
import { emptyFunctionData, FunctionData, NeedArgs, NeedValue } from "./core/types";
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
}

class Controller implements vscode.Disposable {
  private readonly llm: LanguageModel;
  private readonly view: ReplayView;
  private readonly panel = new PanelProvider();
  private readonly status: vscode.StatusBarItem;
  private readonly tree: vscode.TreeView<Node>;
  private readonly modelStatus: vscode.StatusBarItem;
  private readonly chat = new InputChat();
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
          // The recording no longer matches the text. Drop it, keep the target.
          this.clearReplay();
        }
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
          new vscode.CodeLens(range, { title: "$(refresh) New inputs", command: "spotrun.regenerate", arguments: [document.uri, fn.qualname] }),
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

  private async run(target: Target, regenerate: boolean, patch?: (data: FunctionData) => FunctionData): Promise<void> {
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
      data = { ...data, signature, args: null };
    }
    if (regenerate) {
      data = { ...data, args: null, fakes: {} };
    }
    if (patch) {
      data = patch(data);
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
    };

    this.running?.abort();
    const abort = new AbortController();
    this.running = abort;
    const cancel = new vscode.CancellationTokenSource();
    abort.signal.addEventListener("abort", () => cancel.cancel());
    this.lastTarget = target;
    this.status.text = `$(loading~spin) Spot Run: ${target.qualname}`;
    this.status.tooltip = "Running. Use Spot Run: Stop to cancel.";
    this.status.show();
    this.log.appendLine(`\n── ${target.qualname} (${vscode.workspace.asRelativePath(target.uri)}) with ${python}`);

    const handlers = this.handlers(target, fn, text, signature, data, cancel.token);
    const started = Date.now();
    try {
      const outcome = await runWithRetries(spec, data, handlers, {
        python,
        mainScript: this.mainScript(),
        cwd: root,
        timeoutMs: Math.max(1, config.get<number>("timeoutSeconds", 20)) * 1000,
        signal: abort.signal,
        log: (line) => this.log.appendLine(line),
      });
      if (abort.signal.aborted) {
        return;
      }
      await this.context.workspaceState.update(key, outcome.data);
      const result = outcome.result;
      this.runCount += 1;
      if (result.fatal) {
        this.log.appendLine(result.fatal);
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
      const failing = model.failingIndex();
      if (result.exception) {
        model.goTo(failing ?? model.length);
      } else {
        model.goTo(config.get<string>("startAt", "first") === "end" ? model.length : 0);
      }
      this.current = { target, key, spec, data: outcome.data, model, python };
      await this.setContext(true, true);
      this.view.setModel(model);
      this.panel.update(model, outcome.data, chat?.name ?? "");
      this.tree.description = target.qualname;
      this.lensChanged.fire();
      await this.view.reveal();
      this.updateStatus();
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
      if (this.running === abort) {
        this.running = undefined;
        if (!this.current) {
          this.status.hide();
        }
      }
    }
  }

  private mainScript(): string {
    return path.join(this.context.extensionPath, "python", "spotrun_main.py");
  }

  private handlers(target: Target, fn: PyFunction, text: string, signature: string, data: FunctionData, token: vscode.CancellationToken): Handlers {
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
      needArgs: async (need: NeedArgs) => {
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
        return parsed;
      },
      needValue: async (need: NeedValue) => {
        const prompt = buildValuePrompt({
          qualname: target.qualname,
          functionSource: sourceAt(need.file, need.line),
          need,
          known,
          args,
          instructions: data.instructions,
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

  private async setContext(replayActive: boolean, hasResult: boolean): Promise<void> {
    await vscode.commands.executeCommand("setContext", "spotrun.replayActive", replayActive);
    await vscode.commands.executeCommand("setContext", "spotrun.hasResult", hasResult);
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
    this.status.text = `$(${failed ? "error" : "debug-alt-small"}) ${current.target.qualname} · ${position} · ${truncate(model.outcome(), 60)}`;
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
    this.current = undefined;
    this.view.setModel(undefined);
    this.panel.update(undefined);
    this.status.hide();
    this.lensChanged.fire();
    void this.setContext(false, false);
  }

  private stop(): void {
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
  return { state: () => controller.state() };
}

export function deactivate(): void {
  // Subscriptions registered on the context are disposed by VS Code.
}
