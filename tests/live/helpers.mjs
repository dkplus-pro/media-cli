const DEFAULT_AZURE_API_VERSION = "2024-10-21";

function firstEnvironmentValue(environment, names) {
  for (const name of names) {
    const value = environment[name];
    if (value?.trim()) return value.trim();
  }
  throw new Error(`Missing live provider configuration: ${names[0]}.`);
}

function optionalEnvironmentValue(environment, names) {
  for (const name of names) {
    const value = environment[name];
    if (value?.trim()) return value.trim();
  }
  return undefined;
}

export function azureLiveConfig(environment = process.env) {
  return {
    endpoint: firstEnvironmentValue(environment, [
      "AZURE_OPENAI_ENDPOINT",
      "AZURE_OPENAI_BASE_URL"
    ]),
    apiKey: firstEnvironmentValue(environment, ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_KEY"]),
    deployment: firstEnvironmentValue(environment, [
      "AZURE_OPENAI_DEPLOYMENT",
      "AZURE_OPENAI_MODEL"
    ]),
    apiVersion:
      optionalEnvironmentValue(environment, ["AZURE_OPENAI_API_VERSION", "AZURE_OPENAI_VERSION"]) ??
      DEFAULT_AZURE_API_VERSION
  };
}

export function qwenLiveConfig(environment = process.env) {
  return {
    baseUrl: firstEnvironmentValue(environment, ["DASHSCOPE_BASE_URL", "QWEN_BASE_URL"]),
    apiKey: firstEnvironmentValue(environment, ["DASHSCOPE_API_KEY", "QWEN_API_KEY"]),
    model: optionalEnvironmentValue(environment, ["DASHSCOPE_MODEL", "QWEN_MODEL"])
  };
}

export async function azureProvider() {
  const { createAzureOpenAIProvider } = await import("../../packages/ai-core/dist/index.js");
  return createAzureOpenAIProvider(azureLiveConfig());
}

export async function qwenProvider() {
  const { createOpenAICompatibleProvider } = await import("../../packages/ai-core/dist/index.js");
  return createOpenAICompatibleProvider(qwenLiveConfig());
}

export async function runSanitizedLive(label, operation) {
  try {
    return await operation();
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "LIVE_PROVIDER_FAILED";
    throw new Error(`${label} failed (${code}).`, {
      // eslint-disable-next-line preserve-caught-error -- The caught provider error can contain secrets and must be redacted.
      cause: new Error("Live provider error redacted.")
    });
  }
}
