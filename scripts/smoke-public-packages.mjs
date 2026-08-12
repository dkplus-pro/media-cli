import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

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

function packagePath(name) {
  return join("node_modules", ...name.split("/"));
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

async function copyInstall(packages, archives, consumerDirectory) {
  for (const item of packages) {
    const extractionDirectory = await mkdtemp(join(tmpdir(), "dkplus-packed-package-"));
    try {
      await run(
        "tar",
        ["-xzf", archives.get(item.manifest.name), "-C", extractionDirectory],
        rootDirectory
      );
      const target = join(consumerDirectory, packagePath(item.manifest.name));
      await mkdir(dirname(target), { recursive: true });
      await cp(join(extractionDirectory, "package"), target, { recursive: true });
    } finally {
      await rm(extractionDirectory, { recursive: true, force: true });
    }
  }

  for (const dependency of ["zod", "sharp"]) {
    const target = join(consumerDirectory, "node_modules", dependency);
    await mkdir(dirname(target), { recursive: true });
    await symlink(
      resolve(rootDirectory, "node_modules", ".pnpm", "node_modules", dependency),
      target,
      "dir"
    );
  }
}

async function verifyCliHelp(consumerDirectory, name) {
  const packageDirectory = join(consumerDirectory, packagePath(`@dkplus/${name}`));
  const manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
  const binaryPath = join(packageDirectory, manifest.bin[name]);
  const output = await run(process.execPath, [binaryPath, "--help"], consumerDirectory);
  assert.match(output, new RegExp(`Usage: ${name}`, "u"));
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "dkplus-public-package-smoke-"));
try {
  const packages = await publicPackages();
  const packDirectory = join(temporaryDirectory, "packed");
  const consumerDirectory = join(temporaryDirectory, "consumer");
  await Promise.all([
    mkdir(packDirectory, { recursive: true }),
    mkdir(join(consumerDirectory, "node_modules"), { recursive: true })
  ]);
  const archives = await packAndInspect(packages, packDirectory);
  await copyInstall(packages, archives, consumerDirectory);
  for (const name of ["dk-audio", "dk-image", "dk-video"]) {
    await verifyCliHelp(consumerDirectory, name);
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
