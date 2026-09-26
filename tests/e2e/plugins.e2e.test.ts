import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const BIN = fileURLToPath(new URL("../../dist/media-cli.js", import.meta.url));
const FIXTURES = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}`, import.meta.url));

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

interface Envelope {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
  warnings: { code: string; message: string }[];
}

describe("插件系统 e2e", () => {
  it("合法插件命令可执行且返回数据", async () => {
    const r = await cli(["--json", "plugin-echo", "--text", "hi"], {
      MEDIA_CLI_PLUGINS_DIR: FIXTURES("good"),
    });
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as Envelope;
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toEqual({ text: "hi" });
    expect(parsed.warnings).toEqual([]);
  });

  it("人类模式下插件命令输出到 stdout", async () => {
    const r = await cli(["plugin-echo", "--text", "hi"], {
      MEDIA_CLI_PLUGINS_DIR: FIXTURES("good"),
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("hi");
  });

  it("坏插件只产生警告，不影响其他插件与内置命令", async () => {
    const env = {
      MEDIA_CLI_PLUGINS_DIR: [
        FIXTURES("good"),
        FIXTURES("bad-syntax"),
        FIXTURES("bad-manifest"),
      ].join(":"),
    };
    const r = await cli(["--json", "plugin-echo", "--text", "ok"], env);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as Envelope;
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toEqual({ text: "ok" });
    const codes = parsed.warnings.map((w) => w.code);
    expect(codes).toContain("E_PLUGIN_LOAD_FAILED");
    expect(codes).toContain("E_PLUGIN_MANIFEST_INVALID");

    const version = await cli(["--json", "version"], env);
    expect(version.code).toBe(0);
    expect((JSON.parse(version.stdout) as Envelope).ok).toBe(true);
  });

  it("同名插件高优先级来源胜出，低优先级跳过并警告", async () => {
    const env = { MEDIA_CLI_PLUGINS_DIR: [FIXTURES("good"), FIXTURES("dup")].join(":") };
    const r = await cli(["--json", "plugin-echo"], env);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as Envelope;
    expect(parsed.ok).toBe(true);
    expect(parsed.warnings.map((w) => w.code)).toContain("E_PLUGIN_DUPLICATE");

    const dupCommand = await cli(["--json", "plugin-echo-dup"], env);
    expect(dupCommand.code).toBe(2);
    expect((JSON.parse(dupCommand.stdout) as Envelope).error?.code).toBe("E_COMMAND_NOT_FOUND");
  });
});
