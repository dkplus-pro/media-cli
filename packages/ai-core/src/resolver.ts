import type { AzureOpenAIConfig, OpenAICompatibleConfig } from "./config.js";
import { AIProviderError } from "./error.js";

export type ProviderKind = "azure" | "openai-compatible" | "mock";

export interface FeatureProfile {
  id: string;
  provider: ProviderKind;
  features: readonly string[];
  config?: AzureOpenAIConfig | OpenAICompatibleConfig;
}

function matchesFeature(pattern: string, feature: string): boolean {
  return pattern === feature || (pattern.endsWith(".*") && feature.startsWith(pattern.slice(0, -1)));
}

export class FeatureResolver {
  readonly profiles: readonly FeatureProfile[];

  constructor(profiles: readonly FeatureProfile[]) {
    this.profiles = profiles;
  }

  resolve(feature: string): FeatureProfile {
    const profile = this.profiles.find((candidate) => candidate.features.some((pattern) => matchesFeature(pattern, feature)));
    if (!profile) {
      throw new AIProviderError("AI_FEATURE_UNAVAILABLE", `No AI profile is configured for feature: ${feature}.`);
    }

    return profile;
  }
}
