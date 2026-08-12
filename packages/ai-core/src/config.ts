import { AIProviderError } from "./error.js";

export interface AzureOpenAIConfig {
  endpoint: string;
  apiKey: string;
  deployment: string;
  apiVersion: string;
}

export interface OpenAICompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model?: string;
}

export interface ProviderProfiles {
  azure: AzureOpenAIConfig;
  qwen: OpenAICompatibleConfig;
}

export type Environment = Readonly<Record<string, string | undefined>>;

const DEFAULT_AZURE_API_VERSION = "2024-10-21";

function firstValue(environment: Environment, names: readonly string[]): string | undefined {
  return names.map((name) => environment[name]).find((value) => value && value.trim().length > 0)?.trim();
}

function requireValue(environment: Environment, names: readonly string[]): string {
  const value = firstValue(environment, names);
  if (!value) {
    throw new AIProviderError(
      "AI_CONFIGURATION_INVALID",
      `Missing required provider configuration: ${names[0] ?? "unknown"}.`
    );
  }

  return value;
}

export function createProviderProfiles(environment: Environment): ProviderProfiles {
  return {
    azure: {
      endpoint: requireValue(environment, ["AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_BASE_URL"]),
      apiKey: requireValue(environment, ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_KEY"]),
      deployment: requireValue(environment, ["AZURE_OPENAI_DEPLOYMENT", "AZURE_OPENAI_MODEL"]),
      apiVersion: firstValue(environment, ["AZURE_OPENAI_API_VERSION"]) ?? DEFAULT_AZURE_API_VERSION
    },
    qwen: {
      baseUrl: requireValue(environment, ["DASHSCOPE_BASE_URL", "QWEN_BASE_URL"]),
      apiKey: requireValue(environment, ["DASHSCOPE_API_KEY", "QWEN_API_KEY"]),
      model: firstValue(environment, ["DASHSCOPE_MODEL", "QWEN_MODEL"])
    }
  };
}
