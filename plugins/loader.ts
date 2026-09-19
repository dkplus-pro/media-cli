import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CommandDefinition, RunContext } from "../core/types.js";
import { discoverPluginDirs, PLUGIN_ENTRY_FILE } from "./discover.js";
import { validatePluginExport } from "./manifest.js";
import type { PluginCommandSink } from "./types.js";

export async function loadPlugins(ctx: RunContext, sink: PluginCommandSink): Promise<void> {
  const seenNames = new Set<string>();
  for (const candidate of discoverPluginDirs(ctx.cwd)) {
    const entry = join(candidate.dir, PLUGIN_ENTRY_FILE);
    let mod: unknown;
    try {
      mod = await import(pathToFileURL(entry).href);
    } catch (err) {
      ctx.warnings.add({
        code: "E_PLUGIN_LOAD_FAILED",
        message: `插件加载失败: ${candidate.dir}（${err instanceof Error ? err.message : String(err)}）`,
      });
      continue;
    }

    const result = validatePluginExport((mod as { default?: unknown } | null)?.default);
    if (!result.ok) {
      ctx.warnings.add({
        code: "E_PLUGIN_MANIFEST_INVALID",
        message: `插件 manifest 校验失败: ${candidate.dir}（${result.errors.join("; ")}）`,
      });
      continue;
    }

    const manifest = result.manifest;
    if (seenNames.has(manifest.name)) {
      ctx.warnings.add({
        code: "E_PLUGIN_DUPLICATE",
        message: `插件 "${manifest.name}" 重复发现，来自 ${candidate.source} 的实例被跳过`,
        plugin: manifest.name,
      });
      continue;
    }
    seenNames.add(manifest.name);
    ctx.logger.debug(`插件已加载: ${manifest.name} (${candidate.source})`);

    for (const pluginCommand of manifest.commands) {
      const def: CommandDefinition = {
        name: pluginCommand.name,
        description: pluginCommand.description,
        options: pluginCommand.options,
        handler: pluginCommand.handler,
      };
      const registered = sink.register(def, `plugin:${manifest.name}`);
      if (!registered.ok && registered.warning) ctx.warnings.add(registered.warning);
    }
  }
}
