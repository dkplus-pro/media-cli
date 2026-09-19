import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { CommandRegistry } from "../../src/commands/registry.js";
import { createRunContext } from "../../src/core/context.js";
import { EXIT_CODES } from "../../src/core/exit-codes.js";
import type { CommandDefinition, GlobalFlags } from "../../src/core/types.js";

const dummy: CommandDefinition = { name: "cmd", description: "d", handler: () => ({}) };

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

const BASE_FLAGS: GlobalFlags = { json: true, quiet: false, verbose: false, color: false };

describe("CommandRegistry", () => {
  it("注册后可获取，list 携带 source", () => {
    const registry = new CommandRegistry();
    expect(registry.register(dummy, "builtin")).toEqual({ ok: true });
    expect(registry.get("cmd")?.source).toBe("builtin");
    expect(registry.list().map((c) => c.def.name)).toEqual(["cmd"]);
  });

  it("重名注册被拒绝并返回结构化警告", () => {
    const registry = new CommandRegistry();
    registry.register(dummy, "builtin");
    const result = registry.register({ ...dummy, name: "cmd" }, "plugin:other");
    expect(result.ok).toBe(false);
    expect(result.warning?.code).toBe("E_PLUGIN_COMMAND_CONFLICT");
    expect(result.warning?.plugin).toBe("other");
    expect(registry.list()).toHaveLength(1);
  });

  it("handler 抛带已登记码的鸭子类型错误 → 包络携带该码且退出码 3", async () => {
    const registry = new CommandRegistry();
    registry.register(
      {
        name: "coded",
        description: "d",
        handler: () => {
          throw Object.assign(new Error("bad config"), {
            code: "E_CONFIG",
            details: { var: "SUNO_API_KEY" },
          });
        },
      },
      "plugin:test",
    );
    const stdout = new MockStream();
    const ctx = createRunContext(BASE_FLAGS, "/tmp", {
      stdout: writable(stdout),
      stderr: writable(new MockStream()),
    });
    const program = new Command();
    registry.attachTo(program, ctx);
    await program.parseAsync(["coded"], { from: "user" });

    const parsed = JSON.parse(stdout.text) as {
      ok: boolean;
      error: { code: string; message: string; details: { var: string } };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("E_CONFIG");
    expect(parsed.error.message).toBe("bad config");
    expect(parsed.error.details).toEqual({ var: "SUNO_API_KEY" });
    expect((program as { exitCode?: number | null }).exitCode).toBe(EXIT_CODES.COMMAND);
  });

  it("handler 抛未登记码的鸭子类型错误 → 按未捕获收敛为 E_INTERNAL", async () => {
    const registry = new CommandRegistry();
    registry.register(
      {
        name: "coded-bad",
        description: "d",
        handler: () => {
          throw Object.assign(new Error("weird"), { code: "E_NOT_REGISTERED" });
        },
      },
      "plugin:test",
    );
    const stdout = new MockStream();
    const ctx = createRunContext(BASE_FLAGS, "/tmp", {
      stdout: writable(stdout),
      stderr: writable(new MockStream()),
    });
    const program = new Command();
    registry.attachTo(program, ctx);
    await program.parseAsync(["coded-bad"], { from: "user" });

    const parsed = JSON.parse(stdout.text) as { ok: boolean; error: { code: string } };
    expect(parsed.error.code).toBe("E_INTERNAL");
    expect((program as { exitCode?: number | null }).exitCode).toBe(EXIT_CODES.COMMAND);
  });
});
