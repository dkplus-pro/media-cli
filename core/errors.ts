import { EXIT_CODES, type ExitCode } from "./exit-codes.js";

export type CliErrorCode =
  | "E_USAGE"
  | "E_COMMAND_NOT_FOUND"
  | "E_MISSING_ARGUMENT"
  | "E_INVALID_OPTION"
  | "E_INTERNAL"
  | "E_PLUGIN_MANIFEST_INVALID"
  | "E_PLUGIN_LOAD_FAILED"
  | "E_PLUGIN_COMMAND_CONFLICT"
  | "E_PLUGIN_DUPLICATE";

const USAGE_CODES: ReadonlySet<string> = new Set([
  "E_USAGE",
  "E_COMMAND_NOT_FOUND",
  "E_MISSING_ARGUMENT",
  "E_INVALID_OPTION",
]);

export const CLI_ERROR_CODES: readonly CliErrorCode[] = [
  "E_USAGE",
  "E_COMMAND_NOT_FOUND",
  "E_MISSING_ARGUMENT",
  "E_INVALID_OPTION",
  "E_INTERNAL",
  "E_PLUGIN_MANIFEST_INVALID",
  "E_PLUGIN_LOAD_FAILED",
  "E_PLUGIN_COMMAND_CONFLICT",
  "E_PLUGIN_DUPLICATE",
];

export class CliError extends Error {
  readonly code: CliErrorCode;
  readonly details?: unknown;
  constructor(code: CliErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.details = details;
  }
}

export function exitCodeForError(err: unknown): ExitCode {
  if (err instanceof CliError) {
    return USAGE_CODES.has(err.code) ? EXIT_CODES.USAGE : EXIT_CODES.COMMAND;
  }
  return EXIT_CODES.UNCAUGHT;
}
