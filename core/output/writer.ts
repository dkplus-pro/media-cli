import type { CliStreams, RunContext } from "../types.js";
import type { Warning } from "./warnings.js";

export function defaultStreams(): CliStreams {
  return { stdout: process.stdout, stderr: process.stderr };
}

export type CommandResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

export function writeResult(ctx: RunContext, result: CommandResult): void {
  if (ctx.json) {
    const envelope = result.ok
      ? { ok: true, data: result.data, warnings: ctx.warnings.list() }
      : { ok: false, error: result.error, warnings: ctx.warnings.list() };
    ctx.streams.stdout.write(`${JSON.stringify(envelope)}\n`);
    return;
  }
  if (result.ok) {
    const text =
      typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2);
    ctx.streams.stdout.write(`${text}\n`);
    return;
  }
  ctx.streams.stderr.write(`[error] [${result.error.code}] ${result.error.message}\n`);
}

export type { Warning };
