import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { CliError } from "@dkplus/contracts";

function sameInputOutputError(outputDescription: string): CliError {
  return new CliError({
    code: "INVALID_ARGUMENT",
    message: `${outputDescription} must differ from the input path.`
  });
}

function outputPathInspectionError(): CliError {
  return new CliError({
    code: "INVALID_ARGUMENT",
    message: "Unable to inspect media output path."
  });
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export async function assertOutputPathIsDistinct(
  inputPath: string,
  outputPath: string,
  outputDescription: string
): Promise<void> {
  if (resolve(inputPath) === resolve(outputPath)) {
    throw sameInputOutputError(outputDescription);
  }

  let outputStats;
  try {
    outputStats = await stat(outputPath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return;
    }
    throw outputPathInspectionError();
  }

  let inputStats;
  try {
    inputStats = await stat(inputPath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return;
    }
    throw outputPathInspectionError();
  }

  if (inputStats.dev === outputStats.dev && inputStats.ino === outputStats.ino) {
    throw sameInputOutputError(outputDescription);
  }
}
