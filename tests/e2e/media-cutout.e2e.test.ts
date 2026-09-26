import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const BIN = fileURLToPath(new URL("../../dist/media-cli.js", import.meta.url));

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(args: string[], env: Record<string, string | undefined> = {}): Promise<CliRun> {
  const merged = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [BIN, ...args], {
      env: merged,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

interface CliEnveloped {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  warnings: unknown[];
}

// 集成分支需要 macOS + swiftc（Vision 为 macOS 专属引擎）
const hasSwiftc = (() => {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    try {
      execFileSync("test", ["-x", path.join(dir, "swiftc")], { stdio: "ignore" });
      return true;
    } catch {
      // 下一个
    }
  }
  return false;
})();

const canIntegrate = process.platform === "darwin" && hasSwiftc;

describe("media-cutout 错误分支（无需 macOS 集成环境）", () => {
  it("缺 --input → E_MISSING_ARGUMENT 退出 2", async () => {
    const r = await cli(["--json", "media-cutout"], { CUTOUT_BIN: undefined });
    expect(r.code).toBe(2);
    expect((JSON.parse(r.stdout) as CliEnveloped).error?.code).toBe("E_MISSING_ARGUMENT");
  });

  it("输入不存在 → E_MISSING_ARGUMENT", async () => {
    const r = await cli(["--json", "media-cutout", "--input", "/nonexistent.png"], {
      CUTOUT_BIN: undefined,
    });
    expect(r.code).toBe(2);
    expect((JSON.parse(r.stdout) as CliEnveloped).error?.code).toBe("E_MISSING_ARGUMENT");
  });

  it("CUTOUT_BIN 不可执行 → E_MISSING_DEPENDENCY 退出 3", async () => {
    const r = await cli(["--json", "media-cutout", "--input", "x.png"], {
      CUTOUT_BIN: "/nonexistent",
    });
    expect(r.code).toBe(3);
    const parsed = JSON.parse(r.stdout) as CliEnveloped;
    expect(parsed.error?.code).toBe("E_MISSING_DEPENDENCY");
    expect(parsed.error?.details).toMatchObject({ dependency: "vision-cutout" });
  });

  it("--padding 非法 → E_INVALID_OPTION", async () => {
    const r = await cli(["--json", "media-cutout", "--input", "x.png", "--padding", "abc"], {
      CUTOUT_BIN: "/nonexistent",
    });
    expect(r.code).toBe(2);
    expect((JSON.parse(r.stdout) as CliEnveloped).error?.code).toBe("E_INVALID_OPTION");
  });

  it("spec 自省含 media-cutout 且 source 为 plugin:media-cutout", async () => {
    const r = await cli(["--json", "spec"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      data: { commands: { name: string; source: string }[] };
    };
    const cmd = parsed.data.commands.find((c) => c.name === "media-cutout");
    expect(cmd?.source).toBe("plugin:media-cutout");
  });
});

describe.skipIf(!canIntegrate)("media-cutout 集成（macOS Vision）", () => {
  let dir: string;
  // drawbox 合成图：灰底中央红方块，Vision 可稳定识别为主体
  const FIXTURE_FFMPEG = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=0x505050:s=512x512",
    "-frames:v",
    "1",
    "-vf",
    "drawbox=x=136:y=136:w=240:h=240:color=red@1:t=fill",
  ];

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "media-cutout-e2e-"));
    const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
    execFileSync(ffmpeg, [...FIXTURE_FFMPEG, path.join(dir, "subject.png")]);
    await mkdir(path.join(dir, "batch", "sub"), { recursive: true });
    execFileSync(ffmpeg, [...FIXTURE_FFMPEG, path.join(dir, "batch", "a.png")]);
    execFileSync(ffmpeg, [...FIXTURE_FFMPEG, path.join(dir, "batch", "sub", "b.png")]);
    // 坏文件：扩展名合法但内容非图片
    await writeFile(path.join(dir, "batch", "broken.png"), "not an image");
    await writeFile(path.join(dir, "batch", "note.txt"), "ignored by extension filter");
  }, 60_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("单文件：裁剪到主体 + padding，输出透明 PNG", async () => {
    const out = path.join(dir, "cut.png");
    const r = await cli([
      "--json",
      "media-cutout",
      "--input",
      path.join(dir, "subject.png"),
      "--output",
      out,
    ]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as CliEnveloped & {
      data: { path: string; width: number; height: number; cropped: boolean; padding: number };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.path).toBe(out);
    expect(parsed.data.cropped).toBe(true);
    expect(parsed.data.padding).toBe(32);
    // 主体 240px + 边距 64px 上下，远小于原图 512，且不越界
    expect(parsed.data.width).toBeGreaterThan(240);
    expect(parsed.data.width).toBeLessThan(512);
    expect(parsed.data.height).toBe(parsed.data.width); // 方块主体 bbox 近似正方形
    expect(existsSync(out)).toBe(true);
    // PNG magic
    const head = await readFile(out).then((b) => b.subarray(1, 4).toString("ascii"));
    expect(head).toBe("PNG");
  }, 60_000);

  it("--no-crop：保留原始画布尺寸", async () => {
    const out = path.join(dir, "nocrop.png");
    const r = await cli([
      "--json",
      "media-cutout",
      "--input",
      path.join(dir, "subject.png"),
      "--output",
      out,
      "--no-crop",
    ]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as CliEnveloped & {
      data: { width: number; height: number; cropped: boolean; padding: number };
    };
    expect(parsed.data.width).toBe(512);
    expect(parsed.data.height).toBe(512);
    expect(parsed.data.cropped).toBe(false);
    expect(parsed.data.padding).toBe(0);
  }, 60_000);

  it("文件夹批量：一级不递归，坏图进 failed，其余成功", async () => {
    const outDir = path.join(dir, "out-flat");
    const r = await cli([
      "--json",
      "media-cutout",
      "--input",
      path.join(dir, "batch"),
      "--output",
      outDir,
    ]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as CliEnveloped & {
      data: {
        outputDir: string;
        results: unknown[];
        failed: { file: string; reason: string }[];
        total: number;
      };
    };
    expect(parsed.data.total).toBe(2); // a.png + broken.png（sub 目录不递归）
    expect(parsed.data.results).toHaveLength(1); // broken.png 故意失败
    expect(parsed.data.failed).toHaveLength(1);
    expect(parsed.data.failed[0].file).toContain("broken.png");
    expect(existsSync(path.join(outDir, "a.png"))).toBe(true);
    expect(existsSync(path.join(outDir, "sub", "b.png"))).toBe(false);
  }, 120_000);

  it("--recursive：mirror 相对目录结构", async () => {
    const outDir = path.join(dir, "out-recursive");
    const r = await cli([
      "--json",
      "media-cutout",
      "--input",
      path.join(dir, "batch"),
      "--output",
      outDir,
      "--recursive",
    ]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as CliEnveloped & {
      data: { results: { path: string }[]; failed: unknown[] };
    };
    expect(parsed.data.results).toHaveLength(2); // a.png + sub/b.png（broken.png 失败）
    expect(parsed.data.failed).toHaveLength(1);
    expect(existsSync(path.join(outDir, "a.png"))).toBe(true);
    expect(existsSync(path.join(outDir, "sub", "b.png"))).toBe(true);
  }, 120_000);
});
