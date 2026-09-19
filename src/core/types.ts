import type { Logger } from "./output/logger.js";
import type { WarningCollector } from "./output/warnings.js";

export interface GlobalFlags {
  json: boolean;
  quiet: boolean;
  verbose: boolean;
  color: boolean;
}

export interface CliStreams {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export interface RunContext extends GlobalFlags {
  cwd: string;
  streams: CliStreams;
  logger: Logger;
  warnings: WarningCollector;
}

export interface CommandOptionDef {
  flags: string;
  description: string;
  defaultValue?: string | boolean | number;
}

export interface CommandDefinition {
  name: string;
  description: string;
  options?: CommandOptionDef[];
  handler: (ctx: RunContext, args: Record<string, unknown>) => unknown | Promise<unknown>;
}
