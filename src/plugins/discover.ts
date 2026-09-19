import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { PluginCandidate } from "./types.js";

export const PLUGIN_ENTRY_FILE = "index.mjs";

function containerPluginDirs(container: string): string[] {
  try {
    return readdirSync(container, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(container, entry.name));
  } catch {
    return [];
  }
}

export function discoverPluginDirs(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): PluginCandidate[] {
  const candidates: PluginCandidate[] = [];
  for (const raw of (env.COMMON_CLI_PLUGINS_DIR ?? "").split(":")) {
    if (raw.length > 0) candidates.push({ dir: resolve(cwd, raw), source: "env" });
  }
  for (const dir of containerPluginDirs(join(cwd, "plugins"))) {
    candidates.push({ dir, source: "project" });
  }
  for (const dir of containerPluginDirs(join(homedir(), ".common-cli", "plugins"))) {
    candidates.push({ dir, source: "global" });
  }
  return candidates;
}
