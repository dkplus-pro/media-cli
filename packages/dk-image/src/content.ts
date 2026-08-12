import { readFile } from "node:fs/promises";

import { AIProviderError, type AIProvider } from "@dkplus/ai-core";
import { CliError, type SourceFingerprint } from "@dkplus/contracts";
import {
  fingerprintFile,
  loadImage,
  readImageMetadata,
  type ImageMetadata as MediaImageMetadata
} from "@dkplus/media-core";
import { z } from "zod";

const sourceFingerprintSchema = z
  .object({
    algorithm: z.literal("sha256"),
    value: z.string().regex(/^[a-f0-9]{64}$/u)
  })
  .strict();

const assetSchema = z
  .object({
    kind: z.string().min(1),
    schemaVersion: z.literal("1.0"),
    sourceFingerprint: sourceFingerprintSchema
  })
  .strict();

export const imageMetadataResultSchema = assetSchema
  .extend({
    kind: z.literal("image-metadata"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    format: z.enum(["jpeg", "png", "webp"]),
    hasAlpha: z.boolean()
  })
  .strict();

export const imageDescriptionResultSchema = assetSchema
  .extend({ kind: z.literal("image-description"), description: z.string().min(1) })
  .strict();

export const imageKeywordsResultSchema = assetSchema
  .extend({ kind: z.literal("image-keywords"), keywords: z.array(z.string().min(1)) })
  .strict();

export const imageOcrResultSchema = assetSchema
  .extend({
    kind: z.literal("image-ocr"),
    text: z.string(),
    blocks: z.array(z.object({ text: z.string().min(1) }).strict())
  })
  .strict();

export const imageScoreResultSchema = assetSchema
  .extend({
    kind: z.literal("image-score"),
    score: z.number().min(0).max(10),
    rationale: z.string().min(1)
  })
  .strict();

export const imageAnalysisResultSchema = z
  .object({
    metadata: imageMetadataResultSchema,
    description: imageDescriptionResultSchema,
    keywords: imageKeywordsResultSchema,
    ocr: imageOcrResultSchema,
    score: imageScoreResultSchema
  })
  .strict();

export type ImageMetadataResult = z.infer<typeof imageMetadataResultSchema>;
export type ImageDescription = z.infer<typeof imageDescriptionResultSchema>;
export type ImageKeywords = z.infer<typeof imageKeywordsResultSchema>;
export type ImageOcr = z.infer<typeof imageOcrResultSchema>;
export type ImageScore = z.infer<typeof imageScoreResultSchema>;
export type ImageAnalysis = z.infer<typeof imageAnalysisResultSchema>;

interface LoadedImageAsset {
  sourceFingerprint: SourceFingerprint;
  metadata: MediaImageMetadata;
  image: { mimeType: string; base64Data: string };
}

export interface ImageContentOptions {
  provider: AIProvider;
}

export interface AnalyzeImageOptions extends ImageContentOptions {
  dependencies?: Partial<{
    metadata: ImageMetadataResult;
    description: ImageDescription;
    keywords: ImageKeywords;
    ocr: ImageOcr;
    score: ImageScore;
  }>;
}

const mimeTypes: Record<MediaImageMetadata["format"], string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp"
};

function providerFailure(error: unknown): CliError {
  if (error instanceof CliError) {
    return error;
  }
  if (error instanceof AIProviderError) {
    return new CliError({ code: error.code, message: error.message });
  }
  return new CliError({
    code: "AI_PROVIDER_RESPONSE_INVALID",
    message: "The AI provider returned an invalid response."
  });
}

function sourceMismatch(): CliError {
  return new CliError({
    code: "ARTIFACT_SOURCE_MISMATCH",
    message: "Image dependency source fingerprint does not match the requested image."
  });
}

function fingerprintsMatch(left: SourceFingerprint, right: SourceFingerprint): boolean {
  return left.algorithm === right.algorithm && left.value === right.value;
}

function requireSourceFingerprint(
  asset: { sourceFingerprint: SourceFingerprint },
  expected: SourceFingerprint
): void {
  if (!fingerprintsMatch(asset.sourceFingerprint, expected)) {
    throw sourceMismatch();
  }
}

async function loadImageAsset(imagePath: string): Promise<LoadedImageAsset> {
  const [, bytes, sourceFingerprint, metadata] = await Promise.all([
    loadImage(imagePath),
    readFile(imagePath),
    fingerprintFile(imagePath),
    readImageMetadata(imagePath)
  ]);
  return {
    sourceFingerprint,
    metadata,
    image: { mimeType: mimeTypes[metadata.format], base64Data: bytes.toString("base64") }
  };
}

function metadataResult(asset: LoadedImageAsset): ImageMetadataResult {
  return imageMetadataResultSchema.parse({
    kind: "image-metadata",
    schemaVersion: "1.0",
    sourceFingerprint: asset.sourceFingerprint,
    ...asset.metadata
  });
}

async function executeContentFeature<Result>(
  asset: LoadedImageAsset,
  provider: AIProvider,
  feature:
    | "image.content.describe"
    | "image.content.keywords"
    | "image.content.ocr"
    | "image.content.score",
  prompt: string,
  responseSchema: z.ZodType<Result>
): Promise<Result> {
  try {
    return await provider.execute({
      feature,
      prompt: `${prompt}\n${JSON.stringify({ sourceFingerprint: asset.sourceFingerprint, metadata: asset.metadata })}`,
      images: [asset.image],
      responseSchema
    });
  } catch (error) {
    throw providerFailure(error);
  }
}

async function describeLoadedImage(
  asset: LoadedImageAsset,
  provider: AIProvider
): Promise<ImageDescription> {
  const response = await executeContentFeature(
    asset,
    provider,
    "image.content.describe",
    'Return a single JSON object with exactly one key: "description" (non-empty string). Do not use Markdown or wrap the object. Describe this local image.',
    imageDescriptionResultSchema.pick({ description: true })
  );
  return imageDescriptionResultSchema.parse({
    kind: "image-description",
    schemaVersion: "1.0",
    sourceFingerprint: asset.sourceFingerprint,
    ...response
  });
}

async function extractLoadedImageKeywords(
  asset: LoadedImageAsset,
  provider: AIProvider
): Promise<ImageKeywords> {
  const response = await executeContentFeature(
    asset,
    provider,
    "image.content.keywords",
    "Extract concise image keywords as JSON.",
    imageKeywordsResultSchema.pick({ keywords: true })
  );
  return imageKeywordsResultSchema.parse({
    kind: "image-keywords",
    schemaVersion: "1.0",
    sourceFingerprint: asset.sourceFingerprint,
    ...response
  });
}

async function extractLoadedImageOcr(
  asset: LoadedImageAsset,
  provider: AIProvider
): Promise<ImageOcr> {
  const response = await executeContentFeature(
    asset,
    provider,
    "image.content.ocr",
    "Extract visible image text and text blocks as JSON.",
    imageOcrResultSchema.pick({ text: true, blocks: true })
  );
  return imageOcrResultSchema.parse({
    kind: "image-ocr",
    schemaVersion: "1.0",
    sourceFingerprint: asset.sourceFingerprint,
    ...response
  });
}

async function scoreLoadedImage(
  asset: LoadedImageAsset,
  provider: AIProvider
): Promise<ImageScore> {
  const response = await executeContentFeature(
    asset,
    provider,
    "image.content.score",
    "Score this image from 0 through 10 and explain the score as JSON.",
    imageScoreResultSchema.pick({ score: true, rationale: true })
  );
  return imageScoreResultSchema.parse({
    kind: "image-score",
    schemaVersion: "1.0",
    sourceFingerprint: asset.sourceFingerprint,
    ...response
  });
}

export async function metadata(imagePath: string): Promise<ImageMetadataResult> {
  return metadataResult(await loadImageAsset(imagePath));
}

export async function describeImage(
  imagePath: string,
  options: ImageContentOptions
): Promise<ImageDescription> {
  return describeLoadedImage(await loadImageAsset(imagePath), options.provider);
}

export async function extractImageKeywords(
  imagePath: string,
  options: ImageContentOptions
): Promise<ImageKeywords> {
  return extractLoadedImageKeywords(await loadImageAsset(imagePath), options.provider);
}

export async function extractImageOcr(
  imagePath: string,
  options: ImageContentOptions
): Promise<ImageOcr> {
  return extractLoadedImageOcr(await loadImageAsset(imagePath), options.provider);
}

export async function scoreImage(
  imagePath: string,
  options: ImageContentOptions
): Promise<ImageScore> {
  return scoreLoadedImage(await loadImageAsset(imagePath), options.provider);
}

export async function analyzeImage(
  imagePath: string,
  options: AnalyzeImageOptions
): Promise<ImageAnalysis> {
  const asset = await loadImageAsset(imagePath);
  const dependencies = options.dependencies ?? {};
  const imageMetadata = dependencies.metadata ?? metadataResult(asset);
  requireSourceFingerprint(imageMetadata, asset.sourceFingerprint);

  const [description, keywords, ocr, score] = await Promise.all([
    dependencies.description ?? describeLoadedImage(asset, options.provider),
    dependencies.keywords ?? extractLoadedImageKeywords(asset, options.provider),
    dependencies.ocr ?? extractLoadedImageOcr(asset, options.provider),
    dependencies.score ?? scoreLoadedImage(asset, options.provider)
  ]);
  requireSourceFingerprint(description, asset.sourceFingerprint);
  requireSourceFingerprint(keywords, asset.sourceFingerprint);
  requireSourceFingerprint(ocr, asset.sourceFingerprint);
  requireSourceFingerprint(score, asset.sourceFingerprint);

  return imageAnalysisResultSchema.parse({
    metadata: imageMetadata,
    description,
    keywords,
    ocr,
    score
  });
}
