import * as vscode from "vscode";

const SMALL = /mini|nano|haiku|flash|lite|small|fast/i;

export const NO_MODEL = "none";

/** Access to the language models VS Code exposes (GitHub Copilot and others). */
export class LanguageModel {
  private cached: vscode.LanguageModelChat | undefined;
  private cachedFor: string | undefined;
  private warned = false;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly log: vscode.OutputChannel) {
    // Editors built on older VS Code versions may not have the Language Model API.
    this.subscription =
      vscode.lm?.onDidChangeChatModels?.(() => {
        this.cached = undefined;
      }) ?? new vscode.Disposable(() => undefined);
  }

  dispose(): void {
    this.subscription.dispose();
  }

  private preference(): string {
    return vscode.workspace.getConfiguration("spotrun").get<string>("model", "").trim();
  }

  enabled(): boolean {
    const config = vscode.workspace.getConfiguration("spotrun");
    return config.get<boolean>("useLanguageModel", true) && this.preference().toLowerCase() !== NO_MODEL;
  }

  async available(): Promise<vscode.LanguageModelChat[]> {
    try {
      const copilot = await vscode.lm.selectChatModels({ vendor: "copilot" });
      const all = await vscode.lm.selectChatModels();
      const seen = new Set(copilot.map((m) => m.id));
      return [...copilot, ...all.filter((m) => !seen.has(m.id))];
    } catch (error) {
      this.log.appendLine(`Listing language models failed: ${String(error)}`);
      return [];
    }
  }

  /** The model to use: the configured one, otherwise the smallest fast model, Copilot first. */
  async pick(): Promise<vscode.LanguageModelChat | undefined> {
    if (!this.enabled()) {
      return undefined;
    }
    const preference = this.preference();
    if (this.cached && this.cachedFor === preference) {
      return this.cached;
    }
    const models = await this.available();
    let chosen: vscode.LanguageModelChat | undefined;
    if (preference) {
      const wanted = preference.toLowerCase();
      // "6-luna" should also match "GPT-6 Luna" or "gpt_6_luna": compare on letters and digits only.
      const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
      chosen =
        models.find((m) => m.id.toLowerCase() === wanted || m.family.toLowerCase() === wanted) ??
        models.find((m) => `${m.id} ${m.family} ${m.name}`.toLowerCase().includes(wanted)) ??
        models.find((m) => [m.id, m.family, m.name].some((field) => squash(field).includes(squash(wanted))));
      if (!chosen && models.length > 0) {
        this.log.appendLine(`Configured model "${preference}" is not available; choosing automatically.`);
      }
    }
    if (!chosen) {
      chosen = models.find((m) => SMALL.test(`${m.family} ${m.id} ${m.name}`)) ?? models[0];
    }
    this.cached = chosen;
    this.cachedFor = preference;
    if (chosen) {
      this.log.appendLine(`Using language model ${chosen.name} (${chosen.vendor}/${chosen.family}).`);
    } else {
      this.log.appendLine("No language model is available; using built-in sample values.");
    }
    return chosen;
  }

  /** Sends one prompt and returns the full reply, or undefined when the model cannot be used. */
  async ask(prompt: string, token: vscode.CancellationToken, timeoutMs = 30000): Promise<string | undefined> {
    const model = await this.pick();
    if (!model) {
      return undefined;
    }
    const source = new vscode.CancellationTokenSource();
    const linked = token.onCancellationRequested(() => source.cancel());
    const timer = setTimeout(() => source.cancel(), timeoutMs);
    try {
      const response = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        { justification: "Spot Run asks the model for sample inputs so it can run your function without touching real systems." },
        source.token,
      );
      let text = "";
      for await (const chunk of response.text) {
        text += chunk;
      }
      return text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof vscode.LanguageModelError ? error.code : "";
      this.log.appendLine(`Language model request failed${code ? ` (${code})` : ""}: ${message}`);
      if (!this.warned && !token.isCancellationRequested) {
        this.warned = true;
        void vscode.window
          .showWarningMessage(`Spot Run could not use the language model${code ? ` (${code})` : ""}. Built-in sample values are used instead.`, "Show Log")
          .then((choice) => {
            if (choice) {
              this.log.show();
            }
          });
      }
      return undefined;
    } finally {
      clearTimeout(timer);
      linked.dispose();
      source.dispose();
    }
  }

  /** Lets the user pick the model. Returns true when the choice changed. */
  async choose(): Promise<boolean> {
    const models = await this.available();
    const preference = this.preference();
    const active = await this.pick();
    type Item = vscode.QuickPickItem & { value: string; real?: boolean };
    const mark = (selected: boolean) => (selected ? "$(check) " : "");
    const items: Item[] = [
      {
        label: `${mark(preference === "")}Automatic`,
        description: "smallest fast model available, GitHub Copilot first" + (preference === "" && active ? ` (now ${active.name})` : ""),
        value: "",
        real: true,
      },
      { label: `${mark(preference.toLowerCase() === NO_MODEL)}None`, description: "built-in sample values only, no model requests", value: NO_MODEL, real: true },
      { label: "Available models", kind: vscode.QuickPickItemKind.Separator, value: "" },
      ...models.map((m) => ({
        label: `${mark(preference !== "" && active?.id === m.id)}${m.name}`,
        description: `${m.vendor} · ${m.family}`,
        detail: m.id,
        value: m.id,
        real: true,
      })),
    ];
    if (models.length === 0) {
      items.push({ label: "No language models found", description: "sign in to GitHub Copilot or install a model provider", value: "" });
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: "Spot Run: language model",
      placeHolder: "Model used to invent inputs and fake values",
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked || !picked.real || picked.value === preference) {
      return false;
    }
    await vscode.workspace.getConfiguration("spotrun").update("model", picked.value, vscode.ConfigurationTarget.Global);
    this.cached = undefined;
    this.cachedFor = undefined;
    return true;
  }

  /** Short label of the model in use, for the status bar. */
  async label(): Promise<string> {
    if (!this.enabled()) {
      return "no model";
    }
    const model = await this.pick();
    return model ? model.name : "no model available";
  }
}
