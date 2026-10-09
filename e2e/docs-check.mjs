// Checks that the walkthrough and the README pictures render from the packaged extension.
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const entry = process.env.CODE_SERVER;
const { chromium } = await import(pathToFileURL(path.join(process.env.PLAYWRIGHT, "index.mjs")).href);
const out = path.join(here, "out", "docs");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "spotrun-docs-"));
const userData = path.join(temp, "user");
const extensions = path.join(temp, "ext");
const workspace = path.join(temp, "shop");
fs.cpSync(path.join(here, "demo-workspace"), workspace, { recursive: true });
fs.mkdirSync(path.join(userData, "User"), { recursive: true });
fs.writeFileSync(path.join(userData, "User", "settings.json"), JSON.stringify({ "security.workspace.trust.enabled": false, "workbench.startupEditor": "none", "chat.disableAIFeatures": true, "workbench.secondarySideBar.defaultVisibility": "hidden" }));
const vsix = fs.readdirSync(root).find((f) => f.endsWith(".vsix"));
const installed = spawnSync(process.execPath, [entry, "--user-data-dir", userData, "--extensions-dir", extensions, "--install-extension", path.join(root, vsix)], { encoding: "utf8" });
if (installed.status !== 0) {
  throw new Error(installed.stdout + installed.stderr);
}
const port = 8700 + Math.floor(Math.random() * 90);
const server = spawn(process.execPath, [entry, "--auth", "none", "--bind-addr", `127.0.0.1:${port}`, "--user-data-dir", userData, "--extensions-dir", extensions, "--disable-telemetry", "--disable-update-check", "--disable-workspace-trust", workspace], { stdio: ["ignore", "pipe", "pipe"] });
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));
let browser;
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n       ${detail}`}`);
  failures += ok ? 0 : 1;
};
try {
  for (let i = 0; i < 100 && !log.includes("HTTP server listening"); i++) {
    await new Promise((r) => setTimeout(r, 200));
  }
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/?folder=${encodeURIComponent(workspace)}`);
  await page.waitForSelector(".monaco-workbench", { timeout: 60000 });
  await page.waitForTimeout(3000);
  // Opening a Python file activates the extension, which opens the walkthrough once.
  await page.locator(".explorer-folders-view .monaco-list-row", { hasText: /^shop\.py$/ }).first().dblclick();
  await page.waitForSelector(".gettingStartedContainer, .getting-started", { timeout: 30000 }).catch(() => undefined);
  await page.waitForTimeout(4000);
  const walkthrough = (await page.locator(".gettingStartedContainer").first().textContent().catch(() => "")) ?? "";
  check("the walkthrough opens after install", walkthrough.includes("Get started with Spot Run") && walkthrough.includes("Find the edge cases"), walkthrough.slice(0, 200));
  await page.screenshot({ path: path.join(out, "walkthrough.png") });
  const media = await page.evaluate(async () => {
    const frames = [...document.querySelectorAll("iframe, webview")];
    return frames.length;
  });
  console.log(`     media frames in the walkthrough: ${media}`);

  // The README pictures: VS Code's extension page and the Marketplace only load
  // pictures over HTTPS, so the packaged README must point at the repository.
  const extensionDir = fs.readdirSync(extensions).find((d) => d.startsWith("kareemlsd.spotrun"));
  const readmeName = fs.readdirSync(path.join(extensions, extensionDir)).find((f) => f.toLowerCase() === "readme.md");
  const readme = fs.readFileSync(path.join(extensions, extensionDir, readmeName), "utf8");
  const links = [...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
  check("the packaged README points its pictures at HTTPS addresses", links.length >= 5 && links.every((l) => l.startsWith("https://")), JSON.stringify(links.slice(0, 2)));
  const packaged = fs.readdirSync(path.join(extensions, extensionDir, "docs", "media"));
  check("the walkthrough's pictures are inside the package", ["run-and-step.gif", "describe-inputs.gif", "edge-cases.gif", "write-tests.gif", "panel.png"].every((f) => packaged.includes(f)), packaged.join(", "));
} catch (error) {
  failures += 1;
  console.log(`FAIL ${error.stack ?? error}`);
} finally {
  await browser?.close();
  server.kill();
}
process.exit(failures === 0 ? 0 : 1);
