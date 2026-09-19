import pkg from "../../../package.json" with { type: "json" };
import type { CommandDefinition } from "../../core/types.js";

export const versionCommand: CommandDefinition = {
  name: "version",
  description: "打印 CLI 名称与版本",
  handler: () => ({ name: pkg.name, version: pkg.version }),
};
