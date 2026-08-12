import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  describeCommands,
  emitProgress,
  emitResult,
  runCommand
} from "../dist/index.js";

const command = {
  name: "example uppercase",
  description: "Uppercases a value.",
  version: "0.1.0",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
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

    const result = await runCommand(missingImage, undefined);
    assert.equal(result.success, false);
    assert.deepEqual(result.error, {
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred."
    });
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

  it("emits progress only as JSONL when requested", () => {
    const lines = [];
    emitProgress({ stage: "probe", completed: 1, total: 3 }, { jsonl: true, write: (line) => lines.push(line) });

    assert.deepEqual(lines, ['{"type":"progress","stage":"probe","completed":1,"total":3}\n']);
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
          inputSchema: { type: "object" },
          outputSchema: { type: "object" }
        },
        {
          name: "zeta command",
          description: "Uppercases a value.",
          version: "0.1.0",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" }
        }
      ]
    });
  });
});
