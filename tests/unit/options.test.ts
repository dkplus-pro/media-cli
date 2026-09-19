import { describe, expect, it } from "vitest";
import { prescanGlobalFlags } from "../../src/cli/options.js";

describe("prescanGlobalFlags", () => {
  it("识别全局旗标", () => {
    expect(prescanGlobalFlags(["--json", "version"])).toEqual({
      json: true,
      quiet: false,
      verbose: false,
      color: true,
    });
    expect(prescanGlobalFlags(["--quiet"]).quiet).toBe(true);
    expect(prescanGlobalFlags(["--verbose"]).verbose).toBe(true);
    expect(prescanGlobalFlags(["--no-color"]).color).toBe(false);
  });

  it("NO_COLOR 环境变量生效", () => {
    expect(prescanGlobalFlags([], { NO_COLOR: "1" }).color).toBe(false);
    expect(prescanGlobalFlags(["--no-color"], { NO_COLOR: "" }).color).toBe(false);
    expect(prescanGlobalFlags([], {}).color).toBe(true);
  });

  it("在 -- 分隔符后停止扫描", () => {
    expect(prescanGlobalFlags(["--", "--json"]).json).toBe(false);
  });
});
