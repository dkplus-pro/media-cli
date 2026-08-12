import type { AzureOpenAIConfig } from "./config.js";
import { createChatBody, executeChat, normalizeAzureEndpoint } from "./chat.js";
import type { AIProvider, AITask, FetchLike } from "./task.js";

function defaultFetch(url: string, request: Parameters<FetchLike>[1]): ReturnType<FetchLike> {
  return fetch(url, request);
}

export function createAzureOpenAIProvider(config: AzureOpenAIConfig, fetcher: FetchLike = defaultFetch): AIProvider {
  const endpoint = normalizeAzureEndpoint(config.endpoint);

  return {
    execute<Result>(task: AITask<Result>): Promise<Result> {
      const url = `${endpoint}/openai/deployments/${encodeURIComponent(config.deployment)}/chat/completions?api-version=${encodeURIComponent(config.apiVersion)}`;
      return executeChat(
        fetcher,
        url,
        {
          method: "POST",
          headers: { "content-type": "application/json", "api-key": config.apiKey },
          body: createChatBody(task, config.deployment)
        },
        task
      );
    }
  };
}
