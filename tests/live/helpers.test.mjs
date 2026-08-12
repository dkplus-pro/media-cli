import assert from "node:assert/strict";
import { it } from "node:test";

import { azureLiveConfig, qwenLiveConfig, runSanitizedLive } from "./helpers.mjs";

it("uses the runtime Azure API-version default when the live environment omits it", () => {
  assert.deepEqual(
    azureLiveConfig({
      AZURE_OPENAI_ENDPOINT: "https://azure.example.test",
      AZURE_OPENAI_API_KEY: "not-a-secret",
      AZURE_OPENAI_DEPLOYMENT: "gpt-4o"
    }),
    {
      endpoint: "https://azure.example.test",
      apiKey: "not-a-secret",
      deployment: "gpt-4o",
      apiVersion: "2024-10-21"
    }
  );
});

it("accepts Azure compatibility aliases for live configuration", () => {
  assert.deepEqual(
    azureLiveConfig({
      AZURE_OPENAI_BASE_URL: "https://azure-alias.example.test",
      AZURE_OPENAI_KEY: "not-a-secret",
      AZURE_OPENAI_MODEL: "gpt-4o-alias",
      AZURE_OPENAI_VERSION: "2025-01-01-preview"
    }),
    {
      endpoint: "https://azure-alias.example.test",
      apiKey: "not-a-secret",
      deployment: "gpt-4o-alias",
      apiVersion: "2025-01-01-preview"
    }
  );
});

it("leaves the Qwen model undefined so the compatible provider selects its default", () => {
  assert.deepEqual(
    qwenLiveConfig({
      DASHSCOPE_BASE_URL: "https://qwen.example.test/compatible-mode/v1",
      DASHSCOPE_API_KEY: "not-a-secret"
    }),
    {
      baseUrl: "https://qwen.example.test/compatible-mode/v1",
      apiKey: "not-a-secret",
      model: undefined
    }
  );
});

it("accepts Qwen compatibility aliases including an optional model", () => {
  assert.deepEqual(
    qwenLiveConfig({
      QWEN_BASE_URL: "https://qwen-alias.example.test/compatible-mode/v1",
      QWEN_API_KEY: "not-a-secret",
      QWEN_MODEL: "qwen-test-model"
    }),
    {
      baseUrl: "https://qwen-alias.example.test/compatible-mode/v1",
      apiKey: "not-a-secret",
      model: "qwen-test-model"
    }
  );
});

it("redacts provider failures without retaining a sensitive cause", async () => {
  await assert.rejects(
    () =>
      runSanitizedLive("Azure text summary", async () => {
        const error = new Error("provider returned api-key=secret-value");
        error.code = "AI_PROVIDER_REQUEST_FAILED";
        throw error;
      }),
    (error) =>
      error instanceof Error &&
      error.message === "Azure text summary failed (AI_PROVIDER_REQUEST_FAILED)." &&
      !error.message.includes("secret-value") &&
      error.cause instanceof Error &&
      error.cause.message === "Live provider error redacted."
  );
});
