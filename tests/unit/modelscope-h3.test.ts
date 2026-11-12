import { describe, expect, it } from "vitest";
import manifest from "../../plugins/modelscope-image/index.mjs";
import { H3_DEFAULTS, MODEL_CONFIG_FIELD } from "../../plugins/modelscope-image/lib/defaults.mjs";
import { loadConfig } from "../../plugins/modelscope-image/lib/env.mjs";
import {
  assertH3Prompt,
  H3_PROMPT_MAX,
  H3_RATIOS,
  parseH3Size,
  resolveH3Model,
  runH3Image,
  sizeFromH3Ratio,
} from "../../plugins/modelscope-image/lib/h3.mjs";

interface CliErr extends Error {
  code: string;
  details?: Record<string, unknown>;
}

// 与 modelscope-fast/edit 测试同风格：把鸭子类型错误取回来逐项断言
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

function fakeCtx() {
  return { cwd: "/tmp", logger: { info: () => {} }, warnings: { add: () => {} } };
}

// 网关不可达的 BASE_URL：用来证明本地校验已过、卡在配置阶段，任何用例都不会打真云
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const OFFLINE = {
  MODELSCOPE_BASE_URL: "::not-a-url::",
  MODELSCOPE_API_KEY: "unit-test-key",
  MODELSCOPE_H3_MODEL: "",
};

describe("modelscope-image-h3 的 defaults（MiniMax-H3-Image 契约）", () => {
  it("模型/尺寸/前缀/参考图上限与 MODEL_CONFIG_FIELD 映射", () => {
    expect(H3_DEFAULTS).toEqual({
      modelVar: "MODELSCOPE_H3_MODEL",
      modelFallback: "MiniMax/MiniMax-H3-Image",
      sizeDefault: "1024x1024",
      filePrefix: "modelscope-h3-",
      refMax: 16,
    });
    expect(MODEL_CONFIG_FIELD.MODELSCOPE_H3_MODEL).toBe("h3Model");
    // 兄弟命令的映射没被带歪
    expect(MODEL_CONFIG_FIELD.MODELSCOPE_IMAGE_MODEL).toBe("model");
    expect(MODEL_CONFIG_FIELD.MODELSCOPE_EDIT_MODEL).toBe("editModel");
    // 采样固定 6 steps / guidance 1：defaults 不提供可覆盖的采样字段
    expect("stepsDefault" in H3_DEFAULTS).toBe(false);
    expect("guidanceDefault" in H3_DEFAULTS).toBe(false);
  });
});

describe("modelscope env 契约（MODELSCOPE_H3_MODEL）", () => {
  const BASE = { MODELSCOPE_API_KEY: "k" };

  it("未设置/空串/纯空白读成空，由命令侧退回内置模型；生效时 trim", () => {
    expect(loadConfig(BASE).h3Model).toBe("");
    expect(loadConfig({ ...BASE, MODELSCOPE_H3_MODEL: "" }).h3Model).toBe("");
    expect(loadConfig({ ...BASE, MODELSCOPE_H3_MODEL: "   " }).h3Model).toBe("");
    expect(loadConfig({ ...BASE, MODELSCOPE_H3_MODEL: " Custom/H3 " }).h3Model).toBe("Custom/H3");
  });

  it("--model > MODELSCOPE_H3_MODEL > 内置 MiniMax/MiniMax-H3-Image", () => {
    const envConfig = loadConfig({ ...BASE, MODELSCOPE_H3_MODEL: "Custom/H3" });
    expect(resolveH3Model({}, envConfig)).toBe("Custom/H3");
    expect(resolveH3Model({ model: "Flag/H3" }, envConfig)).toBe("Flag/H3");
    expect(resolveH3Model({}, loadConfig(BASE))).toBe("MiniMax/MiniMax-H3-Image");
  });

  it("只认 MODELSCOPE_H3_MODEL：MODELSCOPE_IMAGE_MODEL 不会串门", () => {
    const config = loadConfig({ ...BASE, MODELSCOPE_IMAGE_MODEL: "Qwen/Qwen-Image-2.1" });
    expect(config.h3Model).toBe("");
    expect(resolveH3Model({}, config)).toBe("MiniMax/MiniMax-H3-Image");
  });
});

describe("尺寸边界（实测网关每边 [64,2048]，4096 本地即拒）", () => {
  it("64 与 2048 的边界放行（64 是两位数，格式正则不能误拒）", () => {
    expect(parseH3Size("64x64")).toBe("64x64");
    expect(parseH3Size("64x2048")).toBe("64x2048");
    expect(parseH3Size("2048x64")).toBe("2048x64");
    expect(parseH3Size("2048x2048")).toBe("2048x2048");
    expect(parseH3Size("1024x1536")).toBe("1024x1536");
  });

  it("63 / 2049 越界拒，错误码 E_INVALID_OPTION 且 details 带 --size", () => {
    for (const size of ["63x1024", "1024x63", "2049x1024", "1024x2049", "9999x9999"]) {
      const err = capture(() => parseH3Size(size));
      expect(err.code).toBe("E_INVALID_OPTION");
      expect(err.details?.option).toBe("--size");
      expect(err.message).toContain("2048");
    }
  });

  it("4096 本地拒：提示网关每边上限 2048，4K 改走 minimax-image", () => {
    for (const size of ["4096x4096", "4096x1024", "1024x4096"]) {
      const err = capture(() => parseH3Size(size));
      expect(err.code).toBe("E_INVALID_OPTION");
      expect(err.details).toEqual({ option: "--size", value: size });
      expect(err.message).toContain("4096");
      expect(err.message).toContain("2048");
      expect(err.message).toContain("4K");
      expect(err.message).toContain("minimax-image");
    }
  });

  it("格式非法（星号/缺边长/非数字）本地拒", () => {
    for (const size of ["1024", "1024*1024", "axb", "", "64x", "x64"]) {
      expect(capture(() => parseH3Size(size)).code).toBe("E_INVALID_OPTION");
    }
  });
});

describe("--ratio 映射（与兄弟命令同一张表）", () => {
  it("7 档比例全部映射到每边 ≤2048 的尺寸", () => {
    expect(H3_RATIOS).toEqual({
      "1:1": "2048x2048",
      "4:3": "2048x1536",
      "3:4": "1536x2048",
      "3:2": "2016x1344",
      "2:3": "1344x2016",
      "16:9": "2048x1152",
      "9:16": "1152x2048",
    });
    for (const [ratio, size] of Object.entries(H3_RATIOS)) {
      expect(sizeFromH3Ratio(ratio)).toBe(size);
      // 映射本身就是合法尺寸，不需要再兜底
      expect(parseH3Size(size)).toBe(size);
    }
  });

  it("未知比例拒，details.option 是 --ratio", () => {
    const err = capture(() => sizeFromH3Ratio("5:4"));
    expect(err.code).toBe("E_INVALID_OPTION");
    expect(err.details?.option).toBe("--ratio");
  });
});

describe("prompt 上限 32000（MiniMax 文档，按 Unicode 码点计）", () => {
  it("32000 放行，32001 拒（汉字与 surrogate 对都按码点算）", () => {
    expect(H3_PROMPT_MAX).toBe(32000);
    expect(() => assertH3Prompt("a".repeat(32000))).not.toThrow();
    expect(() => assertH3Prompt("苹".repeat(32000))).not.toThrow();
    expect(() => assertH3Prompt("😀".repeat(32000))).not.toThrow();

    const err = capture(() => assertH3Prompt("苹".repeat(32001)));
    expect(err.code).toBe("E_INVALID_OPTION");
    expect(err.details).toEqual({ option: "--prompt", limit: 32000, actual: 32001 });
    expect(err.message).toContain("32000");

    // 😀 是 surrogate 对：按码点计数应报 32001 而不是 64002
    const emoji = capture(() => assertH3Prompt("😀".repeat(32001)));
    expect(emoji.details?.actual).toBe(32001);
  });

  it("缺 prompt / 纯空白是 E_MISSING_ARGUMENT（非交互，绝不挂起）", () => {
    for (const prompt of [undefined, "", "   "]) {
      const err = capture(() => assertH3Prompt(prompt));
      expect(err.code).toBe("E_MISSING_ARGUMENT");
      expect(err.details?.option).toBe("--prompt");
    }
  });
});

describe("handler 的本地校验全部先于配置与网络", () => {
  it("prompt 32001 / 4096 / size+ratio 同时传：fetch 炸弹不响，直接 E_INVALID_OPTION", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("不该发网络请求");
    }) as typeof globalThis.fetch;
    try {
      const long = await captureAsync(() => runH3Image(fakeCtx(), { prompt: "a".repeat(32001) }));
      expect(long.code).toBe("E_INVALID_OPTION");
      expect(long.details?.option).toBe("--prompt");

      const big = await captureAsync(() =>
        runH3Image(fakeCtx(), { prompt: "x", size: "4096x4096" }),
      );
      expect(big.code).toBe("E_INVALID_OPTION");
      expect(big.message).toContain("minimax-image");

      const both = await captureAsync(() =>
        runH3Image(fakeCtx(), { prompt: "x", size: "1024x1024", ratio: "1:1" }),
      );
      expect(both.code).toBe("E_INVALID_OPTION");
      expect(both.details?.option).toBe("--ratio");

      const missing = await captureAsync(() => runH3Image(fakeCtx(), {}));
      expect(missing.code).toBe("E_MISSING_ARGUMENT");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("64x64 与 32000 字符都过本地校验：卡在被故意写坏的 BASE_URL（E_CONFIG）", async () => {
    const err = await captureAsync(() =>
      withEnv(OFFLINE, () => runH3Image(fakeCtx(), { prompt: "a".repeat(32000), size: "64x64" })),
    );
    expect(err.code).toBe("E_CONFIG");
  });
});

describe("modelscope-image-h3 manifest（AGENTS.md §5 声明式契约）", () => {
  const h3 = manifest.commands.find((c: { name: string }) => c.name === "modelscope-image-h3");
  const flagsOf = (cmd: { options?: { flags: string }[] } | undefined) =>
    (cmd?.options ?? []).map((o) => o.flags);
  const textOf = (cmd: { options?: { description: string }[] } | undefined) =>
    (cmd?.options ?? []).map((o) => o.description).join("\n");

  it("h3 是第四条命令，选项集恰好是契约里的 7 项", () => {
    expect(manifest.commands.map((c: { name: string }) => c.name)).toEqual([
      "modelscope-image-gen",
      "modelscope-image-fast",
      "modelscope-image-edit",
      "modelscope-image-h3",
    ]);
    expect(flagsOf(h3)).toEqual([
      "--prompt <text>",
      "--model <id>",
      "--size <WxH>",
      "--ratio <name>",
      "--seed <n>",
      "--ref <pathsOrUrls...>",
      "--output <path>",
    ]);
    // 采样固定：不暴露 steps/guidance/negative-prompt
    const flags = flagsOf(h3).join("\n");
    expect(flags).not.toContain("--steps");
    expect(flags).not.toContain("--guidance");
    expect(flags).not.toContain("--negative-prompt");
    expect(typeof h3?.handler).toBe("function");
  });

  it("选项文本写清 32000 / [64,2048] / 16 张 / minimax-image", () => {
    const text = textOf(h3);
    expect(text).toContain("32000");
    expect(text).toContain("[64,2048]");
    expect(text).toContain("MiniMax/MiniMax-H3-Image");
    expect(text).toContain("MODELSCOPE_H3_MODEL");
    expect(text).toContain("1024x1024");
    expect(text).toContain("16");
    expect(text).toContain("minimax-image");
    expect(text).toContain("modelscope-h3-");
  });

  it("handler 缺 --prompt 抛 E_MISSING_ARGUMENT 且不碰网络", async () => {
    const err = await captureAsync(() => h3?.handler(fakeCtx(), {}));
    expect(err.code).toBe("E_MISSING_ARGUMENT");
    expect(err.details?.option).toBe("--prompt");
  });
});
