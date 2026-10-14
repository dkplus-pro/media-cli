import { describe, expect, it } from "vitest";
import manifest from "../../plugins/modelscope-image/index.mjs";
import { loadConfig } from "../../plugins/modelscope-image/lib/env.mjs";
import {
  assertPromptLength,
  FAST_DEFAULTS,
  GEN_DEFAULTS,
  PROMPT_MAX,
  parseNumberOption,
  parseRefUrls,
  parseSize,
  RATIOS,
  runImageGen,
  sizeFromRatio,
} from "../../plugins/modelscope-image/lib/run.mjs";

interface CliErr extends Error {
  code: string;
  details?: Record<string, unknown>;
}

// 与 agnes.test.ts 同风格：把抛出的鸭子类型错误取回来做断言，而不是用 toThrow 只看个码
function capture(fn: () => unknown): CliErr {
  try {
    fn();
  } catch (err) {
    return err as CliErr;
  }
  throw new Error("expected a coded error");
}

async function captureAsync(fn: () => Promise<unknown>): Promise<CliErr> {
  try {
    await fn();
  } catch (err) {
    return err as CliErr;
  }
  throw new Error("expected a coded error");
}

const GUIDANCE_RANGE = { min: FAST_DEFAULTS.guidanceMin, max: 20 };

// 只 return 数据或 throw 的 handler 所需上下文（§4.5：插件不碰流）
function fakeCtx() {
  return {
    cwd: "/tmp",
    logger: { info: () => {} },
    warnings: { add: () => {} },
  };
}

describe("modelscope guidance 下限放宽（D25：1.5 → 1）", () => {
  it("两个命令的下限都是 1：Turbo 官方默认 CFG=1 必须能过", () => {
    expect(GEN_DEFAULTS.guidanceMin).toBe(1);
    expect(FAST_DEFAULTS.guidanceMin).toBe(1);
    expect(parseNumberOption("1", "--guidance", GUIDANCE_RANGE)).toBe(1);
    // 改下限前这两个会被 1.5 拦住
    expect(parseNumberOption("1.4", "--guidance", GUIDANCE_RANGE)).toBe(1.4);
    expect(parseNumberOption("1.5", "--guidance", GUIDANCE_RANGE)).toBe(1.5);
  });

  it("下界之外与非法值仍拒，上限 20 不变", () => {
    for (const value of ["0.999", "0", "-1", "abc", "", "NaN", "20.5"]) {
      expect(capture(() => parseNumberOption(value, "--guidance", GUIDANCE_RANGE)).code).toBe(
        "E_INVALID_OPTION",
      );
    }
    expect(
      capture(() => parseNumberOption("21", "--guidance", GUIDANCE_RANGE)).details?.value,
    ).toBe("21");
    expect(parseNumberOption("20", "--guidance", GUIDANCE_RANGE)).toBe(20);
  });

  it("steps 仍是整数 1-100（没被 defaults 改动带歪）", () => {
    const range = { min: 1, max: 100, integer: true };
    expect(parseNumberOption("8", "--steps", range)).toBe(8);
    expect(capture(() => parseNumberOption("8.5", "--steps", range)).code).toBe("E_INVALID_OPTION");
    expect(capture(() => parseNumberOption("0", "--steps", range)).code).toBe("E_INVALID_OPTION");
  });
});

describe("modelscope prompt 长度本地预检（§1.3 实测 4000 字符）", () => {
  it("上限 4000，且按字符计不按字节", () => {
    expect(PROMPT_MAX).toBe(4000);
    const chinese = "苹".repeat(4000);
    // 4000 个汉字 = 12000 UTF-8 字节，实测网关放行，所以本地不能按字节拦
    expect(Buffer.byteLength(chinese, "utf8")).toBe(12000);
    expect(() => assertPromptLength(chinese)).not.toThrow();
    expect(() => assertPromptLength("a".repeat(4000))).not.toThrow();
  });

  it("超限抛 E_INVALID_OPTION，details 带 option/limit/actual", () => {
    const err = capture(() => assertPromptLength("a".repeat(4001)));
    expect(err.code).toBe("E_INVALID_OPTION");
    expect(err.details).toEqual({ option: "--prompt", limit: 4000, actual: 4001 });
    expect(err.message).toContain("4000");

    const chineseErr = capture(() => assertPromptLength("苹".repeat(4001)));
    // 汉字各算 1 字符（surrogate 安全的码点计数）
    expect(chineseErr.details?.actual).toBe(4001);
    expect(chineseErr.details?.limit).toBe(4000);
  });

  it("两个命令共用这条预检：runImageGen 在取配置/发请求前就拦下", async () => {
    const original = globalThis.fetch;
    // 把 fetch 换成炸弹：真走到网络就会拿到无 code 的裸错误
    globalThis.fetch = (() => {
      throw new Error("不该发网络请求");
    }) as typeof globalThis.fetch;
    try {
      for (const defaults of [GEN_DEFAULTS, FAST_DEFAULTS]) {
        const err = await captureAsync(() =>
          runImageGen(fakeCtx(), { prompt: "x".repeat(4001) }, defaults),
        );
        expect(err.code).toBe("E_INVALID_OPTION");
        expect(err.details?.option).toBe("--prompt");
      }
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("modelscope-image-fast 的 defaults（§4.2 表）", () => {
  it("fast：Turbo 模型 + steps 8 + guidance 1 + 2048x2048 + modelscope-fast- 前缀", () => {
    expect(FAST_DEFAULTS).toEqual({
      modelVar: "MODELSCOPE_FAST_MODEL",
      modelFallback: "Qwen/Qwen-Image-2.1-Turbo",
      stepsDefault: 8,
      guidanceDefault: 1,
      guidanceMin: 1,
      sizeDefault: "2048x2048",
      filePrefix: "modelscope-fast-",
    });
  });

  it("gen：保持原行为（模型无内置默认，steps/guidance 不传即交给 provider）", () => {
    expect(GEN_DEFAULTS).toEqual({
      modelVar: "MODELSCOPE_IMAGE_MODEL",
      modelFallback: "",
      stepsDefault: undefined,
      guidanceDefault: undefined,
      guidanceMin: 1,
      sizeDefault: "1024x1024",
      filePrefix: "modelscope-",
    });
  });
});

describe("modelscope env 契约（MODELSCOPE_FAST_MODEL）", () => {
  const BASE = { MODELSCOPE_API_KEY: "k" };

  it("loadConfig 增返 fastModel：未设置/空串/纯空白都读成空（由命令侧退回内置默认）", () => {
    expect(loadConfig(BASE).fastModel).toBe("");
    expect(loadConfig({ ...BASE, MODELSCOPE_FAST_MODEL: "" }).fastModel).toBe("");
    expect(loadConfig({ ...BASE, MODELSCOPE_FAST_MODEL: "   " }).fastModel).toBe("");
  });

  it("MODELSCOPE_FAST_MODEL 生效并 trim", () => {
    expect(
      loadConfig({ ...BASE, MODELSCOPE_FAST_MODEL: "Qwen/Qwen-Image-2.1-Turbo" }).fastModel,
    ).toBe("Qwen/Qwen-Image-2.1-Turbo");
    expect(loadConfig({ ...BASE, MODELSCOPE_FAST_MODEL: " Custom/Fast " }).fastModel).toBe(
      "Custom/Fast",
    );
  });

  it("既有字段不受影响：model 仍取 MODELSCOPE_IMAGE_MODEL，池仍优先于单 key", () => {
    const config = loadConfig({
      ...BASE,
      MODELSCOPE_IMAGE_MODEL: "Qwen/Qwen-Image-2.1",
      MODELSCOPE_KEY_POOL: " k1 , k2 ",
    });
    expect(config.model).toBe("Qwen/Qwen-Image-2.1");
    expect(config.keys).toEqual(["k1", "k2"]);
    expect(config.baseUrl).toBe("https://api-inference.modelscope.cn");
    expect(config.timeoutMs).toBe(300000);
    expect(config.pollIntervalMs).toBe(2000);
    expect(capture(() => loadConfig({})).code).toBe("E_CONFIG");
  });
});

describe("modelscope 尺寸与比例（抽取到 lib/run.mjs 后行为不变）", () => {
  it("WxH 字符串、每边 [64,2048]，星号格式本地即拒", () => {
    expect(parseSize("2048x2048")).toBe("2048x2048");
    expect(parseSize("1024x1536")).toBe("1024x1536");
    expect(capture(() => parseSize("1024")).code).toBe("E_INVALID_OPTION");
    expect(capture(() => parseSize("928*1664")).code).toBe("E_INVALID_OPTION");
    expect(capture(() => parseSize("2752x1536")).message).toContain("2048");
    expect(capture(() => parseSize("1024x32")).code).toBe("E_INVALID_OPTION");
  });

  it("7 档比例映射到网关最大档（每边 ≤2048）", () => {
    expect(sizeFromRatio("1:1")).toBe("2048x2048");
    expect(sizeFromRatio("16:9")).toBe("2048x1152");
    expect(sizeFromRatio("9:16")).toBe("1152x2048");
    expect(Object.keys(RATIOS)).toHaveLength(7);
    expect(capture(() => sizeFromRatio("5:4")).code).toBe("E_INVALID_OPTION");
  });

  it("参考图上限 10 张、只收 http(s) URL", () => {
    expect(parseRefUrls("https://cdn/a.png")).toEqual(["https://cdn/a.png"]);
    expect(
      capture(() => parseRefUrls(Array.from({ length: 11 }, (_, i) => `https://c/${i}.png`))).code,
    ).toBe("E_INVALID_OPTION");
    expect(capture(() => parseRefUrls(["/tmp/a.png"])).code).toBe("E_INVALID_OPTION");
    expect(capture(() => parseRefUrls(["ftp://c/a.png"])).code).toBe("E_INVALID_OPTION");
  });
});

describe("modelscope manifest（AGENTS.md §5 声明式契约）", () => {
  const flagsOf = (name: string) =>
    (manifest.commands.find((c: { name: string }) => c.name === name)?.options ?? []).map(
      (o: { flags: string }) => o.flags,
    );

  it("两个命令齐备且选项集完全一致（§4.2：只差默认值）", () => {
    expect(manifest.name).toBe("modelscope-image");
    expect(manifest.commands.map((c: { name: string }) => c.name)).toEqual([
      "modelscope-image-gen",
      "modelscope-image-fast",
    ]);
    expect(flagsOf("modelscope-image-gen")).toEqual(flagsOf("modelscope-image-fast"));
    for (const cmd of manifest.commands) {
      expect(typeof cmd.handler).toBe("function");
      expect(cmd.description.length).toBeGreaterThan(0);
      for (const opt of cmd.options ?? []) {
        expect(typeof opt.flags).toBe("string");
        expect(opt.description.length).toBeGreaterThan(0);
      }
    }
  });

  it("选项文本不再写 1.5，且如实标出 prompt 上限", () => {
    for (const cmd of manifest.commands) {
      const text = (cmd.options ?? [])
        .map((o: { description: string }) => o.description)
        .join("\n");
      expect(text).not.toContain("1.5");
      expect(text).toContain("1-20");
      expect(text).toContain("4000 字符");
    }
    const fast = manifest.commands.find(
      (c: { name: string }) => c.name === "modelscope-image-fast",
    );
    const descriptions = (fast.options ?? [])
      .map((o: { description: string }) => o.description)
      .join("\n");
    expect(descriptions).toContain("Qwen/Qwen-Image-2.1-Turbo");
    expect(descriptions).toContain("2048x2048");
    expect(descriptions).toContain("modelscope-fast-");
  });

  it("fast 的 handler 走同一条流程：缺 --prompt 抛 E_MISSING_ARGUMENT 且不碰网络", async () => {
    const [gen, fast] = manifest.commands;
    for (const cmd of [gen, fast]) {
      const err = await captureAsync(() => cmd.handler(fakeCtx(), {}));
      expect(err.code).toBe("E_MISSING_ARGUMENT");
      expect(err.details?.option).toBe("--prompt");
    }
  });
});
