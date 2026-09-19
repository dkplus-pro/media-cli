import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const DIST_BIN = fileURLToPath(new URL("../../dist/common-cli.js", import.meta.url));

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(bin: string, args: string[], cwd: string): Promise<CliRun> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [bin, ...args], { cwd });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

// 模拟 npm 安装布局：<tmp>/pkg/dist/common-cli.js + <tmp>/pkg/plugins/<name>/index.mjs
// 并从包外目录（<tmp>/work）运行，验证「随包内置」发现源在真实安装形态下生效
describe("bundled 插件发现（模拟安装布局）", () => {
  let root: string;
  let pkg: string;
  let work: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "bundled-e2e-"));
    pkg = path.join(root, "pkg");
    work = path.join(root, "work");
    mkdirSync(path.join(pkg, "dist"), { recursive: true });
    mkdirSync(path.join(pkg, "plugins", "demo"), { recursive: true });
    mkdirSync(work, { recursive: true });
    copyFileSync(DIST_BIN, path.join(pkg, "dist", "common-cli.js"));
    // 真实安装的包根必有 package.json（bundled 发现靠它定位包根），且带 type: module
    writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "fake-media-cli", version: "0.1.0", type: "module" }),
    );
    // dist 保持 commander 为外部依赖（npm 安装时由 node_modules 提供），模拟之
    const repoNodeModules = fileURLToPath(new URL("../../node_modules/", import.meta.url));
    mkdirSync(path.join(pkg, "node_modules"), { recursive: true });
    symlinkSync(
      path.join(repoNodeModules, "commander"),
      path.join(pkg, "node_modules", "commander"),
      "dir",
    );
    writeFileSync(
      path.join(pkg, "plugins", "demo", "index.mjs"),
      `export default {
  name: "demo",
  version: "0.1.0",
  commands: [
    {
      name: "bundled-demo",
      description: "随包内置插件冒烟命令",
      handler: () => ({ from: "bundled" }),
    },
  ],
};\n`,
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("从包外任意目录运行，bundled 插件命令可用", async () => {
    const r = await cli(path.join(pkg, "dist", "common-cli.js"), ["--json", "bundled-demo"], work);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      ok: boolean;
      data: { from: string };
      warnings: unknown[];
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.from).toBe("bundled");
    expect(parsed.warnings).toEqual([]);
  });

  it("spec 自省含 bundled 命令，source 为 plugin:demo", async () => {
    const r = await cli(path.join(pkg, "dist", "common-cli.js"), ["--json", "spec"], work);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      data: { commands: { name: string; source: string }[] };
      warnings: unknown[];
    };
    const demo = parsed.data.commands.find((c) => c.name === "bundled-demo");
    expect(demo?.source).toBe("plugin:demo");
    expect(parsed.warnings).toEqual([]);
  });

  it("开发态（仓库根）：bundled 与 project 同目录被跳过，无重复警告", async () => {
    const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
    const r = await cli(DIST_BIN, ["--json", "spec"], repoRoot);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      warnings: { code: string }[];
      data: { commands: { name: string }[] };
    };
    expect(parsed.warnings.filter((w) => w.code === "E_PLUGIN_DUPLICATE")).toEqual([]);
    // 仓库根 project 容器里的插件照常加载（media-av 为例）
    expect(parsed.data.commands.some((c) => c.name === "media-filmstrip")).toBe(true);
  });
});
