import type { Stats } from "node:fs";
import { link, mkdtemp, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

import { CliError } from "@dkplus/contracts";

export type PathInspector = (path: string) => Promise<Stats>;

export interface MediaOutputOptions {
  force?: boolean;
  pathInspector?: PathInspector;
}

export interface PreparedMediaOutput {
  temporaryPath: string;
  publish(): Promise<void>;
  cleanup(): Promise<void>;
}

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

function outputExistsError(): CliError {
  return new CliError({
    code: "OUTPUT_EXISTS",
    message: "Refusing to overwrite an existing output file."
  });
}

function inputChangedError(): CliError {
  return new CliError({
    code: "INVALID_ARGUMENT",
    message: "Media input changed while creating output."
  });
}

function outputPublishError(): CliError {
  return new CliError({
    code: "INVALID_ARGUMENT",
    message: "Unable to publish media output."
  });
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function inspectPath(path: string, pathInspector: PathInspector): Promise<Stats | undefined> {
  try {
    return await pathInspector(path);
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }
    throw outputPathInspectionError();
  }
}

async function canonicalOutputPath(outputPath: string): Promise<string> {
  try {
    return join(await realpath(dirname(outputPath)), basename(outputPath));
  } catch {
    throw outputPathInspectionError();
  }
}

export async function prepareMediaOutput(
  inputPath: string,
  outputPath: string,
  outputDescription: string,
  options: MediaOutputOptions = {}
): Promise<PreparedMediaOutput> {
  if (resolve(inputPath) === resolve(outputPath)) {
    throw sameInputOutputError(outputDescription);
  }

  const targetPath = await canonicalOutputPath(outputPath);
  if (resolve(inputPath) === targetPath) {
    throw sameInputOutputError(outputDescription);
  }

  const pathInspector = options.pathInspector ?? stat;
  const [inputStats, outputStats] = await Promise.all([
    inspectPath(inputPath, pathInspector),
    inspectPath(targetPath, pathInspector)
  ]);
  if (inputStats !== undefined && outputStats !== undefined && sameFile(inputStats, outputStats)) {
    throw sameInputOutputError(outputDescription);
  }
  if (outputStats !== undefined && !options.force) {
    throw outputExistsError();
  }

  let temporaryDirectory: string;
  try {
    temporaryDirectory = await mkdtemp(join(dirname(targetPath), ".dkplus-media-output-"));
  } catch {
    throw outputPathInspectionError();
  }
  const temporaryPath = join(temporaryDirectory, `output${extname(targetPath)}`);

  return {
    temporaryPath,
    async publish(): Promise<void> {
      if (inputStats !== undefined) {
        const currentInputStats = await inspectPath(inputPath, pathInspector);
        if (currentInputStats === undefined || !sameFile(inputStats, currentInputStats)) {
          throw inputChangedError();
        }
      }

      try {
        if (options.force) {
          await rename(temporaryPath, targetPath);
        } else {
          await link(temporaryPath, targetPath);
          await rm(temporaryPath);
        }
      } catch (error) {
        if (!options.force && isAlreadyExistsError(error)) {
          throw outputExistsError();
        }
        throw outputPublishError();
      }
    },
    async cleanup(): Promise<void> {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  };
}
