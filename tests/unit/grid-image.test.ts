import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_SIDE,
  parseMaxSide,
  prepareVisionImage,
  readDecodedSize,
  upscaleCellsToOriginal,
  VISION_JPEG_QUALITY,
} from "../../plugins/doubao/lib/grid-image.mjs";

// Issue 2：降采样后**统一重编码 JPEG** 才是请求体瘦身的来源（旧代码保留 PNG 无损，实测只瘦 9.2%，
// 注释却写「约 3–4 倍」）。这些用例把「送模型的到底是哪种编码、多大」钉死，全部本地测量，不打网络。

function cliCapture(
  fn: () => unknown,
): Error & { code?: string; details?: Record<string, unknown> } {
  try {
    fn();
  } catch (err) {
    return err as Error & { code?: string };
  }
  throw new Error("expected a coded error");
}

async function pngBuffer(width: number, height: number, alpha: boolean) {
  const channels = alpha ? 4 : 3;
  const raw = Buffer.alloc(width * height * channels);
  // 平滑渐变 + 几条深色「格线」：既有细节又能被 JPEG 压干净（真实分镜页的形状）
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * channels;
      const v = Math.round(((x + y) / (width + height)) * 200) + 40;
      const line = x % 512 < 3 || y % 512 < 3 ? 0 : v;
      raw[i] = line;
      raw[i + 1] = line;
      raw[i + 2] = line;
      if (alpha) raw[i + 3] = x % 700 < 8 ? 0 : 255; // 一条透明带，模拟格间缝隙
    }
  }
  return sharp(raw, { raw: { width, height, channels } }).png().toBuffer();
}

function isJpeg(buffer: Buffer) {
  return buffer[0] === 0xff && buffer[1] === 0xd8;
}

describe("prepareVisionImage：降采样后重编码 JPEG（Issue 2）", () => {
  it("RGB PNG 超上限 → mime/字节都是 JPEG，data URI 显著小于原图 base64", async () => {
    const buffer = await pngBuffer(1600, 1600, false);
    const size = { width: 1600, height: 1600 };
    const prepared = await prepareVisionImage(buffer, "image/png", size, DEFAULT_MAX_SIDE);
    expect(prepared.mime).toBe("image/jpeg");
    expect(isJpeg(prepared.buffer)).toBe(true);
    expect(prepared.width).toBeLessThanOrEqual(DEFAULT_MAX_SIDE);
    expect(prepared.resized).toMatchObject({
      maxSide: DEFAULT_MAX_SIDE,
      encode: "jpeg",
      quality: VISION_JPEG_QUALITY,
      width: 1568,
      height: 1568,
    });
    const originalUri = `data:image/png;base64,${buffer.toString("base64")}`;
    const sentUri = `data:${prepared.mime};base64,${prepared.buffer.toString("base64")}`;
    expect(sentUri.length).toBeLessThan(originalUri.length);
    // 旧实现在同一缩率下仍编 PNG（实测只瘦 9.2%）：这里要求 JPEG 明显小于那张 PNG 才算修对
    const pngAtSameScale = await sharp(buffer)
      .resize({
        width: DEFAULT_MAX_SIDE,
        height: DEFAULT_MAX_SIDE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(prepared.resized.bytes).toBeLessThan(pngAtSameScale.length * 0.6);
  });

  it("RGBA PNG（真实分镜页形态）→ 透明区压白底后仍出 JPEG，并留下 note", async () => {
    const buffer = await pngBuffer(1600, 1600, true);
    const meta = await sharp(buffer).metadata();
    expect(meta.hasAlpha).toBe(true);
    const prepared = await prepareVisionImage(
      buffer,
      "image/png",
      {
        width: 1600,
        height: 1600,
      },
      DEFAULT_MAX_SIDE,
    );
    expect(prepared.mime).toBe("image/jpeg");
    expect(isJpeg(prepared.buffer)).toBe(true);
    expect(prepared.note).toContain("透明通道");
    expect(prepared.note).toContain("白底");
    expect(prepared.resized.encode).toBe("jpeg");
  });

  it("长边本就在上限内 → 原图直送：字节一模一样、mime 不动、scale=1、无 resized", async () => {
    const buffer = await pngBuffer(640, 480, false);
    const prepared = await prepareVisionImage(
      buffer,
      "image/png",
      {
        width: 640,
        height: 480,
      },
      DEFAULT_MAX_SIDE,
    );
    expect(prepared.buffer).toBe(buffer);
    expect(prepared.mime).toBe("image/png");
    expect(prepared).toMatchObject({ width: 640, height: 480, scale: 1, resized: null });
    expect(prepared.note).toBeUndefined();
  });

  it("尺寸解不出（size=null）→ 原图直送并写明风险，绝不猜尺寸缩放", async () => {
    const buffer = await pngBuffer(64, 64, false);
    const prepared = await prepareVisionImage(buffer, "image/png", null, DEFAULT_MAX_SIDE);
    expect(prepared.resized).toBeNull();
    expect(prepared.note).toContain("请求体偏大");
    // sharp 兜底仍能解出真实尺寸（供 prompt 用）
    expect(await readDecodedSize(buffer)).toEqual({ width: 64, height: 64 });
  });

  it("sx/sy 与放大回原图仍然互逆：修完的坐标一格都不越界", () => {
    const prepared = { sx: 1568 / 2048, sy: 1568 / 2048 };
    const visionCells = [
      { index: 0, x: 0, y: 0, w: 784, h: 784 },
      { index: 1, x: 784, y: 0, w: 784, h: 784 },
    ];
    const { cells, clamped } = upscaleCellsToOriginal(visionCells, prepared.sx, prepared.sy, {
      width: 2048,
      height: 1024,
    });
    expect(clamped).toBe(0);
    expect(cells[0]).toEqual({ index: 0, x: 0, y: 0, w: 1024, h: 1024 });
    expect(cells[1]).toEqual({ index: 1, x: 1024, y: 0, w: 1024, h: 1024 });
  });
});

describe("--max-side 严格校验", () => {
  it("默认 1568；合法整数照收；越界/非整数/非数字 → E_INVALID_OPTION", () => {
    expect(parseMaxSide(undefined)).toBe(DEFAULT_MAX_SIDE);
    expect(parseMaxSide("1024")).toBe(1024);
    for (const bad of ["255", "4097", "abc", "0", "-1"]) {
      const err = cliCapture(() => parseMaxSide(bad));
      expect((err as { code?: string }).code).toBe("E_INVALID_OPTION");
    }
  });
});
