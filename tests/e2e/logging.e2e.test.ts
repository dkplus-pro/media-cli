import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const BIN = fileURLToPath(new URL("../../dist/common-cli.js", import.meta.url));
const GOOD = fileURLToPath(new URL("../fixtures/plugins/good", import.meta.url));
const ENV = { COMMON_CLI_PLUGINS_DIR: GOOD };

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

describe("日志契约 e2e（stderr）", () => {
  it("--verbose 下输出 debug 与 info", async () => {
    const r = await cli(["--verbose", "version"], ENV);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("[debug] 插件已加载: good (env)");
    expect(r.stderr).toContain("[info] 已加载");
  });

  it("默认 human 模式有 info 无 debug", async () => {
    const r = await cli(["version"], ENV);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("[info] 已加载");
    expect(r.stderr).not.toContain("[debug]");
  });

  it("--quiet 抑制 info", async () => {
    const r = await cli(["--quiet", "version"], ENV);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("[info]");
  });

  it("--json 模式 stderr 静默", async () => {
    const r = await cli(["--json", "version"], ENV);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
  });
});
