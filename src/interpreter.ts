import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

/** Python interpreter for a file: setting, then the Python extension's choice, then a local venv, then PATH. */
export async function resolvePython(uri: vscode.Uri, log: vscode.OutputChannel): Promise<string> {
  const configured = vscode.workspace.getConfiguration("spotrun", uri).get<string>("pythonPath", "").trim();
  if (configured) {
    return expand(configured, uri);
  }
  const extension = vscode.extensions.getExtension("ms-python.python");
  if (extension) {
    try {
      const api = extension.isActive ? extension.exports : await extension.activate();
      const environments = api?.environments;
      if (environments?.getActiveEnvironmentPath) {
        const active = environments.getActiveEnvironmentPath(uri);
        const resolved = await environments.resolveEnvironment(active);
        const executable: string | undefined = resolved?.executable?.uri?.fsPath ?? active?.path;
        if (executable && fs.existsSync(executable) && fs.statSync(executable).isFile()) {
          return executable;
        }
      }
      const legacy = api?.settings?.getExecutionDetails?.(uri)?.execCommand;
      if (Array.isArray(legacy) && legacy.length > 0) {
        return legacy[0];
      }
    } catch (error) {
      log.appendLine(`Could not read the interpreter from the Python extension: ${String(error)}`);
    }
  }
  const folder = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
  if (folder) {
    for (const name of [".venv", "venv", "env"]) {
      const candidate = process.platform === "win32" ? path.join(folder, name, "Scripts", "python.exe") : path.join(folder, name, "bin", "python");
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return process.platform === "win32" ? "python" : "python3";
}

function expand(value: string, uri: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? "";
  let out = value.replace(/\$\{workspaceFolder\}/g, folder);
  if (out.startsWith("~")) {
    out = path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", out.slice(1));
  }
  return out;
}
