import { z } from "zod";

import { type SourceFingerprint } from "@dkplus/contracts";
import { fingerprintFile, watermarkImage, type ImageMetadata } from "@dkplus/media-core";

const sourceFingerprintSchema = z
  .object({ algorithm: z.literal("sha256"), value: z.string().regex(/^[a-f0-9]{64}$/u) })
  .strict();
const outputMetadataSchema = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    format: z.enum(["jpeg", "png", "webp"]),
    hasAlpha: z.boolean()
  })
  .strict();

export const watermarkImageAssetResultSchema = z
  .object({
    kind: z.literal("image-watermark"),
    schemaVersion: z.literal("1.0"),
    sourceFingerprint: sourceFingerprintSchema,
    outputPath: z.string().min(1),
    output: outputMetadataSchema
  })
  .strict();

export type WatermarkedImageAsset = z.infer<typeof watermarkImageAssetResultSchema>;

export interface WatermarkImageAssetOptions {
  text: string;
  force?: boolean;
}

export async function watermarkImageAsset(
  inputPath: string,
  outputPath: string,
  options: WatermarkImageAssetOptions
): Promise<WatermarkedImageAsset> {
  const sourceFingerprint: SourceFingerprint = await fingerprintFile(inputPath);
  const output: ImageMetadata = await watermarkImage(inputPath, outputPath, options);
  return watermarkImageAssetResultSchema.parse({
    kind: "image-watermark",
    schemaVersion: "1.0",
    sourceFingerprint,
    outputPath,
    output
  });
}
