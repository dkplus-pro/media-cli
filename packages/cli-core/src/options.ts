import { CliError } from "@dkplus/contracts";

export interface BaseOptions {
  help: boolean;
  version: boolean;
  config?: string;
  json: boolean;
  jsonl: boolean;
  quiet: boolean;
  verbose: boolean;
  force: boolean;
  noCache: boolean;
}

export interface BaseOptionDefinition {
  flag: string;
  description: string;
}

export const baseOptions: readonly BaseOptionDefinition[] = [
  { flag: "--help", description: "Show command help." },
  { flag: "--version", description: "Show command version." },
  { flag: "--config <path>", description: "Load configuration from a file." },
  { flag: "--json", description: "Emit a single JSON result envelope." },
  { flag: "--jsonl", description: "Emit JSON Lines progress events." },
  { flag: "--quiet", description: "Suppress non-essential diagnostics." },
  { flag: "--verbose", description: "Emit verbose diagnostics." },
  { flag: "--force", description: "Allow an explicitly overwriteable operation." },
  { flag: "--no-cache", description: "Disable cached results." }
];

export interface ParsedBaseOptions {
  options: BaseOptions;
  positionals: string[];
}

function defaultOptions(): BaseOptions {
  return {
    help: false,
    version: false,
    json: false,
    jsonl: false,
    quiet: false,
    verbose: false,
    force: false,
    noCache: false
  };
}

function missingConfigValue(): CliError {
  return new CliError({ code: "INVALID_ARGUMENT", message: "--config requires a path." });
}

export function parseBaseOptions(argumentsList: readonly string[]): ParsedBaseOptions {
  const options = defaultOptions();
  const positionals: string[] = [];

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === undefined) {
      continue;
    }

    if (argument === "--") {
      positionals.push(...argumentsList.slice(index + 1));
      break;
    }

    if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--version" || argument === "-V") {
      options.version = true;
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--jsonl") {
      options.jsonl = true;
    } else if (argument === "--quiet") {
      options.quiet = true;
    } else if (argument === "--verbose") {
      options.verbose = true;
    } else if (argument === "--force") {
      options.force = true;
    } else if (argument === "--no-cache") {
      options.noCache = true;
    } else if (argument === "--config") {
      const config = argumentsList[index + 1];
      if (config === undefined || config.length === 0 || config.startsWith("-")) {
        throw missingConfigValue();
      }
      options.config = config;
      index += 1;
    } else if (argument.startsWith("--config=")) {
      const config = argument.slice("--config=".length);
      if (config.length === 0) {
        throw missingConfigValue();
      }
      options.config = config;
    } else {
      positionals.push(argument);
    }
  }

  if (options.json && options.jsonl) {
    throw new CliError({
      code: "MUTUALLY_EXCLUSIVE_OUTPUT_MODE",
      message: "--json and --jsonl cannot be used together."
    });
  }

  return { options, positionals };
}
