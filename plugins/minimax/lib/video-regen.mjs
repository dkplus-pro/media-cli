import { outputPathOf, writeOutput } from "./audio.mjs";
import { loadConfig, parseNumberOption } from "./config.mjs";
import { cliError } from "./errors.mjs";
import { resolveBaseVideo } from "./video-media.mjs";
import { createVideoTask, downloadVideoFile, hasValue, pollVideoTask } from "./video-task.mjs";

// minimax-video-regen：把 MiniMax-H3 产出的 768P 成片再生成升为 2K。
// 走 POST /v2/video_regeneration（与生成共用查询/取消端点），两种入参二选一：
//   1) --source-task-id：按平台已有的 768P 成功任务 ID 再生（服务端自动回填 prompt/素材；
//      限制：当前账号、7 天内、status=succeeded、resolution=768P）
//   2) --base-video + --prompt：按源视频 URL/本地文件再生（content 里必须恰好一个 role=base_video）
// resolution 固定 2K（provider 当前仅支持这一档），ratio/duration 跟随源视频，均不传。
// 与生成共用任务生命周期，差异只有端点路径与 source 标签。
const REGEN_PATH = "/v2/video_regeneration";
const SOURCE = "minimax-video-regen";
const DEFAULT_REGEN_MODEL = "MiniMax-H3";
const REGEN_RESOLUTION = "2K";
const MAX_TEXT_CHARS = 7_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 900_000;

function optionalText(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function parseRegenParams(args = {}, config = {}) {
  const sourceTaskId = optionalText(args.sourceTaskId);
  const baseVideo = optionalText(args.baseVideo);
  const prompt = optionalText(args.prompt);

  if (sourceTaskId === undefined && baseVideo === undefined) {
    throw cliError("E_MISSING_ARGUMENT", "缺少 --source-task-id 或 --base-video（二选一）", {
      option: "--source-task-id",
    });
  }
  if (sourceTaskId !== undefined && baseVideo !== undefined) {
    throw cliError(
      "E_INVALID_OPTION",
      "--source-task-id 与 --base-video 二选一（provider 不接受同时传 source_task_id 与 content.base_video）",
      { option: "--source-task-id", reason: "mutually_exclusive" },
    );
  }

  const method = sourceTaskId === undefined ? "base_video" : "source_task_id";
  if (method === "source_task_id" && prompt !== undefined) {
    throw cliError(
      "E_INVALID_OPTION",
      "--source-task-id 模式服务端自动回填 prompt/素材，不要再传 --prompt（要自定义输入请改用 --base-video）",
      { option: "--prompt", method },
    );
  }
  if (method === "base_video") {
    if (prompt === undefined) {
      throw cliError("E_MISSING_ARGUMENT", "缺少必填 --prompt（--base-video 模式必须给 text 项）", {
        option: "--prompt",
      });
    }
    if (prompt.length > MAX_TEXT_CHARS) {
      throw cliError(
        "E_INVALID_OPTION",
        `--prompt 超过 provider 的 ${MAX_TEXT_CHARS} 字符上限：当前 ${prompt.length}（实测原文 "content[0].text too long"）`,
        { option: "--prompt", value: prompt.length, max: MAX_TEXT_CHARS },
      );
    }
  }

  const model =
    optionalText(args.model) ?? optionalText(config.videoRegenModel) ?? DEFAULT_REGEN_MODEL;

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
    method,
    model,
    resolution: REGEN_RESOLUTION,
    ...(sourceTaskId === undefined ? {} : { sourceTaskId }),
    ...(baseVideo === undefined ? {} : { baseVideo }),
    ...(prompt === undefined ? {} : { prompt }),
    ...(args.aigcWatermark === true ? { aigcWatermark: true } : {}),
    pollIntervalMs,
    timeoutMs,
  };
}

// baseVideoMedia 只在 method=base_video 时给出（见 resolveBaseVideo）
export function buildRegenBody(input, baseVideoMedia) {
  const body = { model: input.model, resolution: input.resolution };
  if (input.method === "source_task_id") {
    body.source_task_id = input.sourceTaskId;
  } else {
    body.content = [
      { type: "text", text: input.prompt },
      { type: "video_url", video_url: { url: baseVideoMedia.url }, role: "base_video" },
    ];
  }
  if (input.aigcWatermark === true) body.aigc_watermark = true;
  return body;
}

export async function runVideoRegen(ctx, args) {
  const config = loadConfig();
  const input = parseRegenParams(args, config);
  // 源视频在提交任务前读完并预检：内联/格式问题不该白建一次任务
  const baseVideo =
    input.method === "base_video" ? await resolveBaseVideo(input.baseVideo, ctx.cwd) : undefined;
  const deadline = Date.now() + input.timeoutMs;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const defaultName = `minimax-video-regen-${stamp}.mp4`;
  // 输出目录先预检：路径问题在提交任务前失败，不白烧额度
  await outputPathOf(ctx, args.output, defaultName);

  const taskId = await createVideoTask(config, {
    source: SOURCE,
    path: REGEN_PATH,
    body: buildRegenBody(input, baseVideo),
    deadline,
  });
  ctx.logger.info(`minimax-video-regen 任务已提交：${taskId}（再生 2K，轮询中）`);

  const { task, url } = await pollVideoTask(config, {
    source: SOURCE,
    taskId,
    pollIntervalMs: input.pollIntervalMs,
    deadline,
  });
  const buf = await downloadVideoFile(config, { source: SOURCE, url, taskId, deadline });
  const output = await writeOutput(ctx, args.output, defaultName, buf);

  return {
    path: output,
    bytes: buf.length,
    model: input.model,
    method: input.method,
    taskId,
    resolution: input.resolution,
    ...(input.sourceTaskId === undefined ? {} : { sourceTaskId: input.sourceTaskId }),
    // 只回字节摘要：内联 base64 绝不进 stdout
    ...(baseVideo === undefined ? {} : { baseVideo: baseVideo.summary }),
    ...(hasValue(task.created_at) ? { createdAt: task.created_at } : {}),
    ...(hasValue(task.updated_at) ? { updatedAt: task.updated_at } : {}),
    ...(hasValue(task.usage) ? { usage: task.usage } : {}),
  };
}
