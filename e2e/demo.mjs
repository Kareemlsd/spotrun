// Records the documentation demos in a real VS Code workbench (code-server)
// with the scripted demo model, as numbered frames per scene. docs/build_media.py
// turns the frames into the GIFs and pictures used in the README and walkthrough.
//
//   CODE_SERVER=... PLAYWRIGHT=... CHROMIUM=... node e2e/demo.mjs

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const entry = process.env.CODE_SERVER;
const { chromium } = await import(pathToFileURL(path.join(process.env.PLAYWRIGHT, "index.mjs")).href);

const out = path.join(here, "out", "demo");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "spotrun-demo-"));
const userData = path.join(temp, "user");
const extensions = path.join(temp, "ext");
const workspace = path.join(temp, "shop");
fs.cpSync(path.join(here, "demo-workspace"), workspace, { recursive: true });
fs.mkdirSync(path.join(userData, "User"), { recursive: true });
fs.writeFileSync(
  path.join(userData, "User", "settings.json"),
  JSON.stringify({
    "security.workspace.trust.enabled": false,
    "workbench.startupEditor": "none",
    "workbench.tips.enabled": false,
    "workbench.colorTheme": "Default Dark Modern",
    "editor.minimap.enabled": false,
    "editor.fontSize": 15,
    "breadcrumbs.enabled": false,
    "editor.stickyScroll.enabled": false,
    "window.commandCenter": false,
    "workbench.layoutControl.enabled": false,
    "spotrun.pythonPath": process.env.SPOTRUN_PYTHON ?? "python3",
    "chat.disableAIFeatures": true,
    "spotrun.showWalkthroughOnInstall": false,
    "workbench.secondarySideBar.defaultVisibility": "hidden",
    "workbench.welcomePage.walkthroughs.openOnInstall": false,
  }),
);
const cs = (args) => spawnSync(process.execPath, [entry, "--user-data-dir", userData, "--extensions-dir", extensions, ...args], { encoding: "utf8" });
const vsix = fs.readdirSync(root).find((f) => f.endsWith(".vsix"));
for (const file of [path.join(root, vsix)]) {
  const done = cs(["--install-extension", file]);
  if (done.status !== 0) {
    throw new Error(done.stdout + done.stderr);
  }
}
const fake = path.join(temp, "fake-lm.vsix");
spawnSync(path.join(root, "node_modules", ".bin", "vsce"), ["package", "--no-dependencies", "--skip-license", "--allow-missing-repository", "-o", fake], { cwd: path.join(here, "fake-lm") });
cs(["--install-extension", fake]);

const port = 8900 + Math.floor(Math.random() * 90);
const server = spawn(
  process.execPath,
  [entry, "--auth", "none", "--bind-addr", `127.0.0.1:${port}`, "--user-data-dir", userData, "--extensions-dir", extensions, "--disable-telemetry", "--disable-update-check", "--disable-workspace-trust", workspace],
  { env: { ...process.env, SPOTRUN_FAKE_LM_NAME: "Demo model" }, stdio: ["ignore", "pipe", "pipe"] },
);
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

let browser;
let failed = false;
try {
  for (let i = 0; i < 100 && !serverLog.includes("HTTP server listening"); i++) {
    await new Promise((r) => setTimeout(r, 200));
  }
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  await page.goto(`http://127.0.0.1:${port}/?folder=${encodeURIComponent(workspace)}`);
  await page.waitForSelector(".monaco-workbench", { timeout: 60000 });
  await page.waitForTimeout(3000);

  let scene = "";
  let counter = 0;
  const manifest = {};
  const begin = (name) => {
    scene = name;
    counter = 0;
    manifest[name] = [];
    fs.mkdirSync(path.join(out, name), { recursive: true });
  };
  /** One frame: caption shown under the picture, and how long it is held. */
  const frame = async (caption, holdMs = 1400) => {
    await page.waitForTimeout(350);
    const file = `${String(counter++).padStart(3, "0")}.png`;
    await page.screenshot({ path: path.join(out, scene, file) });
    manifest[scene].push({ file, caption, hold: holdMs });
  };
  const replayShowing = (name) =>
    page.waitForFunction((n) => [...document.querySelectorAll(".statusbar-item")].some((e) => e.textContent.includes(n) && / · (end|\d+\/\d+) · /.test(e.textContent)), name, { timeout: 40000 });
  const lens = (title) => page.locator(".codelens-decoration a", { hasText: title }).first();
  const toastGone = async () => {
    await page.keyboard.press("Control+1");
    await page.evaluate(() => document.querySelectorAll(".notifications-toasts .codicon-notifications-clear, .notification-list-item .codicon-close").forEach((e) => e.click()));
  };

  // Open the file and put the cursor in order_total.
  await page.locator(".explorer-folders-view .monaco-list-row", { hasText: /^shop\.py$/ }).first().dblclick();
  await page.waitForSelector('.tab[aria-label*="shop.py"]', { timeout: 15000 });
  await page.waitForTimeout(600);
  await page.keyboard.press("Control+G");
  await page.waitForSelector(".quick-input-widget:not([style*='display: none']) input", { timeout: 10000 });
  await page.keyboard.type("26", { delay: 20 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  await page.waitForFunction(() => document.querySelectorAll(".codelens-decoration").length > 0, null, { timeout: 30000 });
  // Close the sidebar for a wider editor in the first scenes.
  await page.keyboard.press("Control+B");
  await page.waitForTimeout(500);
  await page.keyboard.press("Control+1");

  // ---- scene 1: run and step
  begin("run-and-step");
  await frame("A function that calls an HTTP API. Put the cursor in it.", 2200);
  await page.keyboard.press("Control+Alt+Enter");
  await replayShowing("order_total");
  await page.waitForTimeout(1500); // first-run panel reveal settles
  await page.keyboard.press("Control+B").catch(() => undefined);
  await page.waitForTimeout(300);
  const sidebarOpen = await page.locator(".part.sidebar").isVisible().catch(() => false);
  if (sidebarOpen) {
    await page.keyboard.press("Control+B");
    await page.waitForTimeout(400);
  }
  await page.keyboard.press("Control+1");
  await frame("Ctrl+Alt+Enter: it runs with invented inputs. Nothing real is called.", 2600);
  const steps = [
    ["F10 steps over. The HTTP call returned a fake.", 1800],
    ["The model decided the status code when the code compared it.", 2200],
    ["", 1000],
    ["The response body was invented when the loop needed it.", 2200],
    ["", 900],
    ["", 900],
    ["", 900],
    ["", 900],
  ];
  for (const [caption, hold] of steps) {
    await page.keyboard.press("F10");
    await frame(caption, hold);
  }
  await page.keyboard.press("F11");
  await frame("F11 steps into your own functions.", 2000);
  await page.keyboard.press("F10");
  await frame("", 900);
  await page.keyboard.press("Shift+F11");
  await frame("Shift+F11 steps out. Shift+F10 steps back.", 1800);
  await page.keyboard.press("F10");
  await page.keyboard.press("F10");
  await frame("Every value stays next to the line that produced it.", 3200);

  // ---- picture: the panel
  begin("panel");
  await page.locator(".statusbar-item", { hasText: "order_total" }).first().click();
  await page.waitForTimeout(1500);
  await page.locator(".pane-header", { hasText: /shop/i }).first().click().catch(() => undefined);
  await page.waitForTimeout(600);
  await page.locator(".pane", { hasText: "Spot Run" }).getByText("Intercepted", { exact: true }).first().click().catch(() => undefined);
  await frame("The panel: inputs, invented values, intercepted calls, variables.");
  await page.keyboard.press("Control+B");
  await page.waitForTimeout(400);

  // ---- scene 2: describe inputs
  begin("describe-inputs");
  await page.keyboard.press("Control+1");
  await frame("The first run used a gold customer.", 1800);
  await lens("Describe inputs").click();
  await page.waitForSelector(".review-widget .comment-form", { timeout: 15000 });
  await frame("Describe inputs opens a small conversation under the function.", 2200);
  await page.locator(".review-widget .comment-form .monaco-editor").last().click();
  await page.keyboard.type("a basic customer with one expensive item", { delay: 10 });
  await frame("Say what the data should look like.", 2200);
  await page.locator(".review-widget").getByText("Run with These Inputs", { exact: true }).last().click();
  await page.waitForFunction(() => [...document.querySelectorAll(".review-widget")].some((w) => w.textContent.includes("Returned")), null, { timeout: 40000 });
  await replayShowing("order_total");
  await frame("The function ran with inputs built to that description.", 3400);
  // Close the conversation again.
  await page.locator(".review-widget a.action-label[aria-label*='Clear Description']").first().click().catch(() => undefined);
  await page.waitForTimeout(600);

  // ---- scene 3: edge cases
  begin("edge-cases");
  await page.keyboard.press("Control+1");
  await page.keyboard.press("Control+Alt+Enter");
  await replayShowing("order_total");
  await frame("Edge cases finds the situations this code treats differently.", 2000);
  await lens("Edge cases").click();
  await page.waitForFunction(() => [...document.querySelectorAll(".quick-input-widget .monaco-list-row")].some((r) => r.textContent.includes("Order without lines")), null, { timeout: 60000 });
  await page.waitForTimeout(500);
  await frame("Each case has a title and has already been run: you see what returned and what raised.", 3600);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await frame("Pick one to step through it.", 1600);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => [...document.querySelectorAll(".statusbar-item")].some((e) => e.textContent.includes("Order not found")), null, { timeout: 30000 });
  await frame("“Order not found”: the replay opens on the line that raised.", 3000);
  await page.keyboard.press("Control+1");
  await page.keyboard.press("Control+Alt+]");
  await page.waitForFunction(() => [...document.querySelectorAll(".statusbar-item")].some((e) => e.textContent.includes("Order without lines")), null, { timeout: 30000 });
  await frame("Ctrl+Alt+] moves to the next case.", 2600);

  // ---- scene 4: write tests
  begin("write-tests");
  await page.keyboard.press("Control+1");
  await frame("Happy with the runs? Write tests turns them into test functions.", 2000);
  await lens("Write tests").click();
  await page.waitForFunction(() => [...document.querySelectorAll(".quick-input-widget .monaco-list-row")].some((r) => r.textContent.includes("Order without lines")), null, { timeout: 30000 });
  await page.waitForTimeout(400);
  await frame("Choose which runs become tests.", 2400);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => [...document.querySelectorAll(".notification-list-item")].some((n) => n.textContent.includes("Spot Run wrote")), null, { timeout: 90000 });
  await page.waitForTimeout(800);
  await frame("The model picked the file, wrote the tests with mocks, and they were run: 4 passed.", 4200);
  const written = fs.existsSync(path.join(workspace, "tests", "test_shop.py"));
  const toast = (await page.locator(".notification-list-item", { hasText: "Spot Run wrote" }).first().textContent()) ?? "";
  if (!written || !toast.includes("4 passed")) {
    throw new Error(`write-tests scene did not end as expected: ${toast}`);
  }
  await toastGone();

  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(Object.entries(manifest).map(([name, frames]) => `${name}: ${frames.length} frames`).join("\n"));
} catch (error) {
  failed = true;
  console.log(`FAIL ${error.stack ?? error}`);
} finally {
  await browser?.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
