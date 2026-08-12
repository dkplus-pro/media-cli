#!/usr/bin/env node

import type { AIProvider } from "@dkplus/ai-core";
import {
  baseOptions,
  defineSchema,
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

import { loadConfiguredVideoProvider, type VideoProviderFactory } from "./ai-config.js";
import {
  analyzeVideo,
  extractVideoHighlights,
  extractVideoKeywords,
  readVideoArtifact,
  summarizeVideoContent,
  videoAnalysisSchema,
  videoContentHighlightsSchema,
  videoContentKeywordsSchema,
  videoContentSummarySchema,
  type VideoAnalysis
} from "./content.js";
import {
  createVideoFilmstrip,
  extractVideoAudio,
  extractVideoSubtitles,
  probeVideo,
  videoAudioSchema,
  videoFilmstripSchema,
  videoProbeSchema
} from "./media.js";
import type { AudioTranscriber } from "@dkplus/dk-audio";

const VERSION = "0.1.0";

export interface VideoCliDependencies {
  provider?: AIProvider;
  providerFactory?: VideoProviderFactory;
  transcriber?: AudioTranscriber;
  stdout?: OutputWriter;
  stderr?: OutputWriter;
}

export interface VideoCliRunResult {
  exitCode: 0 | 1;
}

interface VideoPathInput {
  videoPath: string;
}

interface AudioInput extends VideoPathInput {
  outputPath: string;
  force: boolean;
}

interface FilmstripInput extends AudioInput {
  timestamps: [number, number, number, number];
  width: number;
  height: number;
}

interface ContentInput extends VideoPathInput {
  transcriptInput: string;
  filmstripInput: string;
}

interface AnalyzeInput extends VideoPathInput {
  probeInput?: string;
  audioInput?: string;
  filmstripInput?: string;
  subtitlesInput?: string;
  summaryInput?: string;
  keywordsInput?: string;
  highlightsInput?: string;
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

function parseOptionalStringField(value: unknown, field: string): string | undefined {
  if (!isRecord(value) || value[field] === undefined) {
    return undefined;
  }
  return parseStringField(value, field);
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

const videoPathSchema = defineSchema<VideoPathInput>(
  { type: "object", required: ["videoPath"] },
  (value) => ({ videoPath: parseStringField(value, "videoPath") })
);
const audioInputSchema = defineSchema<AudioInput>(
  { type: "object", required: ["videoPath", "outputPath", "force"] },
  (value) => ({
    videoPath: parseStringField(value, "videoPath"),
    outputPath: parseStringField(value, "outputPath"),
    force: isRecord(value) && value["force"] === true
  })
);
const filmstripInputSchema = defineSchema<FilmstripInput>(
  {
    type: "object",
    required: ["videoPath", "outputPath", "timestamps", "width", "height", "force"]
  },
  (value) => {
    if (
      !isRecord(value) ||
      !Array.isArray(value["timestamps"]) ||
      value["timestamps"].length !== 4 ||
      !value["timestamps"].every((item) => typeof item === "number")
    ) {
      throw new CliError({
        code: "INVALID_COMMAND_INPUT",
        message: "timestamps must contain four numbers."
      });
    }
    if (typeof value["width"] !== "number" || typeof value["height"] !== "number") {
      throw new CliError({
        code: "INVALID_COMMAND_INPUT",
        message: "width and height must be numbers."
      });
    }
    return {
      videoPath: parseStringField(value, "videoPath"),
      outputPath: parseStringField(value, "outputPath"),
      timestamps: value["timestamps"] as [number, number, number, number],
      width: value["width"],
      height: value["height"],
      force: value["force"] === true
    };
  }
);
const contentInputSchema = defineSchema<ContentInput>(
  { type: "object", required: ["videoPath", "transcriptInput", "filmstripInput"] },
  (value) => ({
    videoPath: parseStringField(value, "videoPath"),
    transcriptInput: parseStringField(value, "transcriptInput"),
    filmstripInput: parseStringField(value, "filmstripInput")
  })
);
const analyzeInputSchema = defineSchema<AnalyzeInput>(
  { type: "object", required: ["videoPath"] },
  (value) => ({
    videoPath: parseStringField(value, "videoPath"),
    probeInput: parseOptionalStringField(value, "probeInput"),
    audioInput: parseOptionalStringField(value, "audioInput"),
    filmstripInput: parseOptionalStringField(value, "filmstripInput"),
    subtitlesInput: parseOptionalStringField(value, "subtitlesInput"),
    summaryInput: parseOptionalStringField(value, "summaryInput"),
    keywordsInput: parseOptionalStringField(value, "keywordsInput"),
    highlightsInput: parseOptionalStringField(value, "highlightsInput")
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

function createCommands(dependencies: VideoCliDependencies) {
  const probe: CommandDefinition<VideoPathInput, unknown> = {
    name: "probe",
    description: "Read deterministic local video metadata.",
    version: VERSION,
    inputSchema: videoPathSchema,
    outputSchema: runtimeSchema(
      { type: "object", required: ["kind", "sourceFingerprint", "durationMs", "width", "height"] },
      videoProbeSchema
    ),
    execute: ({ videoPath }) => probeVideo(videoPath)
  };
  const audio: CommandDefinition<AudioInput, unknown> = {
    name: "audio",
    description: "Extract a local audio artifact linked to the video source.",
    version: VERSION,
    inputSchema: audioInputSchema,
    outputSchema: runtimeSchema(
      { type: "object", required: ["kind", "sourceFingerprint", "outputPath"] },
      videoAudioSchema
    ),
    execute: ({ videoPath, outputPath, force }) =>
      extractVideoAudio(videoPath, outputPath, { force })
  };
  const filmstrip: CommandDefinition<FilmstripInput, unknown> = {
    name: "filmstrip",
    description: "Create a four-frame filmstrip artifact linked to the video source.",
    version: VERSION,
    inputSchema: filmstripInputSchema,
    outputSchema: runtimeSchema(
      { type: "object", required: ["kind", "sourceFingerprint", "outputPath", "image"] },
      videoFilmstripSchema
    ),
    execute: ({ videoPath, outputPath, timestamps, width, height }) =>
      createVideoFilmstrip(videoPath, outputPath, { timestamps, width, height })
  };
  const subtitles: CommandDefinition<VideoPathInput, unknown> = {
    name: "subtitles",
    description: "Extract temporary audio and transcribe it through an injected adapter.",
    version: VERSION,
    inputSchema: videoPathSchema,
    outputSchema: runtimeSchema(
      { type: "object", required: ["kind", "sourceFingerprint", "language", "segments"] },
      z
        .object({
          kind: z.literal("transcript"),
          schemaVersion: z.literal("1.0"),
          sourceFingerprint: z.object({ algorithm: z.literal("sha256"), value: z.string() }),
          language: z.string(),
          segments: z.array(z.unknown())
        })
        .strict()
    ),
    execute: ({ videoPath }) =>
      extractVideoSubtitles(videoPath, { transcriber: dependencies.transcriber })
  };
  const summary: CommandDefinition<ContentInput, unknown> = {
    name: "content summary",
    description: "Summarize a matching transcript and filmstrip through a feature-routed provider.",
    version: VERSION,
    inputSchema: contentInputSchema,
    outputSchema: runtimeSchema(
      { type: "object", required: ["kind", "sourceFingerprint", "summary", "topics", "keyPoints"] },
      videoContentSummarySchema
    ),
    execute: async ({ videoPath, transcriptInput, filmstripInput }) =>
      summarizeVideoContent(videoPath, {
        transcript: await readVideoArtifact(transcriptInput),
        filmstrip: await readVideoArtifact(filmstripInput),
        provider: providerOrError(dependencies.provider)
      })
  };
  const keywords: CommandDefinition<ContentInput, unknown> = {
    name: "content keywords",
    description:
      "Extract keywords from a matching transcript and filmstrip through a feature-routed provider.",
    version: VERSION,
    inputSchema: contentInputSchema,
    outputSchema: runtimeSchema(
      { type: "object", required: ["kind", "sourceFingerprint", "keywords"] },
      videoContentKeywordsSchema
    ),
    execute: async ({ videoPath, transcriptInput, filmstripInput }) =>
      extractVideoKeywords(videoPath, {
        transcript: await readVideoArtifact(transcriptInput),
        filmstrip: await readVideoArtifact(filmstripInput),
        provider: providerOrError(dependencies.provider)
      })
  };
  const highlights: CommandDefinition<ContentInput, unknown> = {
    name: "content highlights",
    description:
      "Extract timestamped highlights from a matching transcript and filmstrip through a feature-routed provider.",
    version: VERSION,
    inputSchema: contentInputSchema,
    outputSchema: runtimeSchema(
      { type: "object", required: ["kind", "sourceFingerprint", "highlights"] },
      videoContentHighlightsSchema
    ),
    execute: async ({ videoPath, transcriptInput, filmstripInput }) =>
      extractVideoHighlights(videoPath, {
        transcript: await readVideoArtifact(transcriptInput),
        filmstrip: await readVideoArtifact(filmstripInput),
        provider: providerOrError(dependencies.provider)
      })
  };
  const analyze: CommandDefinition<AnalyzeInput, unknown> = {
    name: "analyze",
    description: "Compose only explicitly supplied video prerequisite artifacts.",
    version: VERSION,
    inputSchema: analyzeInputSchema,
    outputSchema: runtimeSchema(
      {
        type: "object",
        required: ["probe", "audio", "filmstrip", "subtitles", "summary", "keywords", "highlights"]
      },
      videoAnalysisSchema
    ),
    execute: async (input) =>
      analyzeVideo(input.videoPath, {
        dependencies: {
          ...(input.probeInput === undefined
            ? {}
            : { probe: await readVideoArtifact<VideoAnalysis["probe"]>(input.probeInput) }),
          ...(input.audioInput === undefined
            ? {}
            : { audio: await readVideoArtifact<VideoAnalysis["audio"]>(input.audioInput) }),
          ...(input.filmstripInput === undefined
            ? {}
            : {
                filmstrip: await readVideoArtifact<VideoAnalysis["filmstrip"]>(input.filmstripInput)
              }),
          ...(input.subtitlesInput === undefined
            ? {}
            : {
                subtitles: await readVideoArtifact<VideoAnalysis["subtitles"]>(input.subtitlesInput)
              }),
          ...(input.summaryInput === undefined
            ? {}
            : { summary: await readVideoArtifact<VideoAnalysis["summary"]>(input.summaryInput) }),
          ...(input.keywordsInput === undefined
            ? {}
            : {
                keywords: await readVideoArtifact<VideoAnalysis["keywords"]>(input.keywordsInput)
              }),
          ...(input.highlightsInput === undefined
            ? {}
            : {
                highlights: await readVideoArtifact<VideoAnalysis["highlights"]>(
                  input.highlightsInput
                )
              })
        }
      })
  };
  return { probe, audio, filmstrip, subtitles, summary, keywords, highlights, analyze };
}

function helpText(command?: { name: string; description: string }): string {
  if (command !== undefined) {
    return `${command.name}: ${command.description}\n${baseOptions.map((option) => option.flag).join(", ")}, --schema\n`;
  }
  return (
    "Usage: dk-video <probe|audio|filmstrip|subtitles|content|analyze> [input] [options]\n\n" +
    "Commands: probe, audio, filmstrip, subtitles, content summary, content keywords, content highlights, analyze\n" +
    `${baseOptions.map((option) => option.flag).join(", ")}, --schema\n`
  );
}

function optionValue(argumentsList: readonly string[], name: string): string | undefined {
  const equalsPrefix = `${name}=`;
  const equals = argumentsList.find((argument) => argument.startsWith(equalsPrefix));
  if (equals !== undefined) {
    const value = equals.slice(equalsPrefix.length);
    if (value.length === 0)
      throw new CliError({ code: "INVALID_ARGUMENT", message: `${name} requires a value.` });
    return value;
  }
  const index = argumentsList.indexOf(name);
  if (index === -1) return undefined;
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
    if (optionNames.some((option) => argument === option || argument.startsWith(`${option}=`)))
      return false;
    return !optionNames.includes(argumentsList[index - 1] ?? "");
  });
  if (values.length !== 1 || values[0] === undefined) {
    throw new CliError({
      code: "INVALID_ARGUMENT",
      message: "This command requires exactly one video input."
    });
  }
  return values[0];
}

function requiredOption(argumentsList: readonly string[], name: string, command: string): string {
  const value = optionValue(argumentsList, name);
  if (value === undefined)
    throw new CliError({
      code: "INVALID_ARGUMENT",
      message: `${command} requires ${name} <value>.`
    });
  return value;
}

function parseTimestamps(value: string | undefined): [number, number, number, number] {
  if (value === undefined) return [0, 1, 2, 3];
  const timestamps = value.split(",").map(Number);
  if (
    timestamps.length !== 4 ||
    timestamps.some((timestamp) => !Number.isFinite(timestamp) || timestamp < 0)
  ) {
    throw new CliError({
      code: "INVALID_ARGUMENT",
      message: "--timestamps requires four non-negative comma-separated seconds."
    });
  }
  return timestamps as [number, number, number, number];
}

function parsePositiveInteger(value: string | undefined, flag: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 1)
    throw new CliError({
      code: "INVALID_ARGUMENT",
      message: `${flag} requires a positive integer.`
    });
  return parsed;
}

function commandInput(name: string, argumentsList: readonly string[], force: boolean): unknown {
  if (name === "audio") {
    return {
      videoPath: positionalInput(argumentsList, ["--output"]),
      outputPath: requiredOption(argumentsList, "--output", name),
      force
    };
  }
  if (name === "filmstrip") {
    return {
      videoPath: positionalInput(argumentsList, [
        "--output",
        "--timestamps",
        "--width",
        "--height"
      ]),
      outputPath: requiredOption(argumentsList, "--output", name),
      timestamps: parseTimestamps(optionValue(argumentsList, "--timestamps")),
      width: parsePositiveInteger(optionValue(argumentsList, "--width"), "--width", 320),
      height: parsePositiveInteger(optionValue(argumentsList, "--height"), "--height", 180),
      force
    };
  }
  if (name.startsWith("content ")) {
    return {
      videoPath: positionalInput(argumentsList, ["--transcript", "--filmstrip"]),
      transcriptInput: requiredOption(argumentsList, "--transcript", name),
      filmstripInput: requiredOption(argumentsList, "--filmstrip", name)
    };
  }
  if (name === "analyze") {
    const flags = [
      "--probe",
      "--audio",
      "--filmstrip",
      "--subtitles",
      "--summary",
      "--keywords",
      "--highlights"
    ];
    return {
      videoPath: positionalInput(argumentsList, flags),
      probeInput: optionValue(argumentsList, "--probe"),
      audioInput: optionValue(argumentsList, "--audio"),
      filmstripInput: optionValue(argumentsList, "--filmstrip"),
      subtitlesInput: optionValue(argumentsList, "--subtitles"),
      summaryInput: optionValue(argumentsList, "--summary"),
      keywordsInput: optionValue(argumentsList, "--keywords"),
      highlightsInput: optionValue(argumentsList, "--highlights")
    };
  }
  return { videoPath: positionalInput(argumentsList) };
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

function requiresAiProvider(name: string): boolean {
  return name === "content summary" || name === "content keywords" || name === "content highlights";
}

async function executeCommand(
  name: string,
  input: unknown,
  commands: ReturnType<typeof createCommands>
): Promise<CliResult<unknown>> {
  const command = namedCommand(name, commands);
  if (command === undefined)
    return failedResult(
      name,
      new CliError({ code: "UNKNOWN_COMMAND", message: "Unknown video command." })
    );
  return runCommand(command, input);
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

export async function runVideoCli(
  argumentsList: readonly string[],
  dependencies: VideoCliDependencies = {}
): Promise<VideoCliRunResult> {
  const stdout = dependencies.stdout ?? process.stdout;
  const { schema, argumentsList: withoutSchema } = parseSchemaFlag(argumentsList);
  let parsed;
  try {
    parsed = parseBaseOptions(withoutSchema);
  } catch (error) {
    emitResult(failedResult("dk-video", error), { stdout });
    return { exitCode: 1 };
  }
  let commands = createCommands(dependencies);
  const [namespace, action, ...commandArguments] = parsed.positionals;
  const isContentCommand = namespace === "content" && action !== undefined;
  const name = isContentCommand ? `content ${action}` : (namespace ?? "dk-video");
  const inputArguments = isContentCommand
    ? commandArguments
    : action === undefined
      ? []
      : [action, ...commandArguments];
  const command = namedCommand(name, commands);
  const mode = parsed.options.jsonl ? "jsonl" : "json";

  if (parsed.options.help) {
    if (parsed.options.json || parsed.options.jsonl) {
      emitResult(
        createSuccessResult(
          { command: `${command?.name ?? "dk-video"} help`, version: VERSION },
          { help: helpText(command) }
        ),
        { mode, stdout }
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
          { command: "dk-video version", version: VERSION },
          { version: VERSION }
        ),
        { mode, stdout }
      );
    } else {
      stdout.write(`${VERSION}\n`);
    }
    return { exitCode: 0 };
  }
  if (command === undefined) {
    emitResult(
      failedResult(
        name,
        new CliError({ code: "UNKNOWN_COMMAND", message: "Unknown video command." })
      ),
      { mode, stdout }
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
      { mode, stdout }
    );
    return { exitCode: 0 };
  }

  let result: CliResult<unknown>;
  try {
    const provider =
      parsed.options.config !== undefined && requiresAiProvider(name)
        ? await loadConfiguredVideoProvider(parsed.options.config, dependencies.providerFactory)
        : dependencies.provider;
    commands = createCommands({ ...dependencies, provider });
    const input = commandInput(name, inputArguments, parsed.options.force);
    emitProgress({ stage: "execute" }, { mode, stdout });
    result = await executeCommand(name, input, commands);
  } catch (error) {
    result = failedResult(name, error);
  }
  emitResult(result, { mode, stdout });
  return { exitCode: result.success ? 0 : 1 };
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  void runVideoCli(process.argv.slice(2)).then(({ exitCode }) => {
    process.exitCode = exitCode;
  });
}
