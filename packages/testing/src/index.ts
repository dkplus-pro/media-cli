import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export const fixturesDirectory = fileURLToPath(new URL("../fixtures/", import.meta.url));

export function fixturePath(name: string): string {
  if (isAbsolute(name) || win32.isAbsolute(name) || name.split(/[\\/]/u).includes("..")) {
    throw new RangeError("Fixture path must be relative to the fixture directory.");
  }

  const path = resolve(fixturesDirectory, name);
  const pathFromFixtures = relative(fixturesDirectory, path);
  if (
    pathFromFixtures.length === 0 ||
    pathFromFixtures === ".." ||
    pathFromFixtures.startsWith(`..${sep}`) ||
    isAbsolute(pathFromFixtures)
  ) {
    throw new RangeError("Fixture path must be relative to the fixture directory.");
  }

  return path;
}
