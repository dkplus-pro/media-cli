import { spawn } from "node:child_process";

import { CliError } from "@dkplus/contracts";

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ProcessRunner = (
  command: string,
  argumentsList: readonly string[]
) => Promise<ProcessResult>;

export interface MediaProcessOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
  processRunner?: ProcessRunner;
}

export function defaultProcessRunner(
  command: string,
  argumentsList: readonly string[]
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

function unavailableToolError(tool: "ffmpeg" | "ffprobe"): CliError {
  return new CliError({
    code: "MEDIA_TOOL_UNAVAILABLE",
    message: "Required media tool is unavailable.",
    details: { tool }
  });
}

function processFailedError(tool: "ffmpeg" | "ffprobe", exitCode?: number): CliError {
  return new CliError({
    code: "MEDIA_PROCESS_FAILED",
    message: "Media processing failed.",
    details: exitCode === undefined ? { tool } : { tool, exitCode }
  });
}

function isUnavailableExecutable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "EACCES")
  );
}

export async function runMediaTool(
  tool: "ffmpeg" | "ffprobe",
  argumentsList: readonly string[],
  options: MediaProcessOptions = {}
): Promise<ProcessResult> {
  const command =
    tool === "ffmpeg" ? (options.ffmpegPath ?? "ffmpeg") : (options.ffprobePath ?? "ffprobe");
  const runner = options.processRunner ?? defaultProcessRunner;

  let result: ProcessResult;
  try {
    result = await runner(command, argumentsList);
  } catch (error) {
    if (isUnavailableExecutable(error)) {
      throw unavailableToolError(tool);
    }
    throw processFailedError(tool);
  }

  if (result.exitCode !== 0) {
    throw processFailedError(tool, result.exitCode);
  }

  return result;
}

export function mediaProcessFailed(): CliError {
  return processFailedError("ffprobe");
}
