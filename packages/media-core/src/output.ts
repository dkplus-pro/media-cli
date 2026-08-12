import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { CliError } from "@dkplus/contracts";

function sameInputOutputError(outputDescription: string): CliError {
  return new CliError({
    code: "INVALID_ARGUMENT",
    message: `${outputDescription} must differ from the input path.`
  });
}

export async function assertOutputPathIsDistinct(
  inputPath: string,
  outputPath: string,
  outputDescription: string
): Promise<void> {
  if (resolve(inputPath) === resolve(outputPath)) {
    throw sameInputOutputError(outputDescription);
  }

  try {
    const [inputStats, outputStats] = await Promise.all([stat(inputPath), stat(outputPath)]);
    if (inputStats.dev === outputStats.dev && inputStats.ino === outputStats.ino) {
      throw sameInputOutputError(outputDescription);
    }
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
  }
}
