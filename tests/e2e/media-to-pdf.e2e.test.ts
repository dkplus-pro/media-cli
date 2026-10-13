import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CliEnveloped, cli } from "./helpers/cli";

interface PdfData {
  output: string;
  pageCount: number;
  order: string;
  page: string;
  items: { file: string; width: number; height: number; pageWidth: number; pageHeight: number }[];
  skipped?: { file: string; reason: string }[];
}

function okData(r: { stdout: string }): PdfData {
  const env = JSON.parse(r.stdout) as CliEnveloped;
  expect(env.ok).toBe(true);
  return env.data as unknown as PdfData;
}

describe("media-to-pdf 错误分支", () => {
  it("缺 --input → E_MISSING_ARGUMENT 退出 2", async () => {
    const r = await cli(["--json", "media-to-pdf"]);
    expect(r.code).toBe(2);
    expect((JSON.parse(r.stdout) as CliEnveloped).error?.code).toBe("E_MISSING_ARGUMENT");
  });

  it("输入不存在 → E_MISSING_ARGUMENT", async () => {
    const r = await cli(["--json", "media-to-pdf", "--input", "/nonexistent.png"]);
    expect(r.code).toBe(2);
    expect((JSON.parse(r.stdout) as CliEnveloped).error?.code).toBe("E_MISSING_ARGUMENT");
  });

  it("--order / --page / --dpi 非法 → E_INVALID_OPTION", async () => {
    for (const flag of [
      ["--order", "random"],
      ["--page", "a3"],
      ["--dpi", "9999"],
    ]) {
      const r = await cli(["--json", "media-to-pdf", "--input", "x.jpg", ...flag]);
      expect(r.code).toBe(2);
      expect((JSON.parse(r.stdout) as CliEnveloped).error?.code).toBe("E_INVALID_OPTION");
    }
  });

  it("spec 自省含 media-to-pdf 且 source 为 plugin:media-image", async () => {
    const r = await cli(["--json", "spec"]);
    const parsed = JSON.parse(r.stdout) as {
      data: { commands: { name: string; source: string }[] };
    };
    expect(parsed.data.commands.find((c) => c.name === "media-to-pdf")?.source).toBe(
      "plugin:media-image",
    );
  });
});

describe("media-to-pdf 集成（sharp + pdf-lib）", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "media-to-pdf-e2e-"));
    // 命名刻意打乱数字序：自然序应为 p1, p2, p10
    await sharp({ create: { width: 200, height: 300, channels: 3, background: "#226699" } })
      .png()
      .toFile(path.join(dir, "p1.png"));
    await sharp({ create: { width: 300, height: 200, channels: 3, background: "#992266" } })
      .jpeg()
      .toFile(path.join(dir, "p2.jpg"));
    // EXIF orientation=6：存储 400x200，摆正后 200x400
    await sharp({ create: { width: 400, height: 200, channels: 3, background: "#229966" } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toFile(path.join(dir, "p10.jpg"));
    await sharp({ create: { width: 160, height: 160, channels: 4, background: "#00000000" } })
      .webp()
      .toFile(path.join(dir, "p3.webp"));
    await writeFile(path.join(dir, "notes.txt"), "not an image");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("目录合成单个 PDF：页面顺序按文件名自然序，页数与页面尺寸可回读", async () => {
    const output = path.join(dir, "book.pdf");
    const data = okData(await cli(["--json", "media-to-pdf", "--input", dir, "--output", output]));
    expect(data.order).toBe("natural");
    expect(data.page).toBe("image");
    expect(data.pageCount).toBe(4);
    expect(data.items.map((i) => path.basename(i.file))).toEqual([
      "p1.png",
      "p2.jpg",
      "p3.webp",
      "p10.jpg",
    ]);
    // EXIF 摆正后写入页面尺寸（200x400 @300dpi → 48x96pt）
    expect(data.items[3]).toMatchObject({ width: 200, height: 400, pageWidth: 48, pageHeight: 96 });

    const doc = await PDFDocument.load(await readFileBytes(output));
    expect(doc.getPageCount()).toBe(4);
    expect(existsSync(path.join(dir, "p1.png"))).toBe(true);
  });

  it("--order lexicographic 改为纯字典序（p10 在 p2 前）", async () => {
    const data = okData(
      await cli([
        "--json",
        "media-to-pdf",
        "--input",
        dir,
        "--output",
        path.join(dir, "lex.pdf"),
        "--order",
        "lexicographic",
      ]),
    );
    expect(data.items.map((i) => path.basename(i.file))).toEqual([
      "p1.png",
      "p10.jpg",
      "p2.jpg",
      "p3.webp",
    ]);
  });

  it("--page a4 --margin 固定页面：横图自动横页，尺寸等于 A4 磅值", async () => {
    const data = okData(
      await cli([
        "--json",
        "media-to-pdf",
        "--input",
        dir,
        "--output",
        path.join(dir, "a4.pdf"),
        "--page",
        "a4",
        "--margin",
        "24",
      ]),
    );
    const byFile = new Map(data.items.map((i) => [path.basename(i.file), i]));
    expect(byFile.get("p1.png")?.pageHeight).toBeCloseTo(841.89, 1); // 竖图 → 竖页
    expect(byFile.get("p2.jpg")?.pageWidth).toBeCloseTo(841.89, 1); // 横图 auto → 横页
  });

  it("单文件默认输出 <name>.pdf，不覆盖原图", async () => {
    const data = okData(
      await cli(["--json", "media-to-pdf", "--input", path.join(dir, "p2.jpg")], {}, dir),
    );
    expect(data.output).toBe(path.join(dir, "p2.pdf"));
    expect(data.pageCount).toBe(1);
  });

  it("--image-format png 保留透明：页面可正常回读", async () => {
    const output = path.join(dir, "png.pdf");
    const data = okData(
      await cli([
        "--json",
        "media-to-pdf",
        "--input",
        path.join(dir, "p3.webp"),
        "--output",
        output,
        "--image-format",
        "png",
      ]),
    );
    expect(data.pageCount).toBe(1);
    const doc = await PDFDocument.load(await readFileBytes(output));
    expect(doc.getPageCount()).toBe(1);
  });

  it("坏图默认整体失败且不落盘；--skip-broken 容错并出警告", async () => {
    const broken = path.join(dir, "sub");
    await rm(broken, { recursive: true, force: true });
    await mkdir(broken);
    await sharp({ create: { width: 100, height: 100, channels: 3, background: "#ffffff" } })
      .png()
      .toFile(path.join(broken, "a.png"));
    await writeFile(path.join(broken, "z.png"), "corrupted");

    const strictOut = path.join(broken, "strict.pdf");
    const r = await cli(["--json", "media-to-pdf", "--input", broken, "--output", strictOut]);
    expect(r.code).toBe(3);
    expect((JSON.parse(r.stdout) as CliEnveloped).error?.code).toBe("E_PROVIDER_ERROR");
    expect(existsSync(strictOut)).toBe(false);

    const lenientOut = path.join(broken, "lenient.pdf");
    const data = okData(
      await cli([
        "--json",
        "media-to-pdf",
        "--input",
        broken,
        "--output",
        lenientOut,
        "--skip-broken",
      ]),
    );
    expect(data.pageCount).toBe(1);
    expect(data.skipped).toHaveLength(1);
    expect(existsSync(lenientOut)).toBe(true);
  });

  it("--output 非 .pdf 或指向目录 → E_INVALID_OPTION", async () => {
    const bad = await cli([
      "--json",
      "media-to-pdf",
      "--input",
      path.join(dir, "p1.png"),
      "--output",
      path.join(dir, "out.jpg"),
    ]);
    expect(bad.code).toBe(2);
    expect((JSON.parse(bad.stdout) as CliEnveloped).error?.code).toBe("E_INVALID_OPTION");

    const self = await cli([
      "--json",
      "media-to-pdf",
      "--input",
      path.join(dir, "p1.png"),
      "--output",
      dir,
    ]);
    expect(self.code).toBe(2);
    expect((JSON.parse(self.stdout) as CliEnveloped).error?.code).toBe("E_INVALID_OPTION");
  });

  it("human 模式：stdout 只有数据、逐页日志走 stderr", async () => {
    const r = await cli(["media-to-pdf", "--input", path.join(dir, "p1.png"), "--verbose"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ pageCount: 1 });
    expect(r.stderr).toContain("已加入第 1 页");
  });
});

async function readFileBytes(file: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(file));
}
