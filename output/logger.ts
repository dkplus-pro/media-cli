import type { CliStreams, GlobalFlags } from "../types.js";

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export function createLogger(flags: GlobalFlags, streams: CliStreams): Logger {
  const line = (level: string, msg: string): void => {
    streams.stderr.write(`[${level}] ${msg}\n`);
  };
  return {
    debug: (msg) => {
      if (flags.verbose) line("debug", msg);
    },
    info: (msg) => {
      if (!flags.quiet && !flags.json) line("info", msg);
    },
    warn: (msg) => {
      if (!flags.json || flags.verbose) line("warn", msg);
    },
    error: (msg) => {
      if (!flags.json || flags.verbose) line("error", msg);
    },
  };
}
