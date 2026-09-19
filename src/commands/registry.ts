import type { Command } from "commander";
import { asCodedError, CliError, exitCodeForError } from "../core/errors.js";
import type { Warning } from "../core/output/warnings.js";
import { writeResult } from "../core/output/writer.js";
import type { CommandDefinition, RunContext } from "../core/types.js";

export type CommandSource = "builtin" | `plugin:${string}`;
export interface RegisteredCommand {
  def: CommandDefinition;
  source: CommandSource;
}

export class CommandRegistry {
  readonly #commands = new Map<string, RegisteredCommand>();

  register(def: CommandDefinition, source: CommandSource): { ok: boolean; warning?: Warning } {
    if (this.#commands.has(def.name)) {
      return {
        ok: false,
        warning: {
          code: "E_PLUGIN_COMMAND_CONFLICT",
          message: `命令 "${def.name}" 已存在，来自 ${source} 的注册被跳过`,
          plugin: source.startsWith("plugin:") ? source.slice("plugin:".length) : undefined,
        },
      };
    }
    this.#commands.set(def.name, { def, source });
    return { ok: true };
  }

  get(name: string): RegisteredCommand | undefined {
    return this.#commands.get(name);
  }

  list(): readonly RegisteredCommand[] {
    return [...this.#commands.values()];
  }

  attachTo(program: Command, ctx: RunContext): void {
    const prog = program as Command & { exitCode?: number | null };
    for (const { def } of this.#commands.values()) {
      const cmd = program.command(def.name).description(def.description);
      for (const opt of def.options ?? []) {
        cmd.option(opt.flags, opt.description, opt.defaultValue as string | boolean | undefined);
      }
      cmd.action(async (opts: Record<string, unknown>) => {
        try {
          writeResult(ctx, { ok: true, data: await def.handler(ctx, opts) });
        } catch (err) {
          const e =
            err instanceof CliError
              ? err
              : (asCodedError(err) ??
                new CliError("E_INTERNAL", err instanceof Error ? err.message : String(err)));
          writeResult(ctx, {
            ok: false,
            error: { code: e.code, message: e.message, details: e.details },
          });
          prog.exitCode = exitCodeForError(e);
        }
      });
    }
  }
}
