import { setTimeout as sleep } from "node:timers/promises";
import { outputPathOf, writeOutput } from "./audio.mjs";
import { assertBaseResp, clipText, requestJson, scrubKey } from "./client.mjs";
import { DEFAULT_VIDEO_MODEL, loadConfig, parseNumberOption } from "./config.mjs";
import { cliError } from "./errors.mjs";

// 纯文生视频：ratio 不接受 adaptive；两个型号的 duration/resolution 白名单不同
const RATIOS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
const VIDEO_MODELS = {
  "MiniMax-H3": { durationMin: 4, durationMax: 15, resolutions: ["768P", "2K"] },
  "MiniMax-H3-Max": { durationMin: 5, durationMax: 15, resolutions: ["480P", "768P"] },
};
const DEFAULT_DURATION_SEC = 5;
const DEFAULT_RESOLUTION = "768P";
const DEFAULT_RATIO = "16:9";
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 900_000;
const CREATE_PATH = "/v2/video_generation";
const QUERY_PREFIX = "/v2/query/video_generation/";

function optionalText(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function hasValue(value) {
  return value !== undefined && value !== null;
}

function remainingMs(deadline) {
  return Math.max(1, deadline - Date.now());
}

export function parseVideoParams(args = {}, config = {}) {
  const prompt = typeof args.prompt === "string" ? args.prompt : "";
  if (prompt.trim() === "") {
    throw cliError("E_MISSING_ARGUMENT", "缺少必填 --prompt", { option: "--prompt" });
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

  const ratio = optionalText(args.ratio) ?? DEFAULT_RATIO;
  if (!RATIOS.includes(ratio)) {
    throw cliError(
      "E_INVALID_OPTION",
      `--ratio 仅支持 ${RATIOS.join(" | ")}（t2v 不支持 adaptive，得到 ${ratio}）`,
      { option: "--ratio", value: ratio },
    );
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

  return { model, prompt, durationSec, resolution, ratio, pollIntervalMs, timeoutMs };
}

export function buildVideoBody(input) {
  return {
    model: input.model,
    content: [{ type: "text", text: input.prompt }],
    resolution: input.resolution,
    duration: input.durationSec ?? input.duration,
    ratio: input.ratio,
  };
}

function timeoutError(taskId) {
  return cliError(
    "E_PROVIDER_ERROR",
    `minimax-video 任务轮询超时（taskId=${taskId}），任务可能仍在运行：请稍后查询或重试`,
    { source: "minimax-video", taskId, reason: "timeout" },
  );
}

function errorMessageOf(error) {
  if (typeof error === "string") return error;
  if (error !== null && typeof error === "object") {
    if (typeof error.message === "string" && error.message !== "") return error.message;
    if (hasValue(error.code)) return `code=${error.code}`;
  }
  return "";
}

function scrubTaskError(error, key) {
  if (error === undefined || error === null) return undefined;
  if (typeof error === "string") return scrubKey(error, key);
  if (typeof error !== "object") return error;
  return {
    ...error,
    ...(typeof error.message === "string" ? { message: scrubKey(error.message, key) } : {}),
  };
}

function taskFailure(config, taskId, taskStatus, task) {
  const message = clipText(scrubKey(errorMessageOf(task?.error), config.apiKey));
  const taskError = scrubTaskError(task?.error, config.apiKey);
  return cliError(
    "E_PROVIDER_ERROR",
    `minimax-video 任务失败（status=${taskStatus}）${message === "" ? "" : `：${message}`}`,
    {
      source: "minimax-video",
      taskId,
      taskStatus,
      ...(taskError === undefined ? {} : { taskError }),
    },
  );
}

async function createTask(config, input, deadline) {
  let payload;
  try {
    payload = await requestJson(config, {
      method: "POST",
      path: CREATE_PATH,
      body: buildVideoBody(input),
      timeoutMs: remainingMs(deadline),
      source: "minimax-video",
    });
  } catch (err) {
    if (err?.details?.reason === "timeout") {
      throw cliError(
        "E_PROVIDER_ERROR",
        "minimax-video 提交请求超时，任务可能已创建但未拿到 taskId",
        {
          source: "minimax-video",
          reason: "timeout",
        },
      );
    }
    throw err;
  }
  assertBaseResp(payload, "minimax-video", config);

  const taskId = typeof payload?.task_id === "string" ? payload.task_id.trim() : "";
  if (taskId === "") {
    throw cliError("E_PROVIDER_ERROR", "minimax-video 提交响应缺少 task_id", {
      source: "minimax-video",
    });
  }
  return taskId;
}

async function pollTask(config, input, taskId, deadline) {
  for (;;) {
    if (Date.now() >= deadline) throw timeoutError(taskId);
    let payload;
    try {
      payload = await requestJson(config, {
        method: "GET",
        path: `${QUERY_PREFIX}${encodeURIComponent(taskId)}`,
        timeoutMs: remainingMs(deadline),
        source: "minimax-video",
      });
    } catch (err) {
      // 单次查询撞上总 deadline：按「任务可能仍在跑」上报，并保留 taskId
      if (err?.details?.reason === "timeout") throw timeoutError(taskId);
      throw err;
    }
    assertBaseResp(payload, "minimax-video", config);

    const task = payload?.task ?? {};
    const status = typeof task.status === "string" ? task.status.toLowerCase() : "";
    if (status === "succeeded") {
      const url = typeof task.content?.url === "string" ? task.content.url : "";
      if (url === "") {
        throw cliError("E_PROVIDER_ERROR", "minimax-video 任务成功但缺少下载地址", {
          source: "minimax-video",
          taskId,
          taskStatus: status,
        });
      }
      return { task, url };
    }
    if (status === "failed" || status === "cancelled" || status === "canceled") {
      throw taskFailure(config, taskId, status, task);
    }
    // queued / running / 未知状态一律继续等，由总 deadline 收敛
    if (Date.now() + input.pollIntervalMs > deadline) throw timeoutError(taskId);
    await sleep(input.pollIntervalMs);
  }
}

async function downloadVideo(config, url, taskId, deadline) {
  if (Date.now() >= deadline) throw timeoutError(taskId);
  let res;
  try {
    // 成片 URL 是对象存储直链：不带 Authorization
    res = await fetch(url, { signal: AbortSignal.timeout(remainingMs(deadline)) });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw cliError(
        "E_PROVIDER_ERROR",
        `minimax-video 成片下载超时（taskId=${taskId}），视频已生成但未落盘`,
        { source: "minimax-video", taskId, reason: "timeout", url },
      );
    }
    const message = clipText(scrubKey(err?.message ?? err, config.apiKey));
    throw cliError("E_PROVIDER_ERROR", `minimax-video 成片下载失败：${message}`, {
      source: "minimax-video",
      taskId,
      reason: "network",
      url,
    });
  }
  if (!res.ok) {
    throw cliError("E_PROVIDER_ERROR", `minimax-video 成片下载失败（HTTP ${res.status}）`, {
      source: "minimax-video",
      taskId,
      status: res.status,
      url,
    });
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) {
    throw cliError("E_PROVIDER_ERROR", "minimax-video 成片下载结果为空", {
      source: "minimax-video",
      taskId,
      url,
    });
  }
  return buf;
}

export async function runVideo(ctx, args) {
  const config = loadConfig();
  const input = parseVideoParams(args, config);
  const deadline = Date.now() + input.timeoutMs;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const defaultName = `minimax-video-${stamp}.mp4`;
  // 输出目录先预检：路径问题在提交任务前失败，不白烧额度
  await outputPathOf(ctx, args.output, defaultName);

  const taskId = await createTask(config, input, deadline);
  ctx.logger.info(`minimax-video 任务已提交：${taskId}（H3 5s/768P 实测约 118s，轮询中）`);

  const { task, url } = await pollTask(config, input, taskId, deadline);
  const buf = await downloadVideo(config, url, taskId, deadline);
  const output = await writeOutput(ctx, args.output, defaultName, buf);

  return {
    path: output,
    bytes: buf.length,
    model: input.model,
    taskId,
    durationSec: input.durationSec,
    resolution: input.resolution,
    ratio: input.ratio,
    ...(hasValue(task.created_at) ? { createdAt: task.created_at } : {}),
    ...(hasValue(task.updated_at) ? { updatedAt: task.updated_at } : {}),
    ...(hasValue(task.usage) ? { usage: task.usage } : {}),
  };
}
