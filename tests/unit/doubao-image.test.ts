import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildImageBody, parseImageSize } from "../../plugins/doubao/lib/image.mjs";
import {
  MAX_REF_BYTES,
  MAX_REFS,
  resolveRefs,
  summarizeRef,
} from "../../plugins/doubao/lib/image-refs.mjs";

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

async function codedAsync(fn: () => Promise<unknown>): Promise<CodedError> {
  try {
    await fn();
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

  it("恰好 4096x4096 通过，超出总像素上限 16,777,216 本地即拒", () => {
    expect(parseImageSize("4096x4096")).toBe("4096x4096");
    expect(parseImageSize("1920x1920")).toBe("1920x1920"); // 与 2560x1440 同为下限边界
    const big = coded(() => parseImageSize("8192x8192"));
    expect(big.code).toBe("E_INVALID_OPTION");
    expect(big.details).toMatchObject({ pixels: 67_108_864, maxPixels: 16_777_216 });
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

  it("无参考图时请求体不出现 image 键（含显式 refs: []）", () => {
    expect(
      buildImageBody({ model: "m", prompt: "p", size: "2048x2048", refs: [] }),
    ).not.toHaveProperty("image");
  });

  it("单张参考图传字符串、多张传数组（两种形态均实测被 Ark 接受）", () => {
    const one = buildImageBody({
      model: "m",
      prompt: "p",
      size: "2048x2048",
      refs: ["data:image/jpeg;base64,AAA"],
    });
    expect(one.image).toBe("data:image/jpeg;base64,AAA");
    const two = buildImageBody({
      model: "m",
      prompt: "p",
      size: "2048x2048",
      refs: ["http://a/b.png", "data:image/png;base64,CCC"],
    });
    expect(two.image).toEqual(["http://a/b.png", "data:image/png;base64,CCC"]);
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

describe("doubao-image 参考图解析", () => {
  let cwd = "";

  beforeAll(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "doubao-refs-"));
    await writeFile(path.join(cwd, "a.png"), Buffer.from([1, 2, 3, 4, 5]));
    await writeFile(path.join(cwd, "b.svg"), Buffer.from([1]));
    await writeFile(path.join(cwd, "c.gif"), Buffer.from([1, 2]));
    await writeFile(path.join(cwd, "huge.png"), Buffer.from([1]));
    await truncate(path.join(cwd, "huge.png"), MAX_REF_BYTES + 1);
  });
  afterAll(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("未传或全为空白 → 空数组（即文生图）", async () => {
    expect(await resolveRefs(undefined, cwd)).toEqual([]);
    expect(await resolveRefs([], cwd)).toEqual([]);
    expect(await resolveRefs(["", "   "], cwd)).toEqual([]);
  });

  it("http(s) URL 原样透传，不读盘", async () => {
    expect(await resolveRefs(["https://cdn/x.png"], cwd)).toEqual(["https://cdn/x.png"]);
  });

  it("本地相对路径按 cwd 解析并内联成带 mime 的 data URI", async () => {
    const [uri] = await resolveRefs(["a.png"], cwd);
    expect(uri).toBe(`data:image/png;base64,${Buffer.from([1, 2, 3, 4, 5]).toString("base64")}`);
  });

  it("张数上限取 provider 实测硬上限 14：14 张通过、15 张 E_INVALID_OPTION", async () => {
    const urls = Array.from({ length: MAX_REFS + 1 }, (_, i) => `https://cdn/${i}.png`);
    expect(await resolveRefs(urls.slice(0, MAX_REFS), cwd)).toHaveLength(MAX_REFS);
    const err = await codedAsync(() => resolveRefs(urls, cwd));
    expect(err.code).toBe("E_INVALID_OPTION");
    expect(err.details).toMatchObject({ option: "--ref", max: MAX_REFS, value: MAX_REFS + 1 });
  });

  it("参考图不存在 → E_MISSING_ARGUMENT；文档 8 种格式外的扩展名 → E_INVALID_OPTION", async () => {
    expect((await codedAsync(() => resolveRefs(["nope.png"], cwd))).code).toBe(
      "E_MISSING_ARGUMENT",
    );
    expect((await codedAsync(() => resolveRefs(["b.svg"], cwd))).code).toBe("E_INVALID_OPTION");
    // gif 在官方文档的参考图格式清单内（早期白名单只有 png/jpg/jpeg/webp，把它误拒了）
    expect(await resolveRefs(["c.gif"], cwd)).toEqual([
      `data:image/gif;base64,${Buffer.from([1, 2]).toString("base64")}`,
    ]);
  });

  it("单张参考图超过文档的 30MB 上限 → 本地即拒，不内联进请求体", async () => {
    const err = await codedAsync(() => resolveRefs(["huge.png"], cwd));
    expect(err.code).toBe("E_INVALID_OPTION");
    expect(err.details).toMatchObject({ option: "--ref", maxBytes: MAX_REF_BYTES });
  });

  it("直传 data URI 与其他 scheme 一律本地拒（不做猜路径的臆断）", async () => {
    const data = await codedAsync(() => resolveRefs(["data:image/png;base64,AAAA"], cwd));
    expect(data.code).toBe("E_INVALID_OPTION");
    expect((await codedAsync(() => resolveRefs(["file:///tmp/a.png"], cwd))).code).toBe(
      "E_INVALID_OPTION",
    );
  });

  it("摘要把 base64 换成解码后字节数，URL 原样回显", () => {
    expect(summarizeRef(`data:image/png;base64,${Buffer.alloc(9).toString("base64")}`)).toBe(
      "data:image/png;base64,9 bytes",
    );
    expect(summarizeRef("https://cdn/x.png")).toBe("https://cdn/x.png");
  });
});
