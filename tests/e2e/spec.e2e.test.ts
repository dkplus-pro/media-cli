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

interface SpecCommand {
  name: string;
  description: string;
  source: string;
  options: { flags: string; description: string }[];
}

interface SpecEnvelope {
  ok: boolean;
  data?: {
    name: string;
    version: string;
    commands: SpecCommand[];
    exitCodes: Record<string, string>;
    errorCodes: string[];
  };
  warnings: unknown[];
}

describe("spec 自省 e2e", () => {
  it("--json spec 输出完整命令树，含内置与插件命令", async () => {
    const r = await cli(["--json", "spec"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as SpecEnvelope;
    expect(parsed.ok).toBe(true);
    expect(parsed.data?.name).toBe("@dkplus/media-cli");
    expect(parsed.data?.version).toBe("0.1.0");

    const byName = new Map(parsed.data?.commands.map((c) => [c.name, c]));
    expect(byName.get("version")?.source).toBe("builtin");
    expect(byName.get("spec")?.source).toBe("builtin");
    expect(byName.get("hello")?.source).toBe("plugin:hello");
    expect(byName.get("hello")?.options).toEqual([
      { flags: "--name <name>", description: "要问候的对象（默认 world）" },
    ]);
  });

  it("spec 的 errorCodes/exitCodes 与契约文档一致", async () => {
    const r = await cli(["--json", "spec"]);
    const parsed = JSON.parse(r.stdout) as SpecEnvelope;
    expect(parsed.data?.errorCodes).toContain("E_USAGE");
    expect(parsed.data?.errorCodes).toContain("E_PLUGIN_LOAD_FAILED");
    expect(Object.keys(parsed.data?.exitCodes ?? {})).toEqual(["0", "1", "2", "3", "4"]);
  });

  it("human 模式 spec 输出可读命令树", async () => {
    const r = await cli(["spec"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("version");
    expect(r.stdout).toContain("hello");
  });

  it("示例插件命令 hello 双模式可用", async () => {
    const withName = await cli(["--json", "hello", "--name", "AI"]);
    expect(withName.code).toBe(0);
    const parsedWithName = JSON.parse(withName.stdout) as {
      ok: boolean;
      data: { message: string };
    };
    expect(parsedWithName.data.message).toBe("hello, AI!");

    const withoutName = await cli(["--json", "hello"]);
    expect(withoutName.code).toBe(0);
    expect((JSON.parse(withoutName.stdout) as { data: { message: string } }).data.message).toBe(
      "hello, world!",
    );
  });
});
