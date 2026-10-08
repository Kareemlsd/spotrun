import * as path from "path";
import * as vscode from "vscode";
import { ReplayModel, truncate } from "./core/replayModel";
import { ArgInfo, FunctionData, Resolution } from "./core/types";

export type Node =
  | { kind: "section"; id: string; label: string; description?: string; children: Node[]; expanded: boolean }
  | { kind: "outcome"; label: string; failed: boolean; tooltip: string }
  | { kind: "arg"; arg: ArgInfo; pinned: boolean }
  | { kind: "fake"; resolution: Resolution; pinned: boolean; pinKey: string }
  | { kind: "info"; label: string; description?: string; tooltip?: string; icon?: string; file?: string | null; line?: number }
  | { kind: "variable"; name: string; value: string };

const SOURCE_LABEL: Record<string, string> = {
  llm: "language model",
  cache: "language model (remembered)",
  pin: "pinned by you",
  heuristic: "built-in sample value",
  default: "the parameter's default",
};

export function pinKeyOf(resolution: Resolution): string {
  return `${resolution.path}|${resolution.text}`;
}

/** Side panel: how the run ended, the inputs, invented values, intercepted effects, variables. */
export class PanelProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private model: ReplayModel | undefined;
  private data: FunctionData | undefined;
  private modelName: string | undefined;

  private roots: Node[] = [];
  private readonly parents = new Map<Node, Node>();

  update(model: ReplayModel | undefined, data?: FunctionData, modelName?: string): void {
    this.model = model;
    this.data = data ?? this.data;
    this.modelName = modelName ?? this.modelName;
    this.refresh();
  }

  refresh(): void {
    this.roots = this.build();
    this.parents.clear();
    for (const root of this.roots) {
      if (root.kind === "section") {
        root.children.forEach((child) => this.parents.set(child, root));
      }
    }
    this.changed.fire(undefined);
  }

  /** First node of the tree, used to reveal the view. */
  first(): Node | undefined {
    return this.roots[0];
  }

  getParent(node: Node): Node | undefined {
    return this.parents.get(node);
  }

  getChildren(node?: Node): Node[] {
    if (node) {
      return node.kind === "section" ? node.children : [];
    }
    return this.roots;
  }

  private build(): Node[] {
    const model = this.model;
    if (!model) {
      return [];
    }
    const result = model.result;
    const pins = this.data?.pins ?? { args: {}, fakes: {} };
    const nodes: Node[] = [];

    const failed = !!result.exception;
    nodes.push({
      kind: "outcome",
      label: failed ? `${result.exception!.type}: ${truncate(result.exception!.message, 200)}` : `returned ${truncate(result.return ?? "None", 200)}`,
      failed,
      tooltip: failed
        ? `${result.exception!.type}: ${result.exception!.message}\n\n${result.exception!.frames.map((f) => `${path.basename(f.file)}:${f.line} in ${f.name}\n    ${f.text}`).join("\n")}`
        : `${result.qualname} returned\n${result.return ?? "None"}`,
    });

    nodes.push({
      kind: "section",
      id: "inputs",
      label: "Inputs",
      description:
        (this.modelName ? `via ${this.modelName}` : "built-in sample values") +
        (this.data?.lookups ? ` · dug deep, ${this.data.lookups.length} lookup${this.data.lookups.length === 1 ? "" : "s"}` : "") +
        (this.data?.instructions?.length ? ` · “${truncate(this.data.instructions[this.data.instructions.length - 1], 60)}”` : ""),
      expanded: true,
      children: (result.args ?? []).map((arg) => ({ kind: "arg" as const, arg, pinned: arg.name in pins.args })),
    });

    if (this.data?.lookups && this.data.lookups.length > 0) {
      const children: Node[] = this.data.lookups.map((label) => ({ kind: "info" as const, label, icon: "search", tooltip: "Looked up in your workspace by the model" }));
      if (this.data.notes) {
        children.push({ kind: "info", label: truncate(this.data.notes, 120), icon: "note", tooltip: this.data.notes, description: "" });
      }
      for (const statement of this.data.imports ?? []) {
        children.push({ kind: "info", label: statement, icon: "symbol-namespace", tooltip: "Import the generated inputs rely on" });
      }
      nodes.push({ kind: "section", id: "dig", label: "Dug deep", description: `${this.data.lookups.length}`, expanded: false, children });
    }

    const resolutions = result.resolutions ?? [];
    if (resolutions.length > 0) {
      nodes.push({
        kind: "section",
        id: "fakes",
        label: "Invented values",
        description: `${resolutions.length}`,
        expanded: true,
        children: resolutions.map((resolution) => {
          const pinKey = pinKeyOf(resolution);
          return { kind: "fake" as const, resolution, pinKey, pinned: pinKey in pins.fakes || resolution.path in pins.fakes };
        }),
      });
    }

    const intercepted: Node[] = [];
    for (const blocked of result.blocked ?? []) {
      intercepted.push({
        kind: "info",
        label: blocked.what,
        description: "blocked",
        tooltip: "This would have been a real side effect, so the run was stopped here.",
        icon: "error",
        file: blocked.file,
        line: blocked.line,
      });
    }
    for (const effect of result.effects ?? []) {
      intercepted.push({
        kind: "info",
        label: effect.what,
        description: effect.kind === "faked" ? "replaced by a fake" : effect.kind === "file" ? "kept in memory" : "skipped",
        tooltip: "The real call was not made.",
        icon: "shield",
        file: effect.file,
        line: effect.line,
      });
    }
    if (intercepted.length > 0) {
      nodes.push({ kind: "section", id: "effects", label: "Intercepted", description: `${intercepted.length}`, expanded: false, children: intercepted });
    }

    const stack = model.stack();
    const top = stack[stack.length - 1];
    if (top) {
      nodes.push({
        kind: "section",
        id: "variables",
        label: "Variables",
        description: model.atEnd ? `${top.frame.name} · end of run` : `${top.frame.name} · step ${model.index + 1} of ${model.length}`,
        expanded: true,
        children: Object.entries(top.locals).map(([name, value]) => ({ kind: "variable" as const, name, value })),
      });
    }
    if (stack.length > 1) {
      nodes.push({
        kind: "section",
        id: "stack",
        label: "Call stack",
        expanded: false,
        children: [...stack].reverse().map((view) => ({
          kind: "info" as const,
          label: view.frame.name,
          description: `${path.basename(result.files[view.frame.file])}:${view.line ?? view.frame.line}`,
          icon: "debug-stackframe",
          file: result.files[view.frame.file],
          line: view.line ?? view.frame.line,
        })),
      });
    }

    const output = model
      .output()
      .map((chunk) => chunk.text)
      .join("");
    if (output.trim() !== "") {
      const lines = output.replace(/\n$/, "").split("\n");
      nodes.push({
        kind: "section",
        id: "output",
        label: "Output",
        description: `${lines.length} line${lines.length === 1 ? "" : "s"}`,
        expanded: lines.length <= 12,
        children: lines.slice(-200).map((line) => ({ kind: "info" as const, label: line === "" ? " " : line, icon: "output" })),
      });
    }

    if (result.truncated || result.skipped > 0) {
      nodes.push({
        kind: "info",
        label: result.truncated ? "Recording stopped at the step limit" : `${result.skipped} loop steps not recorded`,
        tooltip: "Long loops are recorded for their first iterations only. The function still ran to the end.",
        icon: "info",
      });
    }
    return nodes;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case "section": {
        const item = new vscode.TreeItem(node.label, node.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `spotrun.section.${node.id}`;
        item.description = node.description;
        return item;
      }
      case "outcome": {
        const item = new vscode.TreeItem(node.label);
        item.iconPath = new vscode.ThemeIcon(node.failed ? "error" : "pass", new vscode.ThemeColor(node.failed ? "testing.iconFailed" : "testing.iconPassed"));
        item.tooltip = node.tooltip;
        return item;
      }
      case "arg": {
        const arg = node.arg;
        const item = new vscode.TreeItem(arg.name);
        item.description = `= ${truncate(arg.value ?? arg.expr ?? "", 120)}`;
        const tooltip = new vscode.MarkdownString();
        tooltip.appendCodeblock(`${arg.name} = ${arg.expr ?? arg.value ?? ""}`, "python");
        tooltip.appendMarkdown(`Source: ${SOURCE_LABEL[node.pinned ? "pin" : (arg.source ?? "heuristic")]}`);
        if (arg.note) {
          tooltip.appendMarkdown(`\n\n${arg.note}`);
        }
        if (arg.error) {
          tooltip.appendMarkdown(`\n\nThe generated expression \`${arg.rejected ?? ""}\` was rejected: ${arg.error}`);
        }
        item.tooltip = tooltip;
        item.iconPath = new vscode.ThemeIcon(node.pinned ? "pinned" : arg.error ? "warning" : arg.source === "llm" || arg.source === "cache" ? "sparkle" : "symbol-parameter");
        item.contextValue = node.pinned ? "spotrun.arg.pinned" : "spotrun.arg";
        return item;
      }
      case "fake": {
        const r = node.resolution;
        const item = new vscode.TreeItem(truncate(r.path, 90));
        item.description = r.error ? `rejected: ${truncate(r.error, 80)}` : `= ${truncate(r.value ?? r.expr ?? "", 120)}`;
        const tooltip = new vscode.MarkdownString();
        tooltip.appendCodeblock(`${r.path}\n= ${r.expr ?? r.value ?? ""}`, "python");
        tooltip.appendMarkdown(`Source: ${SOURCE_LABEL[node.pinned ? "pin" : r.source]}`);
        if (r.text) {
          tooltip.appendMarkdown(`\n\nNeeded at line ${r.line}: \`${r.text}\``);
        }
        item.tooltip = tooltip;
        item.iconPath = new vscode.ThemeIcon(node.pinned ? "pinned" : r.error ? "warning" : r.source === "heuristic" ? "symbol-constant" : "sparkle");
        item.contextValue = node.pinned ? "spotrun.fake.pinned" : "spotrun.fake";
        if (r.file && r.line > 0) {
          item.command = { command: "spotrun.openLocation", title: "Go to Line", arguments: [r.file, r.line] };
        }
        return item;
      }
      case "variable": {
        const item = new vscode.TreeItem(node.name);
        item.description = `= ${truncate(node.value, 160)}`;
        item.tooltip = new vscode.MarkdownString().appendCodeblock(`${node.name} = ${node.value}`, "python");
        item.iconPath = new vscode.ThemeIcon("symbol-variable");
        return item;
      }
      case "info": {
        const item = new vscode.TreeItem(node.label);
        item.description = node.description;
        item.tooltip = node.tooltip ?? node.label;
        if (node.icon) {
          item.iconPath = new vscode.ThemeIcon(node.icon);
        }
        if (node.file && node.line && node.line > 0) {
          item.command = { command: "spotrun.openLocation", title: "Go to Line", arguments: [node.file, node.line] };
        }
        return item;
      }
    }
  }
}
