// End-to-end check in a real VS Code workbench (code-server) driven by Playwright.
//
//   CODE_SERVER=/path/to/code-server/out/node/entry.js \
//   PLAYWRIGHT=/path/to/node_modules/playwright-core \
//   CHROMIUM=/path/to/chrome \
//   node e2e/run.mjs [--no-model]
//
// Installs the packaged extension (and, unless --no-model, the test language
// model in e2e/fake-lm), runs functions from e2e/workspace and checks what the
// editor shows. Screenshots are written to e2e/out/.

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const entry = process.env.CODE_SERVER;
const chromiumPath = process.env.CHROMIUM;
const withModel = !process.argv.includes("--no-model");
const { chromium } = await import(pathToFileURL(path.join(process.env.PLAYWRIGHT, "index.mjs")).href);

const out = path.join(here, "out");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "spotrun-e2e-"));
const userData = path.join(temp, "user");
const extensions = path.join(temp, "ext");
const workspace = path.join(temp, "workspace");
fs.cpSync(path.join(here, "workspace"), workspace, { recursive: true });
fs.mkdirSync(path.join(userData, "User"), { recursive: true });
fs.writeFileSync(
  path.join(userData, "User", "settings.json"),
  JSON.stringify({
    "security.workspace.trust.enabled": false,
    "workbench.startupEditor": "none",
    "workbench.tips.enabled": false,
    "workbench.colorTheme": "Default Dark Modern",
    "editor.minimap.enabled": false,
    "editor.fontSize": 14,
    "spotrun.pythonPath": process.env.SPOTRUN_PYTHON ?? "python3",
    "chat.disableAIFeatures": true,
    "workbench.secondarySideBar.defaultVisibility": "hidden",
  }),
);

const lmLog = path.join(out, "prompts.log");
const cs = (args, options = {}) => spawnSync(process.execPath, [entry, "--user-data-dir", userData, "--extensions-dir", extensions, ...args], { encoding: "utf8", ...options });

const vsix = fs.readdirSync(root).find((f) => f.endsWith(".vsix"));
let installed = cs(["--install-extension", path.join(root, vsix)]);
if (installed.status !== 0) {
  throw new Error(`installing ${vsix} failed:\n${installed.stdout}\n${installed.stderr}`);
}
if (withModel) {
  const fake = path.join(temp, "fake-lm.vsix");
  const packed = spawnSync(path.join(root, "node_modules", ".bin", "vsce"), ["package", "--no-dependencies", "--skip-license", "--allow-missing-repository", "-o", fake], {
    cwd: path.join(here, "fake-lm"),
    encoding: "utf8",
  });
  if (packed.status !== 0) {
    throw new Error(`packaging the test model failed:\n${packed.stdout}\n${packed.stderr}`);
  }
  installed = cs(["--install-extension", fake]);
  if (installed.status !== 0) {
    throw new Error(`installing the test model failed:\n${installed.stdout}\n${installed.stderr}`);
  }
}

const port = 8300 + Math.floor(Math.random() * 500);
const server = spawn(
  process.execPath,
  [entry, "--auth", "none", "--bind-addr", `127.0.0.1:${port}`, "--user-data-dir", userData, "--extensions-dir", extensions, "--disable-telemetry", "--disable-update-check", "--disable-workspace-trust", workspace],
  { env: { ...process.env, SPOTRUN_FAKE_LM_LOG: lmLog }, stdio: ["ignore", "pipe", "pipe"] },
);
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

const failures = [];
const check = (name, condition, detail = "") => {
  console.log(`${condition ? "ok  " : "FAIL"} ${name}${condition || !detail ? "" : `\n       ${detail}`}`);
  if (!condition) {
    failures.push(name);
  }
};

let browser;
let page;
try {
  for (let i = 0; i < 100 && !serverLog.includes("HTTP server listening"); i++) {
    await new Promise((r) => setTimeout(r, 200));
  }
  browser = await chromium.launch({ executablePath: chromiumPath, args: ["--no-sandbox"] });
  page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/?folder=${encodeURIComponent(workspace)}`);
  await page.waitForSelector(".monaco-workbench", { timeout: 60000 });
  await page.waitForTimeout(3000);

  const shot = (name) => page.screenshot({ path: path.join(out, `${name}.png`) });
  const palette = async (command) => {
    await page.keyboard.press("F1");
    await page.waitForSelector(".quick-input-widget:not([style*='display: none']) input", { timeout: 10000 });
    await page.keyboard.type(command, { delay: 5 });
    await page.waitForTimeout(500);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
  };
  const open = async (file, line) => {
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+Shift+E");
    await page.waitForSelector(".explorer-folders-view", { timeout: 10000 });
    await page.locator(".explorer-folders-view .monaco-list-row", { hasText: file }).first().dblclick();
    await page.waitForSelector(`.tab[aria-label*="${file}"]`, { timeout: 15000 });
    await page.waitForTimeout(500);
    await page.keyboard.press("Control+G");
    await page.waitForSelector(".quick-input-widget:not([style*='display: none']) input", { timeout: 10000 });
    await page.keyboard.type(String(line), { delay: 5 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
  };
  const statusText = async () =>
    (await page.locator(".statusbar-item").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim()).find((t) => / · (end|\d+\/\d+) · /.test(t)) ?? "";
  const waitForReplay = async (qualname) => {
    await page.waitForFunction(
      (name) => [...document.querySelectorAll(".statusbar-item")].some((e) => e.textContent.includes(name) && / · (end|\d+\/\d+) · /.test(e.textContent)),
      qualname,
      { timeout: 40000 },
    );
    await page.waitForTimeout(600);
    return statusText();
  };
  // Inline values are rendered through generated CSS (::after content).
  const inlineTexts = () =>
    page.evaluate(() => {
      const classes = new Set();
      document.querySelectorAll(".view-lines span[class*='TextEditorDecorationType']").forEach((el) => el.classList.forEach((c) => classes.add(c)));
      const texts = [];
      for (const sheet of document.styleSheets) {
        let rules;
        try {
          rules = sheet.cssRules;
        } catch {
          continue;
        }
        for (const rule of rules) {
          if (rule.selectorText && rule.selectorText.includes("::after") && rule.style && rule.style.content) {
            const cls = rule.selectorText.replace("::after", "").replace(/^\./, "").split(".").pop();
            if ([...classes].some((c) => rule.selectorText.includes(c)) || classes.has(cls)) {
              texts.push(rule.style.content.replace(/^['"]|['"]$/g, "").replace(/\\"/g, '"').replace(/\\'/g, "'"));
            }
          }
        }
      }
      return texts;
    });
  const currentLineText = () =>
    page.evaluate(() => {
      // The current line is the one with the gutter arrow.
      const marker = document.querySelector(".glyph-margin-widgets [class*='TextEditorDecorationType'], .margin-view-overlays [class*='TextEditorDecorationType']");
      if (!marker) {
        return null;
      }
      const top = marker.style.top || marker.parentElement.style.top;
      const line = [...document.querySelectorAll(".view-lines .view-line")].find((l) => l.style.top === top);
      return line ? line.textContent.replace(/\u00a0/g, " ").trim() : null;
    });

  // ---- 1. code lens
  await open("pure.py", 20);
  await page.waitForFunction(() => document.querySelectorAll(".codelens-decoration").length > 0, null, { timeout: 30000 }).catch(() => undefined);
  const lensCount = await page.locator(".codelens-decoration", { hasText: "Spot Run" }).count();
  check("code lens appears above functions", lensCount > 0, `found ${lensCount}`);
  await shot("01-codelens");

  // ---- 2. plain function through the command
  await page.locator(".view-lines").first().click({ position: { x: 300, y: 20 } });
  await open("pure.py", 21);
  await palette("Spot Run: Run Function at Cursor");
  let status = await waitForReplay("total");
  check("status bar shows the replay position", /total · 1\/\d+ · → /.test(status), status);
  check("replay starts on the first line of the body", (await currentLineText()) === "subtotal = 0.0", String(await currentLineText()));
  let inline = await inlineTexts();
  check("arguments are shown on the def line", inline.some((t) => t.startsWith("prices = ")), JSON.stringify(inline));
  await shot("02-total-first-step");

  await page.keyboard.press("F10");
  await page.keyboard.press("F10");
  await page.waitForTimeout(500);
  status = await statusText();
  inline = await inlineTexts();
  check("F10 advances the replay", /total · 3\/\d+/.test(status), status);
  check("inline values appear for executed lines", inline.some((t) => t.includes("subtotal = 0.0")) && inline.some((t) => t.startsWith("price = ")), JSON.stringify(inline));
  await page.keyboard.press("Shift+F10");
  await page.waitForTimeout(400);
  check("Shift+F10 steps back", /total · 2\/\d+/.test(await statusText()), await statusText());
  await palette("Spot Run: Go to End");
  await page.waitForTimeout(500);
  inline = await inlineTexts();
  check("the return value is shown at the end", inline.some((t) => /→ \d/.test(t)), JSON.stringify(inline));
  await shot("03-total-end");

  // ---- 3. step into a helper
  await open("pure.py", 28);
  await palette("Spot Run: Run Function at Cursor");
  status = await waitForReplay("discount");
  inline = await inlineTexts();
  if (withModel) {
    check("the model's arguments are used", inline.some((t) => t.includes("Tier.GOLD") && t.includes("Ada")), JSON.stringify(inline));
  }
  for (let i = 0; i < 12 && (await currentLineText()) !== "reduced = amount * (1 - rate)"; i++) {
    await page.keyboard.press("F11");
    await page.waitForTimeout(250);
  }
  check("F11 steps into a function in the same workspace", (await currentLineText()) === "reduced = amount * (1 - rate)", String(await currentLineText()));
  await shot("04-step-into");
  await page.keyboard.press("Shift+F11");
  await page.waitForTimeout(400);
  await shot("05-step-out");

  // ---- 4. HTTP call replaced by a fake
  await open("effects.py", 12);
  await palette("Spot Run: Run Function at Cursor");
  status = await waitForReplay("fetch_prices");
  await palette("Spot Run: Go to End");
  await page.waitForTimeout(600);
  status = await statusText();
  inline = await inlineTexts();
  if (withModel) {
    check("fake HTTP response is filled by the model", status.includes("['desk', 'lamp']"), status);
    check("loop variables show invented rows", inline.some((t) => t.startsWith("item = ") && t.includes("'lamp'")), JSON.stringify(inline));
    check("invented values are shown where they were needed", inline.some((t) => t.includes(".status_code ≈ 200")), JSON.stringify(inline));
  } else {
    check("fake HTTP response falls back to sample values", /fetch_prices · end · → \[/.test(status), status);
  }
  await shot("06-http-fake");

  // ---- 5. the panel
  await page.locator(".statusbar-item", { hasText: "fetch_prices" }).first().click();
  await page.waitForTimeout(1500);
  // Collapse the file tree so the whole Spot Run section is rendered.
  await page.locator(".pane-header", { hasText: "workspace" }).first().click();
  await page.waitForTimeout(800);
  const panelText = (await page.locator(".pane", { hasText: "Spot Run" }).allTextContents()).join(" ");
  check("panel lists inputs", panelText.includes("Inputs") && panelText.includes("base_url"), panelText.slice(0, 300));
  check("panel lists intercepted calls", panelText.includes("Intercepted"), panelText.slice(0, 300));
  check("panel lists invented values", panelText.includes("Invented values"), panelText.slice(0, 300));
  await shot("07-panel");
  await page.locator(".pane-header", { hasText: "workspace" }).first().click();
  await page.waitForTimeout(500);

  // ---- 6. exception: replay starts at the failing line
  await open("pure.py", 51);
  await palette("Spot Run: Run Function at Cursor");
  status = await waitForReplay("fails");
  inline = await inlineTexts();
  check("a raising function reports the exception", status.includes("IndexError"), status);
  check("the error is shown on the failing line", inline.some((t) => t.startsWith("✖ IndexError")), JSON.stringify(inline));
  check("replay is positioned on the failing line", (await currentLineText()) === "return values[n + 10]", String(await currentLineText()));
  await shot("08-exception");

  // ---- 7. blocked side effect
  await open("effects.py", 59);
  await palette("Spot Run: Run Function at Cursor");
  status = await waitForReplay("raw_socket");
  check("a raw socket is blocked", status.includes("EffectBlocked"), status);
  await shot("09-blocked");

  // ---- 8. SQLAlchemy session
  await open("db.py", 21);
  await palette("Spot Run: Run Function at Cursor");
  status = await waitForReplay("active_emails");
  await palette("Spot Run: Go to End");
  await page.waitForTimeout(600);
  status = await statusText();
  if (withModel) {
    check("database rows come from the model", status.includes("kareem@boskalis.com"), status);
  } else {
    check("database function runs without a model", /active_emails · end · → /.test(status), status);
  }
  await shot("10-database");

  // ---- 8b. inputs described in the inline conversation
  if (withModel) {
    const describe = async (text) => {
      // After the first exchange the reply box is folded into a button.
      const folded = page.locator(".review-widget .review-thread-reply-button").last();
      if (await folded.isVisible().catch(() => false)) {
        await folded.click();
      }
      const box = page.locator(".review-widget .comment-form .monaco-editor").last();
      await box.click();
      await page.keyboard.type(text, { delay: 5 });
      await page.locator(".review-widget").getByText("Run with These Inputs", { exact: true }).last().click();
    };
    const threadText = async () => (await page.locator(".review-widget").allTextContents()).join(" ");
    await open("pure.py", 21);
    await palette("Spot Run: Describe Inputs for Function at Cursor");
    await page.waitForSelector(".review-widget .comment-form", { timeout: 15000 });
    await shot("12-describe-open");
    console.log("     title actions: " + JSON.stringify(await page.locator(".review-widget .review-actions a.action-label, .review-widget .head a.action-label").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") || e.title))));
    await describe("one negative price and no tax");
    await page.waitForFunction(() => [...document.querySelectorAll(".review-widget")].some((w) => w.textContent.includes("Returned")), null, { timeout: 40000 });
    status = await waitForReplay("total");
    inline = await inlineTexts();
    check("described inputs are used", inline.some((t) => t.includes("prices = [-5.0, 10.0], tax = 0.0")), JSON.stringify(inline));
    let conversation = await threadText();
    check("the conversation shows the request and the result", conversation.includes("one negative price and no tax") && conversation.includes("Returned") && conversation.includes("5.0"), conversation.slice(0, 400));
    await shot("13-describe-result");
    await describe("make it three prices");
    await page.waitForFunction(() => [...document.querySelectorAll(".review-widget")].some((w) => (w.textContent.match(/Returned/g) || []).length >= 2), null, { timeout: 40000 });
    await page.waitForTimeout(800);
    inline = await inlineTexts();
    check("a follow-up refines the previous inputs", inline.some((t) => t.includes("prices = [-5.0, 10.0, 2.5]")), JSON.stringify(inline));
    await shot("14-describe-follow-up");
    check("the Comments panel is not opened", (await page.locator(".panel .composite.title", { hasText: "Comments" }).count()) === 0 && !(await page.locator(".part.panel").isVisible().catch(() => false)));

    await open("effects.py", 12);
    await palette("Spot Run: Describe Inputs for Function at Cursor");
    await page.waitForTimeout(1500);
    await describe("the API answers 404");
    await page.waitForFunction(() => [...document.querySelectorAll(".review-widget")].some((w) => w.textContent.includes("the API answers 404") && w.textContent.includes("Returned")), null, { timeout: 40000 });
    await page.waitForTimeout(800);
    await palette("Spot Run: Go to End");
    await page.waitForTimeout(600);
    status = await statusText();
    check("the description also steers fake values", /fetch_prices · end · → \[\]/.test(status), status);
    await shot("15-describe-fake-value");
    await open("pure.py", 21);
  }

  // ---- 8c. choosing the model from the status bar
  if (withModel) {
    const modelItem = page.locator(".statusbar-item", { hasText: "Spot Run:" }).first();
    check("status bar shows the model in use", (await modelItem.textContent()).includes("Fake Mini"), await modelItem.textContent());
    const pick = async (label) => {
      await modelItem.click();
      await page.waitForSelector(".quick-input-widget:not([style*='display: none']) input", { timeout: 10000 });
      await shot(`16-model-picker-${label.toLowerCase()}`);
      await page.keyboard.type(label, { delay: 5 });
      await page.waitForTimeout(400);
      await page.keyboard.press("Enter");
    };
    await palette("Spot Run: Run Function at Cursor");
    await waitForReplay("total");
    const promptCount = () => fs.readFileSync(lmLog, "utf8").split("=== PROMPT ===").length;
    const promptsBefore = promptCount();
    await pick("None");
    await page.waitForFunction(() => [...document.querySelectorAll(".statusbar-item")].some((e) => e.textContent.includes("Spot Run: no model")), null, { timeout: 20000 });
    await page.waitForTimeout(2500);
    // Built-in values for total are [1.5, 1.5] with the default tax, which gives 3.6.
    check("choosing None reruns with built-in values", /total · 1\/\d+ · → 3\.6/.test(await statusText()), await statusText());
    check("no model request is made with None", promptCount() === promptsBefore);
    await pick("Fake Mini");
    await page.waitForFunction(() => [...document.querySelectorAll(".statusbar-item")].some((e) => e.textContent.includes("Spot Run: Fake Mini")), null, { timeout: 20000 });
    await page.waitForTimeout(2500);
    check("choosing a model reruns and asks that model", promptCount() > promptsBefore && /total · /.test(await statusText()), await statusText());
    await shot("17-model-chosen");
  }

  // ---- 9. editing ends the replay
  await page.keyboard.press("Control+1");
  await page.waitForTimeout(300);
  await page.keyboard.type(" ");
  await page.waitForTimeout(800);
  check("editing the file ends the replay", (await statusText()) === "", await statusText());
  await page.keyboard.press("Control+Z");
  await shot("11-after-edit");
} catch (error) {
  failures.push(`exception: ${error.stack ?? error}`);
  console.log(`FAIL ${error.stack ?? error}`);
  await page?.screenshot({ path: path.join(out, "failure.png") }).catch(() => undefined);
} finally {
  await browser?.close();
  server.kill();
  fs.writeFileSync(path.join(out, "server.log"), serverLog);
}

console.log(failures.length === 0 ? "\nall end-to-end checks passed" : `\n${failures.length} check(s) failed`);
process.exit(failures.length === 0 ? 0 : 1);
