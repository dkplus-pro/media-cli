import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

// 从模块位置向上找 package.json 定位包根（dist/common-cli.js 在包内一层深，tsx 直跑 src/bin/ 在两层深）
function findPackageRoot(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// 随包内置插件：<包根>/plugins。开发态解析结果与项目 ./plugins/ 相同，调用方按路径相等跳过。
export function bundledPluginsDir(): string | null {
  const root = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
  return root === null ? null : join(root, "plugins");
}

export function discoverPluginDirs(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  overrides: { globalRoot?: string; bundledRoot?: string } = {},
): PluginCandidate[] {
  const candidates: PluginCandidate[] = [];
  for (const raw of (env.COMMON_CLI_PLUGINS_DIR ?? "").split(":")) {
    if (raw.length > 0) candidates.push({ dir: resolve(cwd, raw), source: "env" });
  }
  const projectPlugins = resolve(join(cwd, "plugins"));
  for (const dir of containerPluginDirs(projectPlugins)) {
    candidates.push({ dir, source: "project" });
  }
  const globalRoot = overrides.globalRoot ?? join(homedir(), ".common-cli", "plugins");
  for (const dir of containerPluginDirs(globalRoot)) {
    candidates.push({ dir, source: "global" });
  }
  const bundled = resolve(overrides.bundledRoot ?? bundledPluginsDir() ?? projectPlugins);
  if (bundled !== projectPlugins) {
    for (const dir of containerPluginDirs(bundled)) {
      candidates.push({ dir, source: "bundled" });
    }
  }
  return candidates;
}
