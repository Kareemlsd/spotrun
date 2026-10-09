// Test-only language model. Answers Spot Run's two prompt kinds with canned
// values and appends every prompt it receives to SPOTRUN_FAKE_LM_LOG.
const vscode = require("vscode");
const fs = require("fs");

// Canned answers for the documentation demo (e2e/demo-workspace/shop.py).
const DEMO_LINES = "[{'sku': 'PEN-1', 'price': 2.5, 'quantity': 4}, {'sku': 'DESK-9', 'price': 120.0, 'quantity': 1}]";
const DEMO_SOFA = "[{'sku': 'SOFA-2', 'price': 899.0, 'quantity': 1}]";

function demoAnswer(prompt) {
  const scenario = (text) => prompt.includes('"""' + text + '"""');
  if (prompt.includes("You write unit tests for one Python function")) {
    return JSON.stringify({
      file: "tests/test_shop.py",
      imports: ["from unittest.mock import Mock, patch", "import pytest", "from shop import Customer, order_total"],
      code: [
        "def _response(status, lines=None):",
        "    response = Mock(status_code=status)",
        '    response.json.return_value = {"lines": lines or []}',
        "    return response",
        "",
        "",
        '@patch("shop.requests.get")',
        "def test_order_total_gold_customer_two_lines(get):",
        '    get.return_value = _response(200, [{"sku": "PEN-1", "price": 2.5, "quantity": 4}, {"sku": "DESK-9", "price": 120.0, "quantity": 1}])',
        '    assert order_total(Customer(name="Ada", tier="gold"), 1042) == pytest.approx(110.5)',
        "",
        "",
        '@patch("shop.requests.get")',
        "def test_order_total_basic_customer_above_100(get):",
        '    get.return_value = _response(200, [{"sku": "SOFA-2", "price": 899.0, "quantity": 1}])',
        '    assert order_total(Customer(name="Ben", tier="basic"), 7) == pytest.approx(854.05)',
        "",
        "",
        '@patch("shop.requests.get")',
        "def test_order_total_order_not_found(get):",
        "    get.return_value = _response(404)",
        "    with pytest.raises(LookupError):",
        '        order_total(Customer(name="Ada", tier="gold"), 999)',
        "",
        "",
        '@patch("shop.requests.get")',
        "def test_order_total_order_without_lines(get):",
        "    get.return_value = _response(200, [])",
        '    assert order_total(Customer(name="Ada", tier="gold"), 3) == pytest.approx(0.0)',
        "",
      ].join("\n"),
      reason: "The project has no tests yet.",
    });
  }
  if (prompt.includes("You design a small set of input cases")) {
    return JSON.stringify({
      cases: [
        { title: "Gold customer, two lines", args: { customer: "Customer(name='Ada', tier='gold')", order_id: "1042" } },
        { title: "Basic customer above 100", args: { customer: "Customer(name='Ben', tier='basic')", order_id: "7" }, scenario: "the order has one expensive item" },
        { title: "Order not found", args: { customer: "Customer(name='Ada', tier='gold')", order_id: "999" }, scenario: "the order does not exist" },
        { title: "Order without lines", args: { customer: "Customer(name='Ada', tier='gold')", order_id: "3" }, scenario: "the order has no lines" },
      ],
    });
  }
  if (prompt.includes('{"args":')) {
    if (scenario("a basic customer with one expensive item")) {
      return '{"args": {"customer": "Customer(name=\'Ben\', tier=\'basic\')", "order_id": "7"}}';
    }
    return '{"args": {"customer": "Customer(name=\'Ada\', tier=\'gold\')", "order_id": "1042"}}';
  }
  const path = (/Expression that needs a value: `(.*)`/.exec(prompt) || [])[1] || "";
  if (path.endsWith(".status_code")) {
    return scenario("the order does not exist") ? '{"value": 404}' : '{"value": 200}';
  }
  if (path.endsWith("['lines']")) {
    if (scenario("the order has no lines")) {
      return '{"value": "[]"}';
    }
    const sofa = scenario("the order has one expensive item") || scenario("a basic customer with one expensive item");
    return JSON.stringify({ value: sofa ? DEMO_SOFA : DEMO_LINES });
  }
  return '{"value": "FAKE"}';
}

function answer(prompt) {
  if (prompt.includes("`order_total`")) {
    return demoAnswer(prompt);
  }
  if (prompt.includes("Reply with exactly this JSON object and nothing else")) {
    return '{"value": "42"}';
  }
  if (prompt.includes("Function to run: `discounted`")) {
    return '{"args": {"price": "80.0", "rate": "0.25"}}';
  }
  if (prompt.includes("You write unit tests for one Python function") && prompt.includes("Function `total`")) {
    // The first answer has one wrong expectation, to exercise the repair round.
    const expected = prompt.includes("Running those tests gave") ? "45.0" : "44.0";
    return JSON.stringify({
      file: "tests/test_pure.py",
      imports: ["import pytest", "from pure import total"],
      code: [
        "def test_total_typical_basket():",
        "    assert total([10.0, 20.0], 0.5) == pytest.approx(" + expected + ")",
        "",
        "",
        "def test_total_empty_price_list():",
        "    assert total([]) == pytest.approx(0.0)",
        "",
        "",
        "def test_total_text_instead_of_number():",
        "    with pytest.raises(TypeError):",
        "        total(['a', 2.0])",
        "",
      ].join("\n"),
      reason: "The project has no tests yet.",
    });
  }
  if (prompt.includes("You design a small set of input cases")) {
    if (prompt.includes("Function under test: `total`")) {
      return JSON.stringify({
        cases: [
          { title: "Typical basket", args: { prices: "[10.0, 20.0]", tax: "0.5" } },
          { title: "Empty price list", args: { prices: "[]" } },
          { title: "Text instead of number", args: { prices: "['a', 2.0]" } },
        ],
      });
    }
    if (prompt.includes("Function under test: `fetch_prices`")) {
      return JSON.stringify({
        cases: [
          { title: "Items above the minimum", args: { base_url: "'https://shop.test'", min_price: "10" } },
          { title: "API answers 404", args: { base_url: "'https://shop.test'" }, scenario: "the API answers 404" },
        ],
      });
    }
    return '{"cases": []}';
  }
  if (prompt.includes("DIG DEEP IS ON") && prompt.includes("Function to run: `settle`")) {
    if (!prompt.includes("# deep_caller.py:")) {
      return '{"action": "usages", "name": "settle"}';
    }
    if (!prompt.includes("class Ledger")) {
      return 'I should check the type.\n{"action": "definition", "name": "Ledger"}';
    }
    return JSON.stringify({
      args: {
        ledger: "Ledger({'EUR': 1.0, 'USD': 0.9})",
        entries: "[{'ref': 'A-1', 'kind': 'invoice', 'amount': 100.0, 'currency': 'USD'}, {'ref': 'A-2', 'kind': 'transfer', 'amount': 40.0, 'currency': 'EUR'}]",
        policy: "Policy(allowed=('invoice', 'refund'))",
      },
      imports: ["from deep_models import Ledger, Policy"],
      notes: "Entries are dicts with ref, kind, amount and currency. Ledger maps currency codes to rates.",
    });
  }
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
          name: process.env.SPOTRUN_FAKE_LM_NAME || "Fake Mini",
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
