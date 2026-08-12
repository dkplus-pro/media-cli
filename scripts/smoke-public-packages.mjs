import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

const rootDirectory = process.cwd();
const packagesDirectory = join(rootDirectory, "packages");
const cliPackageNames = ["@dkplus/dk-audio", "@dkplus/dk-image", "@dkplus/dk-video"];

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

function packageIdentity(item) {
  return `${item.manifest.name}@${item.manifest.version}`;
}

async function workspacePackages() {
  const entries = await readdir(packagesDirectory, { withFileTypes: true });
  const manifests = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const directory = join(packagesDirectory, entry.name);
        try {
          return {
            directory,
            manifest: JSON.parse(await readFile(join(directory, "package.json"), "utf8"))
          };
        } catch {
          return undefined;
        }
      })
  );
  return manifests
    .filter((item) => item !== undefined)
    .sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
}

function publicPackages(packages) {
  return packages.filter((item) => item.manifest.private !== true);
}

async function packAndInspect(item, packDirectory, verifyDeclaredFiles = false) {
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
  if (verifyDeclaredFiles) {
    for (const file of item.manifest.files ?? []) {
      assert.ok(
        entries.some(
          (entry) => entry === `package/${file}` || entry.startsWith(`package/${file}/`)
        ),
        `${item.manifest.name} archive lacks ${file}`
      );
    }
  }
  return archivePath;
}

async function packPublicPackages(packages, packDirectory) {
  const archives = new Map();
  for (const item of packages) {
    archives.set(packageIdentity(item), await packAndInspect(item, packDirectory, true));
  }
  return archives;
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

async function findInstalledPackage(fromDirectory, name) {
  let searchDirectory = await realpath(fromDirectory);
  while (isInside(rootDirectory, searchDirectory)) {
    const directory = join(searchDirectory, "node_modules", ...name.split("/"));
    try {
      const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      return { directory: await realpath(directory), manifest };
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    if (searchDirectory === rootDirectory) {
      break;
    }
    searchDirectory = dirname(searchDirectory);
  }
  return undefined;
}

function dependencyEntries(manifest) {
  return [
    ...Object.keys(manifest.dependencies ?? {}).map((name) => ({ name, optional: false })),
    ...Object.keys(manifest.optionalDependencies ?? {})
      .filter((name) => !(name in (manifest.dependencies ?? {})))
      .map((name) => ({ name, optional: true }))
  ].sort((left, right) => left.name.localeCompare(right.name));
}

async function collectRuntimePackages(workspace, archives, packDirectory) {
  const workspaceByName = new Map(workspace.map((item) => [item.manifest.name, item]));
  const runtimePackages = new Map();

  async function visit(item, optional = false) {
    const identity = packageIdentity(item);
    const existing = runtimePackages.get(identity);
    if (existing) {
      existing.optional ||= optional;
      return existing;
    }
    const archivePath = archives.get(identity) ?? (await packAndInspect(item, packDirectory));
    archives.set(identity, archivePath);
    const runtimePackage = {
      ...item,
      archivePath,
      specification: `file:${await realpath(archivePath)}`,
      optional,
      dependencies: new Map(),
      optionalDependencies: new Map()
    };
    runtimePackages.set(identity, runtimePackage);
    for (const dependency of dependencyEntries(item.manifest)) {
      const dependencyPackage =
        workspaceByName.get(dependency.name) ??
        (await findInstalledPackage(item.directory, dependency.name));
      if (!dependencyPackage) {
        assert.ok(
          dependency.optional,
          `missing installed runtime dependency ${dependency.name} for ${item.manifest.name}`
        );
        continue;
      }
      const target = await visit(dependencyPackage, dependency.optional);
      const dependencies = dependency.optional
        ? runtimePackage.optionalDependencies
        : runtimePackage.dependencies;
      dependencies.set(dependency.name, target);
    }
    return runtimePackage;
  }

  const roots = await Promise.all(
    cliPackageNames.map(async (name) => {
      const item = workspaceByName.get(name);
      assert.ok(item, `missing workspace package ${name}`);
      return visit(item);
    })
  );
  return { roots, runtimePackages };
}

async function rewritePackedManifests(runtimePackages, rewriteDirectory) {
  let index = 0;
  for (const item of runtimePackages.values()) {
    const unpackDirectory = join(rewriteDirectory, `${index}`);
    index += 1;
    await mkdir(unpackDirectory, { recursive: true });
    await run("tar", ["-xzf", item.archivePath, "-C", unpackDirectory], rootDirectory);
    const manifestPath = join(unpackDirectory, "package", "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(
      manifest.name,
      item.manifest.name,
      `packed manifest mismatch for ${item.manifest.name}`
    );
    for (const [name, dependency] of item.dependencies) {
      manifest.dependencies ??= {};
      manifest.dependencies[name] = dependency.specification;
    }
    for (const [name] of Object.entries(manifest.optionalDependencies ?? {})) {
      const target = item.optionalDependencies.get(name);
      if (target) {
        manifest.optionalDependencies[name] = target.specification;
      } else {
        delete manifest.optionalDependencies[name];
      }
    }
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await run("tar", ["-czf", item.archivePath, "-C", unpackDirectory, "package"], rootDirectory);
  }
}

async function writeConsumerLockfile(consumerDirectory) {
  await run(
    "pnpm",
    ["install", "--offline", "--ignore-scripts", "--lockfile-only", "--no-frozen-lockfile"],
    consumerDirectory
  );
}

async function installPackedPackages(runtime, consumerDirectory) {
  const cliDependencies = Object.fromEntries(
    runtime.roots.map((item) => [item.manifest.name, item.specification])
  );
  assert.deepEqual(Object.keys(cliDependencies).sort(), [...cliPackageNames].sort());
  await writeFile(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify({
      name: "dkplus-smoke-consumer",
      private: true,
      version: "0.0.0",
      dependencies: cliDependencies
    })}\n`
  );
  await writeConsumerLockfile(consumerDirectory);
  await run(
    "pnpm",
    ["install", "--offline", "--ignore-scripts", "--frozen-lockfile"],
    consumerDirectory
  );
}

async function assertConsumerDependenciesAreIsolated(consumerDirectory, dependencyNames) {
  const virtualStoreDirectory = join(consumerDirectory, "node_modules", ".pnpm");
  const virtualStoreEntries = await readdir(virtualStoreDirectory, { withFileTypes: true });
  for (const dependency of dependencyNames) {
    let installedPath;
    for (const entry of virtualStoreEntries) {
      if (!entry.isDirectory()) {
        continue;
      }
      try {
        installedPath = await realpath(
          join(virtualStoreDirectory, entry.name, "node_modules", ...dependency.split("/"))
        );
        break;
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
    }
    assert.ok(installedPath, `${dependency} must be installed in the consumer virtual store`);
    assert.ok(
      !isInside(rootDirectory, installedPath),
      `${dependency} must be installed into the consumer from archives, not the checkout`
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
  const workspace = await workspacePackages();
  const packages = publicPackages(workspace);
  const packDirectory = join(temporaryDirectory, "packed");
  const rewriteDirectory = join(temporaryDirectory, "rewritten");
  const consumerDirectory = join(temporaryDirectory, "consumer");
  await Promise.all([
    mkdir(packDirectory, { recursive: true }),
    mkdir(rewriteDirectory, { recursive: true }),
    mkdir(consumerDirectory, { recursive: true })
  ]);
  const archives = await packPublicPackages(packages, packDirectory);
  const runtime = await collectRuntimePackages(workspace, archives, packDirectory);
  await rewritePackedManifests(runtime.runtimePackages, rewriteDirectory);
  await installPackedPackages(runtime, consumerDirectory);
  await assertConsumerDependenciesAreIsolated(consumerDirectory, [
    ...new Set([...runtime.runtimePackages.values()].map((item) => item.manifest.name))
  ]);
  for (const name of ["dk-audio", "dk-image", "dk-video"]) {
    await verifyCliHelp(consumerDirectory, name);
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
