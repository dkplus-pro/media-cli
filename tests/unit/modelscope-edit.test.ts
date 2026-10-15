import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import manifest from "../../plugins/modelscope-image/index.mjs";
import { DEFAULT_EDIT_MODEL, loadConfig } from "../../plugins/modelscope-image/lib/env.mjs";
import {
  isHttpUrl,
  resolveRef,
  summarizeRef,
  summarizeRefs,
  toDataUri,
} from "../../plugins/modelscope-image/lib/refs.mjs";
import {
  EDIT_DEFAULTS,
  FAST_DEFAULTS,
  GEN_DEFAULTS,
  PROMPT_MAX,
  parseNumberOption,
  parseRefItems,
  parseRefUrls,
  runImageGen,
  STEPS_MAX,
} from "../../plugins/modelscope-image/lib/run.mjs";

interface CliErr extends Error {
  code: string;
  details?: Record<string, unknown>;
}

// 与 modelscope-fast.test.ts / agnes.test.ts 同风格：把鸭子类型错误取回来逐项断言
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

const STEPS_RANGE = { min: 1, max: STEPS_MAX, integer: true };

// 1x1 PNG（真实字节，用来验证摘要里的字节数是解码后的原图大小而非 base64 字符数）
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function fakeCtx(cwd = "/tmp") {
  return { cwd, logger: { info: () => {} }, warnings: { add: () => {} } };
}

// 网关不可达的 BASE_URL：用来证明「本地校验已过、卡在配置阶段」，任何用例都不会打真云
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
  MODELSCOPE_EDIT_MODEL: "",
};

let dir: string;
const file = (name: string) => path.join(dir, name);

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "modelscope-edit-unit-"));
  await writeFile(file("a.png"), PNG_1PX);
  await writeFile(file("b.jpg"), PNG_1PX);
  await writeFile(file("c.jpeg"), PNG_1PX);
  await writeFile(file("d.webp"), PNG_1PX);
  await writeFile(file("e.txt"), "not an image");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("modelscope-image-edit 的 defaults（实测 2026-10-15 契约）", () => {
  it("edit：Qwen/Qwen-Image-Edit + 2048x2048 + modelscope-edit- 前缀 + refMax 4 + 收本地文件", () => {
    expect(EDIT_DEFAULTS).toEqual({
      modelVar: "MODELSCOPE_EDIT_MODEL",
      modelFallback: "Qwen/Qwen-Image-Edit",
      guidanceMin: 1,
      sizeDefault: "2048x2048",
      filePrefix: "modelscope-edit-",
      refMax: 4,
      localRefs: true,
    });
    expect(DEFAULT_EDIT_MODEL).toBe("Qwen/Qwen-Image-Edit");
    // 不干预采样：Edit 的推荐步数/CFG 未实测，交给 provider 默认
    expect(EDIT_DEFAULTS.stepsDefault).toBeUndefined();
    expect(EDIT_DEFAULTS.guidanceDefault).toBeUndefined();
  });

  it("gen/fast 保持只收公网 URL、上限 10 张（没被 edit 带歪）", () => {
    expect(GEN_DEFAULTS.refMax).toBe(10);
    expect(GEN_DEFAULTS.localRefs).toBe(false);
    expect(FAST_DEFAULTS.refMax).toBe(10);
    expect(FAST_DEFAULTS.localRefs).toBe(false);
    expect(GEN_DEFAULTS.sizeDefault).toBe("1024x1024");
    expect(FAST_DEFAULTS.filePrefix).toBe("modelscope-fast-");
  });

  it("prompt 上限与 gen/fast 同源（网关级校验，与模型无关）", () => {
    expect(PROMPT_MAX).toBe(4000);
  });
});

describe("steps 本地硬上限收紧到 50（网关实测：2.1 与 Edit 都只收 [1,50]）", () => {
  it("STEPS_MAX 是 50，边界内放行、边界外拒", () => {
    expect(STEPS_MAX).toBe(50);
    expect(parseNumberOption("50", "--steps", STEPS_RANGE)).toBe(50);
    expect(parseNumberOption("1", "--steps", STEPS_RANGE)).toBe(1);
    for (const value of ["51", "80", "100", "0", "8.5", "abc", ""]) {
      expect(capture(() => parseNumberOption(value, "--steps", STEPS_RANGE)).code).toBe(
        "E_INVALID_OPTION",
      );
    }
    expect(capture(() => parseNumberOption("80", "--steps", STEPS_RANGE)).message).toContain("50");
  });

  it("三条命令都在本地拦下 --steps 80：错误码 E_INVALID_OPTION，且卡在配置阶段之前", async () => {
    for (const defaults of [GEN_DEFAULTS, FAST_DEFAULTS, EDIT_DEFAULTS]) {
      const err = await captureAsync(() =>
        withEnv(OFFLINE, () => runImageGen(fakeCtx(dir), { prompt: "x", steps: "80" }, defaults)),
      );
      expect(err.code).toBe("E_INVALID_OPTION");
      expect(err.details?.option).toBe("--steps");
      expect(err.details?.value).toBe("80");
    }
  });

  it("50 步合法：不再因为旧的 1–100 区间而白跑一次提交（卡在离线的配置校验上）", async () => {
    for (const defaults of [GEN_DEFAULTS, EDIT_DEFAULTS]) {
      const err = await captureAsync(() =>
        withEnv(OFFLINE, () => runImageGen(fakeCtx(dir), { prompt: "x", steps: "50" }, defaults)),
      );
      // steps 已过校验，接下来的 E_CONFIG 来自被故意写坏的 BASE_URL
      expect(err.code).toBe("E_CONFIG");
    }
  });

  it("guidance 仍是 1–20（Edit 实测 [1.0,20.0] 与此一致）", () => {
    expect(parseNumberOption("1", "--guidance", { min: 1, max: 20 })).toBe(1);
    expect(parseNumberOption("20", "--guidance", { min: 1, max: 20 })).toBe(20);
    expect(capture(() => parseNumberOption("0.9", "--guidance", { min: 1, max: 20 })).code).toBe(
      "E_INVALID_OPTION",
    );
    expect(capture(() => parseNumberOption("20.5", "--guidance", { min: 1, max: 20 })).code).toBe(
      "E_INVALID_OPTION",
    );
  });
});

describe("本地文件 → data URI（实测网关真的消费 data URI，不需要 CDN）", () => {
  it("mime 按扩展名：png/jpg/jpeg/webp 各自对应 image/*", async () => {
    expect(await toDataUri(file("a.png"))).toMatch(/^data:image\/png;base64,/);
    expect(await toDataUri(file("b.jpg"))).toMatch(/^data:image\/jpeg;base64,/);
    expect(await toDataUri(file("c.jpeg"))).toMatch(/^data:image\/jpeg;base64,/);
    expect(await toDataUri(file("d.webp"))).toMatch(/^data:image\/webp;base64,/);
    // base64 段解回来就是原文件字节
    const uri = await toDataUri(file("a.png"));
    expect(Buffer.from(uri.split(",")[1] as string, "base64").length).toBe(PNG_1PX.length);
  });

  it("文件不存在 → E_MISSING_ARGUMENT；扩展名不在实测白名单 → E_INVALID_OPTION", async () => {
    const missing = await captureAsync(() => toDataUri(file("nope.png")));
    expect(missing.code).toBe("E_MISSING_ARGUMENT");
    expect(missing.details?.option).toBe("--ref");

    const txt = await captureAsync(() => toDataUri(file("e.txt")));
    expect(txt.code).toBe("E_INVALID_OPTION");
    expect(txt.message).toContain("e.txt");
    // 目录不是文件，同样算「参考图文件不存在」
    expect((await captureAsync(() => toDataUri(dir))).code).toBe("E_MISSING_ARGUMENT");
  });

  it("resolveRef：http(s) 原样透传，其他 scheme 本地拒，裸路径按 cwd 解析", async () => {
    expect(await resolveRef("https://cdn.example.com/a.png", "--ref", dir)).toBe(
      "https://cdn.example.com/a.png",
    );
    expect(await resolveRef("http://cdn.example.com/a.png", "--ref", dir)).toBe(
      "http://cdn.example.com/a.png",
    );
    expect(await resolveRef("a.png", "--ref", dir)).toMatch(/^data:image\/png;base64,/);
    expect(await resolveRef(path.join(dir, "a.png"), "--ref", "/nonexistent-cwd")).toMatch(
      /^data:image\/png/,
    );
    for (const value of ["ftp://cdn/a.png", "file:///tmp/a.png", "data:image/png;base64,AAA"]) {
      expect((await captureAsync(() => resolveRef(value, "--ref", dir))).code).toBe(
        "E_INVALID_OPTION",
      );
    }
    expect(isHttpUrl("https://a/b")).toBe(true);
    expect(isHttpUrl("a.png")).toBe(false);
    expect(isHttpUrl("ftp://a/b")).toBe(false);
  });

  it("data URI 在 data 里只回摘要（`data:<mime>;base64,<N> bytes`），URL 不受影响", async () => {
    const uri = await toDataUri(file("a.png"));
    expect(summarizeRef(uri)).toBe(`data:image/png;base64,${PNG_1PX.length} bytes`);
    // 摘要里绝不能还有 base64 原文
    expect(summarizeRef(uri)).not.toContain(uri.slice(30));
    expect(summarizeRef("https://cdn.example.com/a.png")).toBe("https://cdn.example.com/a.png");
    const mixed = [uri, "https://cdn.example.com/b.png"];
    expect(summarizeRefs(mixed)).toEqual([
      `data:image/png;base64,${PNG_1PX.length} bytes`,
      "https://cdn.example.com/b.png",
    ]);
  });
});

describe("--ref 张数上限按命令分档（edit 实测 4 / gen 仍是 10）", () => {
  const url = (i: number) => `https://cdn.example.com/${i}.png`;
  const urls = (n: number) => Array.from({ length: n }, (_, i) => url(i));

  it("parseRefUrls 默认上限仍是 10（gen/fast 的历史契约不变）", () => {
    expect(parseRefUrls(urls(10))).toEqual(urls(10));
    expect(parseRefUrls(url(1))).toEqual([url(1)]);
    const over = capture(() => parseRefUrls(urls(11)));
    expect(over.code).toBe("E_INVALID_OPTION");
    expect(over.message).toContain("10");
  });

  it("上限 4 时第 5 张本地即拒，details 带 max，文案抄网关原文", () => {
    expect(parseRefUrls(urls(4), 4)).toEqual(urls(4));
    const err = capture(() => parseRefUrls(urls(5), 4));
    expect(err.code).toBe("E_INVALID_OPTION");
    expect(err.details).toEqual({ option: "--ref", value: 5, max: 4 });
    expect(err.message).toContain("最多 4 张");
    expect(err.message).toContain("exceeds maximum limit of 4");
  });

  it("空列表拒", () => {
    expect(capture(() => parseRefUrls([], 4)).code).toBe("E_INVALID_OPTION");
    expect(capture(() => parseRefUrls([], 10)).details?.option).toBe("--ref");
  });

  it("parseRefItems 可混传本地文件与 URL，顺序保持", async () => {
    const items = await parseRefItems([file("a.png"), url(1), "b.jpg", url(2)], 4, dir);
    expect(items).toHaveLength(4);
    expect(items[0]).toMatch(/^data:image\/png;base64,/);
    expect(items[1]).toBe(url(1));
    expect(items[2]).toMatch(/^data:image\/jpeg;base64,/);
    expect(items[3]).toBe(url(2));
    // 超出上限时连文件都不该去读，直接拒
    const over = await captureAsync(() => parseRefItems([...urls(4), file("a.png")], 4, dir));
    expect(over.code).toBe("E_INVALID_OPTION");
    expect(over.details?.max).toBe(4);
  });

  it("edit 的本地路径在发请求前就拒（缺文件 → E_MISSING_ARGUMENT，不碰配置）", async () => {
    const err = await captureAsync(() =>
      withEnv(OFFLINE, () =>
        runImageGen(fakeCtx(dir), { prompt: "x", ref: ["missing.png"] }, EDIT_DEFAULTS),
      ),
    );
    expect(err.code).toBe("E_MISSING_ARGUMENT");
    expect(err.details?.option).toBe("--ref");

    const tooMany = await captureAsync(() =>
      withEnv(OFFLINE, () =>
        runImageGen(fakeCtx(dir), { prompt: "x", ref: urls(5) }, EDIT_DEFAULTS),
      ),
    );
    expect(tooMany.code).toBe("E_INVALID_OPTION");
    expect(tooMany.details?.max).toBe(4);
  });

  it("gen 仍拒绝本地路径（只有 edit 收本地文件）", async () => {
    const err = await captureAsync(() =>
      withEnv(OFFLINE, () =>
        runImageGen(fakeCtx(dir), { prompt: "x", ref: ["a.png"] }, GEN_DEFAULTS),
      ),
    );
    expect(err.code).toBe("E_INVALID_OPTION");
    expect(err.details?.option).toBe("--ref");
  });
});

describe("modelscope env 契约（MODELSCOPE_EDIT_MODEL）", () => {
  const BASE = { MODELSCOPE_API_KEY: "k" };

  it("未设置/空串/纯空白都读成空（由命令侧退回内置的 Qwen/Qwen-Image-Edit）", () => {
    expect(loadConfig(BASE).editModel).toBe("");
    expect(loadConfig({ ...BASE, MODELSCOPE_EDIT_MODEL: "" }).editModel).toBe("");
    expect(loadConfig({ ...BASE, MODELSCOPE_EDIT_MODEL: "   " }).editModel).toBe("");
  });

  it("生效并 trim", () => {
    expect(loadConfig({ ...BASE, MODELSCOPE_EDIT_MODEL: "Qwen/Qwen-Image-Edit" }).editModel).toBe(
      "Qwen/Qwen-Image-Edit",
    );
    expect(loadConfig({ ...BASE, MODELSCOPE_EDIT_MODEL: " Custom/Edit " }).editModel).toBe(
      "Custom/Edit",
    );
  });

  it("三个模型变量互不串门，其余字段不受影响", () => {
    const config = loadConfig({
      ...BASE,
      MODELSCOPE_IMAGE_MODEL: "Qwen/Qwen-Image-2.1",
      MODELSCOPE_FAST_MODEL: "Qwen/Qwen-Image-2.1-Turbo",
      MODELSCOPE_EDIT_MODEL: "Qwen/Qwen-Image-Edit",
      MODELSCOPE_KEY_POOL: " k1 , k2 ",
    });
    expect(config.model).toBe("Qwen/Qwen-Image-2.1");
    expect(config.fastModel).toBe("Qwen/Qwen-Image-2.1-Turbo");
    expect(config.editModel).toBe("Qwen/Qwen-Image-Edit");
    expect(config.keys).toEqual(["k1", "k2"]);
    expect(capture(() => loadConfig({})).code).toBe("E_CONFIG");
  });

  it("edit 只认 MODELSCOPE_EDIT_MODEL：设了 IMAGE_MODEL 也不会被拿去当默认", async () => {
    // BASE_URL 故意不可达：能走到 E_CONFIG 就说明模型解析没提前失败
    const err = await captureAsync(() =>
      withEnv({ ...OFFLINE, MODELSCOPE_IMAGE_MODEL: "Qwen/Qwen-Image-2.1" }, () =>
        runImageGen(fakeCtx(dir), { prompt: "x" }, EDIT_DEFAULTS),
      ),
    );
    expect(err.code).toBe("E_CONFIG");
  });
});

describe("modelscope-image manifest：第三条命令（AGENTS.md §5 声明式契约）", () => {
  const flagsOf = (name: string) =>
    (manifest.commands.find((c: { name: string }) => c.name === name)?.options ?? []).map(
      (o: { flags: string }) => o.flags,
    );
  const textOf = (name: string) =>
    (manifest.commands.find((c: { name: string }) => c.name === name)?.options ?? [])
      .map((o: { description: string }) => o.description)
      .join("\n");

  it("三个命令齐备，gen 与 fast 的选项集仍完全一致", () => {
    expect(manifest.commands.map((c: { name: string }) => c.name)).toEqual([
      "modelscope-image-gen",
      "modelscope-image-fast",
      "modelscope-image-edit",
    ]);
    expect(flagsOf("modelscope-image-gen")).toEqual(flagsOf("modelscope-image-fast"));
  });

  it("edit 收 --ref <pathsOrUrls...>、不发 --ratio，其余选项与兄弟命令同源", () => {
    // 顺序即 manifest 声明顺序：兄弟命令去掉 --ratio，把 --ref 换成 pathOrUrl 形态并排在 --output 前
    expect(flagsOf("modelscope-image-edit")).toEqual([
      "--prompt <text>",
      "--model <id>",
      "--size <WxH>",
      "--steps <n>",
      "--guidance <n>",
      "--seed <n>",
      "--negative-prompt <text>",
      "--ref <pathsOrUrls...>",
      "--output <path>",
    ]);
    expect(flagsOf("modelscope-image-gen")).toContain("--ref <urls...>");
  });

  it("edit 的选项文本写清实测硬限与本地文件语义", () => {
    const text = textOf("modelscope-image-edit");
    expect(text).toContain("4000 字符");
    expect(text).toContain("1-20");
    expect(text).toContain("1-50");
    expect(text).not.toContain("1-100");
    expect(text).toContain("[64,2048]");
    expect(text).toContain("Qwen/Qwen-Image-Edit");
    expect(text).toContain("modelscope-edit-");
    expect(text).toContain("data:image");
    expect(text).toContain("不需要先上传 CDN");
    expect(text).toContain("exceeds maximum limit of 4");
    expect(text).not.toContain("1.5");
  });

  it("三条命令的选项文本都不再宣称 steps 能到 100", () => {
    for (const cmd of manifest.commands) {
      const text = textOf(cmd.name);
      expect(text).not.toContain("1-100");
      expect(text).toContain("1-50");
      expect(text).toContain("4000 字符");
      expect(text).not.toContain("1.5");
    }
  });

  it("edit 的 handler 走同一条流程：缺 --prompt 抛 E_MISSING_ARGUMENT 且不碰网络", async () => {
    const edit = manifest.commands.find(
      (c: { name: string }) => c.name === "modelscope-image-edit",
    );
    expect(typeof edit?.handler).toBe("function");
    const err = await captureAsync(() => edit.handler(fakeCtx(dir), {}));
    expect(err.code).toBe("E_MISSING_ARGUMENT");
    expect(err.details?.option).toBe("--prompt");
  });
});
