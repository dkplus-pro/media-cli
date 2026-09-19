import type { PluginCommandDef, PluginManifest } from "./types.js";

export interface PluginManifestOk {
  ok: true;
  manifest: PluginManifest;
}

export interface PluginManifestInvalid {
  ok: false;
  errors: string[];
}

export type PluginManifestResult = PluginManifestOk | PluginManifestInvalid;

const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function validatePluginExport(value: unknown): PluginManifestResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["插件默认导出必须是对象"] };

  if (typeof value.name !== "string" || !PLUGIN_NAME_RE.test(value.name)) {
    errors.push("name 必须匹配 ^[a-z][a-z0-9-]*$");
  }
  if (!nonEmptyString(value.version)) errors.push("version 必须是非空字符串");

  const commands = value.commands;
  if (!Array.isArray(commands)) {
    errors.push("commands 必须是数组");
  } else {
    commands.forEach((command, i) => {
      if (!isRecord(command)) {
        errors.push(`commands[${i}] 必须是对象`);
        return;
      }
      if (!nonEmptyString(command.name)) errors.push(`commands[${i}].name 必须是非空字符串`);
      if (!nonEmptyString(command.description))
        errors.push(`commands[${i}].description 必须是非空字符串`);
      if (command.options !== undefined) {
        if (!Array.isArray(command.options)) {
          errors.push(`commands[${i}].options 必须是数组`);
        } else {
          command.options.forEach((option, j) => {
            if (!isRecord(option)) {
              errors.push(`commands[${i}].options[${j}] 必须是对象`);
              return;
            }
            if (!nonEmptyString(option.flags))
              errors.push(`commands[${i}].options[${j}].flags 必须是非空字符串`);
            if (!nonEmptyString(option.description)) {
              errors.push(`commands[${i}].options[${j}].description 必须是非空字符串`);
            }
          });
        }
      }
      if (typeof command.handler !== "function") errors.push(`commands[${i}].handler 必须是函数`);
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    manifest: {
      name: value.name as string,
      version: value.version as string,
      commands: commands as PluginCommandDef[],
    },
  };
}
