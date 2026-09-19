import { describe, expect, it } from "vitest";
import { CommandRegistry } from "../../src/commands/registry.js";
import type { CommandDefinition } from "../../src/core/types.js";

const dummy: CommandDefinition = { name: "cmd", description: "d", handler: () => ({}) };

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
});
