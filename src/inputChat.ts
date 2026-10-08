import * as vscode from "vscode";

/**
 * The small inline conversation under a function's `def` line where the
 * user describes the inputs to test with. It is built on VS Code's comment
 * threads, which give a real in-editor widget with a reply box.
 */
export interface ChatTarget {
  uri: vscode.Uri;
  qualname: string;
}

interface Entry {
  target: ChatTarget;
  thread: vscode.CommentThread;
}

export class InputChat implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private readonly entries = new Map<string, Entry>();

  constructor() {
    this.controller = vscode.comments.createCommentController("spotrun", "Spot Run");
    this.controller.options = {
      prompt: "Describe the inputs to test with",
      placeHolder: "For example: an empty basket and a gold customer, or: the API answers 404",
    };
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      entry.thread.dispose();
    }
    this.entries.clear();
    this.controller.dispose();
  }

  private key(target: ChatTarget): string {
    return `${target.uri.toString()}::${target.qualname}`;
  }

  /** Opens (or re-opens) the conversation for a function at its def line. */
  open(target: ChatTarget, line: number, history: string[]): vscode.CommentThread {
    const key = this.key(target);
    let entry = this.entries.get(key);
    if (!entry) {
      const thread = this.controller.createCommentThread(target.uri, new vscode.Range(line, 0, line, 0), []);
      thread.label = `Inputs for ${target.qualname}`;
      thread.canReply = true;
      thread.contextValue = "spotrun.inputs";
      thread.comments = history.map((text) => this.comment("You", text));
      entry = { target, thread };
      this.entries.set(key, entry);
    }
    entry.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    return entry.thread;
  }

  targetOf(thread: vscode.CommentThread): ChatTarget | undefined {
    for (const entry of this.entries.values()) {
      if (entry.thread === thread) {
        return entry.target;
      }
    }
    return undefined;
  }

  say(thread: vscode.CommentThread, author: "You" | "Spot Run", body: string | vscode.MarkdownString): void {
    thread.comments = [...thread.comments, this.comment(author, body)];
  }

  close(target: ChatTarget): void {
    const key = this.key(target);
    this.entries.get(key)?.thread.dispose();
    this.entries.delete(key);
  }

  private comment(author: string, body: string | vscode.MarkdownString): vscode.Comment {
    return { author: { name: author }, body, mode: vscode.CommentMode.Preview };
  }
}
