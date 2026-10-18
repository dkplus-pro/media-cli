import { describe, expect, it } from "vitest";
import { buildImageBody, parseImageSize } from "../../plugins/doubao/lib/image.mjs";

interface CodedError {
  code: string;
  details?: Record<string, unknown>;
}

function coded(fn: () => unknown): CodedError {
  try {
    fn();
  } catch (err) {
    return err as CodedError;
  }
  throw new Error("预期抛错但函数正常返回");
}

describe("doubao-image 尺寸", () => {
  it("默认 2048x2048 与恰好达到下限的尺寸通过", () => {
    expect(parseImageSize()).toBe("2048x2048");
    expect(parseImageSize("2048x2048")).toBe("2048x2048");
    expect(parseImageSize("2560x1440")).toBe("2560x1440"); // 恰好 3,686,400 px
  });

  it("1024x1024 与 2048x1536 低于像素下限 → E_INVALID_OPTION 且不发网络", () => {
    const small = coded(() => parseImageSize("1024x1024"));
    expect(small.code).toBe("E_INVALID_OPTION");
    expect(small.details).toMatchObject({ pixels: 1_048_576, minPixels: 3_686_400 });
    expect(coded(() => parseImageSize("2048x1536")).code).toBe("E_INVALID_OPTION");
  });

  it("非 WxH 格式 → E_INVALID_OPTION", () => {
    expect(coded(() => parseImageSize("2048*2048")).code).toBe("E_INVALID_OPTION");
    expect(coded(() => parseImageSize("auto")).code).toBe("E_INVALID_OPTION");
  });
});

describe("doubao-image 请求体", () => {
  it("默认 url 取件、不加水印、关闭组图", () => {
    expect(
      buildImageBody({
        model: "doubao-seedream-4-5-251128",
        prompt: "一只猫",
        size: "2048x2048",
        watermark: undefined,
      }),
    ).toEqual({
      model: "doubao-seedream-4-5-251128",
      prompt: "一只猫",
      size: "2048x2048",
      response_format: "url",
      watermark: false,
      sequential_image_generation: "disabled",
    });
  });

  it("--watermark 仅在显式 true 时开启", () => {
    expect(
      buildImageBody({ model: "m", prompt: "p", size: "2048x2048", watermark: true }).watermark,
    ).toBe(true);
    expect(
      buildImageBody({ model: "m", prompt: "p", size: "2048x2048", watermark: false }).watermark,
    ).toBe(false);
  });
});
