import type { CommandDefinition } from "../src/index.js";

const command: CommandDefinition<{ value: string }, { uppercase: string }> = {
  name: "example uppercase",
  description: "Uppercases a value.",
  version: "0.1.0",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  execute: ({ value }) => ({ uppercase: value.toUpperCase() })
};

void command;
