import { downloadBytes } from "./client.mjs";
import { loadConfig } from "./env.mjs";
import { cliError } from "./errors.mjs";
import { generateImage } from "./image.mjs";
import {
  actualPixels,
  loadSharp,
  resolveOutputPath,
  summarizeRefs,
  writeResult,
} from "./output.mjs";
import { withRetryProgress } from "./progress.mjs";
import { assertCount, assertPublicUrls, resolveRef, splitRefs } from "./refs.mjs";
import { pollVideo, submitVideo } from "./video.mjs";

// 以下限制全部来自实测（§1.1/§1.2）。本地预检的意义：省额度 + 错误比 provider 的 400 更好读（D26）
const IMAGE_TIERS = ["1K", "2K", "3K", "4K"];
const IMAGE_WXH_RE = /^\d{3,4}x\d{3,4}$/;
const IMAGE_RATIOS = ["1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"];
const IMAGE_PROMPT_MAX = 10000;
const IMAGE_REF_MAX = 6;
// 实测显式 WxH 会被降采样（2048x1152 → 1312x736），所以默认走 4K 档拿最大尺寸（D21）
const IMAGE_DEFAULT_SIZE = "4K";
// 实测 response_format 合法值只有 url / b64_json，CLI 侧 --format b64 是它的别名
const IMAGE_FORMATS = { url: "url", b64: "b64_json" };

const VIDEO_SIZES = ["720P"];
const VIDEO_RATIOS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
const VIDEO_MODES = ["text", "keyframe", "reference"];
const VIDEO_SECONDS = { min: 4, max: 12 };
const VIDEO_IMAGES_MAX = 5;
const VIDEO_AUDIOS_MAX = 3;

function requireText(value, option) {
  if (typeof value !== "string" || value.trim() === "") {
    throw cliError("E_MISSING_ARGUMENT", `缺少必填 ${option}`, { option });
  }
  return value;
}

function parseChoice(value, option, allowed) {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw cliError("E_INVALID_OPTION", `${option} 只支持 ${allowed.join(" | ")}，得到：${value}`, {
      option,
      value,
    });
  }
  return value;
}

function parseIntegerOption(value, option, { min, max }) {
  const num = Number(value);
  if (!Number.isInteger(num) || num < min || num > max) {
    throw cliError(
      "E_INVALID_OPTION",
      `${option} 必须是 ${min}–${max} 之间的整数，得到：${value}`,
      { option, value },
    );
  }
  return num;
}

// 实测超限 400 "prompt exceeds 10000 characters"，按字符数计（不是字节）本地预检
function assertPromptLength(prompt, limit) {
  if (prompt.length > limit) {
    throw cliError(
      "E_INVALID_OPTION",
      `--prompt 超过 ${limit} 字符（provider 实测上限），得到 ${prompt.length} 字符`,
      { option: "--prompt", limit, actual: prompt.length },
    );
  }
}

/** 档位（1K–4K）与显式 WxH 两种形态；非法值（如 8K）本地即拒。tier=false 表示 WxH 形态 */
export function parseImageSize(value) {
  const raw = String(value);
  if (IMAGE_TIERS.includes(raw)) return { size: raw, tier: true };
  if (IMAGE_WXH_RE.test(raw)) return { size: raw, tier: false };
  throw cliError(
    "E_INVALID_OPTION",
    `--size 只支持 ${IMAGE_TIERS.join(" | ")} 或 WIDTHxHEIGHT（如 1024x1024），得到：${raw}`,
    { option: "--size", value: raw },
  );
}

function parseImageFormat(value) {
  const wire = IMAGE_FORMATS[String(value)];
  if (wire === undefined) {
    throw cliError("E_INVALID_OPTION", `--format 只支持 url | b64，得到：${value}`, {
      option: "--format",
      value,
    });
  }
  return wire;
}

// video 素材只收公网 URL：本地路径在这里给出「先上传」的可执行指引（D20）
function publicUrlOption(value, option) {
  if (value === undefined) return undefined;
  return assertPublicUrls([String(value)], option)[0];
}

function inferVideoMode(args, { images, audios, firstFrame }) {
  if (args.mode !== undefined) return parseChoice(args.mode, "--mode", VIDEO_MODES);
  if (firstFrame !== undefined) return "keyframe";
  if (images.length > 0 || audios.length > 0) return "reference";
  return "text";
}

export async function agnesImage(ctx, args) {
  const prompt = requireText(args.prompt, "--prompt");
  assertPromptLength(prompt, IMAGE_PROMPT_MAX);
  const requested = args.size ?? IMAGE_DEFAULT_SIZE;
  const { size, tier } = parseImageSize(requested);
  const givenRatio =
    args.ratio === undefined ? undefined : parseChoice(args.ratio, "--ratio", IMAGE_RATIOS);
  if (!tier && givenRatio !== undefined) {
    throw cliError(
      "E_INVALID_OPTION",
      "--size 传 WxH 时不能再传 --ratio（比例已含在 WxH 里），二者二选一",
      { option: "--ratio", value: args.ratio },
    );
  }
  // 实测：ratio 只在 size 是档位时有意义
  const ratio = tier ? (givenRatio ?? "1:1") : undefined;
  const format = args.format === undefined ? "url" : parseImageFormat(args.format);
  const refValues = splitRefs(args.ref);
  assertCount(refValues, "--ref", IMAGE_REF_MAX);
  const refs = await Promise.all(refValues.map((item) => resolveRef(item, "--ref", ctx.cwd)));

  // sharp 与输出目录都在发请求前就位：缺原生依赖/输出目录不存在不该花掉一次生成额度
  const sharp = await loadSharp();
  const output = await resolveOutputPath({
    output: args.output,
    cwd: ctx.cwd,
    prefix: "agnes",
    ext: "png",
  });

  // 配置校验必须先于任何网络请求
  const config = loadConfig();
  const model = args.model ?? config.imageModel;
  // 实测单张图要 7 次提交 / 200 秒才排空队列：重试进度必须经 withRetryProgress 变成
  // envelope 的 warnings[]，否则 --json 的调用方（AI/管道）看到的就是空输出（B4）
  const result = await withRetryProgress(ctx, (progress) =>
    generateImage(config, {
      model,
      prompt,
      size,
      ratio,
      refs,
      format,
      logger: ctx.logger,
      progress,
      deadline: Date.now() + config.timeoutMs,
    }),
  );

  const written = await writeResult(result.bytes, output);
  ctx.logger.info(`已写入 ${written.path}（${written.bytes} 字节）`);
  const actual = await actualPixels(sharp, result.bytes);
  // 档位模式的期望像素依赖 provider 的 ratio/16 对齐规则，本地推不出来 → 只如实写实测像素
  if (!tier && actual !== undefined && actual !== requested) {
    ctx.warnings.add({
      code: "E_SIZE_MISMATCH",
      message: `模型未按请求尺寸出图：请求 ${requested}，实际 ${actual}（agnes 显式 WxH 会被降采样，要最大尺寸请用 4K 档）`,
      plugin: "agnes",
    });
  }
  const taskId = result.taskId;
  return {
    path: written.path,
    bytes: written.bytes,
    model,
    // 真实像素（sharp 解出），与 requested 一起回显便于排查降采样
    size: actual ?? requested,
    requested,
    ...(ratio === undefined ? {} : { ratio }),
    mode: refs.length > 0 ? "i2i" : "t2i",
    keyIndex: result.keyIndex,
    ...(taskId === undefined ? {} : { taskId }),
    ...(result.requestId === undefined ? {} : { requestId: result.requestId }),
    ...(refs.length === 0 ? {} : { refUrls: summarizeRefs(refs) }),
    ...(result.url === undefined ? {} : { sourceUrl: result.url }),
  };
}

export async function agnesVideo(ctx, args) {
  // prompt 长度上限**待实测**（§1.2），探测前只做非空校验，不做本地预检
  const prompt = requireText(args.prompt, "--prompt");
  const size = parseChoice(args.size ?? "720P", "--size", VIDEO_SIZES);
  const seconds = parseIntegerOption(args.seconds ?? 5, "--seconds", VIDEO_SECONDS);
  const aspectRatio = parseChoice(args.aspectRatio ?? "16:9", "--aspect-ratio", VIDEO_RATIOS);
  const images = assertCount(splitRefs(args.images), "--images", VIDEO_IMAGES_MAX);
  const audios = assertCount(splitRefs(args.audios), "--audios", VIDEO_AUDIOS_MAX);
  assertPublicUrls(images, "--images");
  assertPublicUrls(audios, "--audios");
  const firstFrame = publicUrlOption(args.firstFrame, "--first-frame");
  const lastFrame = publicUrlOption(args.lastFrame, "--last-frame");
  const mode = inferVideoMode(args, { images, audios, firstFrame });
  if (mode === "keyframe" && (firstFrame === undefined || lastFrame === undefined)) {
    throw cliError("E_MISSING_ARGUMENT", "keyframe 模式必须成对给 --first-frame 与 --last-frame", {
      option: "--last-frame",
    });
  }
  if (mode === "reference" && images.length === 0 && audios.length === 0) {
    throw cliError("E_MISSING_ARGUMENT", "reference 模式至少要给 --images 或 --audios", {
      option: "--images|--audios",
    });
  }
  const seed =
    args.seed === undefined
      ? undefined
      : parseIntegerOption(args.seed, "--seed", { min: 0, max: 2147483647 });
  const waiting = args.wait !== false;
  const output = waiting
    ? await resolveOutputPath({
        output: args.output,
        cwd: ctx.cwd,
        prefix: "agnes-video",
        ext: "mp4",
      })
    : undefined;

  const config = loadConfig();
  const model = args.model ?? config.videoModel;
  const deadline = Date.now() + config.timeoutMs;
  const submitted = await withRetryProgress(ctx, (progress) =>
    submitVideo(config, {
      model,
      prompt,
      mode,
      seconds,
      size,
      aspectRatio,
      images,
      audios,
      firstFrame,
      lastFrame,
      seed,
      deadline,
      logger: ctx.logger,
      progress,
    }),
  );
  if (!waiting) {
    return {
      taskId: submitted.taskId,
      model,
      mode,
      seconds,
      size,
      aspectRatio,
      keyIndex: submitted.keyIndex,
      ...(submitted.requestId === undefined ? {} : { requestId: submitted.requestId }),
    };
  }

  const done = await withRetryProgress(ctx, (progress) =>
    pollVideo(config, {
      taskId: submitted.taskId,
      model,
      keyIndex: submitted.keyIndex,
      deadline,
      logger: ctx.logger,
      progress,
    }),
  );
  const bytes = await downloadBytes(config, done.url, "download");
  const written = await writeResult(bytes, output);
  ctx.logger.info(`已写入 ${written.path}（${written.bytes} 字节）`);
  return {
    path: written.path,
    bytes: written.bytes,
    model,
    taskId: submitted.taskId,
    mode,
    seconds,
    size,
    aspectRatio,
    status: done.status,
    sourceUrl: done.url,
    keyIndex: submitted.keyIndex,
    ...(done.requestId === undefined ? {} : { requestId: done.requestId }),
  };
}
