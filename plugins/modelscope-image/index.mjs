import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { fetchImageBytes, generateImage } from "./lib/client.mjs";
import { loadConfig } from "./lib/env.mjs";
import { cliError } from "./lib/errors.mjs";

const SIZE_RE = /^\d{3,4}x\d{3,4}$/;

function parseSize(size) {
  // 网关要求 "WxH"（实测 "928*1664" 会被拒：size format should be WxH）
  if (!SIZE_RE.test(size)) {
    throw cliError("E_INVALID_OPTION", `--size 格式非法：${size}（如 1024x1024）`, {
      option: "--size",
      value: size,
    });
  }
  return size;
}

function parseNumberOption(value, option, { min, max, integer = false }) {
  const num = Number(value);
  const ok = integer ? Number.isInteger(num) : Number.isFinite(num);
  if (!ok || num < min || num > max) {
    throw cliError(
      `E_INVALID_OPTION`,
      `${option} 必须是${integer ? "整数" : "数"} ${min}–${max} 之间的值，得到：${value}`,
      { option, value },
    );
  }
  return num;
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

async function modelscopeImageGen(ctx, args) {
  if (typeof args.prompt !== "string" || args.prompt.trim() === "") {
    throw cliError("E_MISSING_ARGUMENT", "缺少必填 --prompt", { option: "--prompt" });
  }
  const size = parseSize(args.size ?? "1024x1024");
  const steps =
    args.steps === undefined
      ? undefined
      : parseNumberOption(args.steps, "--steps", { min: 1, max: 100, integer: true });
  const guidance =
    args.guidance === undefined
      ? undefined
      : parseNumberOption(args.guidance, "--guidance", { min: 1.5, max: 20 });
  const seed =
    args.seed === undefined
      ? undefined
      : parseNumberOption(args.seed, "--seed", {
          min: 0,
          max: 2147483647,
          integer: true,
        });
  const imageUrl = args.ref === undefined ? undefined : parseRefUrl(args.ref);

  // 配置校验必须先于任何网络请求
  const config = loadConfig();
  const model = args.model ?? config.model;
  if (model === "") {
    throw cliError("E_CONFIG", "缺少模型名：设置 MODELSCOPE_IMAGE_MODEL 或传 --model", {
      var: "MODELSCOPE_IMAGE_MODEL",
    });
  }

  const result = await generateImage(config, {
    model,
    prompt: args.prompt,
    size,
    negativePrompt: args.negativePrompt,
    steps,
    guidance,
    seed,
    imageUrl,
  });

  const buf = await fetchImageBytes(config, result);
  const output = path.resolve(
    ctx.cwd,
    args.output ??
      `modelscope-${new Date().toISOString().replace(/[:.]/g, "-")}.${extensionFor(result, "png")}`,
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
    ...(imageUrl === undefined ? {} : { refUrl: imageUrl }),
    ...(result.url !== undefined ? { sourceUrl: result.url } : {}),
    ...(result.taskId !== undefined ? { taskId: result.taskId } : {}),
  };
}

export default {
  name: "modelscope-image",
  version: "0.1.0",
  commands: [
    {
      name: "modelscope-image-gen",
      description:
        "ModelScope API-Inference 生图（Qwen-Image 系列，--model 默认取 MODELSCOPE_IMAGE_MODEL）",
      options: [
        { flags: "--prompt <text>", description: "生图文案" },
        {
          flags: "--model <id>",
          description: "模型 id（默认取 MODELSCOPE_IMAGE_MODEL，如 Qwen/Qwen-Image-2.1）",
        },
        {
          flags: "--size <WxH>",
          description: "尺寸，WxH 字符串（默认 1024x1024；Qwen-Image 档位上限 1664x1664）",
        },
        { flags: "--steps <n>", description: "采样步数（可选，1-100）" },
        { flags: "--guidance <n>", description: "提示词引导系数（可选，1.5-20）" },
        { flags: "--seed <n>", description: "随机种子（可选，0-2147483647，同 seed 可复现）" },
        { flags: "--negative-prompt <text>", description: "负向提示词（可选）" },
        {
          flags: "--ref <url>",
          description:
            "参考图公网 URL（可选，走图生图/编辑；本地文件先用 tencent-cos-upload 换 URL）",
        },
        {
          flags: "--output <path>",
          description: "输出图片路径（默认 ./modelscope-<时间戳>.<扩展名>）",
        },
      ],
      handler: modelscopeImageGen,
    },
  ],
};
