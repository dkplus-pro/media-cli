#!/usr/bin/env node

import type { AIProvider } from "@dkplus/ai-core";
import {
  baseOptions,
  defineSchema,
  describeCommands,
  emitProgress,
  emitResult,
  parseBaseOptions,
  runCommand,
  type CommandDefinition,
  type JsonSchema,
  type OutputWriter,
  type RuntimeSchema
} from "@dkplus/cli-core";
import {
  CliError,
  createErrorResult,
  createSuccessResult,
  type CliResult
} from "@dkplus/contracts";
import { z } from "zod";

import {
  analyzeImage,
  describeImage,
  extractImageKeywords,
  extractImageOcr,
  imageAnalysisResultSchema,
  imageDescriptionResultSchema,
  imageKeywordsResultSchema,
  imageMetadataResultSchema,
  imageOcrResultSchema,
  imageScoreResultSchema,
  metadata,
  scoreImage
} from "./content.js";
import { watermarkImageAsset, watermarkImageAssetResultSchema } from "./watermark.js";

const VERSION = "0.1.0";

export interface ImageCliDependencies {
  provider?: AIProvider;
  stdout?: OutputWriter;
  stderr?: OutputWriter;
}

export interface ImageCliRunResult {
  exitCode: 0 | 1;
}

interface ImagePathInput {
  imagePath: string;
}

interface WatermarkInput {
  inputPath: string;
  outputPath: string;
  text: string;
  force: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStringField(value: unknown, field: string): string {
  if (!isRecord(value) || typeof value[field] !== "string" || value[field].trim().length === 0) {
    throw new CliError({
      code: "INVALID_COMMAND_INPUT",
      message: `${field} must be a non-empty string.`
    });
  }
  return value[field];
}

function runtimeSchema<T>(jsonSchema: JsonSchema, schema: z.ZodType<T>): RuntimeSchema<T> {
  return defineSchema(jsonSchema, (value) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new CliError({ code: "INVALID_COMMAND_OUTPUT", message: "Command output is invalid." });
    }
    return parsed.data;
  });
}

const imagePathSchema = defineSchema<ImagePathInput>(
  { type: "object", required: ["imagePath"] },
  (value) => ({ imagePath: parseStringField(value, "imagePath") })
);
const watermarkInputSchema = defineSchema<WatermarkInput>(
  { type: "object", required: ["inputPath", "outputPath", "text", "force"] },
  (value) => ({
    inputPath: parseStringField(value, "inputPath"),
    outputPath: parseStringField(value, "outputPath"),
    text: parseStringField(value, "text"),
    force: isRecord(value) && value["force"] === true
  })
);

function providerOrError(provider: AIProvider | undefined): AIProvider {
  if (provider === undefined) {
    throw new CliError({
      code: "AI_FEATURE_UNAVAILABLE",
      message: "This command requires a configured AI provider."
    });
  }
  return provider;
}

function createCommands(dependencies: ImageCliDependencies) {
  const contentMetadata: CommandDefinition<ImagePathInput, unknown> = {
    name: "content metadata",
    description: "Read deterministic local image metadata.",
    version: VERSION,
    inputSchema: imagePathSchema,
    outputSchema: runtimeSchema(
      { type: "object", required: ["kind", "sourceFingerprint", "width", "height"] },
      imageMetadataResultSchema
    ),
    execute: ({ imagePath }) => metadata(imagePath)
  };
  const describe: CommandDefinition<ImagePathInput, unknown> = {
    name: "content describe",
    description: "Describe local image content with a feature-routed AI provider.",
    version: VERSION,
    inputSchema: imagePathSchema,
    outputSchema: runtimeSchema(
      { type: "object", required: ["kind", "sourceFingerprint", "description"] },
      imageDescriptionResultSchema
    ),
    execute: ({ imagePath }) =>
      describeImage(imagePath, { provider: providerOrError(dependencies.provider) })
  };
  const keywords: CommandDefinition<ImagePathInput, unknown> = {
    name: "content keywords",
    description: "Extract local image keywords with a feature-routed AI provider.",
    version: VERSION,
    inputSchema: imagePathSchema,
    outputSchema: runtimeSchema(
      { type: "object", required: ["kind", "sourceFingerprint", "keywords"] },
      imageKeywordsResultSchema
    ),
    execute: ({ imagePath }) =>
      extractImageKeywords(imagePath, { provider: providerOrError(dependencies.provider) })
  };
  const ocr: CommandDefinition<ImagePathInput, unknown> = {
    name: "content ocr",
    description: "Extract visible local image text with a feature-routed AI provider.",
    version: VERSION,
    inputSchema: imagePathSchema,
    outputSchema: runtimeSchema(
      { type: "object", required: ["kind", "sourceFingerprint", "text", "blocks"] },
      imageOcrResultSchema
    ),
    execute: ({ imagePath }) =>
      extractImageOcr(imagePath, { provider: providerOrError(dependencies.provider) })
  };
  const score: CommandDefinition<ImagePathInput, unknown> = {
    name: "content score",
    description: "Score a local image from zero through ten with a feature-routed AI provider.",
    version: VERSION,
    inputSchema: imagePathSchema,
    outputSchema: runtimeSchema(
      { type: "object", required: ["kind", "sourceFingerprint", "score", "rationale"] },
      imageScoreResultSchema
    ),
    execute: ({ imagePath }) =>
      scoreImage(imagePath, { provider: providerOrError(dependencies.provider) })
  };
  const analyze: CommandDefinition<ImagePathInput, unknown> = {
    name: "analyze",
    description: "Combine image metadata, description, keywords, OCR, and score.",
    version: VERSION,
    inputSchema: imagePathSchema,
    outputSchema: runtimeSchema(
      { type: "object", required: ["metadata", "description", "keywords", "ocr", "score"] },
      imageAnalysisResultSchema
    ),
    execute: ({ imagePath }) =>
      analyzeImage(imagePath, { provider: providerOrError(dependencies.provider) })
  };
  const watermark: CommandDefinition<WatermarkInput, unknown> = {
    name: "watermark",
    description: "Write a watermark only to a distinct output image.",
    version: VERSION,
    inputSchema: watermarkInputSchema,
    outputSchema: runtimeSchema(
      { type: "object", required: ["kind", "sourceFingerprint", "outputPath", "output"] },
      watermarkImageAssetResultSchema
    ),
    execute: ({ inputPath, outputPath, text, force }) =>
      watermarkImageAsset(inputPath, outputPath, { text, force })
  };
  return { contentMetadata, describe, keywords, ocr, score, analyze, watermark };
}

function helpText(command?: { name: string; description: string }): string {
  if (command !== undefined) {
    return `${command.name}: ${command.description}\n${baseOptions.map((option) => option.flag).join(", ")}, --schema\n`;
  }
  return (
    "Usage: dk-image <content|analyze|watermark> <command> [input] [options]\n\n" +
    "Commands: content metadata, content describe, content keywords, content ocr, content score, analyze, watermark\n" +
    `${baseOptions.map((option) => option.flag).join(", ")}, --schema\n`
  );
}

function optionValue(argumentsList: readonly string[], name: string): string | undefined {
  const equalsPrefix = `${name}=`;
  const equals = argumentsList.find((argument) => argument.startsWith(equalsPrefix));
  if (equals !== undefined) {
    const value = equals.slice(equalsPrefix.length);
    if (value.length === 0) {
      throw new CliError({ code: "INVALID_ARGUMENT", message: `${name} requires a value.` });
    }
    return value;
  }
  const index = argumentsList.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = argumentsList[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("-")) {
    throw new CliError({ code: "INVALID_ARGUMENT", message: `${name} requires a value.` });
  }
  return value;
}

function positionalInput(
  argumentsList: readonly string[],
  optionNames: readonly string[] = []
): string {
  const values = argumentsList.filter((argument, index) => {
    if (optionNames.some((option) => argument === option || argument.startsWith(`${option}=`))) {
      return false;
    }
    return !optionNames.includes(argumentsList[index - 1] ?? "");
  });
  const input = values[0];
  if (input === undefined || values.length !== 1) {
    throw new CliError({
      code: "INVALID_ARGUMENT",
      message: "This command requires exactly one input."
    });
  }
  return input;
}

function commandInput(name: string, argumentsList: readonly string[], force: boolean): unknown {
  if (name === "watermark") {
    const outputPath = optionValue(argumentsList, "--output");
    const text = optionValue(argumentsList, "--text");
    if (outputPath === undefined || text === undefined) {
      throw new CliError({
        code: "INVALID_ARGUMENT",
        message: "watermark requires --output <path> and --text <text>."
      });
    }
    return {
      inputPath: positionalInput(argumentsList, ["--output", "--text"]),
      outputPath,
      text,
      force
    };
  }
  return { imagePath: positionalInput(argumentsList) };
}

function failedResult(command: string, error: unknown): CliResult<unknown> {
  return createErrorResult(
    { command, version: VERSION },
    error instanceof CliError
      ? error
      : new CliError({ code: "INTERNAL_ERROR", message: "An unexpected error occurred." })
  );
}

function namedCommand(name: string, commands: ReturnType<typeof createCommands>) {
  return Object.values(commands).find((command) => command.name === name);
}

async function executeCommand(
  name: string,
  input: unknown,
  commands: ReturnType<typeof createCommands>
): Promise<CliResult<unknown>> {
  if (name === commands.contentMetadata.name) {
    return runCommand(commands.contentMetadata, input);
  }
  if (name === commands.describe.name) {
    return runCommand(commands.describe, input);
  }
  if (name === commands.keywords.name) {
    return runCommand(commands.keywords, input);
  }
  if (name === commands.ocr.name) {
    return runCommand(commands.ocr, input);
  }
  if (name === commands.score.name) {
    return runCommand(commands.score, input);
  }
  if (name === commands.analyze.name) {
    return runCommand(commands.analyze, input);
  }
  if (name === commands.watermark.name) {
    return runCommand(commands.watermark, input);
  }
  return failedResult(
    name,
    new CliError({ code: "UNKNOWN_COMMAND", message: "Unknown image command." })
  );
}

function parseSchemaFlag(argumentsList: readonly string[]): {
  schema: boolean;
  argumentsList: string[];
} {
  return {
    schema: argumentsList.includes("--schema"),
    argumentsList: argumentsList.filter((argument) => argument !== "--schema")
  };
}

export async function runImageCli(
  argumentsList: readonly string[],
  dependencies: ImageCliDependencies = {}
): Promise<ImageCliRunResult> {
  const stdout = dependencies.stdout ?? process.stdout;
  const { schema, argumentsList: withoutSchema } = parseSchemaFlag(argumentsList);
  let parsed;
  try {
    parsed = parseBaseOptions(withoutSchema);
  } catch (error) {
    emitResult(failedResult("dk-image", error), { stdout });
    return { exitCode: 1 };
  }

  const commands = createCommands(dependencies);
  const [namespace, action, ...commandArguments] = parsed.positionals;
  const isContentCommand = namespace === "content" && action !== undefined;
  const name = isContentCommand ? `content ${action}` : (namespace ?? "dk-image");
  const inputArguments = isContentCommand
    ? commandArguments
    : action === undefined
      ? []
      : [action, ...commandArguments];
  const command = namedCommand(name, commands);
  if (parsed.options.help) {
    if (parsed.options.json || parsed.options.jsonl) {
      emitResult(
        createSuccessResult(
          { command: `${command?.name ?? "dk-image"} help`, version: VERSION },
          { help: helpText(command) }
        ),
        {
          mode: parsed.options.jsonl ? "jsonl" : "json",
          stdout
        }
      );
    } else {
      stdout.write(helpText(command));
    }
    return { exitCode: 0 };
  }
  if (parsed.options.version) {
    if (parsed.options.json || parsed.options.jsonl) {
      emitResult(
        createSuccessResult(
          { command: "dk-image version", version: VERSION },
          { version: VERSION }
        ),
        {
          mode: parsed.options.jsonl ? "jsonl" : "json",
          stdout
        }
      );
    } else {
      stdout.write(`${VERSION}\n`);
    }
    return { exitCode: 0 };
  }
  if (namespace === "describe" && action === undefined) {
    emitResult(
      createSuccessResult(
        { command: "describe", version: VERSION },
        describeCommands(Object.values(commands))
      ),
      {
        mode: parsed.options.jsonl ? "jsonl" : "json",
        stdout
      }
    );
    return { exitCode: 0 };
  }
  if (command === undefined) {
    emitResult(
      failedResult(
        name,
        new CliError({ code: "UNKNOWN_COMMAND", message: "Unknown image command." })
      ),
      {
        mode: parsed.options.jsonl ? "jsonl" : "json",
        stdout
      }
    );
    return { exitCode: 1 };
  }
  if (schema) {
    emitResult(
      createSuccessResult(
        { command: `${name} schema`, version: VERSION },
        {
          name: command.name,
          description: command.description,
          inputSchema: command.inputSchema.jsonSchema,
          outputSchema: command.outputSchema.jsonSchema,
          options: baseOptions
        }
      ),
      { mode: parsed.options.jsonl ? "jsonl" : "json", stdout }
    );
    return { exitCode: 0 };
  }

  let result: CliResult<unknown>;
  try {
    const input = commandInput(name, inputArguments, parsed.options.force);
    emitProgress({ stage: "execute" }, { mode: parsed.options.jsonl ? "jsonl" : "json", stdout });
    result = await executeCommand(name, input, commands);
  } catch (error) {
    result = failedResult(name, error);
  }
  emitResult(result, { mode: parsed.options.jsonl ? "jsonl" : "json", stdout });
  return { exitCode: result.success ? 0 : 1 };
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  void runImageCli(process.argv.slice(2)).then(({ exitCode }) => {
    process.exitCode = exitCode;
  });
}
