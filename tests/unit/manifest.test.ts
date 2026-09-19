import { describe, expect, it } from "vitest";
import { validatePluginExport } from "../../src/plugins/manifest.js";

describe("validatePluginExport", () => {
  const okManifest = {
    name: "good",
    version: "0.1.0",
    commands: [
      {
        name: "cmd",
        description: "描述",
        options: [{ flags: "--text <text>", description: "文本" }],
        handler: () => ({}),
      },
    ],
  };

  it("合法 manifest 通过校验", () => {
    const result = validatePluginExport(okManifest);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.name).toBe("good");
      expect(result.manifest.commands).toHaveLength(1);
    }
  });

  it("非对象导出报错", () => {
    const result = validatePluginExport("nope");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain("对象");
  });

  it("非法 name 报错", () => {
    const result = validatePluginExport({ ...okManifest, name: "Bad_Name" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(";")).toContain("name");
  });

  it("空 version 报错", () => {
    const result = validatePluginExport({ ...okManifest, version: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(";")).toContain("version");
  });

  it("commands 非数组报错", () => {
    const result = validatePluginExport({ ...okManifest, commands: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(";")).toContain("commands");
  });

  it("命令缺 handler 报错且带字段路径", () => {
    const result = validatePluginExport({
      ...okManifest,
      commands: [{ name: "cmd", description: "描述" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(";")).toContain("commands[0].handler");
  });

  it("options 项非法报错且带字段路径", () => {
    const result = validatePluginExport({
      ...okManifest,
      commands: [
        {
          name: "cmd",
          description: "描述",
          options: [{ flags: "", description: "" }],
          handler: () => ({}),
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const joined = result.errors.join(";");
      expect(joined).toContain("commands[0].options[0].flags");
      expect(joined).toContain("commands[0].options[0].description");
    }
  });
});
