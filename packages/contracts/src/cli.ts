export interface CommandContext {
  command: string;
  version: string;
}

export interface CliErrorData {
  code: string;
  message: string;
  details?: unknown;
}

export class CliError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor({ code, message, details }: CliErrorData) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.details = details;
  }

  toJSON(): CliErrorData {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

export interface CliSuccessResult<T> extends CommandContext {
  success: true;
  data: T;
}

export interface CliFailureResult extends CommandContext {
  success: false;
  error: CliErrorData;
}

export type CliResult<T> = CliSuccessResult<T> | CliFailureResult;

export function createSuccessResult<T>(context: CommandContext, data: T): CliSuccessResult<T> {
  return { success: true, ...context, data };
}

export function createErrorResult(context: CommandContext, error: CliError): CliFailureResult {
  return { success: false, ...context, error: error.toJSON() };
}
