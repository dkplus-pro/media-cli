import { createLogger } from "./output/logger.js";
import { WarningCollector } from "./output/warnings.js";
import { defaultStreams } from "./output/writer.js";
import type { CliStreams, GlobalFlags, RunContext } from "./types.js";

export function createRunContext(
  flags: GlobalFlags,
  cwd: string,
  streams: CliStreams = defaultStreams(),
): RunContext {
  return {
    ...flags,
    cwd,
    streams,
    logger: createLogger(flags, streams),
    warnings: new WarningCollector(),
  };
}
