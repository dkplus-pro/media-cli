#!/usr/bin/env node

import { readFile } from "node:fs/promises";

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
  type OutputWriter,
  type RuntimeSchema
} from "@dkplus/cli-core";
import {
  CliError,
  createErrorResult,
  createSuccessResult,
  parseTranscript,
  type CliResult
} from "@dkplus/contracts";

import {
  analyzeMusic,
  analyzeMusicEmotion,
  readAudioMetadata,
  summarizeTranscript,
  transcribeAudio,
  translateTranscript,
  type AudioTranscriber,
  type TranscriptTranslator
} from "./index.js";

const VERSION = "0.1.0";

export interface AudioCliDependencies {
  provider?: AIProvider;
  transcriber?: AudioTranscriber;
  translator?: TranscriptTranslator;
  stdout?: OutputWriter;
  stderr?: OutputWriter;
}

export interface AudioCliRunResult {
  exitCode: 0 | 1;
}

interface AudioPathInput {
  audioPath: string;
}

interface TranslateInput {
  transcriptInput: string;
  targetLanguage: string;
}

interface TranscriptInput {
  transcriptInput: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStringField(value: unknown, field: string): string {
  if (!isRecord(value) || typeof value[field] !== "string" || value[field].trim().length === 0) {
    throw new CliError({ code: "INVALID_COMMAND_INPUT", message: `${field} must be a non-empty string.` });
  }
  return value[field];
}

function parseAudioPathInput(value: unknown): AudioPathInput {
  return { audioPath: parseStringField(value, "audioPath") };
}

function parseTranscriptInput(value: unknown): TranscriptInput {
  return { transcriptInput: parseStringField(value, "transcriptInput") };
}

function parseTranslateInput(value: unknown): TranslateInput {
  return {
    transcriptInput: parseStringField(value, "transcriptInput"),
    targetLanguage: parseStringField(value, "targetLanguage")
  };
}

function outputSchema<T>(required: readonly string[]): RuntimeSchema<T> {
  return defineSchema({ type: "object", required: [...required] }, (value) => {
    if (!isRecord(value) || required.some((field) => !(field in value))) {
      throw new CliError({ code: "INVALID_COMMAND_OUTPUT", message: "Command output is invalid." });
    }
    return value as T;
  });
}

const audioPathSchema = defineSchema<AudioPathInput>(
  { type: "object", required: ["audioPath"] },
  parseAudioPathInput
);
const transcriptInputSchema = defineSchema<TranscriptInput>(
  { type: "object", required: ["transcriptInput"] },
  parseTranscriptInput
);
const translateInputSchema = defineSchema<TranslateInput>(
  { type: "object", required: ["transcriptInput", "targetLanguage"] },
  parseTranslateInput
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

async function readCanonicalTranscript(input: string) {
  let raw: unknown;
  try {
    raw = input.trim().startsWith("{") ? JSON.parse(input) : JSON.parse(await readFile(input, "utf8"));
  } catch {
    throw new CliError({ code: "INVALID_TRANSCRIPT", message: "Transcript data is invalid." });
  }
  return parseTranscript(raw);
}

function createCommands(dependencies: AudioCliDependencies) {
  const transcribe: CommandDefinition<AudioPathInput, unknown> = {
    name: "speech transcribe",
    description: "Transcribe audio through a configured raw-audio adapter.",
    version: VERSION,
    inputSchema: audioPathSchema,
    outputSchema: outputSchema(["kind", "schemaVersion", "sourceFingerprint", "language", "segments"]),
    execute: ({ audioPath }) => transcribeAudio(audioPath, { transcriber: dependencies.transcriber })
  };
  const translate: CommandDefinition<TranslateInput, unknown> = {
    name: "speech translate",
    description: "Translate a canonical transcript through a configured translator adapter.",
    version: VERSION,
    inputSchema: translateInputSchema,
    outputSchema: outputSchema(["kind", "schemaVersion", "sourceFingerprint", "language", "segments"]),
    execute: async ({ transcriptInput, targetLanguage }) =>
      translateTranscript(await readCanonicalTranscript(transcriptInput), {
        targetLanguage,
        translator: dependencies.translator
      })
  };
  const summarize: CommandDefinition<TranscriptInput, unknown> = {
    name: "speech summarize",
    description: "Summarize a canonical transcript with a feature-routed AI provider.",
    version: VERSION,
    inputSchema: transcriptInputSchema,
    outputSchema: outputSchema(["summary", "topics", "keyPoints", "participants", "decisions", "questions"]),
    execute: async ({ transcriptInput }) =>
      summarizeTranscript(await readCanonicalTranscript(transcriptInput), {
        provider: providerOrError(dependencies.provider)
      })
  };
  const metadata: CommandDefinition<AudioPathInput, unknown> = {
    name: "music metadata",
    description: "Read deterministic local audio metadata.",
    version: VERSION,
    inputSchema: audioPathSchema,
    outputSchema: outputSchema(["kind", "schemaVersion", "sourceFingerprint", "durationMs", "codec"]),
    execute: ({ audioPath }) => readAudioMetadata(audioPath)
  };
  const emotion: CommandDefinition<AudioPathInput, unknown> = {
    name: "music emotion",
    description: "Analyze music emotion with a feature-routed AI provider.",
    version: VERSION,
    inputSchema: audioPathSchema,
    outputSchema: outputSchema(["kind", "schemaVersion", "sourceFingerprint", "primaryEmotion"]),
    execute: ({ audioPath }) =>
      analyzeMusicEmotion(audioPath, { provider: providerOrError(dependencies.provider) })
  };
  const analyze: CommandDefinition<AudioPathInput, unknown> = {
    name: "music analyze",
    description: "Combine deterministic music metadata and AI music emotion.",
    version: VERSION,
    inputSchema: audioPathSchema,
    outputSchema: outputSchema(["metadata", "emotion"]),
    execute: ({ audioPath }) => analyzeMusic(audioPath, { provider: providerOrError(dependencies.provider) })
  };

  return { transcribe, translate, summarize, metadata, emotion, analyze };
}

function writeHelp(writer: OutputWriter, command?: { name: string; description: string }): void {
  if (command !== undefined) {
    writer.write(`${command.name}: ${command.description}\n`);
  } else {
    writer.write("Usage: dk-audio <speech|music> <command> [input] [options]\n\n");
    writer.write("Commands: speech transcribe, speech translate, speech summarize, music metadata, music emotion, music analyze\n");
  }
  writer.write(`${baseOptions.map((option) => option.flag).join(", ")}, --schema\n`);
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

function positionalInput(argumentsList: readonly string[], optionNames: readonly string[] = []): string {
  const values = argumentsList.filter((argument, index) => {
    if (optionNames.some((option) => argument === option || argument.startsWith(`${option}=`))) {
      return false;
    }
    return !optionNames.includes(argumentsList[index - 1] ?? "");
  });
  const input = values[0];
  if (input === undefined || values.length !== 1) {
    throw new CliError({ code: "INVALID_ARGUMENT", message: "This command requires exactly one input." });
  }
  return input;
}

function commandInput(command: string, argumentsList: readonly string[]): unknown {
  if (command === "speech translate") {
    const targetLanguage = optionValue(argumentsList, "--to");
    if (targetLanguage === undefined) {
      throw new CliError({ code: "INVALID_ARGUMENT", message: "speech translate requires --to <language>." });
    }
    return { transcriptInput: positionalInput(argumentsList, ["--to"]), targetLanguage };
  }
  if (command.startsWith("speech ") && command !== "speech transcribe") {
    return { transcriptInput: positionalInput(argumentsList) };
  }
  return { audioPath: positionalInput(argumentsList) };
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
  const candidates = Object.values(commands);
  return candidates.find((command) => command.name === name);
}

async function executeCommand(
  name: string,
  input: unknown,
  commands: ReturnType<typeof createCommands>
): Promise<CliResult<unknown>> {
  if (name === commands.transcribe.name) {
    return runCommand(commands.transcribe, input);
  }
  if (name === commands.translate.name) {
    return runCommand(commands.translate, input);
  }
  if (name === commands.summarize.name) {
    return runCommand(commands.summarize, input);
  }
  if (name === commands.metadata.name) {
    return runCommand(commands.metadata, input);
  }
  if (name === commands.emotion.name) {
    return runCommand(commands.emotion, input);
  }
  if (name === commands.analyze.name) {
    return runCommand(commands.analyze, input);
  }
  return failedResult(name, new CliError({ code: "UNKNOWN_COMMAND", message: "Unknown audio command." }));
}

function parseSchemaFlag(argumentsList: readonly string[]): { schema: boolean; argumentsList: string[] } {
  return {
    schema: argumentsList.includes("--schema"),
    argumentsList: argumentsList.filter((argument) => argument !== "--schema")
  };
}

export async function runAudioCli(
  argumentsList: readonly string[],
  dependencies: AudioCliDependencies = {}
): Promise<AudioCliRunResult> {
  const stdout = dependencies.stdout ?? process.stdout;
  const { schema, argumentsList: withoutSchema } = parseSchemaFlag(argumentsList);
  let parsed;
  try {
    parsed = parseBaseOptions(withoutSchema);
  } catch (error) {
    emitResult(failedResult("dk-audio", error), { stdout });
    return { exitCode: 1 };
  }

  const commands = createCommands(dependencies);
  const [namespace, action, ...commandArguments] = parsed.positionals;
  if (parsed.options.help) {
    const command = namespace !== undefined && action !== undefined ? namedCommand(`${namespace} ${action}`, commands) : undefined;
    writeHelp(stdout, command);
    return { exitCode: 0 };
  }
  if (parsed.options.version) {
    stdout.write(`${VERSION}\n`);
    return { exitCode: 0 };
  }
  if (namespace === "describe") {
    const result = createSuccessResult(
      { command: "describe", version: VERSION },
      describeCommands(Object.values(commands))
    );
    emitResult(result, { mode: parsed.options.jsonl ? "jsonl" : "json", stdout });
    return { exitCode: 0 };
  }

  const name = namespace === undefined || action === undefined ? "dk-audio" : `${namespace} ${action}`;
  const command = namedCommand(name, commands);
  if (command === undefined) {
    emitResult(
      failedResult(name, new CliError({ code: "UNKNOWN_COMMAND", message: "Unknown audio command." })),
      { mode: parsed.options.jsonl ? "jsonl" : "json", stdout }
    );
    return { exitCode: 1 };
  }
  if (schema) {
    const result = createSuccessResult(
      { command: `${name} schema`, version: VERSION },
      {
        name: command.name,
        description: command.description,
        inputSchema: command.inputSchema.jsonSchema,
        outputSchema: command.outputSchema.jsonSchema,
        options: baseOptions
      }
    );
    emitResult(result, { mode: parsed.options.jsonl ? "jsonl" : "json", stdout });
    return { exitCode: 0 };
  }

  let result: CliResult<unknown>;
  try {
    const input = commandInput(name, commandArguments);
    emitProgress({ stage: "execute" }, { mode: parsed.options.jsonl ? "jsonl" : "json", stdout });
    result = await executeCommand(name, input, commands);
  } catch (error) {
    result = failedResult(name, error);
  }
  emitResult(result, { mode: parsed.options.jsonl ? "jsonl" : "json", stdout });
  return { exitCode: result.success ? 0 : 1 };
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void runAudioCli(process.argv.slice(2)).then(({ exitCode }) => {
    process.exitCode = exitCode;
  });
}
