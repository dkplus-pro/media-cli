export type AIProviderErrorCode =
  | "AI_CONFIGURATION_INVALID"
  | "AI_FEATURE_UNAVAILABLE"
  | "AI_PROVIDER_REQUEST_FAILED"
  | "AI_PROVIDER_RESPONSE_INVALID";

export class AIProviderError extends Error {
  readonly code: AIProviderErrorCode;

  constructor(code: AIProviderErrorCode, message: string) {
    super(message);
    this.name = "AIProviderError";
    this.code = code;
  }
}
