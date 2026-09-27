import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CliEnveloped, cli } from "./helpers/cli";

describe("media-compress 错误分支", () => {
  it("缺 --input → E_MISSING_ARGUMENT 退出 2", async () => {
    const r = await cli(["--json", "media-compress"]);
    expect(r.code).toBe(2);
    expect((JSON.parse(r.stdout) as CliEnveloped).error?.code).toBe("E_MISSING_ARGUMENT");
  });

  it("输入不存在 → E_MISSING_ARGUMENT", async () => {
    const r = await cli(["--json", "media-compress", "--input", "/nonexistent.png"]);
    expect(r.code).toBe(2);
    expect((JSON.parse(r.stdout) as CliEnveloped).error?.code).toBe("E_MISSING_ARGUMENT");
  });

  it("单文件扩展名不支持 → E_INVALID_OPTION", async () => {
    const r = await cli(["--json", "media-compress", "--input", "README.md"]);
    expect(r.code).toBe(2);
    expect((JSON.parse(r.stdout) as CliEnveloped).error?.code).toBe("E_INVALID_OPTION");
  });

  it("--quality 非法 → E_INVALID_OPTION", async () => {
    const r = await cli(["--json", "media-compress", "--input", "x.png", "--quality", "abc"]);
    expect(r.code).toBe(2);
    expect((JSON.parse(r.stdout) as CliEnveloped).error?.code).toBe("E_INVALID_OPTION");
  });

  it("spec 自省含 media-compress 且 source 为 plugin:media-image", async () => {
    const r = await cli(["--json", "spec"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      data: { commands: { name: string; source: string }[] };
    };
    const cmd = parsed.data.commands.find((c) => c.name === "media-compress");
    expect(cmd?.source).toBe("plugin:media-image");
  });
});

// media-image 仅依赖 npm 包 sharp（无外部二进制），全平台可跑
describe("media-compress 集成（sharp）", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "media-compress-e2e-"));
    // 1200x900 蓝底 + 白块：q100 jpeg 体积冗余大，压缩收益明显
    const base = sharp({
      create: { width: 1200, height: 900, channels: 3, background: "#336699" },
    }).composite([
      {
        input: await sharp({
          create: { width: 400, height: 300, channels: 3, background: "#ffffff" },
        })
          .png()
          .toBuffer(),
        left: 100,
        top: 80,
      },
    ]);
    await base.clone().jpeg({ quality: 100 }).toFile(path.join(dir, "photo.jpg"));
    // EXIF orientation=6：存储 400x200，摆正后应为 200x400
    await sharp({ create: { width: 400, height: 200, channels: 3, background: "#ff0000" } })
      .withMetadata({ orientation: 6 })
      .jpeg({ quality: 100 })
      .toFile(path.join(dir, "rotated.jpg"));
    // 随机噪声 PNG（与 compress 完全相同的编码参数 → 重编码不会更小 → skipped 分支）
    const noise = randomBytes(64 * 64 * 3);
    await sharp(noise, { raw: { width: 64, height: 64, channels: 3 } })
      .png({ compressionLevel: 9 })
      .toFile(path.join(dir, "noise.png"));
    await mkdir(path.join(dir, "batch", "sub"), { recursive: true });
    await base
      .clone()
      .jpeg({ quality: 100 })
      .toFile(path.join(dir, "batch", "a.jpg"));
    await base
      .clone()
      .jpeg({ quality: 100 })
      .toFile(path.join(dir, "batch", "sub", "b.jpg"));
    // 坏文件：扩展名合法但内容非图片
    await writeFile(path.join(dir, "batch", "broken.jpg"), "not an image");
    await writeFile(path.join(dir, "batch", "note.txt"), "ignored by extension filter");
  }, 30_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("单文件：分辨率不变、体积变小、默认旁路输出", async () => {
    const r = await cli(["--json", "media-compress", "--input", path.join(dir, "photo.jpg")]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as CliEnveloped & {
      data: {
        path: string;
        width: number;
        height: number;
        bytesBefore: number;
        bytesAfter: number;
        savedBytes: number;
        savedPercent: number;
        skipped: boolean;
        quality: number;
      };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.path).toBe(path.join(dir, "photo.min.jpg"));
    expect(parsed.data.width).toBe(1200);
    expect(parsed.data.height).toBe(900);
    expect(parsed.data.skipped).toBe(false);
    expect(parsed.data.bytesAfter).toBeLessThan(parsed.data.bytesBefore);
    expect(parsed.data.savedBytes).toBe(parsed.data.bytesBefore - parsed.data.bytesAfter);
    expect(parsed.data.quality).toBe(80);
    expect(existsSync(parsed.data.path)).toBe(true);
  }, 60_000);

  it("EXIF 方向图：摆正到像素，尺寸互换", async () => {
    const r = await cli(["--json", "media-compress", "--input", path.join(dir, "rotated.jpg")]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as CliEnveloped & {
      data: { width: number; height: number };
    };
    expect(parsed.data.width).toBe(200);
    expect(parsed.data.height).toBe(400);
  }, 60_000);

  it("已达最优的图：跳过落盘，bytesAfter 按原大小计", async () => {
    const out = path.join(dir, "noise-out.png");
    const r = await cli([
      "--json",
      "media-compress",
      "--input",
      path.join(dir, "noise.png"),
      "--output",
      out,
    ]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as CliEnveloped & {
      data: { skipped: boolean; bytesBefore: number; bytesAfter: number };
    };
    expect(parsed.data.skipped).toBe(true);
    expect(parsed.data.bytesAfter).toBe(parsed.data.bytesBefore);
    expect(existsSync(out)).toBe(false);
  }, 60_000);

  it("文件夹：一级批量、坏图进 failed、汇总节省字节", async () => {
    const outDir = path.join(dir, "out-min");
    const r = await cli([
      "--json",
      "media-compress",
      "--input",
      path.join(dir, "batch"),
      "--output",
      outDir,
    ]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as CliEnveloped & {
      data: {
        outputDir: string;
        results: { path: string; bytesBefore: number; bytesAfter: number }[];
        failed: { file: string; reason: string }[];
        total: number;
        bytesBefore: number;
        bytesAfter: number;
      };
    };
    expect(parsed.data.total).toBe(2); // a.jpg + broken.jpg（sub 一级不递归、note.txt 扩展名过滤）
    expect(parsed.data.results).toHaveLength(1);
    expect(parsed.data.failed).toHaveLength(1);
    expect(parsed.data.failed[0].file).toContain("broken.jpg");
    expect(existsSync(path.join(outDir, "a.jpg"))).toBe(true);
    expect(existsSync(path.join(outDir, "sub", "b.jpg"))).toBe(false);
    const r0 = parsed.data.results[0];
    expect(parsed.data.bytesBefore).toBe(r0.bytesBefore);
    expect(parsed.data.bytesAfter).toBe(r0.bytesAfter);
    expect(parsed.data.bytesAfter).toBeLessThan(parsed.data.bytesBefore);
  }, 60_000);

  it("--recursive：递归处理子目录", async () => {
    const outDir = path.join(dir, "out-min-recursive");
    const r = await cli([
      "--json",
      "media-compress",
      "--input",
      path.join(dir, "batch"),
      "--output",
      outDir,
      "--recursive",
    ]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as CliEnveloped & {
      data: { results: unknown[]; failed: unknown[] };
    };
    expect(parsed.data.results).toHaveLength(2); // a.jpg + sub/b.jpg
    expect(existsSync(path.join(outDir, "sub", "b.jpg"))).toBe(true);
  }, 60_000);
});
