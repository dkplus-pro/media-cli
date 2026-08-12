import {
  CliError,
  createErrorResult,
  createSuccessResult,
  type CliResult
} from "@dkplus/contracts";

import type { JsonSchema, RuntimeSchema } from "./schema.js";

export interface CommandDefinition<Input, Output> {
  name: string;
  description: string;
  version: string;
  inputSchema: RuntimeSchema<Input>;
  outputSchema: RuntimeSchema<Output>;
  execute(input: Input): Output | Promise<Output>;
}

export interface CommandDescriptor {
  name: string;
  description: string;
  version: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
}

export interface CommandCatalog {
  schemaVersion: "1.0";
  commands: CommandDescriptor[];
}

export async function runCommand<Input, Output>(
  command: CommandDefinition<Input, Output>,
  input: unknown
): Promise<CliResult<Output>> {
  const context = { command: command.name, version: command.version };

  try {
    const parsedInput = command.inputSchema.parse(input);
    const output = await command.execute(parsedInput);
    return createSuccessResult(context, command.outputSchema.parse(output));
  } catch (error) {
    return createErrorResult(
      context,
      error instanceof CliError
        ? error
        : new CliError({ code: "INTERNAL_ERROR", message: "An unexpected error occurred." })
    );
  }
}

interface CommandMetadata {
  name: string;
  description: string;
  version: string;
  inputSchema: { jsonSchema: JsonSchema };
  outputSchema: { jsonSchema: JsonSchema };
}

export function describeCommands(commands: readonly CommandMetadata[]): CommandCatalog {
  return {
    schemaVersion: "1.0",
    commands: commands
      .map(({ name, description, version, inputSchema, outputSchema }) => ({
        name,
        description,
        version,
        inputSchema: inputSchema.jsonSchema,
        outputSchema: outputSchema.jsonSchema
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  };
}
