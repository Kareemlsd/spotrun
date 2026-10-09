"""The small model that invents inputs and fake values, reached over HTTP.

Configured through the environment of the MCP server:

  SPOTRUN_MODEL      model name; without it no model is called
  SPOTRUN_BASE_URL   endpoint (default: api.openai.com, or api.anthropic.com for claude models)
  SPOTRUN_API_KEY    key (falls back to OPENAI_API_KEY / ANTHROPIC_API_KEY)
  SPOTRUN_PROVIDER   "openai" (any OpenAI-compatible chat completions endpoint) or "anthropic"
"""

import json
import urllib.error
import urllib.request


class ModelError(Exception):
    pass


class Model(object):
    def __init__(self, provider, base_url, name, key, timeout=60.0):
        self.provider = provider
        self.base_url = base_url.rstrip("/")
        self.name = name
        self.key = key
        self.timeout = timeout
        self.calls = 0
        self.failures = 0

    @property
    def label(self):
        return "%s (%s)" % (self.name, self.base_url.split("//")[-1].split("/")[0])

    def ask(self, prompt):
        """One prompt in, the reply text out. Raises ModelError."""
        if self.failures >= 3:
            raise ModelError("the model failed three times in a row and is no longer called in this run")
        self.calls += 1
        try:
            text = self._anthropic(prompt) if self.provider == "anthropic" else self._openai(prompt)
        except ModelError:
            self.failures += 1
            raise
        self.failures = 0
        return text

    def _post(self, url, headers, body):
        request = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), method="POST")
        request.add_header("Content-Type", "application/json")
        for name, value in headers.items():
            request.add_header(name, value)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:300].replace("\n", " ")
            raise ModelError("%s answered HTTP %s: %s" % (self.label, exc.code, detail))
        except (urllib.error.URLError, OSError, ValueError) as exc:
            raise ModelError("%s could not be reached: %s" % (self.label, exc))

    def _openai(self, prompt):
        headers = {"Authorization": "Bearer %s" % self.key} if self.key else {}
        url = self.base_url if self.base_url.endswith("/chat/completions") else self.base_url + "/chat/completions"
        reply = self._post(url, headers, {"model": self.name, "messages": [{"role": "user", "content": prompt}]})
        try:
            content = reply["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            raise ModelError("%s gave a reply without a message: %s" % (self.label, json.dumps(reply)[:200]))
        if isinstance(content, list):
            content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
        return content or ""

    def _anthropic(self, prompt):
        headers = {"x-api-key": self.key or "", "anthropic-version": "2023-06-01"}
        base = self.base_url[: -len("/v1")] if self.base_url.endswith("/v1") else self.base_url
        reply = self._post(
            base + "/v1/messages",
            headers,
            {"model": self.name, "max_tokens": 2000, "messages": [{"role": "user", "content": prompt}]},
        )
        try:
            return "".join(part.get("text", "") for part in reply["content"] if part.get("type") == "text")
        except (KeyError, TypeError, AttributeError):
            raise ModelError("%s gave a reply without content: %s" % (self.label, json.dumps(reply)[:200]))


def from_environment(env):
    """The configured small model, or None when SPOTRUN_MODEL is not set."""
    name = (env.get("SPOTRUN_MODEL") or "").strip()
    if not name:
        return None
    base = (env.get("SPOTRUN_BASE_URL") or "").strip()
    provider = (env.get("SPOTRUN_PROVIDER") or "").strip().lower()
    if provider not in ("openai", "anthropic"):
        provider = "anthropic" if "anthropic" in base or (not base and name.startswith("claude")) else "openai"
    if not base:
        base = "https://api.anthropic.com" if provider == "anthropic" else "https://api.openai.com/v1"
    key = env.get("SPOTRUN_API_KEY") or env.get("ANTHROPIC_API_KEY" if provider == "anthropic" else "OPENAI_API_KEY") or ""
    try:
        timeout = float(env.get("SPOTRUN_MODEL_TIMEOUT") or 60)
    except ValueError:
        timeout = 60.0
    return Model(provider, base, name, key.strip(), timeout)
