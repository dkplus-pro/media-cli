import { access } from "node:fs/promises";
import { constants } from "node:fs";

import sharp from "sharp";

import { CliError } from "@dkplus/contracts";

import { readImageMetadata, type ImageMetadata } from "./image.js";

export interface WatermarkOptions {
  text: string;
  force?: boolean;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    const replacements: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&apos;"
    };
    return replacements[character] ?? character;
  });
}

async function outputExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function outputExistsError(): CliError {
  return new CliError({
    code: "OUTPUT_EXISTS",
    message: "Refusing to overwrite an existing output file."
  });
}

function imageFailed(): CliError {
  return new CliError({
    code: "MEDIA_PROCESS_FAILED",
    message: "Media processing failed.",
    details: { operation: "watermark" }
  });
}

export async function watermarkImage(
  inputPath: string,
  outputPath: string,
  options: WatermarkOptions
): Promise<ImageMetadata> {
  if (!options.force && (await outputExists(outputPath))) {
    throw outputExistsError();
  }
  if (options.text.trim().length === 0) {
    throw new CliError({ code: "INVALID_ARGUMENT", message: "Watermark text must not be empty." });
  }

  let metadata: ImageMetadata;
  try {
    metadata = await readImageMetadata(inputPath);
    const fontSize = Math.max(12, Math.round(Math.min(metadata.width, metadata.height) / 8));
    const overlay = Buffer.from(
      `<svg width="${metadata.width}" height="${metadata.height}" xmlns="http://www.w3.org/2000/svg"><text x="${metadata.width - Math.round(fontSize / 2)}" y="${metadata.height - Math.round(fontSize / 2)}" text-anchor="end" font-family="sans-serif" font-size="${fontSize}" font-weight="bold" fill="white" stroke="black" stroke-width="1" opacity="0.8">${escapeXml(options.text)}</text></svg>`
    );
    await sharp(inputPath).composite([{ input: overlay }]).removeAlpha().toFile(outputPath);
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw imageFailed();
  }

  return readImageMetadata(outputPath);
}
