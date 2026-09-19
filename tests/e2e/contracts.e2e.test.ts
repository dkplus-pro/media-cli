import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const BIN = fileURLToPath(new URL("../../dist/common-cli.js", import.meta.url));

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}
async function cli(args: string[]): Promise<CliRun> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [BIN, ...args]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

describe("输出契约 e2e", () => {
  it("--version 退出 0 且输出版本号", async () => {
    const r = await cli(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("0.1.0");
  });

  it("version 人类模式输出到 stdout", async () => {
    const r = await cli(["version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("common-cli");
    expect(r.stdout).toContain("0.1.0");
  });

  it("--json version 输出单个可解析 JSON 包络", async () => {
    const r = await cli(["--json", "version"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    const parsed = JSON.parse(r.stdout) as {
      ok: boolean;
      data: { name: string; version: string };
      warnings: unknown[];
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toEqual({ name: "common-cli", version: "0.1.0" });
    expect(parsed.warnings).toEqual([]);
  });

  it("--json 未知命令退出 2 且包络 code 为 E_COMMAND_NOT_FOUND", async () => {
    const r = await cli(["--json", "nope"]);
    expect(r.code).toBe(2);
    const parsed = JSON.parse(r.stdout) as { ok: boolean; error: { code: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("E_COMMAND_NOT_FOUND");
  });

  it("人类模式未知命令 stdout 为空、错误在 stderr", async () => {
    const r = await cli(["nope"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("E_COMMAND_NOT_FOUND");
  });

  it("未知选项退出 2 且 code 为 E_USAGE", async () => {
    const r = await cli(["--json", "version", "--unknown-flag"]);
    expect(r.code).toBe(2);
    const parsed = JSON.parse(r.stdout) as { ok: boolean; error: { code: string } };
    expect(parsed.error.code).toBe("E_USAGE");
  });
});
