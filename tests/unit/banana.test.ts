import { describe, expect, it } from "vitest";
import { loadConfig, normalizeBase } from "../../plugins/banana-image/lib/env.mjs";
import { parseSize } from "../../plugins/banana-image/lib/size.mjs";

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

describe("banana-image 配置", () => {
  it("base 归一：去末尾斜杠与误填的 /v1，空值回落官方地址", () => {
    expect(normalizeBase("https://api.bananarouter.com/")).toBe("https://api.bananarouter.com");
    expect(normalizeBase("https://api.bananarouter.com/v1/")).toBe("https://api.bananarouter.com");
    expect(normalizeBase("")).toBe("https://api.bananarouter.com");
    expect(normalizeBase(undefined)).toBe("https://api.bananarouter.com");
  });

  it("base 非法协议或 URL → E_CONFIG", () => {
    expect(coded(() => normalizeBase("ftp://x.com")).code).toBe("E_CONFIG");
    expect(coded(() => normalizeBase("not-a-url")).code).toBe("E_CONFIG");
  });

  it("缺 key → E_CONFIG 且指明变量名", () => {
    const err = coded(() => loadConfig({}));
    expect(err.code).toBe("E_CONFIG");
    expect(err.details?.var).toBe("BANANA_IMAGE_API_KEY");
  });

  it("默认 quality=high、model=gpt-image-2、png、300s 超时", () => {
    const config = loadConfig({ BANANA_IMAGE_API_KEY: "k" });
    expect(config).toMatchObject({
      apiKey: "k",
      baseUrl: "https://api.bananarouter.com",
      model: "gpt-image-2",
      quality: "high",
      outputFormat: "png",
      timeoutMs: 300_000,
    });
  });

  it("quality/output_format/timeout 白名单与正整数校验", () => {
    expect(
      coded(() => loadConfig({ BANANA_IMAGE_API_KEY: "k", BANANA_IMAGE_QUALITY: "ultra" })).code,
    ).toBe("E_CONFIG");
    expect(
      coded(() => loadConfig({ BANANA_IMAGE_API_KEY: "k", BANANA_IMAGE_OUTPUT_FORMAT: "gif" }))
        .code,
    ).toBe("E_CONFIG");
    expect(
      coded(() => loadConfig({ BANANA_IMAGE_API_KEY: "k", BANANA_IMAGE_TIMEOUT_MS: "0" })).code,
    ).toBe("E_CONFIG");
    expect(loadConfig({ BANANA_IMAGE_API_KEY: "k", BANANA_IMAGE_QUALITY: "medium" }).quality).toBe(
      "medium",
    );
  });
});

describe("banana-image 尺寸约束", () => {
  it("auto 与合法 WxH 通过", () => {
    expect(parseSize("auto")).toBe("auto");
    expect(parseSize("1024x1024")).toBe("1024x1024");
    expect(parseSize("1536x1024")).toBe("1536x1024");
    expect(parseSize("3840x2160")).toBe("3840x2160"); // 恰好 8,294,400 像素
  });

  it("格式错误（星号/非数字）→ E_INVALID_OPTION", () => {
    expect(coded(() => parseSize("1024*1024")).code).toBe("E_INVALID_OPTION");
    expect(coded(() => parseSize("abc")).code).toBe("E_INVALID_OPTION");
  });

  it("非 16 倍数、超长边、比例或像素越界均本地拒绝", () => {
    expect(coded(() => parseSize("1023x1024")).code).toBe("E_INVALID_OPTION");
    expect(coded(() => parseSize("3856x1024")).code).toBe("E_INVALID_OPTION");
    expect(coded(() => parseSize("3840x1232")).code).toBe("E_INVALID_OPTION");
    expect(coded(() => parseSize("768x768")).code).toBe("E_INVALID_OPTION");
    expect(coded(() => parseSize("3840x2176")).code).toBe("E_INVALID_OPTION");
  });
});
