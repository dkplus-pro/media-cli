import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { z } from "zod";

import {
  AIProviderError,
  FeatureResolver,
  createAzureOpenAIProvider,
  createMockProvider,
  createOpenAICompatibleProvider,
  createProviderProfiles
} from "../dist/index.js";

const summarySchema = z.object({ summary: z.string().min(1) });

function task(overrides = {}) {
  return {
    feature: "audio.speech.summarize",
    prompt: "Summarize this transcript.",
    responseSchema: summarySchema,
    ...overrides
  };
}

describe("provider profile routing", () => {
  it("resolves audio.speech.summarize to Azure from passed environment values", () => {
    const profiles = createProviderProfiles({
      AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com/openai/v1/",
      AZURE_OPENAI_KEY: "azure-test-key",
      AZURE_OPENAI_MODEL: "gpt-4o-deployment",
      AZURE_OPENAI_API_VERSION: "2024-10-21",
      DASHSCOPE_API_KEY: "qwen-test-key",
      DASHSCOPE_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      DASHSCOPE_MODEL: "qwen-plus"
    });
    const resolver = new FeatureResolver([
      { id: "azure", provider: "azure", features: ["audio.speech.*"], config: profiles.azure },
      { id: "qwen", provider: "openai-compatible", features: ["music.*"], config: profiles.qwen }
    ]);

    assert.equal(resolver.resolve("audio.speech.summarize").id, "azure");
  });
});

describe("Azure OpenAI provider", () => {
  it("uses the deployment chat-completions endpoint, api-key auth, image content, and parsed output", async () => {
    const calls = [];
    const provider = createAzureOpenAIProvider(
      {
        endpoint: "https://example.openai.azure.com/openai/v1/",
        apiKey: "azure-test-key",
        deployment: "gpt-4o-deployment",
        apiVersion: "2024-10-21"
      },
      async (url, init) => {
        calls.push({ url, init });
        return new Response(
          JSON.stringify({ choices: [{ message: { content: '{"summary":"Concise summary."}' } }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    );

    const result = await provider.execute(
      task({ images: [{ mimeType: "image/png", base64Data: "aW1hZ2U=" }] })
    );

    assert.deepEqual(result, { summary: "Concise summary." });
    assert.equal(
      calls[0].url,
      "https://example.openai.azure.com/openai/deployments/gpt-4o-deployment/chat/completions?api-version=2024-10-21"
    );
    assert.equal(calls[0].init.headers["api-key"], "azure-test-key");
    assert.equal(calls[0].init.headers.authorization, undefined);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.model, "gpt-4o-deployment");
    assert.deepEqual(body.messages[0].content[1], {
      type: "image_url",
      image_url: { url: "data:image/png;base64,aW1hZ2U=" }
    });
  });

  it("returns a sanitized typed error for failed provider responses", async () => {
    const provider = createAzureOpenAIProvider(
      {
        endpoint: "https://example.openai.azure.com",
        apiKey: "azure-test-key",
        deployment: "gpt-4o-deployment",
        apiVersion: "2024-10-21"
      },
      async () => new Response("sensitive provider body", { status: 500 })
    );

    await assert.rejects(
      () => provider.execute(task()),
      (error) =>
        error instanceof AIProviderError &&
        error.code === "AI_PROVIDER_REQUEST_FAILED" &&
        !error.message.includes("sensitive")
    );
  });
});

describe("OpenAI-compatible provider", () => {
  it("uses the compatible endpoint, Bearer auth, and a default model only when no model is configured", async () => {
    const calls = [];
    const provider = createOpenAICompatibleProvider(
      { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/", apiKey: "qwen-test-key" },
      async (url, init) => {
        calls.push({ url, init });
        return new Response(
          JSON.stringify({ choices: [{ message: { content: '{"summary":"Compatible result."}' } }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    );

    assert.deepEqual(await provider.execute(task({ feature: "music.emotion" })), {
      summary: "Compatible result."
    });
    assert.equal(calls[0].url, "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
    assert.equal(calls[0].init.headers.authorization, "Bearer qwen-test-key");
    assert.equal(JSON.parse(calls[0].init.body).model, "qwen-plus");
  });
});

describe("Mock provider", () => {
  it("parses deterministic mock responses through the task schema", async () => {
    const provider = createMockProvider(async () => ({ summary: "Mocked." }));

    assert.deepEqual(await provider.execute(task()), { summary: "Mocked." });
  });
});
