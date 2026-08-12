import { z } from "zod";

import { createAzureOpenAIProvider, type AITask, type AzureOpenAIConfig } from "../src/index.js";

const config: AzureOpenAIConfig = {
  endpoint: "https://example.openai.azure.com",
  apiKey: "test",
  deployment: "gpt-4o",
  apiVersion: "2024-10-21"
};

const task: AITask<{ summary: string }> = {
  feature: "audio.speech.summarize",
  prompt: "Summarize.",
  responseSchema: z.object({ summary: z.string() })
};

void createAzureOpenAIProvider(config);
void task;
