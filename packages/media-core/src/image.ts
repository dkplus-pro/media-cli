import sharp, { type Sharp } from "sharp";

import { CliError } from "@dkplus/contracts";

export type ImageFormat = "jpeg" | "png" | "webp";

export interface ImageMetadata {
  width: number;
  height: number;
  format: ImageFormat;
  hasAlpha: boolean;
}

const supportedFormats = new Set<ImageFormat>(["jpeg", "png", "webp"]);

function imageFailed(): CliError {
  return new CliError({
    code: "MEDIA_PROCESS_FAILED",
    message: "Media processing failed.",
    details: { operation: "image" }
  });
}

export async function loadImage(path: string): Promise<Sharp> {
  const image = sharp(path, { failOn: "error" });
  try {
    await image.metadata();
  } catch {
    throw imageFailed();
  }
  return image;
}

export async function readImageMetadata(path: string): Promise<ImageMetadata> {
  const metadata = await (await loadImage(path)).metadata();
  if (
    metadata.width === undefined ||
    metadata.height === undefined ||
    metadata.format === undefined ||
    !supportedFormats.has(metadata.format as ImageFormat)
  ) {
    throw imageFailed();
  }

  return {
    width: metadata.width,
    height: metadata.height,
    format: metadata.format as ImageFormat,
    hasAlpha: metadata.hasAlpha === true
  };
}
