import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CliError,
  defineSchema,
  describeCommands,
  emitDiagnostic,
  emitProgress,
  emitResult,
  parseBaseOptions,
  runCommand
} from "../dist/index.js";

const inputSchema = defineSchema({ type: "object", required: ["value"] }, (value) => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("value" in value) ||
    typeof value.value !== "string"
  ) {
    throw new CliError({ code: "INVALID_COMMAND_INPUT", message: "A string value is required." });
  }

  return { value: value.value };
});

const outputSchema = defineSchema({ type: "object", required: ["uppercase"] }, (value) => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("uppercase" in value) ||
    typeof value.uppercase !== "string"
  ) {
    throw new CliError({
      code: "INVALID_COMMAND_OUTPUT",
      message: "An uppercase value is required."
    });
  }

  return { uppercase: value.uppercase };
});

const command = {
  name: "example uppercase",
  description: "Uppercases a value.",
  version: "0.1.0",
  inputSchema,
  outputSchema,
  execute: ({ value }) => ({ uppercase: value.toUpperCase() })
};

describe("runCommand", () => {
  it("wraps command output in the stable success result", async () => {
    assert.deepEqual(await runCommand(command, { value: "hello" }), {
      success: true,
      command: "example uppercase",
      version: "0.1.0",
      data: { uppercase: "HELLO" }
    });
  });

  it("maps untyped failures to a stable internal error result", async () => {
    const missingImage = {
      ...command,
      execute: () => {
        throw new Error("IMAGE_NOT_FOUND");
      }
    };

    const result = await runCommand(missingImage, { value: "hello" });
    assert.equal(result.success, false);
    assert.deepEqual(result.error, {
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred."
    });
  });

  it("rejects invalid input before execution with a CLI error envelope", async () => {
    let executed = false;
    const result = await runCommand(
      {
        ...command,
        execute: () => {
          executed = true;
          return { uppercase: "UNREACHABLE" };
        }
      },
      { value: 42 }
    );

    assert.equal(executed, false);
    assert.deepEqual(result, {
      success: false,
      command: "example uppercase",
      version: "0.1.0",
      error: { code: "INVALID_COMMAND_INPUT", message: "A string value is required." }
    });
  });

  it("rejects invalid output with a CLI error envelope", async () => {
    const result = await runCommand(
      { ...command, execute: () => ({ uppercase: 42 }) },
      { value: "hello" }
    );

    assert.deepEqual(result, {
      success: false,
      command: "example uppercase",
      version: "0.1.0",
      error: { code: "INVALID_COMMAND_OUTPUT", message: "An uppercase value is required." }
    });
  });
});

describe("base options", () => {
  it("parses standard flags while preserving command arguments", () => {
    assert.deepEqual(
      parseBaseOptions([
        "speech",
        "summarize",
        "input.json",
        "--help",
        "--version",
        "--config",
        "media.toml",
        "--json",
        "--quiet",
        "--verbose",
        "--force",
        "--no-cache",
        "--domain-option"
      ]),
      {
        options: {
          help: true,
          version: true,
          config: "media.toml",
          json: true,
          jsonl: false,
          quiet: true,
          verbose: true,
          force: true,
          noCache: true
        },
        positionals: ["speech", "summarize", "input.json", "--domain-option"]
      }
    );
  });

  it("recognizes JSONL output mode without consuming positional arguments", () => {
    assert.deepEqual(parseBaseOptions(["audio", "--jsonl", "clip.wav"]), {
      options: {
        help: false,
        version: false,
        json: false,
        jsonl: true,
        quiet: false,
        verbose: false,
        force: false,
        noCache: false
      },
      positionals: ["audio", "clip.wav"]
    });
  });

  it("rejects JSON and JSONL together with a CLI error", () => {
    assert.throws(
      () => parseBaseOptions(["--json", "--jsonl"]),
      (error) => error instanceof CliError && error.code === "MUTUALLY_EXCLUSIVE_OUTPUT_MODE"
    );
  });

  it("does not consume another option as a config path", () => {
    assert.throws(
      () => parseBaseOptions(["--config", "--json"]),
      (error) => error instanceof CliError && error.code === "INVALID_ARGUMENT"
    );
  });
});

describe("output helpers", () => {
  it("emits exactly one JSON result line", () => {
    const lines = [];
    emitResult(
      {
        success: true,
        command: "example uppercase",
        version: "0.1.0",
        data: { uppercase: "HELLO" }
      },
      { write: (line) => lines.push(line) }
    );

    assert.deepEqual(lines, [
      '{"success":true,"command":"example uppercase","version":"0.1.0","data":{"uppercase":"HELLO"}}\n'
    ]);
  });

  it("emits JSONL progress only in explicit JSONL mode", () => {
    const lines = [];
    emitProgress(
      { stage: "probe", completed: 1, total: 3 },
      { mode: "jsonl", stdout: { write: (line) => lines.push(line) } }
    );

    assert.deepEqual(lines, ['{"type":"progress","stage":"probe","completed":1,"total":3}\n']);
  });

  it("keeps the legacy JSONL writer form compatible", () => {
    const lines = [];
    emitProgress({ stage: "probe" }, { jsonl: true, write: (line) => lines.push(line) });

    assert.deepEqual(lines, ['{"type":"progress","stage":"probe"}\n']);
  });

  it("keeps normal JSON stdout to one result and sends diagnostics to stderr", () => {
    const stdout = [];
    const stderr = [];
    const result = {
      success: true,
      command: "example uppercase",
      version: "0.1.0",
      data: { uppercase: "HELLO" }
    };

    emitProgress(
      { stage: "probe" },
      { mode: "json", stdout: { write: (line) => stdout.push(line) } }
    );
    emitResult(result, { mode: "json", stdout: { write: (line) => stdout.push(line) } });
    emitDiagnostic("probing input", { stderr: { write: (line) => stderr.push(line) } });

    assert.deepEqual(stdout, [
      '{"success":true,"command":"example uppercase","version":"0.1.0","data":{"uppercase":"HELLO"}}\n'
    ]);
    assert.deepEqual(stderr, ["probing input\n"]);
  });
});

describe("command descriptions", () => {
  it("returns descriptors in stable command-name order", () => {
    const later = { ...command, name: "zeta command", execute: () => undefined };

    assert.deepEqual(describeCommands([later, command]), {
      schemaVersion: "1.0",
      commands: [
        {
          name: "example uppercase",
          description: "Uppercases a value.",
          version: "0.1.0",
          inputSchema: { type: "object", required: ["value"] },
          outputSchema: { type: "object", required: ["uppercase"] }
        },
        {
          name: "zeta command",
          description: "Uppercases a value.",
          version: "0.1.0",
          inputSchema: { type: "object", required: ["value"] },
          outputSchema: { type: "object", required: ["uppercase"] }
        }
      ]
    });
  });
});
