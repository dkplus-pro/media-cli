import { describe, expect, it } from "vitest";
import { defaultSidecar } from "../../plugins/media-image/lib/files.mjs";
import { resolveImageFormat } from "../../plugins/media-image/lib/format.mjs";
import {
  parseAngle,
  parseColor,
  parseOpacity,
  parseQuality,
  parseSpacing,
  parseText,
} from "../../plugins/media-image/lib/options.mjs";
import {
  autoFontSize,
  buildOverlaySvg,
  escapeXml,
} from "../../plugins/media-image/lib/watermark.mjs";

describe("media-image lib 纯函数", () => {
  it("escapeXml 转义全部危险字符", () => {
    expect(escapeXml(`a&b<c>d"e'f`)).toBe("a&amp;b&lt;c&gt;d&quot;e&apos;f");
  });

  it("autoFontSize 按最短边 1/24 自适应并夹在 14–160", () => {
    expect(autoFontSize(1200, 900)).toBe(38); // 900/24 = 37.5 → 38
    expect(autoFontSize(4000, 3000)).toBe(125);
    expect(autoFontSize(200, 100)).toBe(14); // 下限
    expect(autoFontSize(8000, 8000)).toBe(160); // 上限
  });

  it("buildOverlaySvg：网格数量按投影长度铺满、带 rotate 变换与透明度", () => {
    // 1000x1000、text 100x40、spacing 100 → step 200x140；extent = 1000*(cos30+sin30) ≈ 1366
    const svg = buildOverlaySvg({
      width: 1000,
      height: 1000,
      text: "wm",
      font: "sans-serif",
      fontSize: 40,
      color: "#ffffff",
      opacity: 0.3,
      angle: 30,
      spacing: 100,
      textW: 100,
      textH: 40,
    });
    const nodes = svg.match(/<text /g) ?? [];
    // cols = ceil(1366/200)+1 = 8，rows = ceil(1366/140)+1 = 11 → 88
    expect(nodes).toHaveLength(88);
    expect(svg).toContain("rotate(30)");
    expect(svg).toContain('fill-opacity="0.3"');
    expect(svg).toContain('width="1000"');
  });

  it("buildOverlaySvg：节点数超上限 → E_INVALID_OPTION", () => {
    expect(() =>
      buildOverlaySvg({
        width: 150,
        height: 150,
        text: "w",
        font: "sans-serif",
        fontSize: 8,
        color: "#fff",
        opacity: 0.3,
        angle: 30,
        spacing: 0,
        textW: 1,
        textH: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "E_INVALID_OPTION" }) as never);
  });

  it("resolveImageFormat：扩展名映射 sharp 格式，不支持即抛错", () => {
    expect(resolveImageFormat("a/b.jpg")).toBe("jpeg");
    expect(resolveImageFormat("a/b.JPEG")).toBe("jpeg");
    expect(resolveImageFormat("a/b.png")).toBe("png");
    expect(resolveImageFormat("a/b.webp")).toBe("webp");
    expect(() => resolveImageFormat("a/b.gif")).toThrowError(
      expect.objectContaining({ code: "E_INVALID_OPTION" }) as never,
    );
  });

  it("defaultSidecar：.min 扩展名前插入，不改目录", () => {
    expect(defaultSidecar("a/b/photo.jpg", "min")).toBe("a/b/photo.min.jpg");
    expect(defaultSidecar("photo.jpeg", "watermark")).toBe("photo.watermark.jpeg");
  });

  it("选项解析：合法值放行", () => {
    expect(parseQuality(undefined, 80)).toBe(80);
    expect(parseQuality("95", 80)).toBe(95);
    expect(parseOpacity(undefined, 0.3)).toBe(0.3);
    expect(parseOpacity("1", 0.3)).toBe(1);
    expect(parseAngle("-30", 30)).toBe(-30);
    expect(parseSpacing("0", 80)).toBe(0);
    expect(parseColor("rgb(255, 255, 255)", "#fff")).toBe("rgb(255, 255, 255)");
  });

  it("选项解析：非法值抛 E_INVALID_OPTION", () => {
    const cases: (() => unknown)[] = [
      () => parseQuality("0", 80),
      () => parseQuality("101", 80),
      () => parseOpacity("0", 0.3),
      () => parseOpacity("1.5", 0.3),
      () => parseAngle("400", 30),
      () => parseSpacing("-1", 80),
      () => parseColor('evil"/>', "#fff"),
    ];
    for (const fn of cases) {
      expect(fn).toThrowError(expect.objectContaining({ code: "E_INVALID_OPTION" }) as never);
    }
  });

  it("parseText：空文案抛 E_MISSING_ARGUMENT，两侧空白裁掉", () => {
    expect(() => parseText(undefined)).toThrowError(
      expect.objectContaining({ code: "E_MISSING_ARGUMENT" }) as never,
    );
    expect(() => parseText("   ")).toThrowError(
      expect.objectContaining({ code: "E_MISSING_ARGUMENT" }) as never,
    );
    expect(parseText(" 版权所有 ")).toBe("版权所有");
  });
});
