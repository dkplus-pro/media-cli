import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { fixturePath } from "@dkplus/testing";

import { runImageCli } from "../dist/cli.js";

const imagePath = fixturePath("sample.png");
const commands = [
  ["content", "metadata"],
  ["content", "describe"],
  ["content", "keywords"],
  ["content", "ocr"],
  ["content", "score"],
  ["analyze"],
  ["watermark"]
];

function writers() {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    writers: {
      stdout: { write: (line) => stdout.push(line) },
      stderr: { write: (line) => stderr.push(line) }
    }
  };
}

async function withTemporaryDirectory(work) {
  const directory = await mkdtemp(join(tmpdir(), "dk-image-cli-"));
  try {
    return await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("dk-image CLI", () => {
  it("shows help and version and exposes a schema for every command", async () => {
    const help = writers();
    assert.equal((await runImageCli(["--help"], help.writers)).exitCode, 0);
    assert.match(help.stdout.join(""), /content describe/u);

    const version = writers();
    assert.equal((await runImageCli(["--version"], version.writers)).exitCode, 0);
    assert.match(version.stdout.join(""), /0\.1\.0/u);

    for (const command of commands) {
      const output = writers();
      const result = await runImageCli([...command, "--schema", "--json"], output.writers);
      assert.equal(result.exitCode, 0, command.join(" "));
      const envelope = JSON.parse(output.stdout.join(""));
      assert.equal(envelope.success, true);
      assert.equal(envelope.data.name, command.join(" "));
      assert.equal(envelope.data.inputSchema.type, "object");
      assert.equal(envelope.data.outputSchema.type, "object");
    }
  });

  it("emits one JSON result envelope for a metadata command", async () => {
    const output = writers();
    const result = await runImageCli(["content", "metadata", imagePath, "--json"], output.writers);

    assert.equal(result.exitCode, 0);
    assert.equal(output.stdout.length, 1);
    const envelope = JSON.parse(output.stdout[0]);
    assert.equal(envelope.success, true);
    assert.equal(envelope.data.kind, "image-metadata");
  });

  it("returns a typed non-zero JSON error for malformed command input", async () => {
    const output = writers();
    const result = await runImageCli(["content", "describe", "--json"], output.writers);

    assert.equal(result.exitCode, 1);
    assert.equal(JSON.parse(output.stdout.join("")).error.code, "INVALID_ARGUMENT");
  });

  it("honors non-destructive watermark output handling", async () => {
    await withTemporaryDirectory(async (directory) => {
      const outputPath = join(directory, "watermarked.png");
      await copyFile(imagePath, outputPath);
      const blocked = writers();
      const blockedResult = await runImageCli(
        ["watermark", imagePath, "--output", outputPath, "--text", "dkplus", "--json"],
        blocked.writers
      );
      assert.equal(blockedResult.exitCode, 1);
      assert.equal(JSON.parse(blocked.stdout.join("")).error.code, "OUTPUT_EXISTS");

      const forced = writers();
      const forcedResult = await runImageCli(
        ["watermark", imagePath, "--output", outputPath, "--text", "dkplus", "--force", "--json"],
        forced.writers
      );
      assert.equal(forcedResult.exitCode, 0);
      assert.equal(JSON.parse(forced.stdout.join("")).data.kind, "image-watermark");
    });
  });

  it("publishes exactly the seven phase-one commands without generation", async () => {
    const manifestPath = fileURLToPath(new URL("../commands.json", import.meta.url));
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

    assert.deepEqual(manifest.commands.map((command) => command.command).sort(), [
      "analyze",
      "content describe",
      "content keywords",
      "content metadata",
      "content ocr",
      "content score",
      "watermark"
    ]);
  });
});
