import pkg from "../../../package.json" with { type: "json" };
import { CLI_ERROR_CODES } from "../../core/errors.js";
import type { CommandDefinition } from "../../core/types.js";
import type { CommandRegistry } from "../registry.js";

export const EXIT_CODE_LABELS: Readonly<Record<string, string>> = {
  "0": "成功",
  "1": "未捕获/内部错误",
  "2": "用法类错误",
  "3": "命令执行错误",
  "4": "保留（未来插件致命错误）",
};

export function specCommand(registry: CommandRegistry): CommandDefinition {
  return {
    name: "spec",
    description: "输出全部命令的机器可读自省（AI 入口，配合 --json 使用）",
    handler: () => ({
      name: pkg.name,
      version: pkg.version,
      commands: registry.list().map(({ def, source }) => ({
        name: def.name,
        description: def.description,
        source,
        options: (def.options ?? []).map((option) => ({
          flags: option.flags,
          description: option.description,
        })),
      })),
      exitCodes: EXIT_CODE_LABELS,
      errorCodes: [...CLI_ERROR_CODES],
    }),
  };
}
