import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const BIN = fileURLToPath(new URL("../../dist/media-cli.js", import.meta.url));
const THROWER = fileURLToPath(new URL("../fixtures/plugins/thrower", import.meta.url));

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(args: string[], env: Record<string, string> = {}): Promise<CliRun> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [BIN, ...args], {
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

describe("退出码 e2e", () => {
  it("成功退出 0", async () => {
    const r = await cli(["--json", "version"]);
    expect(r.code).toBe(0);
  });

  it("用法类错误退出 2", async () => {
    const r = await cli(["--json", "nope"]);
    expect(r.code).toBe(2);
  });

  it("命令执行错误退出 3（JSON 模式 stdout 包络、stderr 空）", async () => {
    const r = await cli(["--json", "plugin-throw"], { MEDIA_CLI_PLUGINS_DIR: THROWER });
    expect(r.code).toBe(3);
    expect(r.stderr).toBe("");
    const parsed = JSON.parse(r.stdout) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("E_INTERNAL");
    expect(parsed.error.message).toContain("boom from plugin");
  });

  it("命令执行错误退出 3（human 模式错误在 stderr）", async () => {
    const r = await cli(["plugin-throw"], { MEDIA_CLI_PLUGINS_DIR: THROWER });
    expect(r.code).toBe(3);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("[error] [E_INTERNAL]");
    expect(r.stderr).toContain("boom from plugin");
  });
});
