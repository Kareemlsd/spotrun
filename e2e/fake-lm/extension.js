// Test-only language model. Answers Spot Run's two prompt kinds with canned
// values and appends every prompt it receives to SPOTRUN_FAKE_LM_LOG.
const vscode = require("vscode");
const fs = require("fs");

function answer(prompt) {
  if (prompt.includes('{"args":')) {
    if (prompt.includes('"""make it three prices"""') && prompt.includes("- prices = [-5.0, 10.0]") && prompt.includes("- one negative price and no tax")) {
      return '{"args": {"prices": "[-5.0, 10.0, 2.5]", "tax": "0.0"}}';
    }
    if (prompt.includes('"""one negative price and no tax"""')) {
      return '{"args": {"prices": "[-5.0, 10.0]", "tax": "0.0"}}';
    }
    if (prompt.includes("Function to run: `fetch_prices`")) {
      return 'Here you go:\n```json\n{"args": {"base_url": "\'https://shop.test\'", "min_price": "10"}}\n```';
    }
    if (prompt.includes("Function to run: `active_emails`")) {
      return '{"args": {"session": "FAKE", "domain": "\'@boskalis.com\'"}}';
    }
    if (prompt.includes("Function to run: `discount`")) {
      return '{"args": {"customer": "Customer(name=\'Ada\', tier=Tier.GOLD, age=36)", "amount": "250.0"}}';
    }
    return '{"args": {}}';
  }
  const path = (/Expression that needs a value: `(.*)`/.exec(prompt) || [])[1] || "";
  if (path.endsWith(".status_code")) {
    return prompt.includes('"""the API answers 404"""') ? '{"value": 404}' : '{"value": 200}';
  }
  if (path.endsWith("['items']")) {
    return '{"value": "[{\'name\': \'pen\', \'price\': 2.5}, {\'name\': \'desk\', \'price\': 120.0}, {\'name\': \'lamp\', \'price\': 35.0}]"}';
  }
  if (path.includes("SELECT")) {
    return '{"value": "[User(id=1, email=\'kareem@boskalis.com\'), User(id=2, email=\'guest@other.org\')]"}';
  }
  return '{"value": "FAKE"}';
}

function textOf(messages) {
  return messages
    .map((m) => (Array.isArray(m.content) ? m.content.map((p) => (typeof p.value === "string" ? p.value : "")).join("") : String(m.content ?? "")))
    .join("\n");
}

exports.activate = function (context) {
  const changed = new vscode.EventEmitter();
  const provider = {
    onDidChangeLanguageModelChatInformation: changed.event,
    async provideLanguageModelChatInformation() {
      return [
        {
          id: "spotrun-fake-mini",
          name: "Fake Mini",
          family: "fake-mini",
          version: "1",
          maxInputTokens: 200000,
          maxOutputTokens: 4000,
          capabilities: {},
        },
      ];
    },
    async provideLanguageModelChatResponse(model, messages, options, progress) {
      const prompt = textOf(messages);
      const reply = answer(prompt);
      if (process.env.SPOTRUN_FAKE_LM_LOG) {
        fs.appendFileSync(process.env.SPOTRUN_FAKE_LM_LOG, `=== PROMPT ===\n${prompt}\n=== REPLY ===\n${reply}\n\n`);
      }
      progress.report(new vscode.LanguageModelTextPart(reply));
    },
    async provideTokenCount(model, text) {
      return Math.ceil(String(typeof text === "string" ? text : "").length / 4);
    },
  };
  context.subscriptions.push(changed, vscode.lm.registerLanguageModelChatProvider("spotrun-fake", provider));
};
