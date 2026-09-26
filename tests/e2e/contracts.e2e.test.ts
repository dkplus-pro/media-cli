import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const BIN = fileURLToPath(new URL("../../dist/media-cli.js", import.meta.url));
const CODED = fileURLToPath(new URL("../fixtures/plugins/coded-thrower", import.meta.url));
const PKG_VERSION = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

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

describe("输出契约 e2e", () => {
  it("--version 退出 0 且输出版本号", async () => {
    const r = await cli(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(PKG_VERSION);
  });

  it("version 人类模式输出到 stdout", async () => {
    const r = await cli(["version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("@dkplus/media-cli");
    expect(r.stdout).toContain(PKG_VERSION);
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
    expect(parsed.data).toEqual({ name: "@dkplus/media-cli", version: PKG_VERSION });
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

  it("--json 插件抛带已登记码的错误 → 包络携带该码且退出 3", async () => {
    const r = await cli(["--json", "coded-throw"], { MEDIA_CLI_PLUGINS_DIR: CODED });
    expect(r.code).toBe(3);
    const parsed = JSON.parse(r.stdout) as {
      ok: boolean;
      error: { code: string; message: string; details: { var: string } };
      warnings: unknown[];
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("E_CONFIG");
    expect(parsed.error.message).toBe("bad config");
    expect(parsed.error.details).toEqual({ var: "SUNO_API_KEY" });
    expect(parsed.warnings).toEqual([]);
    expect(r.stderr).toBe("");
  });

  it("human 模式插件带码错误 → stderr [error] [E_CONFIG] 且 stdout 为空", async () => {
    const r = await cli(["coded-throw"], { MEDIA_CLI_PLUGINS_DIR: CODED });
    expect(r.code).toBe(3);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("[error] [E_CONFIG]");
    expect(r.stderr).toContain("bad config");
  });
});
