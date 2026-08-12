import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

it("packs every public package and runs each public CLI help from a disposable consumer", async () => {
  const scriptPath = fileURLToPath(
    new URL("../../scripts/smoke-public-packages.mjs", import.meta.url)
  );
  const child = spawn(process.execPath, [scriptPath], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"]
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => output.push(chunk));
  const exitCode = await new Promise((resolve) => child.once("close", resolve));

  assert.equal(exitCode, 0, Buffer.concat(output).toString("utf8"));
});
