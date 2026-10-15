import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { fetchImageBytes, generateImage } from "./client.mjs";
import { MODEL_CONFIG_FIELD, REF_MAX_GENERATION } from "./defaults.mjs";
import { loadConfig } from "./env.mjs";
import { cliError } from "./errors.mjs";
import { resolveRef, summarizeRefs } from "./refs.mjs";

// 三条命令的 defaults 拆到 lib/defaults.mjs（AGENTS.md §6 的 300 行红线）；
// 此处再导出，`index.mjs` 与既有测试的引用路径不变
export {
  EDIT_DEFAULTS,
  FAST_DEFAULTS,
  GEN_DEFAULTS,
  MODEL_CONFIG_FIELD,
  REF_MAX_EDIT,
  REF_MAX_GENERATION,
} from "./defaults.mjs";

const SIZE_RE = /^\d{3,4}x\d{3,4}$/;

// 实测网关：每边 [64, 2048]（超界在提交期即 400，如 "width must be integer in [64,2048]"）。
// Qwen-Image-2.1 卡片推荐的 2400/2528/2752 长边是本地 diffusers 管线，经网关会被拒
const EDGE_MIN = 64;
const EDGE_MAX = 2048;

// steps 上限从文档的 100 收紧到 50：官方文档写 [1,100]，但 Qwen/Qwen-Image-2.1 与
// Qwen/Qwen-Image-Edit 的网关都只收 [1,50]（实测提交期 400 原文 `steps must be in [1,50]`）。
// 本地按 50 拦，用户传 --steps 80 拿到清楚的 E_INVALID_OPTION，而不是白跑一次提交吃 400
export const STEPS_MAX = 50;
export const GUIDANCE_MAX = 20;

// 实测网关硬拦 prompt 长度：4001 字符被拒（"invalid prompt or prompt length more than 4000"），
// base 2.1 与 Turbo 同一规则（网关级校验，与模型无关）。按字符计不按字节：
// 4000 个汉字（=12000 UTF-8 字节）实测可通过，所以这里数的是字符而不是字节。
// 本地预检省额度，且错误比网关的 400 更好读（D26）
export const PROMPT_MAX = 4000;

// 卡片 7 个比例映射到网关可用尺寸：比例精确、每边 ≤2048、且都是 16 的倍数
export const RATIOS = {
  "1:1": "2048x2048",
  "4:3": "2048x1536",
  "3:4": "1536x2048",
  "3:2": "2016x1344",
  "2:3": "1344x2016",
  "16:9": "2048x1152",
  "9:16": "1152x2048",
};

export function parseSize(size) {
  // 网关要求 "WxH"（实测 "928*1664" 会被拒：size format should be WxH）
  if (!SIZE_RE.test(size)) {
    throw cliError("E_INVALID_OPTION", `--size 格式非法：${size}（如 1024x1024）`, {
      option: "--size",
      value: size,
    });
  }
  const [width, height] = size.split("x").map(Number);
  for (const [edge, name] of [
    [width, "width"],
    [height, "height"],
  ]) {
    if (edge < EDGE_MIN || edge > EDGE_MAX) {
      throw cliError(
        "E_INVALID_OPTION",
        `--size 的 ${name} 必须在 ${EDGE_MIN}–${EDGE_MAX} 之间（网关实测边界），得到 ${size}`,
        { option: "--size", value: size },
      );
    }
  }
  return size;
}

export function sizeFromRatio(ratio) {
  const size = RATIOS[ratio];
  if (size === undefined) {
    throw cliError(
      "E_INVALID_OPTION",
      `--ratio 只支持 ${Object.keys(RATIOS).join(" | ")}，得到 ${ratio}`,
      { option: "--ratio", value: ratio },
    );
  }
  return size;
}

export function parseNumberOption(value, option, { min, max, integer = false }) {
  const num = Number(value);
  const ok = integer ? Number.isInteger(num) : Number.isFinite(num);
  if (!ok || num < min || num > max) {
    throw cliError(
      "E_INVALID_OPTION",
      `${option} 必须是${integer ? "整数" : "数"} ${min}–${max} 之间的值，得到：${value}`,
      { option, value },
    );
  }
  return num;
}

// 未传时回落到该命令的默认值（gen 的默认是 undefined，即「不发这个字段，交给 provider」）
function optionalNumber(value, fallback, option, range) {
  return value === undefined ? fallback : parseNumberOption(value, option, range);
}

export function assertPromptLength(prompt, limit = PROMPT_MAX) {
  // 按 Unicode 码点计数（汉字/常用标点各算 1），与网关实测的「4000 汉字可过」一致
  const actual = Array.from(prompt).length;
  if (actual > limit) {
    throw cliError(
      "E_INVALID_OPTION",
      `--prompt 超过 ${limit} 字符（网关实测硬拦 "prompt length more than ${limit}"），得到 ${actual} 字符`,
      { option: "--prompt", limit, actual },
    );
  }
}

function extensionFor(ref, fallback) {
  const match = /\.(png|jpe?g|webp)(?=$|[?#])/i.exec(ref.url ?? "");
  if (match) return match[1].toLowerCase().replace("jpg", "jpeg");
  return fallback;
}

// gen/fast 沿用：只接受已经是公网 URL 的地址，本地文件先用 tencent-cos-upload 换 URL
function parseRefUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw cliError("E_INVALID_OPTION", `--ref 必须是 http(s) 图片 URL：${value}`, {
      option: "--ref",
      value,
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw cliError("E_INVALID_OPTION", `--ref 协议必须是 http/https：${value}`, {
      option: "--ref",
      value,
    });
  }
  return value;
}

// commander 的 variadic 在只传一项时也可能给字符串，统一归一；张数上限本地先拦（省一次 400）
function refList(values, max) {
  const list = Array.isArray(values) ? values : [values];
  if (list.length === 0) {
    throw cliError("E_INVALID_OPTION", "--ref 至少需要一项", { option: "--ref" });
  }
  if (list.length > max) {
    throw cliError(
      "E_INVALID_OPTION",
      `--ref 最多 ${max} 张参考图，得到 ${list.length} 张（超出会被网关拒："image_url count exceeds maximum limit of ${max}"）`,
      { option: "--ref", value: list.length, max },
    );
  }
  return list;
}

// Qwen-Image-2.1 卡片：单次最多 10 张参考图，且只收公网 URL
export function parseRefUrls(values, max = REF_MAX_GENERATION) {
  return refList(values, max).map(parseRefUrl);
}

// Qwen/Qwen-Image-Edit：上限实测 4 张，且每项可以是本地文件（内联成 data URI，见 lib/refs.mjs）
export async function parseRefItems(values, max, cwd) {
  return Promise.all(refList(values, max).map((item) => resolveRef(item, "--ref", cwd)));
}

// 按该命令的 defaults 决定走哪条参考图路径；返回 undefined 表示本次不发 image_url（纯文生图）
async function collectRefs(value, defaults, cwd) {
  return defaults.localRefs
    ? parseRefItems(value, defaults.refMax, cwd)
    : parseRefUrls(value, defaults.refMax);
}

// --model > 对应环境变量 > 该命令的内置默认（gen 无默认，因此缺变量即 E_CONFIG）
function resolveModel(args, config, defaults) {
  const fromEnv = config[MODEL_CONFIG_FIELD[defaults.modelVar]] ?? "";
  const model = args.model ?? (fromEnv === "" ? defaults.modelFallback : fromEnv);
  if (model === "") {
    throw cliError("E_CONFIG", `缺少模型名：设置 ${defaults.modelVar} 或传 --model`, {
      var: defaults.modelVar,
    });
  }
  return model;
}

export async function runImageGen(ctx, args, defaults) {
  if (typeof args.prompt !== "string" || args.prompt.trim() === "") {
    throw cliError("E_MISSING_ARGUMENT", "缺少必填 --prompt", { option: "--prompt" });
  }
  assertPromptLength(args.prompt);
  if (args.size !== undefined && args.ratio !== undefined) {
    throw cliError("E_INVALID_OPTION", "--size 与 --ratio 二选一", {
      option: "--ratio",
      value: args.ratio,
    });
  }
  const size = parseSize(
    args.size ?? (args.ratio === undefined ? defaults.sizeDefault : sizeFromRatio(args.ratio)),
  );
  const steps = optionalNumber(args.steps, defaults.stepsDefault, "--steps", {
    min: 1,
    max: STEPS_MAX,
    integer: true,
  });
  const guidance = optionalNumber(args.guidance, defaults.guidanceDefault, "--guidance", {
    min: defaults.guidanceMin,
    max: GUIDANCE_MAX,
  });
  const seed = optionalNumber(args.seed, undefined, "--seed", {
    min: 0,
    max: 2147483647,
    integer: true,
  });
  // 本地文件的读取在这里发生（不发网络，也不碰配置），data URI 只进请求体
  const refUrls =
    args.ref === undefined ? undefined : await collectRefs(args.ref, defaults, ctx.cwd);

  // 配置校验必须先于任何网络请求
  const config = loadConfig();
  const model = resolveModel(args, config, defaults);

  const result = await generateImage(config, {
    model,
    prompt: args.prompt,
    size,
    negativePrompt: args.negativePrompt,
    steps,
    guidance,
    seed,
    refUrls,
  });

  const buf = await fetchImageBytes(config, result);
  const output = path.resolve(
    ctx.cwd,
    args.output ??
      `${defaults.filePrefix}${new Date().toISOString().replace(/[:.]/g, "-")}.${extensionFor(result, "png")}`,
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

  // 个别部署可能按自身档位调整分辨率：契约以真实像素为准，偏差给结构化警告
  const requested = size;
  const meta = await sharp(buf)
    .metadata()
    .catch(() => ({}));
  const actual =
    typeof meta.width === "number" && typeof meta.height === "number"
      ? `${meta.width}x${meta.height}`
      : undefined;
  if (actual !== undefined && actual !== requested) {
    ctx.warnings.add({
      code: "E_SIZE_MISMATCH",
      message: `模型未按请求尺寸出图：请求 ${requested}，实际 ${actual}`,
      plugin: "modelscope-image",
    });
  }

  return {
    path: output,
    bytes: buf.length,
    model,
    size: actual ?? requested,
    keyIndex: result.keyIndex,
    // 回显顺序与传入一致；data URI 一律压成摘要（base64 原文绝不进 stdout）
    ...(refUrls === undefined ? {} : { refUrls: summarizeRefs(refUrls), refCount: refUrls.length }),
    ...(result.url !== undefined ? { sourceUrl: result.url } : {}),
    ...(result.taskId !== undefined ? { taskId: result.taskId } : {}),
  };
}
