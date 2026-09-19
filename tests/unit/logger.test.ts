import { describe, expect, it } from "vitest";
import { createRunContext } from "../../src/core/context.js";
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
  const stderr = new MockStream();
  const ctx = createRunContext(flags, "/tmp", {
    stdout: writable(new MockStream()),
    stderr: writable(stderr),
  });
  return { ctx, stderr };
}

const BASE_FLAGS: GlobalFlags = { json: false, quiet: false, verbose: false, color: false };

describe("createLogger output matrix (all lines go to stderr)", () => {
  it("default flags: no debug, info/warn/error emitted", () => {
    const { ctx, stderr } = setup(BASE_FLAGS);
    ctx.logger.debug("d");
    ctx.logger.info("i");
    ctx.logger.warn("w");
    ctx.logger.error("e");

    expect(stderr.text).toBe("[info] i\n[warn] w\n[error] e\n");
  });

  it("verbose: debug emitted too", () => {
    const { ctx, stderr } = setup({ ...BASE_FLAGS, verbose: true });
    ctx.logger.debug("d");
    ctx.logger.info("i");

    expect(stderr.text).toBe("[debug] d\n[info] i\n");
  });

  it("quiet: info and debug suppressed, warn/error still emitted", () => {
    const { ctx, stderr } = setup({ ...BASE_FLAGS, quiet: true });
    ctx.logger.debug("d");
    ctx.logger.info("i");
    ctx.logger.warn("w");
    ctx.logger.error("e");

    expect(stderr.text).toBe("[warn] w\n[error] e\n");
  });

  it("json: everything silenced by default", () => {
    const { ctx, stderr } = setup({ ...BASE_FLAGS, json: true });
    ctx.logger.debug("d");
    ctx.logger.info("i");
    ctx.logger.warn("w");
    ctx.logger.error("e");

    expect(stderr.text).toBe("");
  });

  it("json + verbose: only debug/warn/error emitted (no info)", () => {
    const { ctx, stderr } = setup({ ...BASE_FLAGS, json: true, verbose: true });
    ctx.logger.debug("d");
    ctx.logger.info("i");
    ctx.logger.warn("w");
    ctx.logger.error("e");

    expect(stderr.text).toBe("[debug] d\n[warn] w\n[error] e\n");
  });
});
