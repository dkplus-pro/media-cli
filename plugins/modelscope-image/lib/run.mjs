import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { fetchImageBytes, generateImage } from "./client.mjs";
import { DEFAULT_FAST_MODEL, loadConfig } from "./env.mjs";
import { cliError } from "./errors.mjs";

const SIZE_RE = /^\d{3,4}x\d{3,4}$/;

// 实测网关：每边 [64, 2048]（超界在提交期即 400，如 "width must be integer in [64,2048]"）。
// Qwen-Image-2.1 卡片推荐的 2400/2528/2752 长边是本地 diffusers 管线，经网关会被拒
const EDGE_MIN = 64;
const EDGE_MAX = 2048;

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

// modelscope-image-gen 与 modelscope-image-fast 走同一条流程，全部差异收敛在这两份 defaults（§4.2）
export const GEN_DEFAULTS = {
  modelVar: "MODELSCOPE_IMAGE_MODEL",
  // 无内置默认模型：模型 id 按月变，缺 env 直接 E_CONFIG（与 doubao 的房子规则一致）
  modelFallback: "",
  stepsDefault: undefined,
  guidanceDefault: undefined,
  // 下限从 1.5 放宽到 1：网关实测 CFG=1 可用，而 1 正是 Turbo 的官方默认值（D25）
  guidanceMin: 1,
  sizeDefault: "1024x1024",
  filePrefix: "modelscope-",
};

export const FAST_DEFAULTS = {
  modelVar: "MODELSCOPE_FAST_MODEL",
  // 实测 Turbo 网关可直接调；模型页元数据 SupportApiInference=false 不可信（在用的 base 2.1 同样是 false）
  modelFallback: DEFAULT_FAST_MODEL,
  stepsDefault: 8,
  guidanceDefault: 1,
  guidanceMin: 1,
  // 用户要最大尺寸：实测 2048x2048 真出 2048x2048（每边网关上限就是 2048）
  sizeDefault: "2048x2048",
  filePrefix: "modelscope-fast-",
};

// defaults 里存的是环境变量名，而 loadConfig 已把变量读成 camelCase 字段，这里做一次映射
const MODEL_CONFIG_FIELD = {
  MODELSCOPE_IMAGE_MODEL: "model",
  MODELSCOPE_FAST_MODEL: "fastModel",
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

// 参考图只接受已经是公网 URL 的地址：本地文件先用 tencent-cos-upload 换 URL
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

// Qwen-Image-2.1 卡片：单次最多 10 张参考图
export function parseRefUrls(values) {
  const list = Array.isArray(values) ? values : [values];
  if (list.length === 0) {
    throw cliError("E_INVALID_OPTION", "--ref 至少需要一个 URL", { option: "--ref" });
  }
  if (list.length > 10) {
    throw cliError("E_INVALID_OPTION", `--ref 最多 10 张参考图，得到 ${list.length} 张`, {
      option: "--ref",
      value: list.length,
    });
  }
  return list.map(parseRefUrl);
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
    max: 100,
    integer: true,
  });
  const guidance = optionalNumber(args.guidance, defaults.guidanceDefault, "--guidance", {
    min: defaults.guidanceMin,
    max: 20,
  });
  const seed = optionalNumber(args.seed, undefined, "--seed", {
    min: 0,
    max: 2147483647,
    integer: true,
  });
  const refUrls = args.ref === undefined ? undefined : parseRefUrls(args.ref);

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
    ...(refUrls === undefined ? {} : { refUrls }),
    ...(result.url !== undefined ? { sourceUrl: result.url } : {}),
    ...(result.taskId !== undefined ? { taskId: result.taskId } : {}),
  };
}
