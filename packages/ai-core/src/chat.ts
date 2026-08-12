import { z } from "zod";

import { AIProviderError } from "./error.js";
import type { AIImage, AITask, FetchLike, FetchRequest } from "./task.js";

export const DEFAULT_QWEN_TEXT_MODEL = "qwen-plus";

const chatResponseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1)
});

export function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/u, "");
}

export function normalizeAzureEndpoint(value: string): string {
  return normalizeBaseUrl(value).replace(/\/openai(?:\/v1)?$/u, "");
}

function imageUrl(image: AIImage): string {
  if (image.dataUrl) {
    return image.dataUrl;
  }
  if (image.base64Data) {
    return `data:${image.mimeType};base64,${image.base64Data}`;
  }

  throw new AIProviderError(
    "AI_PROVIDER_RESPONSE_INVALID",
    "Image input requires a data URL or base64 data."
  );
}

export function createChatBody<Result>(task: AITask<Result>, model: string): string {
  const content = task.images?.length
    ? [
        { type: "text", text: task.prompt },
        ...task.images.map((image) => ({ type: "image_url", image_url: { url: imageUrl(image) } }))
      ]
    : task.prompt;

  return JSON.stringify({
    model,
    messages: [{ role: "user", content }],
    response_format: { type: "json_object" }
  });
}

export async function executeChat<Result>(
  fetcher: FetchLike,
  url: string,
  request: FetchRequest,
  task: AITask<Result>
): Promise<Result> {
  let response: Response;
  try {
    response = await fetcher(url, request);
  } catch {
    throw new AIProviderError("AI_PROVIDER_REQUEST_FAILED", "The AI provider request failed.");
  }

  if (!response.ok) {
    throw new AIProviderError(
      "AI_PROVIDER_REQUEST_FAILED",
      `The AI provider request failed with status ${response.status}.`
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AIProviderError(
      "AI_PROVIDER_RESPONSE_INVALID",
      "The AI provider returned an invalid response."
    );
  }

  const envelope = chatResponseSchema.safeParse(payload);
  if (!envelope.success) {
    throw new AIProviderError(
      "AI_PROVIDER_RESPONSE_INVALID",
      "The AI provider returned an invalid response."
    );
  }

  const choice = envelope.data.choices[0];
  if (!choice) {
    throw new AIProviderError(
      "AI_PROVIDER_RESPONSE_INVALID",
      "The AI provider returned an invalid response."
    );
  }

  try {
    return task.responseSchema.parse(JSON.parse(choice.message.content));
  } catch {
    throw new AIProviderError(
      "AI_PROVIDER_RESPONSE_INVALID",
      "The AI provider returned an invalid response."
    );
  }
}
