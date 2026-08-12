import { defineSchema, type CommandDefinition } from "../src/index.js";

const command: CommandDefinition<{ value: string }, { uppercase: string }> = {
  name: "example uppercase",
  description: "Uppercases a value.",
  version: "0.1.0",
  inputSchema: defineSchema({ type: "object" }, (input) => input as { value: string }),
  outputSchema: defineSchema({ type: "object" }, (output) => output as { uppercase: string }),
  execute: ({ value }) => ({ uppercase: value.toUpperCase() })
};

void command;
