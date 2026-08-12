import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

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
  const archiveSpecifications = new Map(
    await Promise.all(
      packages.map(async (item) => {
        const archivePath = archives.get(item.manifest.name);
        assert.ok(archivePath, `missing archive for ${item.manifest.name}`);
        return [item.manifest.name, `file:${await realpath(archivePath)}`];
      })
    )
  );
  const packedDependencies = Object.fromEntries(archiveSpecifications);
  const externalDependencies = { sharp: "0.34.5", zod: "3.25.76" };
  await writeFile(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify({
      name: "dkplus-smoke-consumer",
      private: true,
      version: "0.0.0",
      dependencies: { ...packedDependencies, ...externalDependencies }
    })}\n`
  );
  await writeConsumerLockfile(
    packages,
    archives,
    archiveSpecifications,
    consumerDirectory,
    { ...packedDependencies, ...externalDependencies },
    externalDependencies
  );
  await run("pnpm", ["install", "--offline", "--ignore-scripts", "--frozen-lockfile"], consumerDirectory);
}

async function writeConsumerLockfile(
  packages,
  archives,
  archiveSpecifications,
  consumerDirectory,
  dependencies,
  externalDependencies
) {
  const rootLockfile = await readFile(join(rootDirectory, "pnpm-lock.yaml"), "utf8");
  const packagesStart = rootLockfile.indexOf("\npackages:");
  const snapshotsStart = rootLockfile.indexOf("\nsnapshots:");
  const packageResolutionRecords = rootLockfile.slice(packagesStart + 11, snapshotsStart);
  const snapshotRecords = rootLockfile.slice(snapshotsStart + 12);
  const dependencyEntries = Object.entries(dependencies)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([name, specification]) =>
        `      ${JSON.stringify(name)}:\n        specifier: ${JSON.stringify(specification)}\n        version: ${JSON.stringify(specification)}`
    )
    .join("\n");
  const archiveEntries = await Promise.all(
    packages.map(async (item) => {
      const archivePath = archives.get(item.manifest.name);
      assert.ok(archivePath, `missing archive for ${item.manifest.name}`);
      const specification = archiveSpecifications.get(item.manifest.name);
      assert.ok(specification, `missing archive specification for ${item.manifest.name}`);
      const key = `${item.manifest.name}@${specification}`;
      const integrity = `sha512-${createHash("sha512")
        .update(await readFile(archivePath))
        .digest("base64")}`;
      const snapshotDependencies = Object.entries(item.manifest.dependencies ?? {})
        .map(([name]) => {
          const version = archiveSpecifications.get(name) ?? externalDependencies[name];
          assert.ok(version, `missing smoke dependency resolution for ${name}`);
          return `      ${JSON.stringify(name)}: ${JSON.stringify(version)}`;
        })
        .sort()
        .join("\n");
      return {
        packageRecord: `  ${JSON.stringify(key)}:\n    resolution: {integrity: ${JSON.stringify(integrity)}}\n    version: ${item.manifest.version}`,
        snapshotRecord:
          snapshotDependencies.length === 0
            ? `  ${JSON.stringify(key)}: {}`
            : `  ${JSON.stringify(key)}:\n    dependencies:\n${snapshotDependencies}`
      };
    })
  );
  const lockfile = [
    "lockfileVersion: '9.0'",
    "",
    "settings:",
    "  autoInstallPeers: true",
    "  excludeLinksFromLockfile: false",
    "",
    "importers:",
    "",
    "  .:",
    "    dependencies:",
    dependencyEntries,
    "",
    "packages:",
    ...archiveEntries.map((entry) => entry.packageRecord),
    packageResolutionRecords,
    "",
    "snapshots:",
    ...archiveEntries.map((entry) => entry.snapshotRecord),
    snapshotRecords
  ].join("\n");
  await writeFile(join(consumerDirectory, "pnpm-lock.yaml"), lockfile);
}

function isInside(directory, path) {
  const pathFromDirectory = relative(directory, path);
  return (
    pathFromDirectory === "" ||
    (!isAbsolute(pathFromDirectory) &&
      pathFromDirectory !== ".." &&
      !pathFromDirectory.startsWith(`..${sep}`))
  );
}

async function assertConsumerDependenciesAreIsolated(consumerDirectory, dependencyNames) {
  for (const dependency of dependencyNames) {
    const installedPath = await realpath(
      join(consumerDirectory, "node_modules", ...dependency.split("/"))
    );
    assert.ok(
      !isInside(rootDirectory, installedPath),
      `${dependency} must be installed into the consumer from archives or its offline dependency store, not the checkout`
    );
  }
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
  await assertConsumerDependenciesAreIsolated(consumerDirectory, [
    ...packages.map((item) => item.manifest.name),
    "zod",
    "sharp"
  ]);
  for (const name of ["dk-audio", "dk-image", "dk-video"]) {
    await verifyCliHelp(consumerDirectory, name);
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
