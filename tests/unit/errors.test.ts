import { describe, expect, it } from "vitest";
import { CliError, exitCodeForError } from "../../src/core/errors.js";
import { EXIT_CODES } from "../../src/core/exit-codes.js";

describe("exitCodeForError", () => {
  it("maps usage-class CliError codes to exit code 2", () => {
    const usageCodes = [
      "E_USAGE",
      "E_COMMAND_NOT_FOUND",
      "E_MISSING_ARGUMENT",
      "E_INVALID_OPTION",
    ] as const;
    for (const code of usageCodes) {
      expect(exitCodeForError(new CliError(code, "boom"))).toBe(EXIT_CODES.USAGE);
    }
  });

  it("maps other CliError codes to exit code 3", () => {
    const commandCodes = [
      "E_INTERNAL",
      "E_PLUGIN_MANIFEST_INVALID",
      "E_PLUGIN_LOAD_FAILED",
      "E_PLUGIN_COMMAND_CONFLICT",
      "E_PLUGIN_DUPLICATE",
    ] as const;
    for (const code of commandCodes) {
      expect(exitCodeForError(new CliError(code, "boom"))).toBe(EXIT_CODES.COMMAND);
    }
  });

  it("maps non-CliError values to exit code 1", () => {
    expect(exitCodeForError(new Error("plain error"))).toBe(EXIT_CODES.UNCAUGHT);
    expect(exitCodeForError("a string")).toBe(EXIT_CODES.UNCAUGHT);
    expect(exitCodeForError(undefined)).toBe(EXIT_CODES.UNCAUGHT);
    expect(exitCodeForError(null)).toBe(EXIT_CODES.UNCAUGHT);
  });
});

describe("CliError", () => {
  it("carries code, message and details", () => {
    const details = { input: "--unknown" };
    const err = new CliError("E_INVALID_OPTION", "unknown option", details);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CliError);
    expect(err.name).toBe("CliError");
    expect(err.code).toBe("E_INVALID_OPTION");
    expect(err.message).toBe("unknown option");
    expect(err.details).toEqual(details);
  });

  it("defaults details to undefined", () => {
    const err = new CliError("E_INTERNAL", "boom");
    expect(err.details).toBeUndefined();
  });
});
