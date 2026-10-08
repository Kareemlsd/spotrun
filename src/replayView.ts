import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { defLineFrom } from "./core/pythonFunctions";
import { formatWrites, FrameView, ReplayModel, shortPath, truncate } from "./core/replayModel";

const realCache = new Map<string, string>();

function canonical(file: string): string {
  let real = realCache.get(file);
  if (real === undefined) {
    try {
      real = fs.realpathSync.native(file);
    } catch {
      real = path.resolve(file);
    }
    if (process.platform === "win32" || process.platform === "darwin") {
      real = real.toLowerCase();
    }
    realCache.set(file, real);
  }
  return real;
}

export function sameFile(a: string, b: string): boolean {
  return a === b || canonical(a) === canonical(b);
}

/** Draws the replay position and inline values in editors, like the debugger does. */
export class ReplayView implements vscode.Disposable {
  private model: ReplayModel | undefined;
  private readonly currentLine: vscode.TextEditorDecorationType;
  private readonly callerLine: vscode.TextEditorDecorationType;
  private readonly values: vscode.TextEditorDecorationType;
  private readonly inputs: vscode.TextEditorDecorationType;
  private readonly invented: vscode.TextEditorDecorationType;
  private readonly errors: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(context: vscode.ExtensionContext) {
    this.currentLine = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("editor.stackFrameHighlightBackground"),
      overviewRulerColor: new vscode.ThemeColor("debugIcon.breakpointCurrentStackframeForeground"),
      overviewRulerLane: vscode.OverviewRulerLane.Full,
      gutterIconPath: vscode.Uri.joinPath(context.extensionUri, "media", "current.svg"),
      gutterIconSize: "contain",
    });
    this.callerLine = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("editor.focusedStackFrameHighlightBackground"),
    });
    const after = (color: string, background?: string): vscode.DecorationRenderOptions => ({
      after: {
        color: new vscode.ThemeColor(color),
        backgroundColor: background ? new vscode.ThemeColor(background) : undefined,
        margin: "0 0 0 3ch",
      },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
    });
    this.values = vscode.window.createTextEditorDecorationType(after("editor.inlineValuesForeground", "editor.inlineValuesBackground"));
    this.inputs = vscode.window.createTextEditorDecorationType({
      ...after("editorCodeLens.foreground"),
      fontStyle: "italic",
    });
    this.invented = vscode.window.createTextEditorDecorationType({
      ...after("editorCodeLens.foreground"),
      fontStyle: "italic",
    });
    this.errors = vscode.window.createTextEditorDecorationType(after("editorError.foreground"));

    this.disposables.push(
      this.currentLine,
      this.callerLine,
      this.values,
      this.inputs,
      this.invented,
      this.errors,
      vscode.window.onDidChangeVisibleTextEditors(() => this.render()),
      vscode.languages.registerHoverProvider({ language: "python" }, { provideHover: (document, position) => this.hover(document, position) }),
    );
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }

  setModel(model: ReplayModel | undefined): void {
    this.model = model;
    this.render();
  }

  /** True when `file` is one of the files the current recording covers. */
  covers(file: string): boolean {
    return !!this.model && (this.model.result.files ?? []).some((f) => sameFile(f, file));
  }

  private fileOf(view: FrameView): string {
    return this.model!.result.files[view.frame.file];
  }

  render(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.renderEditor(editor);
    }
  }

  private renderEditor(editor: vscode.TextEditor): void {
    const model = this.model;
    const file = editor.document.uri.fsPath;
    if (!model || editor.document.uri.scheme !== "file" || !this.covers(file)) {
      for (const type of [this.currentLine, this.callerLine, this.values, this.inputs, this.invented, this.errors]) {
        editor.setDecorations(type, []);
      }
      return;
    }
    const document = editor.document;
    const lineCount = document.lineCount;
    const at = (line1: number) => {
      const line = Math.max(0, Math.min(lineCount - 1, line1 - 1));
      const end = document.lineAt(line).range.end;
      return new vscode.Range(end, end);
    };
    const whole = (line1: number) => document.lineAt(Math.max(0, Math.min(lineCount - 1, line1 - 1))).range;

    const valueText = new Map<number, string>();
    const errorText = new Map<number, string>();
    const inputText = new Map<number, string>();
    const current: vscode.Range[] = [];
    const callers: vscode.Range[] = [];

    const stack = model.stack();
    const sourceLines = document.getText().split(/\r?\n/);
    stack.forEach((view, position) => {
      if (!sameFile(this.fileOf(view), file)) {
        return;
      }
      const innermost = position === stack.length - 1;
      const args = formatWrites(view.frame.args, 140);
      if (args) {
        inputText.set(defLineFrom(sourceLines, view.frame.line - 1) + 1, args);
      }
      for (const annotation of view.annotations.values()) {
        const parts: string[] = [];
        const writes = formatWrites(annotation.writes, 140);
        if (writes) {
          parts.push(writes);
        }
        if (annotation.ret !== undefined) {
          parts.push(`→ ${truncate(annotation.ret, 140)}`);
        }
        if (annotation.hits > 1 && parts.length > 0) {
          parts.push(`(×${annotation.hits})`);
        }
        if (parts.length > 0) {
          valueText.set(annotation.line, parts.join("  "));
        }
        if (annotation.exc) {
          errorText.set(annotation.line, `✖ ${truncate(annotation.exc, 160)}`);
        }
      }
      if (view.line !== undefined) {
        (innermost ? current : callers).push(whole(view.line));
      }
    });

    // Values invented for fakes, shown on the line that needed them.
    const inventedText = new Map<number, string>();
    for (const resolution of model.invented()) {
      if (!resolution.file || resolution.line <= 0 || !sameFile(resolution.file, file)) {
        continue;
      }
      const text = `${shortPath(resolution.path)} ≈ ${truncate(resolution.value ?? "", 90)}`;
      const existing = inventedText.get(resolution.line);
      inventedText.set(resolution.line, truncate(existing ? `${existing}, ${text}` : text, 200));
    }

    // Standing on the line that raised: show the error there before stepping past it.
    const here = model.current;
    if (here?.exc && model.result.exception && model.index === model.failingIndex()) {
      const frameFile = model.result.files[model.frames[here.f].file];
      if (sameFile(frameFile, file)) {
        errorText.set(here.l, `✖ ${truncate(here.exc, 160)}`);
      }
    }

    const toOptions = (map: Map<number, string>): vscode.DecorationOptions[] =>
      [...map.entries()].map(([line, text]) => ({ range: at(line), renderOptions: { after: { contentText: text } } }));

    editor.setDecorations(this.currentLine, current);
    editor.setDecorations(this.callerLine, callers);
    editor.setDecorations(this.values, toOptions(valueText));
    editor.setDecorations(this.inputs, toOptions(inputText));
    editor.setDecorations(this.invented, toOptions(inventedText));
    editor.setDecorations(this.errors, toOptions(errorText));
  }

  /** Brings the current line into view, opening its file when stepping into another one. */
  async reveal(): Promise<void> {
    const model = this.model;
    if (!model) {
      return;
    }
    const stack = model.stack();
    const view = stack[stack.length - 1];
    if (!view) {
      return;
    }
    const file = this.fileOf(view);
    const line = (view.line ?? this.lastLine(view)) - 1;
    let editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === "file" && sameFile(e.document.uri.fsPath, file));
    if (!editor) {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      editor = await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
    }
    const safe = Math.max(0, Math.min(editor.document.lineCount - 1, line));
    editor.revealRange(new vscode.Range(safe, 0, safe, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    this.render();
  }

  private lastLine(view: FrameView): number {
    const model = this.model!;
    for (let i = model.steps.length - 1; i >= 0; i--) {
      if (model.steps[i].f === view.frame.id) {
        return model.steps[i].l;
      }
    }
    return view.frame.line;
  }

  private hover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const model = this.model;
    if (!model || document.uri.scheme !== "file" || !this.covers(document.uri.fsPath)) {
      return undefined;
    }
    const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
    if (!range) {
      return undefined;
    }
    const name = document.getText(range);
    const stack = model.stack();
    for (let i = stack.length - 1; i >= 0; i--) {
      const view = stack[i];
      if (!sameFile(this.fileOf(view), document.uri.fsPath)) {
        continue;
      }
      const value = view.locals[name];
      if (value !== undefined) {
        const text = new vscode.MarkdownString();
        text.appendCodeblock(`${name} = ${value}`, "python");
        const where = model.atEnd ? "end of run" : `step ${model.index + 1} of ${model.length}`;
        text.appendMarkdown(`Spot Run · ${where} · \`${view.frame.name}\``);
        return new vscode.Hover(text, range);
      }
    }
    return undefined;
  }
}
