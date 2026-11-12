import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../plugins/minimax/lib/config.mjs";
import {
  MAX_REF_BYTES,
  REF_MAX,
  resolveImageModel,
  resolveImageRefs,
} from "../../plugins/minimax/lib/image.mjs";
import {
  assertBodyBudget,
  buildImageBody,
  MAX_BODY_BYTES,
  normalizeOutputFormat,
  parseAspectRatio,
  parseImageArgs,
} from "../../plugins/minimax/lib/image-params.mjs";

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

describe("minimax-image 配置与模型", () => {
  it("imageModel 默认 MiniMax-H3-Image，env 覆盖；--model 优先", () => {
    expect(loadConfig({ MINIMAX_API_KEY: "k" }).imageModel).toBe("MiniMax-H3-Image");
    expect(
      loadConfig({ MINIMAX_API_KEY: "k", MINIMAX_IMAGE_MODEL: "MiniMax-H3-Image-Highspeed" })
        .imageModel,
    ).toBe("MiniMax-H3-Image-Highspeed");
    expect(resolveImageModel({}, {})).toBe("MiniMax-H3-Image");
    expect(resolveImageModel({}, { imageModel: "env-model" })).toBe("env-model");
    expect(resolveImageModel({ model: "cli-model" }, { imageModel: "env-model" })).toBe(
      "cli-model",
    );
  });
});

describe("minimax-image 尺寸", () => {
  it("默认 1024x1024；面积与比例边界（655,360 / 20,000,000 / 1:3 / 3:1）均可通过", () => {
    expect(parseImageArgs({ prompt: "p" }).size).toBe("1024x1024");
    expect(parseImageArgs({ prompt: "p", size: "1024x640" }).size).toBe("1024x640");
    expect(parseImageArgs({ prompt: "p", size: "5000x4000" }).size).toBe("5000x4000");
    expect(parseImageArgs({ prompt: "p", size: "512x1536" }).size).toBe("512x1536");
    expect(parseImageArgs({ prompt: "p", size: "1536x512" }).size).toBe("1536x512");
    expect(parseImageArgs({ prompt: "p", size: "AUTO" }).size).toBe("auto");
    expect(parseImageArgs({ prompt: "p", size: "1024X1024" }).size).toBe("1024x1024");
  });

  it("面积越界：1024x639（少 1 px）与 5000x4001 本地即拒", () => {
    const low = coded(() => parseImageArgs({ prompt: "p", size: "1024x639" }));
    expect(low.code).toBe("E_INVALID_OPTION");
    expect(low.details).toMatchObject({ pixels: 654_336, minArea: 655_360 });
    const high = coded(() => parseImageArgs({ prompt: "p", size: "5000x4001" }));
    expect(high.code).toBe("E_INVALID_OPTION");
    expect(high.details).toMatchObject({ pixels: 20_005_000, maxArea: 20_000_000 });
  });

  it("宽高比越界（>3:1）与非法格式本地即拒", () => {
    expect(coded(() => parseImageArgs({ prompt: "p", size: "500x1501" })).details).toMatchObject({
      maxAspect: 3,
    });
    for (const size of ["1024*1024", "1024", "0x1024", "-1x1024", "abc"]) {
      expect(coded(() => parseImageArgs({ prompt: "p", size })).code).toBe("E_INVALID_OPTION");
    }
  });

  it("area/aspect 只在 size auto/省略时可用，显式 WxH 一律冲突", () => {
    const autoByArea = parseImageArgs({ prompt: "p", area: "2K" });
    expect(autoByArea).toMatchObject({ size: "auto", sizeMode: "auto", area: "2K" });
    const autoByAspect = parseImageArgs({ prompt: "p", aspectRatio: "16:9" });
    expect(autoByAspect).toMatchObject({ size: "auto", aspectRatio: "16:9" });
    expect(
      parseImageArgs({ prompt: "p", size: "auto", area: "2K", aspectRatio: "1:1" }),
    ).toMatchObject({ size: "auto", area: "2K", aspectRatio: "1:1" });
    expect(
      coded(() => parseImageArgs({ prompt: "p", size: "1024x1024", aspectRatio: "16:9" })).code,
    ).toBe("E_INVALID_OPTION");
    expect(coded(() => parseImageArgs({ prompt: "p", size: "1024x1024", area: "2K" })).code).toBe(
      "E_INVALID_OPTION",
    );
  });

  it("aspect_ratio 枚举：1:3/3:1 通过，4:1、301:1、0:1 拒绝", () => {
    expect(parseAspectRatio("1:3")).toBe("1:3");
    expect(parseAspectRatio("3:1")).toBe("3:1");
    expect(parseAspectRatio("auto")).toBe("auto");
    expect(coded(() => parseAspectRatio("4:1")).code).toBe("E_INVALID_OPTION");
    expect(coded(() => parseAspectRatio("301:1")).code).toBe("E_INVALID_OPTION");
    expect(coded(() => parseAspectRatio("0:1")).code).toBe("E_INVALID_OPTION");
    expect(coded(() => parseImageArgs({ prompt: "p", area: "8K" })).code).toBe("E_INVALID_OPTION");
  });
});

describe("minimax-image prompt 与 disable_prompt_enhanced", () => {
  it("prompt 必填非空；32000 字符通过，32001 拒绝", () => {
    expect(coded(() => parseImageArgs({})).code).toBe("E_MISSING_ARGUMENT");
    expect(coded(() => parseImageArgs({ prompt: "   " })).code).toBe("E_MISSING_ARGUMENT");
    expect(parseImageArgs({ prompt: "a".repeat(32_000) }).prompt).toHaveLength(32_000);
    const err = coded(() => parseImageArgs({ prompt: "a".repeat(32_001) }));
    expect(err.code).toBe("E_INVALID_OPTION");
    expect(err.details).toMatchObject({ limit: 32_000, actual: 32_001 });
  });

  it("disable-prompt-enhanced 要求显式比例：默认 WxH 可，auto 必须带 X:Y", () => {
    expect(parseImageArgs({ prompt: "p", disablePromptEnhanced: true }).size).toBe("1024x1024");
    expect(
      parseImageArgs({ prompt: "p", size: "2048x2048", disablePromptEnhanced: true })
        .disablePromptEnhanced,
    ).toBe(true);
    expect(
      coded(() => parseImageArgs({ prompt: "p", area: "4K", disablePromptEnhanced: true })).code,
    ).toBe("E_INVALID_OPTION");
    expect(
      coded(() => parseImageArgs({ prompt: "p", size: "auto", disablePromptEnhanced: true })).code,
    ).toBe("E_INVALID_OPTION");
    expect(
      coded(() =>
        parseImageArgs({
          prompt: "p",
          size: "auto",
          aspectRatio: "auto",
          disablePromptEnhanced: true,
        }),
      ).code,
    ).toBe("E_INVALID_OPTION");
    expect(
      parseImageArgs({
        prompt: "p",
        size: "auto",
        aspectRatio: "1:1",
        disablePromptEnhanced: true,
      }),
    ).toMatchObject({ size: "auto", aspectRatio: "1:1", disablePromptEnhanced: true });
    expect(
      parseImageArgs({ prompt: "p", aspectRatio: "16:9", disablePromptEnhanced: true }),
    ).toMatchObject({ size: "auto", aspectRatio: "16:9" });
  });
});

describe("minimax-image 输出格式、压缩与请求体", () => {
  it("jpg 归一为 jpeg，非法格式拒绝", () => {
    expect(normalizeOutputFormat(undefined)).toBe("jpeg");
    expect(normalizeOutputFormat("jpg")).toBe("jpeg");
    expect(normalizeOutputFormat("JPG")).toBe("jpeg");
    expect(normalizeOutputFormat("PNG")).toBe("png");
    expect(coded(() => normalizeOutputFormat("gif")).code).toBe("E_INVALID_OPTION");
  });

  it("压缩 0–100 整数；未传不进请求体，显式 0 保留", () => {
    expect(parseImageArgs({ prompt: "p" })).not.toHaveProperty("outputCompression");
    expect(parseImageArgs({ prompt: "p", outputCompression: "0" }).outputCompression).toBe(0);
    expect(parseImageArgs({ prompt: "p", outputCompression: "100" }).outputCompression).toBe(100);
    for (const value of ["-1", "101", "1.5", "x"]) {
      expect(coded(() => parseImageArgs({ prompt: "p", outputCompression: value })).code).toBe(
        "E_INVALID_OPTION",
      );
    }
  });

  it("默认请求体只有 model/prompt/size/output_format（provider 默认值不铺）", () => {
    const input = parseImageArgs({ prompt: "p" });
    expect(buildImageBody({ ...input, model: "MiniMax-H3-Image" })).toEqual({
      model: "MiniMax-H3-Image",
      prompt: "p",
      size: "1024x1024",
      output_format: "jpeg",
    });
  });

  it("显式 area/aspect/水印/压缩与参考图按契约进请求体", () => {
    const input = parseImageArgs({
      prompt: "p",
      size: "auto",
      aspectRatio: "16:9",
      area: "2K",
      disablePromptEnhanced: true,
      outputFormat: "webp",
      outputCompression: "80",
      aigcWatermark: true,
    });
    expect(buildImageBody({ ...input, model: "m" }, [{ url: "https://cdn/a.png" }])).toEqual({
      model: "m",
      prompt: "p",
      size: "auto",
      output_format: "webp",
      aspect_ratio: "16:9",
      area: "2K",
      disable_prompt_enhanced: true,
      output_compression: 80,
      aigc_watermark: true,
      images: [{ image_url: "https://cdn/a.png" }],
    });
    expect(buildImageBody({ ...input, model: "m" }, [])).not.toHaveProperty("images");
  });
});

describe("minimax-image 参考图", () => {
  let cwd = "";

  beforeAll(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "minimax-image-refs-"));
    await sharp({ create: { width: 512, height: 384, channels: 3, background: "#334455" } })
      .png()
      .toFile(path.join(cwd, "ok.png"));
    await sharp({ create: { width: 100, height: 100, channels: 3, background: "#112233" } })
      .png()
      .toFile(path.join(cwd, "tiny.png"));
    await sharp({ create: { width: 1024, height: 200, channels: 3, background: "#445566" } })
      .png()
      .toFile(path.join(cwd, "wide.png"));
    await writeFile(path.join(cwd, "bad.svg"), Buffer.from([1]));
    await writeFile(path.join(cwd, "big.png"), Buffer.from([1]));
    await truncate(path.join(cwd, "big.png"), MAX_REF_BYTES + 1);
  });
  afterAll(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("http(s)/mm_file 原样透传；1..16 张通过、17 张本地拒", async () => {
    const passed = await resolveImageRefs(["https://cdn/a.png", "mm_file://file-1"], cwd);
    expect(passed.map((item) => item.url)).toEqual(["https://cdn/a.png", "mm_file://file-1"]);
    expect(passed.every((item) => item.bytes === 0)).toBe(true);
    const urls = Array.from({ length: REF_MAX + 1 }, (_, i) => `https://cdn/${i}.png`);
    expect(await resolveImageRefs(urls.slice(0, REF_MAX), cwd)).toHaveLength(REF_MAX);
    const err = await codedAsync(() => resolveImageRefs(urls, cwd));
    expect(err.code).toBe("E_INVALID_OPTION");
    expect(err.details).toMatchObject({ option: "--ref", max: REF_MAX, value: REF_MAX + 1 });
  });

  it("本地 png 内联为 data URI，摘要只带字节数", async () => {
    const [item] = await resolveImageRefs(["ok.png"], cwd);
    expect(item.url).toMatch(/^data:image\/png;base64,/);
    expect(item.summary).toMatch(/^data:image\/png;base64,\d+ bytes$/);
    expect(item.bytes).toBeGreaterThan(0);
  });

  it("缺文件 E_MISSING_ARGUMENT；data URI/file:///白名单外扩展名 E_INVALID_OPTION", async () => {
    expect((await codedAsync(() => resolveImageRefs(["nope.png"], cwd))).code).toBe(
      "E_MISSING_ARGUMENT",
    );
    expect(
      (await codedAsync(() => resolveImageRefs(["data:image/png;base64,AAAA"], cwd))).code,
    ).toBe("E_INVALID_OPTION");
    expect((await codedAsync(() => resolveImageRefs(["file:///tmp/a.png"], cwd))).code).toBe(
      "E_INVALID_OPTION",
    );
    expect((await codedAsync(() => resolveImageRefs(["bad.svg"], cwd))).code).toBe(
      "E_INVALID_OPTION",
    );
  });

  it("单文件 >64MiB、边长 <128、宽高比 >4:1 全部本地拒", async () => {
    const big = await codedAsync(() => resolveImageRefs(["big.png"], cwd));
    expect(big.code).toBe("E_INVALID_OPTION");
    expect(big.details).toMatchObject({ maxBytes: MAX_REF_BYTES });
    const tiny = await codedAsync(() => resolveImageRefs(["tiny.png"], cwd));
    expect(tiny.code).toBe("E_INVALID_OPTION");
    expect(tiny.details).toMatchObject({ width: 100, height: 100, minEdge: 128 });
    const wide = await codedAsync(() => resolveImageRefs(["wide.png"], cwd));
    expect(wide.code).toBe("E_INVALID_OPTION");
    expect(wide.details).toMatchObject({ width: 1024, height: 200, maxAspect: 4 });
  });

  it("请求体预算：恰好 64MB 通过，超过 1 字节即拒", () => {
    const inlineAtLimit = (MAX_BODY_BYTES / 4) * 3;
    expect(() => assertBodyBudget(inlineAtLimit)).not.toThrow();
    const err = coded(() => assertBodyBudget(inlineAtLimit + 1));
    expect(err.code).toBe("E_INVALID_OPTION");
    expect(err.details).toMatchObject({ maxBodyBytes: MAX_BODY_BYTES });
  });
});
