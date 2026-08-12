import type { OpenAICompatibleConfig } from "./config.js";
import { createChatBody, DEFAULT_QWEN_TEXT_MODEL, executeChat, normalizeBaseUrl } from "./chat.js";
import type { AIProvider, AITask, FetchLike } from "./task.js";

function defaultFetch(url: string, request: Parameters<FetchLike>[1]): ReturnType<FetchLike> {
  return fetch(url, request);
}

export function createOpenAICompatibleProvider(
  config: OpenAICompatibleConfig,
  fetcher: FetchLike = defaultFetch
): AIProvider {
  const endpoint = `${normalizeBaseUrl(config.baseUrl)}/chat/completions`;
  const model = config.model ?? DEFAULT_QWEN_TEXT_MODEL;

  return {
    execute<Result>(task: AITask<Result>): Promise<Result> {
      return executeChat(
        fetcher,
        endpoint,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
          body: createChatBody(task, model)
        },
        task
      );
    }
  };
}
