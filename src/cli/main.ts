import { CommanderError } from "commander";
import { specCommand } from "../commands/builtin/spec.js";
import { versionCommand } from "../commands/builtin/version.js";
import { CommandRegistry } from "../commands/registry.js";
import { createRunContext } from "../core/context.js";
import { CliError, exitCodeForError } from "../core/errors.js";
import { EXIT_CODES } from "../core/exit-codes.js";
import { writeResult } from "../core/output/writer.js";
import { loadPlugins } from "../plugins/loader.js";
import { prescanGlobalFlags } from "./options.js";
import { buildProgram } from "./program.js";

export async function run(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const ctx = createRunContext(prescanGlobalFlags(argv), process.cwd());
  const program = buildProgram();
  const registry = new CommandRegistry();
  registry.register(versionCommand, "builtin");
  registry.register(specCommand(registry), "builtin");
  await loadPlugins(ctx, registry);
  const pluginCommandCount = registry.list().filter((c) => c.source !== "builtin").length;
  ctx.logger.info(`已加载 ${pluginCommandCount} 个插件命令`);
  registry.attachTo(program, ctx);

  const firstArg = argv.find((token) => token.length > 0 && token !== "--");
  if (firstArg !== undefined && !firstArg.startsWith("-") && registry.get(firstArg) === undefined) {
    writeResult(ctx, {
      ok: false,
      error: {
        code: "E_COMMAND_NOT_FOUND",
        message: `未知命令: ${firstArg}`,
        details: { command: firstArg },
      },
    });
    return EXIT_CODES.USAGE;
  }

  try {
    await program.parseAsync([...argv], { from: "user" });
    return (program as { exitCode?: number | null }).exitCode ?? EXIT_CODES.OK;
  } catch (err) {
    if (err instanceof CliError) {
      writeResult(ctx, {
        ok: false,
        error: { code: err.code, message: err.message, details: err.details },
      });
      return exitCodeForError(err);
    }
    if (err instanceof CommanderError) {
      if (
        err.code === "commander.version" ||
        err.code === "commander.helpDisplayed" ||
        err.code === "commander.help"
      ) {
        return EXIT_CODES.OK;
      }
      const unknownCommand = err.code === "commander.unknownCommand";
      writeResult(ctx, {
        ok: false,
        error: { code: unknownCommand ? "E_COMMAND_NOT_FOUND" : "E_USAGE", message: err.message },
      });
      return EXIT_CODES.USAGE;
    }
    writeResult(ctx, {
      ok: false,
      error: { code: "E_INTERNAL", message: err instanceof Error ? err.message : String(err) },
    });
    return exitCodeForError(err);
  }
}
