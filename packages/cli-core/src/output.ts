import type { CliResult } from "@dkplus/contracts";

export interface OutputWriter {
  write(line: string): void;
}

export interface ProgressUpdate {
  stage: string;
  completed?: number;
  total?: number;
}

export interface ProgressOptions {
  jsonl?: boolean;
  write?: (line: string) => void;
}

function defaultWriter(): OutputWriter {
  return process.stdout;
}

export function emitResult<T>(result: CliResult<T>, writer: OutputWriter = defaultWriter()): void {
  writer.write(`${JSON.stringify(result)}\n`);
}

export function emitProgress(update: ProgressUpdate, options: ProgressOptions = {}): void {
  if (!options.jsonl) {
    return;
  }

  const line = `${JSON.stringify({ type: "progress", ...update })}\n`;
  if (options.write) {
    options.write(line);
    return;
  }

  defaultWriter().write(line);
}
