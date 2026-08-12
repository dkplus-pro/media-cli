import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const rootDirectory = process.cwd();
const packagesDirectory = join(rootDirectory, "packages");

function run(command, argumentsList, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, argumentsList, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode) => {
      const output = `${Buffer.concat(stdout)}${Buffer.concat(stderr)}`;
      if (exitCode === 0) {
        resolveRun(output);
      } else {
        reject(
          new Error(`${command} ${argumentsList.join(" ")} failed with exit ${exitCode}: ${output}`)
        );
      }
    });
  });
}

async function publicPackages() {
  const entries = await readdir(packagesDirectory, { withFileTypes: true });
  const manifests = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const directory = join(packagesDirectory, entry.name);
        try {
          const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
          return manifest.private === true ? undefined : { directory, manifest };
        } catch {
          return undefined;
        }
      })
  );
  return manifests
    .filter((item) => item !== undefined)
    .sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
}

async function packAndInspect(packages, packDirectory) {
  const archives = new Map();
  for (const item of packages) {
    const before = new Set(await readdir(packDirectory));
    await run("pnpm", ["pack", "--pack-destination", packDirectory], item.directory);
    const archive = (await readdir(packDirectory)).find(
      (name) => !before.has(name) && name.endsWith(".tgz")
    );
    assert.ok(archive, `pnpm pack did not create an archive for ${item.manifest.name}`);
    const archivePath = join(packDirectory, archive);
    const entries = (await run("tar", ["-tzf", archivePath], rootDirectory)).trim().split("\n");
    assert.ok(
      entries.includes("package/package.json"),
      `${item.manifest.name} archive lacks package.json`
    );
    for (const file of item.manifest.files ?? []) {
      assert.ok(
        entries.some(
          (entry) => entry === `package/${file}` || entry.startsWith(`package/${file}/`)
        ),
        `${item.manifest.name} archive lacks ${file}`
      );
    }
    archives.set(item.manifest.name, archivePath);
  }
  return archives;
}

async function installPackedPackages(packages, archives, consumerDirectory) {
  const packedDependencies = Object.fromEntries(
    packages.map((item) => [item.manifest.name, `file:${archives.get(item.manifest.name)}`])
  );
  const dependencies = {
    ...packedDependencies,
    zod: `link:${resolve(rootDirectory, "packages/ai-core/node_modules/zod")}`,
    sharp: `link:${resolve(rootDirectory, "packages/media-core/node_modules/sharp")}`
  };
  await writeFile(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify({
      name: "dkplus-smoke-consumer",
      private: true,
      version: "0.0.0",
      dependencies
    })}\n`
  );
  await writeFile(
    join(consumerDirectory, "pnpm-workspace.yaml"),
    `overrides:\n${Object.entries(dependencies)
      .map(([name, specification]) => `  ${JSON.stringify(name)}: ${JSON.stringify(specification)}`)
      .join("\n")}\n`
  );
  await run("pnpm", ["install", "--offline", "--ignore-scripts"], consumerDirectory);
}

async function verifyCliHelp(consumerDirectory, name) {
  const installedBinary = join(consumerDirectory, "node_modules", ".bin", name);
  const binaryStats = await lstat(installedBinary);
  assert.ok(
    binaryStats.isFile() || binaryStats.isSymbolicLink(),
    `${name} must be available through the consumer node_modules/.bin directory`
  );
  const output = await run(installedBinary, ["--help"], consumerDirectory);
  assert.match(output, new RegExp(`Usage: ${name}`, "u"));
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "dkplus-public-package-smoke-"));
try {
  const packages = await publicPackages();
  const packDirectory = join(temporaryDirectory, "packed");
  const consumerDirectory = join(temporaryDirectory, "consumer");
  await Promise.all([
    mkdir(packDirectory, { recursive: true }),
    mkdir(consumerDirectory, { recursive: true })
  ]);
  const archives = await packAndInspect(packages, packDirectory);
  await installPackedPackages(packages, archives, consumerDirectory);
  for (const name of ["dk-audio", "dk-image", "dk-video"]) {
    await verifyCliHelp(consumerDirectory, name);
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
