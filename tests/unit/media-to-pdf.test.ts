import { describe, expect, it } from "vitest";
import { naturalCompare, sortInputs } from "../../plugins/media-image/lib/natural-order.mjs";
import {
  parseDpi,
  parseImageFormat,
  parseMargin,
  parseOrder,
  parseOrientation,
  parsePageSize,
} from "../../plugins/media-image/lib/options.mjs";
import { pageGeometry } from "../../plugins/media-image/lib/pdf.mjs";

const item = (relative: string) => ({ path: `/in/${relative}`, relative });

describe("media-to-pdf 纯函数", () => {
  it("naturalCompare：数字段按数值比较，其余不区分大小写", () => {
    expect(naturalCompare("page2.jpg", "page10.jpg")).toBe(-1);
    expect(naturalCompare("IMG_9.png", "IMG_10.png")).toBe(-1);
    expect(naturalCompare("B.jpg", "a.jpg")).toBe(1);
    expect(naturalCompare("page2.jpg", "page2.jpg")).toBe(0);
    // 数值等值时前导零更多者排后，保证确定性
    expect(naturalCompare("007.jpg", "7.jpg")).toBe(1);
  });

  it("sortInputs natural：先目录后文件名，数字尾号不成乱序", () => {
    const inputs = [
      item("b/page2.jpg"),
      item("a/page10.jpg"),
      item("a/page2.jpg"),
      item("a/img.webp"),
    ];
    expect(sortInputs(inputs, "natural").map((i) => i.relative)).toEqual([
      "a/img.webp",
      "a/page2.jpg",
      "a/page10.jpg",
      "b/page2.jpg",
    ]);
  });

  it("sortInputs lexicographic：纯字典序（page10 在 page2 前），且不改动入参", () => {
    const inputs = [item("page2.jpg"), item("page10.jpg")];
    expect(sortInputs(inputs, "lexicographic").map((i) => i.relative)).toEqual([
      "page10.jpg",
      "page2.jpg",
    ]);
    expect(inputs.map((i) => i.relative)).toEqual(["page2.jpg", "page10.jpg"]);
  });

  it("pageGeometry image：页面 = 像素按 dpi 换算，满幅无留白", () => {
    expect(
      pageGeometry({
        imageWidth: 300,
        imageHeight: 200,
        page: "image",
        dpi: 300,
        margin: 24,
        orientation: "auto",
      }),
    ).toEqual({ pageWidth: 72, pageHeight: 48, drawX: 0, drawY: 0, drawWidth: 72, drawHeight: 48 });
  });

  it("pageGeometry a4：竖图用竖页、横图 auto 翻横页，等比缩放居中", () => {
    const portrait = pageGeometry({
      imageWidth: 200,
      imageHeight: 300,
      page: "a4",
      dpi: 300,
      margin: 0,
      orientation: "auto",
    });
    expect(portrait.pageWidth).toBeCloseTo(595.28, 2);
    expect(portrait.pageHeight).toBeCloseTo(841.89, 2);
    expect(portrait.drawHeight).toBeCloseTo(841.89, 1);
    expect(portrait.drawX).toBeCloseTo((595.28 - portrait.drawWidth) / 2, 2);

    const landscape = pageGeometry({
      imageWidth: 300,
      imageHeight: 200,
      page: "a4",
      dpi: 300,
      margin: 0,
      orientation: "auto",
    });
    expect(landscape.pageWidth).toBeCloseTo(841.89, 2);
    expect(landscape.pageHeight).toBeCloseTo(595.28, 2);

    const forced = pageGeometry({
      imageWidth: 300,
      imageHeight: 200,
      page: "letter",
      dpi: 300,
      margin: 0,
      orientation: "portrait",
    });
    expect([forced.pageWidth, forced.pageHeight]).toEqual([612, 792]);
  });

  it("pageGeometry：margin 挤掉绘图区 → E_INVALID_OPTION", () => {
    expect(() =>
      pageGeometry({
        imageWidth: 100,
        imageHeight: 100,
        page: "a4",
        dpi: 300,
        margin: 300,
        orientation: "auto",
      }),
    ).toThrowError(expect.objectContaining({ code: "E_INVALID_OPTION" }) as never);
  });

  it("PDF 选项解析：默认值与白名单", () => {
    expect(parseOrder(undefined)).toBe("natural");
    expect(parseOrder("LEXICOGRAPHIC")).toBe("lexicographic");
    expect(parsePageSize(undefined)).toBe("image");
    expect(parsePageSize("a4")).toBe("a4");
    expect(parseOrientation(undefined)).toBe("auto");
    expect(parseImageFormat("png")).toBe("png");
    expect(parseDpi(undefined)).toBe(300);
    expect(parseMargin(undefined)).toBe(0);
  });

  it("PDF 选项解析：非法值抛 E_INVALID_OPTION", () => {
    const cases: (() => unknown)[] = [
      () => parseOrder("random"),
      () => parsePageSize("a3"),
      () => parseOrientation("sideways"),
      () => parseImageFormat("tiff"),
      () => parseDpi("71"),
      () => parseDpi("abc"),
      () => parseMargin("-1"),
      () => parseMargin("201"),
    ];
    for (const fn of cases) {
      expect(fn).toThrowError(expect.objectContaining({ code: "E_INVALID_OPTION" }) as never);
    }
  });
});
