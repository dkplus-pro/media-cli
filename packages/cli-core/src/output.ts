import type { CliResult } from "@dkplus/contracts";

export interface OutputWriter {
  write(line: string): void;
}

export type OutputMode = "json" | "jsonl";

export interface EmitResultOptions {
  mode?: OutputMode;
  stdout?: OutputWriter;
}

export interface ProgressUpdate {
  stage: string;
  completed?: number;
  total?: number;
}

export interface ProgressOptions {
  mode?: OutputMode;
  stdout?: OutputWriter;
  /** @deprecated Use mode: "jsonl" and stdout instead. */
  jsonl?: boolean;
  /** @deprecated Use stdout instead. */
  write?: (line: string) => void;
}

export interface DiagnosticOptions {
  stderr?: OutputWriter;
}

function defaultStdout(): OutputWriter {
  return process.stdout;
}

function defaultStderr(): OutputWriter {
  return process.stderr;
}

function isOutputWriter(value: OutputWriter | EmitResultOptions): value is OutputWriter {
  return "write" in value;
}

export function emitResult<T>(
  result: CliResult<T>,
  writerOrOptions: EmitResultOptions | OutputWriter = defaultStdout()
): void {
  const writer = isOutputWriter(writerOrOptions)
    ? writerOrOptions
    : (writerOrOptions.stdout ?? defaultStdout());
  writer.write(`${JSON.stringify(result)}\n`);
}

export function emitProgress(update: ProgressUpdate, options: ProgressOptions = {}): void {
  const mode = options.mode ?? (options.jsonl ? "jsonl" : "json");
  if (mode !== "jsonl") {
    return;
  }

  const line = `${JSON.stringify({ type: "progress", ...update })}\n`;
  if (options.write !== undefined) {
    options.write(line);
    return;
  }
  (options.stdout ?? defaultStdout()).write(line);
}

export function emitDiagnostic(message: string, options: DiagnosticOptions = {}): void {
  (options.stderr ?? defaultStderr()).write(`${message}\n`);
}
