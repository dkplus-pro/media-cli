import type { CommandDefinition, RunContext } from "../core/types.js";

export interface PluginOptionDef {
  flags: string;
  description: string;
}

export interface PluginCommandDef {
  name: string;
  description: string;
  options?: PluginOptionDef[];
  handler: (ctx: RunContext, args: Record<string, unknown>) => unknown | Promise<unknown>;
}

export interface PluginManifest {
  name: string;
  version: string;
  commands: PluginCommandDef[];
}

export type PluginSource = "env" | "project" | "global";

export interface PluginCandidate {
  dir: string;
  source: PluginSource;
}

export interface PluginCommandSink {
  register(
    def: CommandDefinition,
    source: `plugin:${string}`,
  ): { ok: boolean; warning?: { code: string; message: string; plugin?: string } };
}
