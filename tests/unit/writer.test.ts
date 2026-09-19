import { describe, expect, it } from "vitest";
import { createRunContext } from "../../src/core/context.js";
import { writeResult } from "../../src/core/output/writer.js";
import type { GlobalFlags } from "../../src/core/types.js";

class MockStream {
  text = "";
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

function writable(stream: MockStream): NodeJS.WritableStream {
  return stream as unknown as NodeJS.WritableStream;
}

function setup(flags: GlobalFlags) {
  const stdout = new MockStream();
  const stderr = new MockStream();
  const ctx = createRunContext(flags, "/tmp", {
    stdout: writable(stdout),
    stderr: writable(stderr),
  });
  return { ctx, stdout, stderr };
}

const BASE_FLAGS: GlobalFlags = { json: false, quiet: false, verbose: false, color: false };

describe("writeResult (json mode)", () => {
  it("writes a single-line parseable success envelope to stdout", () => {
    const { ctx, stdout } = setup({ ...BASE_FLAGS, json: true });
    writeResult(ctx, { ok: true, data: { name: "common-cli", version: "0.1.0" } });

    const text = stdout.text;
    expect(text.endsWith("\n")).toBe(true);
    expect(text.indexOf("\n")).toBe(text.length - 1); // exactly one line

    const parsed = JSON.parse(text) as { ok: boolean; data: unknown; warnings: unknown[] };
    expect(parsed).toEqual({
      ok: true,
      data: { name: "common-cli", version: "0.1.0" },
      warnings: [],
    });
  });

  it("writes a failure envelope with error code and message to stdout", () => {
    const { ctx, stdout } = setup({ ...BASE_FLAGS, json: true });
    writeResult(ctx, { ok: false, error: { code: "E_INTERNAL", message: "boom" } });

    const parsed = JSON.parse(stdout.text) as {
      ok: boolean;
      error: { code: string; message: string };
      warnings: unknown[];
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toEqual({ code: "E_INTERNAL", message: "boom" });
    expect(parsed.warnings).toEqual([]);
  });

  it("includes collected warnings in the envelope", () => {
    const { ctx, stdout } = setup({ ...BASE_FLAGS, json: true });
    ctx.warnings.add({ code: "W_PLUGIN_SKIPPED", message: "duplicate", plugin: "p1" });
    writeResult(ctx, { ok: true, data: "done" });

    const parsed = JSON.parse(stdout.text) as {
      warnings: Array<{ code: string; message: string; plugin?: string }>;
    };
    expect(parsed.warnings).toEqual([
      { code: "W_PLUGIN_SKIPPED", message: "duplicate", plugin: "p1" },
    ]);
  });
});

describe("writeResult (human mode)", () => {
  it("writes object data to stdout as two-space indented JSON", () => {
    const { ctx, stdout, stderr } = setup(BASE_FLAGS);
    const data = { name: "common-cli", nested: { a: 1 } };
    writeResult(ctx, { ok: true, data });

    expect(stdout.text).toBe(`${JSON.stringify(data, null, 2)}\n`);
    expect(stderr.text).toBe("");
  });

  it("writes string data to stdout as-is", () => {
    const { ctx, stdout } = setup(BASE_FLAGS);
    writeResult(ctx, { ok: true, data: "plain text" });
    expect(stdout.text).toBe("plain text\n");
  });

  it("writes errors to stderr in `[error] [CODE] message` format and keeps stdout empty", () => {
    const { ctx, stdout, stderr } = setup(BASE_FLAGS);
    writeResult(ctx, { ok: false, error: { code: "E_USAGE", message: "missing argument" } });

    expect(stderr.text).toBe("[error] [E_USAGE] missing argument\n");
    expect(stdout.text).toBe("");
  });
});
