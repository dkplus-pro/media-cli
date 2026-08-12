import type { AIProvider, AITask } from "./task.js";

export type MockResponseFactory = (task: AITask<unknown>) => unknown | Promise<unknown>;

export function createMockProvider(factory: MockResponseFactory): AIProvider {
  return {
    async execute<Result>(task: AITask<Result>): Promise<Result> {
      return task.responseSchema.parse(await factory(task));
    }
  };
}
