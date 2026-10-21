import { DEFAULT_VIDEO_MODEL, parseNumberOption } from "./config.mjs";
import { cliError } from "./errors.mjs";
import { detectMediaMode } from "./video-media.mjs";

// minimax-video 的参数解析与请求体构造（从 lib/video.mjs 拆出：该文件已到 300 行硬线）。
//
// content[] 三种场景（实测）：t2v 只允许一个非空 text；i2v 用 first_frame/last_frame；
// r2v 用 reference_image/reference_video/reference_audio。帧角色与参考角色互斥。
// ratio 按场景分档（官方 + 实测）：t2v 必填且不许 adaptive；i2v 恒为 adaptive（传具体比例
// 不报错但被静默忽略，所以这里直接钉成 adaptive 并给显式传值一条警告）；r2v 可选、默认 adaptive。
const RATIOS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
const PROMPT_EXPANSION = ["disabled", "balanced", "quality"];
const MAX_TEXT_CHARS = 7_000;
const VIDEO_MODELS = {
  "MiniMax-H3": { durationMin: 4, durationMax: 15, resolutions: ["768P", "2K"] },
  "MiniMax-H3-Max": { durationMin: 5, durationMax: 15, resolutions: ["480P", "768P"] },
};
const DEFAULT_DURATION_SEC = 5;
const DEFAULT_RESOLUTION = "768P";
const DEFAULT_RATIO = "16:9";
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 900_000;

function optionalText(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

// ratio 按场景分档；i2v 恒为 adaptive（官方：传具体比例不报错但被忽略）
function resolveRatio(mode, rawRatio) {
  if (mode === "i2v") return "adaptive";
  const ratio = rawRatio ?? (mode === "r2v" ? "adaptive" : DEFAULT_RATIO);
  if (ratio === "adaptive") {
    if (mode === "t2v") {
      throw cliError(
        "E_INVALID_OPTION",
        "--ratio adaptive 仅在有图片/视频/音频输入时可用（纯文生视频必须指定具体比例）",
        { option: "--ratio", value: ratio, mode },
      );
    }
    return ratio;
  }
  if (!RATIOS.includes(ratio)) {
    throw cliError(
      "E_INVALID_OPTION",
      `--ratio 仅支持 ${RATIOS.join(" | ")}${mode === "t2v" ? "（t2v 不支持 adaptive）" : " 或 adaptive"}（得到 ${ratio}）`,
      { option: "--ratio", value: ratio, mode },
    );
  }
  return ratio;
}

export function parseVideoParams(args = {}, config = {}) {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (prompt === "") {
    throw cliError("E_MISSING_ARGUMENT", "缺少必填 --prompt", { option: "--prompt" });
  }
  if (prompt.length > MAX_TEXT_CHARS) {
    throw cliError(
      "E_INVALID_OPTION",
      `--prompt 超过 provider 的 ${MAX_TEXT_CHARS} 字符上限：当前 ${prompt.length}（实测原文 "content[0].text too long"）`,
      { option: "--prompt", value: prompt.length, max: MAX_TEXT_CHARS },
    );
  }

  const model = optionalText(args.model) ?? optionalText(config.videoModel) ?? DEFAULT_VIDEO_MODEL;
  const spec = VIDEO_MODELS[model];
  if (spec === undefined) {
    throw cliError(
      "E_INVALID_OPTION",
      `--model 仅支持 ${Object.keys(VIDEO_MODELS).join(" | ")}（得到 ${model}）`,
      { option: "--model", value: model },
    );
  }

  const durationSec = parseNumberOption(args.duration, "--duration", {
    min: spec.durationMin,
    max: spec.durationMax,
    integer: true,
    fallback: DEFAULT_DURATION_SEC,
  });

  const rawResolution = optionalText(args.resolution);
  const resolution = (rawResolution ?? DEFAULT_RESOLUTION).toUpperCase();
  if (!spec.resolutions.includes(resolution)) {
    throw cliError(
      "E_INVALID_OPTION",
      `${model} 的 --resolution 仅支持 ${spec.resolutions.join(" | ")}（得到 ${rawResolution ?? resolution}）`,
      { option: "--resolution", value: rawResolution ?? resolution },
    );
  }

  const mode = detectMediaMode(args);
  const rawRatio = optionalText(args.ratio);
  const ratio = resolveRatio(mode, rawRatio);

  // extra 与 H3 不兼容（实测原文 "param 'extra' incompatible with model MiniMax-H3"），
  // 且枚举只认 disabled|balanced|quality——文档还特别警告不要传 "balance"
  const promptExpansion = optionalText(args.promptExpansion);
  if (promptExpansion !== undefined) {
    if (!PROMPT_EXPANSION.includes(promptExpansion)) {
      throw cliError(
        "E_INVALID_OPTION",
        `--prompt-expansion 仅支持 ${PROMPT_EXPANSION.join(" | ")}（得到 ${promptExpansion}）`,
        { option: "--prompt-expansion", value: promptExpansion },
      );
    }
    if (model !== "MiniMax-H3-Max") {
      throw cliError(
        "E_INVALID_OPTION",
        `--prompt-expansion 仅 MiniMax-H3-Max 支持（${model} 传 extra 会被拒："param 'extra' incompatible with model ${model}"）`,
        { option: "--prompt-expansion", value: promptExpansion, model },
      );
    }
  }

  const pollIntervalMs = parseNumberOption(
    args.pollInterval ?? args.pollIntervalMs,
    "--poll-interval",
    { min: 1, integer: true, fallback: DEFAULT_POLL_INTERVAL_MS },
  );
  const timeoutMs = parseNumberOption(args.timeout, "--timeout", {
    min: 1,
    integer: true,
    fallback: DEFAULT_TIMEOUT_MS,
  });

  return {
    model,
    prompt,
    durationSec,
    resolution,
    ratio,
    mode,
    // i2v 下用户显式传了具体比例：会被 provider 静默忽略，交给 runVideo 发警告
    ratioIgnored: mode === "i2v" && rawRatio !== undefined && rawRatio !== "adaptive",
    ...(promptExpansion === undefined ? {} : { promptExpansion }),
    ...(args.aigcWatermark === true ? { aigcWatermark: true } : {}),
    pollIntervalMs,
    timeoutMs,
  };
}

// 无媒体输入时请求体与 media-31 逐字段一致（不会多出 aigc_watermark / extra 这类键）
export function buildVideoBody(input, media = { content: [] }) {
  return {
    model: input.model,
    content: [{ type: "text", text: input.prompt }, ...media.content],
    resolution: input.resolution,
    duration: input.durationSec ?? input.duration,
    ratio: input.ratio,
    ...(input.aigcWatermark === true ? { aigc_watermark: true } : {}),
    ...(input.promptExpansion === undefined
      ? {}
      : { extra: { prompt_expansion_mode: input.promptExpansion } }),
  };
}
