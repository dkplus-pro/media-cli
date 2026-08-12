import { readFile } from "node:fs/promises";

import {
  AIProviderError,
  FeatureResolver,
  createAzureOpenAIProvider,
  createOpenAICompatibleProvider,
  type AIProvider,
  type AzureOpenAIConfig,
  type OpenAICompatibleConfig
} from "@dkplus/ai-core";
import { CliError } from "@dkplus/contracts";
import { z } from "zod";

export interface AzureAudioAiProfile {
  id: string;
  provider: "azure";
  features: readonly string[];
  config: AzureOpenAIConfig;
}

export interface OpenAICompatibleAudioAiProfile {
  id: string;
  provider: "openai-compatible";
  features: readonly string[];
  config: OpenAICompatibleConfig;
}

export type AudioAiProfile = AzureAudioAiProfile | OpenAICompatibleAudioAiProfile;
export type AudioProviderFactory = (profile: AudioAiProfile) => AIProvider;

const featureSchema = z.string().trim().min(1);
const profileBaseSchema = { id: z.string().trim().min(1), features: z.array(featureSchema).min(1) };
const configurationSchema = z
  .object({
    profiles: z
      .array(
        z.discriminatedUnion("provider", [
          z
            .object({
              ...profileBaseSchema,
              provider: z.literal("azure"),
              config: z
                .object({
                  endpoint: z.string().trim().min(1),
                  apiKey: z.string().trim().min(1),
                  deployment: z.string().trim().min(1),
                  apiVersion: z.string().trim().min(1)
                })
                .strict()
            })
            .strict(),
          z
            .object({
              ...profileBaseSchema,
              provider: z.literal("openai-compatible"),
              config: z
                .object({
                  baseUrl: z.string().trim().min(1),
                  apiKey: z.string().trim().min(1),
                  model: z.string().trim().min(1).optional()
                })
                .strict()
            })
            .strict()
        ])
      )
      .min(1)
  })
  .strict();

function configurationError(): CliError {
  return new CliError({
    code: "AI_CONFIGURATION_INVALID",
    message: "AI configuration is invalid."
  });
}

function readError(): CliError {
  return new CliError({
    code: "AI_CONFIGURATION_INVALID",
    message: "Unable to read AI configuration."
  });
}

function parseProfiles(value: unknown): readonly AudioAiProfile[] {
  const parsed = configurationSchema.safeParse(value);
  if (!parsed.success) throw configurationError();
  const ids = new Set<string>();
  for (const profile of parsed.data.profiles) {
    if (ids.has(profile.id)) throw configurationError();
    ids.add(profile.id);
  }
  return parsed.data.profiles;
}

export function defaultAudioProviderFactory(profile: AudioAiProfile): AIProvider {
  return profile.provider === "azure"
    ? createAzureOpenAIProvider(profile.config)
    : createOpenAICompatibleProvider(profile.config);
}

export function createFeatureRoutingAudioProvider(
  profiles: readonly AudioAiProfile[],
  providerFactory: AudioProviderFactory = defaultAudioProviderFactory
): AIProvider {
  const providers = new Map(profiles.map((profile) => [profile.id, providerFactory(profile)]));
  const resolver = new FeatureResolver(profiles);
  return {
    execute(task) {
      const profile = resolver.resolve(task.feature);
      const provider = providers.get(profile.id);
      if (provider === undefined) {
        throw new AIProviderError(
          "AI_CONFIGURATION_INVALID",
          "Configured AI provider is unavailable."
        );
      }
      return provider.execute(task);
    }
  };
}

export async function loadConfiguredAudioProvider(
  configPath: string,
  providerFactory: AudioProviderFactory = defaultAudioProviderFactory
): Promise<AIProvider> {
  let contents: string;
  try {
    contents = await readFile(configPath, "utf8");
  } catch {
    throw readError();
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw configurationError();
  }
  return createFeatureRoutingAudioProvider(parseProfiles(value), providerFactory);
}
