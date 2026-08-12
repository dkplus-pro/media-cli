import {
  CliError,
  createErrorResult,
  createSuccessResult,
  type CliResult
} from "@dkplus/contracts";

export interface CommandDefinition<Input, Output> {
  name: string;
  description: string;
  version: string;
  inputSchema: unknown;
  outputSchema: unknown;
  execute(input: Input): Output | Promise<Output>;
}

export interface CommandDescriptor {
  name: string;
  description: string;
  version: string;
  inputSchema: unknown;
  outputSchema: unknown;
}

export interface CommandCatalog {
  schemaVersion: "1.0";
  commands: CommandDescriptor[];
}

export async function runCommand<Input, Output>(
  command: CommandDefinition<Input, Output>,
  input: Input
): Promise<CliResult<Output>> {
  const context = { command: command.name, version: command.version };

  try {
    return createSuccessResult(context, await command.execute(input));
  } catch (error) {
    return createErrorResult(
      context,
      error instanceof CliError
        ? error
        : new CliError({ code: "INTERNAL_ERROR", message: "An unexpected error occurred." })
    );
  }
}

export function describeCommands(commands: readonly CommandDefinition<unknown, unknown>[]): CommandCatalog {
  return {
    schemaVersion: "1.0",
    commands: commands
      .map(({ name, description, version, inputSchema, outputSchema }) => ({
        name,
        description,
        version,
        inputSchema,
        outputSchema
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  };
}
