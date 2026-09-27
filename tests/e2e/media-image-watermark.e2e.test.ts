import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CliEnveloped, cli } from "./helpers/cli";

describe("media-watermark 错误分支", () => {
  it("缺 --text → E_MISSING_ARGUMENT 退出 2", async () => {
    const r = await cli(["--json", "media-watermark", "--input", "x.png"]);
    expect(r.code).toBe(2);
    expect((JSON.parse(r.stdout) as CliEnveloped).error?.code).toBe("E_MISSING_ARGUMENT");
  });

  it("缺 --input → E_MISSING_ARGUMENT", async () => {
    const r = await cli(["--json", "media-watermark", "--text", "hi"]);
    expect(r.code).toBe(2);
    expect((JSON.parse(r.stdout) as CliEnveloped).error?.code).toBe("E_MISSING_ARGUMENT");
  });

  it("输入不存在 → E_MISSING_ARGUMENT", async () => {
    const r = await cli([
      "--json",
      "media-watermark",
      "--input",
      "/nonexistent.png",
      "--text",
      "hi",
    ]);
    expect(r.code).toBe(2);
    expect((JSON.parse(r.stdout) as CliEnveloped).error?.code).toBe("E_MISSING_ARGUMENT");
  });

  it("--opacity 越界 → E_INVALID_OPTION", async () => {
    const r = await cli([
      "--json",
      "media-watermark",
      "--input",
      "x.png",
      "--text",
      "hi",
      "--opacity",
      "2",
    ]);
    expect(r.code).toBe(2);
    expect((JSON.parse(r.stdout) as CliEnveloped).error?.code).toBe("E_INVALID_OPTION");
  });

  it("--angle 越界 → E_INVALID_OPTION", async () => {
    const r = await cli([
      "--json",
      "media-watermark",
      "--input",
      "x.png",
      "--text",
      "hi",
      "--angle",
      "500",
    ]);
    expect(r.code).toBe(2);
    expect((JSON.parse(r.stdout) as CliEnveloped).error?.code).toBe("E_INVALID_OPTION");
  });

  it("--color 注入字符 → E_INVALID_OPTION", async () => {
    const r = await cli([
      "--json",
      "media-watermark",
      "--input",
      "x.png",
      "--text",
      "hi",
      "--color",
      '#ff"/><script',
    ]);
    expect(r.code).toBe(2);
    expect((JSON.parse(r.stdout) as CliEnveloped).error?.code).toBe("E_INVALID_OPTION");
  });

  it("spec 自省含 media-watermark 且 source 为 plugin:media-image", async () => {
    const r = await cli(["--json", "spec"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      data: { commands: { name: string; source: string }[] };
    };
    const cmd = parsed.data.commands.find((c) => c.name === "media-watermark");
    expect(cmd?.source).toBe("plugin:media-image");
  });
});

// media-image 仅依赖 npm 包 sharp（无外部二进制），全平台可跑
describe("media-watermark 集成（sharp）", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "media-watermark-e2e-"));
    const base = sharp({
      create: { width: 1200, height: 900, channels: 3, background: "#336699" },
    });
    await base.clone().jpeg({ quality: 100 }).toFile(path.join(dir, "photo.jpg"));
    // RGBA PNG：验证水印后 alpha 通道保留
    await sharp({
      create: {
        width: 400,
        height: 300,
        channels: 4,
        background: { r: 51, g: 102, b: 153, alpha: 1 },
      },
    })
      .png()
      .toFile(path.join(dir, "logo.png"));
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

  it("单文件：默认 30°/0.3/80，像素确实改变，分辨率不变", async () => {
    const input = path.join(dir, "photo.jpg");
    const r = await cli(["--json", "media-watermark", "--input", input, "--text", "版权所有"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as CliEnveloped & {
      data: {
        path: string;
        width: number;
        height: number;
        text: string;
        font: string;
        angle: number;
        spacing: number;
        opacity: number;
        color: string;
        fontSize: number | null;
      };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.path).toBe(path.join(dir, "photo.watermark.jpg"));
    expect(parsed.data.width).toBe(1200);
    expect(parsed.data.height).toBe(900);
    expect(parsed.data.angle).toBe(30);
    expect(parsed.data.spacing).toBe(80);
    expect(parsed.data.opacity).toBe(0.3);
    expect(parsed.data.color).toBe("#ffffff");
    expect(parsed.data.fontSize).toBeGreaterThanOrEqual(14); // 自适应字号已解析
    expect(parsed.data.fontSize).toBeLessThanOrEqual(160);
    expect(existsSync(parsed.data.path)).toBe(true);
    // 输出与原图的原始像素必须不同（水印已烙进画面）
    const [before, after] = await Promise.all([
      sharp(input).raw().toBuffer(),
      sharp(parsed.data.path).raw().toBuffer(),
    ]);
    expect(before.equals(after)).toBe(false);
  }, 60_000);

  it("自定义字体/角度/间距/透明度/字号/颜色并回显", async () => {
    const r = await cli([
      "--json",
      "media-watermark",
      "--input",
      path.join(dir, "photo.jpg"),
      "--text",
      "AI 生成",
      "--font",
      "PingFang SC",
      "--angle",
      "45",
      "--spacing",
      "120",
      "--opacity",
      "0.5",
      "--font-size",
      "64",
      "--color",
      "#000000",
    ]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as CliEnveloped & {
      data: {
        text: string;
        font: string;
        angle: number;
        spacing: number;
        opacity: number;
        color: string;
        fontSize: number;
      };
    };
    expect(parsed.data.text).toBe("AI 生成");
    expect(parsed.data.font).toBe("PingFang SC");
    expect(parsed.data.angle).toBe(45);
    expect(parsed.data.spacing).toBe(120);
    expect(parsed.data.opacity).toBe(0.5);
    expect(parsed.data.color).toBe("#000000");
    expect(parsed.data.fontSize).toBe(64);
  }, 60_000);

  it("PNG：alpha 通道保留", async () => {
    const r = await cli([
      "--json",
      "media-watermark",
      "--input",
      path.join(dir, "logo.png"),
      "--text",
      "wm",
    ]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as CliEnveloped & { data: { path: string } };
    const meta = await sharp(parsed.data.path).metadata();
    expect(meta.channels).toBe(4);
  }, 60_000);

  it("文件夹：默认输出 ./watermark（cwd 相对）、坏图进 failed", async () => {
    const workDir = path.join(dir, "cwd-flat");
    await mkdir(path.join(workDir, "batch"), { recursive: true });
    const sharpBase = sharp({
      create: { width: 600, height: 400, channels: 3, background: "#336699" },
    });
    await sharpBase
      .clone()
      .jpeg({ quality: 100 })
      .toFile(path.join(workDir, "batch", "a.jpg"));
    await writeFile(path.join(workDir, "batch", "broken.jpg"), "not an image");
    const r = await cli(
      ["--json", "media-watermark", "--input", "batch", "--text", "wm"],
      {},
      workDir,
    );
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as CliEnveloped & {
      data: {
        outputDir: string;
        results: { path: string }[];
        failed: unknown[];
        total: number;
      };
    };
    // 子进程 cwd 会被系统解析为 realpath（macOS /tmp 符号链接），两侧都用 realpath 比较
    expect(parsed.data.outputDir).toBe(realpathSync(path.join(workDir, "watermark")));
    expect(parsed.data.results).toHaveLength(1);
    expect(existsSync(path.join(workDir, "watermark", "a.jpg"))).toBe(true);
    expect(parsed.data.failed).toHaveLength(1);
    expect(parsed.data.total).toBe(2);
  }, 60_000);

  it("--recursive：mirror 子目录", async () => {
    const outDir = path.join(dir, "out-wm-recursive");
    const r = await cli([
      "--json",
      "media-watermark",
      "--input",
      path.join(dir, "batch"),
      "--output",
      outDir,
      "--recursive",
      "--text",
      "wm",
    ]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as CliEnveloped & {
      data: { results: { path: string }[]; failed: unknown[] };
    };
    expect(parsed.data.results).toHaveLength(2); // a.jpg + sub/b.jpg（broken.jpg 失败）
    expect(parsed.data.failed).toHaveLength(1);
    expect(existsSync(path.join(outDir, "sub", "b.jpg"))).toBe(true);
  }, 60_000);
});
