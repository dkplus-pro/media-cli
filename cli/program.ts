import { Command } from "commander";
import pkg from "../../package.json" with { type: "json" };

export function buildProgram(): Command {
  return new Command()
    .name(pkg.name)
    .description("通用 Node CLI 壳：给人用，也给 AI 用")
    .version(pkg.version)
    .option("--json", "机器可读 JSON 输出（stdout 仅一个 JSON 文档）", false)
    .option("--quiet", "抑制 info 级日志", false)
    .option("--verbose", "输出 debug 级日志", false)
    .option("--no-color", "禁用彩色输出（同时尊重 NO_COLOR 环境变量）")
    .exitOverride();
}
