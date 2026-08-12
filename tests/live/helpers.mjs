function firstEnvironmentValue(names) {
  for (const name of names) {
    const value = process.env[name];
    if (value?.trim()) return value.trim();
  }
  throw new Error(`Missing live provider configuration: ${names[0]}.`);
}

export async function azureProvider() {
  const { createAzureOpenAIProvider } = await import("../../packages/ai-core/dist/index.js");
  return createAzureOpenAIProvider({
    endpoint: firstEnvironmentValue(["AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_BASE_URL"]),
    apiKey: firstEnvironmentValue(["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_KEY"]),
    deployment: firstEnvironmentValue(["AZURE_OPENAI_DEPLOYMENT", "AZURE_OPENAI_MODEL"]),
    apiVersion: firstEnvironmentValue(["AZURE_OPENAI_API_VERSION", "AZURE_OPENAI_VERSION"])
  });
}

export async function qwenProvider() {
  const { createOpenAICompatibleProvider } = await import("../../packages/ai-core/dist/index.js");
  return createOpenAICompatibleProvider({
    baseUrl: firstEnvironmentValue(["DASHSCOPE_BASE_URL", "QWEN_BASE_URL"]),
    apiKey: firstEnvironmentValue(["DASHSCOPE_API_KEY", "QWEN_API_KEY"]),
    model: firstEnvironmentValue(["DASHSCOPE_MODEL", "QWEN_MODEL"])
  });
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
