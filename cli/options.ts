import type { GlobalFlags } from "../core/types.js";

export function prescanGlobalFlags(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): GlobalFlags {
  const flags: GlobalFlags = { json: false, quiet: false, verbose: false, color: true };
  for (const token of argv) {
    if (token === "--") break;
    if (token === "--json") flags.json = true;
    else if (token === "--quiet") flags.quiet = true;
    else if (token === "--verbose") flags.verbose = true;
    else if (token === "--no-color") flags.color = false;
  }
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") flags.color = false;
  return flags;
}
