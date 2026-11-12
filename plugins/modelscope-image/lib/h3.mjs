import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { fetchImageBytes, generateImage } from "./client.mjs";
import { H3_DEFAULTS, MODEL_CONFIG_FIELD } from "./defaults.mjs";
import { loadConfig } from "./env.mjs";
import { cliError } from "./errors.mjs";
import { resolveRef, summarizeRefs } from "./refs.mjs";
import { parseNumberOption } from "./run.mjs";

// modelscope-image-h3：MiniMax-H3-Image 经 ModelScope API-Inference 的文生图/图片编辑。
// 采样固定 6 steps / guidance 1、不吃 negative_prompt，所以本命令刻意不暴露
// --steps/--guidance/--negative-prompt；请求体最小化为 { model, prompt, size, seed?, image_url? }。

// MiniMax 文档：prompt 上限 32000（按 Unicode 码点计）；本地预检比网关 400 更好读
export const H3_PROMPT_MAX = 32000;

// 实测网关（2026-11-12）：每边 [64,2048]，4096x4096 提交期 400 "width must be integer in [64,2048]"。
// 64 是两位数，格式正则下限放到 2 位，边界交给数值判断（run.mjs 的 3-4 位正则会误拒 64x64）
const H3_EDGE_MIN = 64;
const H3_EDGE_MAX = 2048;
const H3_SIZE_RE = /^\d{2,4}x\d{2,4}$/;

// 比例映射与兄弟命令同一张表：比例精确、每边 ≤2048、且都是 16 的倍数
export const H3_RATIOS = {
  "1:1": "2048x2048",
  "4:3": "2048x1536",
  "3:4": "1536x2048",
  "3:2": "2016x1344",
  "2:3": "1344x2016",
  "16:9": "2048x1152",
  "9:16": "1152x2048",
};

export function parseH3Size(size) {
  if (typeof size !== "string" || !H3_SIZE_RE.test(size)) {
    throw cliError("E_INVALID_OPTION", `--size 格式非法：${size}（WxH 字符串，如 1024x1024）`, {
      option: "--size",
      value: size,
    });
  }
  const [width, height] = size.split("x").map(Number);
  for (const [edge, name] of [
    [width, "width"],
    [height, "height"],
  ]) {
    if (edge === 4096) {
      throw cliError(
        "E_INVALID_OPTION",
        `--size 的 ${name} 不能是 4096：ModelScope API-Inference 每边上限 2048（实测 4096x4096 直接 HTTP 400 "width must be integer in [64,2048]"）；4K 出图请改用 MiniMax 官方 API 的 minimax-image 命令`,
        { option: "--size", value: size },
      );
    }
    if (edge < H3_EDGE_MIN || edge > H3_EDGE_MAX) {
      throw cliError(
        "E_INVALID_OPTION",
        `--size 的 ${name} 必须在 ${H3_EDGE_MIN}–${H3_EDGE_MAX} 之间（ModelScope API-Inference 实测边界；4K 请用 minimax-image），得到 ${size}`,
        { option: "--size", value: size },
      );
    }
  }
  return size;
}

export function sizeFromH3Ratio(ratio) {
  const size = H3_RATIOS[ratio];
  if (size === undefined) {
    throw cliError(
      "E_INVALID_OPTION",
      `--ratio 只支持 ${Object.keys(H3_RATIOS).join(" | ")}，得到 ${ratio}`,
      { option: "--ratio", value: ratio },
    );
  }
  return size;
}

// 必填 + 长度都在本地拦：空 prompt 是 E_MISSING_ARGUMENT（非交互，绝不挂起）
export function assertH3Prompt(prompt) {
  if (typeof prompt !== "string" || prompt.trim() === "") {
    throw cliError("E_MISSING_ARGUMENT", "缺少必填 --prompt", { option: "--prompt" });
  }
  const actual = Array.from(prompt).length;
  if (actual > H3_PROMPT_MAX) {
    throw cliError(
      "E_INVALID_OPTION",
      `--prompt 超过 ${H3_PROMPT_MAX} 字符（MiniMax 文档上限，按 Unicode 码点计），得到 ${actual} 字符`,
      { option: "--prompt", limit: H3_PROMPT_MAX, actual },
    );
  }
}

// --model > MODELSCOPE_H3_MODEL > 内置 MiniMax/MiniMax-H3-Image（与兄弟命令同一优先级）
export function resolveH3Model(args, config) {
  const fromEnv = (config[MODEL_CONFIG_FIELD[H3_DEFAULTS.modelVar]] ?? "").trim();
  return args.model ?? (fromEnv === "" ? H3_DEFAULTS.modelFallback : fromEnv);
}

// 本地文件 → data URI 的机制与 modelscope-image-edit 完全一致（lib/refs.mjs）：
// http(s) 原样透传，其他 scheme 本地拒。注意：data URI 参考图在 H3 网关尚未实测
// （同一网关的 Qwen-Image-Edit 实测会被真实消费），保持与 edit 同一形态。
async function collectRefs(value, cwd) {
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0) {
    throw cliError("E_INVALID_OPTION", "--ref 至少需要一项", { option: "--ref" });
  }
  if (list.length > H3_DEFAULTS.refMax) {
    throw cliError(
      "E_INVALID_OPTION",
      `--ref 最多 ${H3_DEFAULTS.refMax} 张参考图（MiniMax-H3-Image 图片编辑上限），得到 ${list.length} 张`,
      { option: "--ref", value: list.length, max: H3_DEFAULTS.refMax },
    );
  }
  return Promise.all(list.map((item) => resolveRef(item, "--ref", cwd)));
}

// 与 run.mjs 同一口径：从结果 URL 推断扩展名，b64/无扩展名时回落 png
function extensionFor(ref, fallback) {
  const match = /\.(png|jpe?g|webp)(?=$|[?#])/i.exec(ref.url ?? "");
  if (match) return match[1].toLowerCase().replace("jpg", "jpeg");
  return fallback;
}

export async function runH3Image(ctx, args) {
  // 全部本地校验（prompt/size/seed/参考图读取）先于 loadConfig 与任何网络请求
  assertH3Prompt(args.prompt);
  if (args.size !== undefined && args.ratio !== undefined) {
    throw cliError("E_INVALID_OPTION", "--size 与 --ratio 二选一", {
      option: "--ratio",
      value: args.ratio,
    });
  }
  const size = parseH3Size(
    args.size ?? (args.ratio === undefined ? H3_DEFAULTS.sizeDefault : sizeFromH3Ratio(args.ratio)),
  );
  const seed =
    args.seed === undefined
      ? undefined
      : parseNumberOption(args.seed, "--seed", { min: 0, max: 2147483647, integer: true });
  const refUrls = args.ref === undefined ? undefined : await collectRefs(args.ref, ctx.cwd);

  const config = loadConfig();
  const model = resolveH3Model(args, config);

  // generateImage 对 undefined 的 steps/guidance/negative_prompt 不发字段；
  // 单图 image_url 传字符串、多图传数组，无参考图时整字段省略
  const result = await generateImage(config, {
    model,
    prompt: args.prompt,
    size,
    seed,
    refUrls,
  });

  const buf = await fetchImageBytes(config, result);
  const output = path.resolve(
    ctx.cwd,
    args.output ??
      `${H3_DEFAULTS.filePrefix}${new Date().toISOString().replace(/[:.]/g, "-")}.${extensionFor(result, "png")}`,
  );
  const parent = await stat(path.dirname(output)).catch(() => null);
  if (!parent?.isDirectory()) {
    throw cliError("E_INVALID_OPTION", `输出目录不存在：${path.dirname(output)}`, {
      option: "--output",
      value: output,
    });
  }
  await writeFile(output, buf);
  ctx.logger.info(`已写入 ${output}`);

  // 契约以真实像素为准：请求尺寸与实际不符给结构化警告（同 run.mjs 口径）
  const meta = await sharp(buf)
    .metadata()
    .catch(() => ({}));
  const actual =
    typeof meta.width === "number" && typeof meta.height === "number"
      ? `${meta.width}x${meta.height}`
      : undefined;
  if (actual !== undefined && actual !== size) {
    ctx.warnings.add({
      code: "E_SIZE_MISMATCH",
      message: `模型未按请求尺寸出图：请求 ${size}，实际 ${actual}`,
      plugin: "modelscope-image",
    });
  }

  return {
    path: output,
    bytes: buf.length,
    model,
    size: actual ?? size,
    keyIndex: result.keyIndex,
    // data URI 一律压成摘要（base64 原文绝不进 stdout），与 run.mjs 的 data 契约一致
    ...(refUrls === undefined ? {} : { refUrls: summarizeRefs(refUrls), refCount: refUrls.length }),
    ...(result.url !== undefined ? { sourceUrl: result.url } : {}),
    ...(result.taskId !== undefined ? { taskId: result.taskId } : {}),
  };
}
