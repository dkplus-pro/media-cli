import { fileURLToPath } from "node:url";

export const fixturesDirectory = fileURLToPath(new URL("../fixtures/", import.meta.url));

export function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
}
