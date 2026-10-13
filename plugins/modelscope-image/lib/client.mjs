import { cliError } from "./errors.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function scrub(text, key) {
  return key && key.length >= 8 ? text.split(key).join("***") : text;
}

async function requestJson(config, url, init) {
  const headers = { authorization: `Bearer ${config.key}`, ...init.headers };
  let res;
  try {
    res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(config.timeoutMs) });
  } catch (err) {
    throw cliError(
      "E_PROVIDER_ERROR",
      `modelscope 请求失败：${scrub(String(err?.message ?? err), config.key)}`,
      {
        source: "modelscope",
        url,
      },
    );
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw cliError("E_PROVIDER_ERROR", `modelscope 请求失败（HTTP ${res.status}）`, {
      source: "modelscope",
      status: res.status,
      body: scrub(text.slice(0, 300), config.key),
    });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw cliError("E_PROVIDER_ERROR", "modelscope 响应不是合法 JSON", {
      source: "modelscope",
      body: scrub(text.slice(0, 300), config.key),
    });
  }
}

function requireKey(config) {
  if (config.key === "") {
    throw cliError("E_CONFIG", "缺少环境变量 MODELSCOPE_API_KEY", { var: "MODELSCOPE_API_KEY" });
  }
}

// 参数名以 ModelScope API-Inference 官方文档的 AIGC 生图表为准：
// size 是 "WxH" 字符串（非 width/height），steps/guidance/seed/negative_prompt
function buildSubmitBody({ model, prompt, size, negativePrompt, steps, guidance, seed }) {
  const body = { model, prompt, size };
  if (negativePrompt !== undefined) body.negative_prompt = negativePrompt;
  if (steps !== undefined) body.steps = steps;
  if (guidance !== undefined) body.guidance = guidance;
  if (seed !== undefined) body.seed = seed;
  return body;
}

const FAILED = ["failed", "error", "canceled", "cancelled", "invalid", "timed_out"];
const DONE = ["succeed", "success", "succeeded", "completed", "done", "finished"];

function statusOf(json) {
  return String(json?.task_status ?? json?.status ?? "").toLowerCase();
}

// 完成态的图片载荷：ModelScope 任务形态是顶层 output_images[]，OpenAI 形态是 data[]
function imagesOf(json) {
  const out = [];
  for (const item of json?.output_images ?? []) {
    if (typeof item === "string" && item !== "") out.push({ url: item });
    else if (typeof item?.url === "string") out.push({ url: item.url });
    else if (typeof item?.b64_json === "string") out.push({ b64: item.b64_json });
  }
  for (const item of json?.data ?? []) {
    if (typeof item?.url === "string" && item.url !== "") out.push({ url: item.url });
    else if (typeof item?.b64_json === "string" && item.b64_json !== "") {
      out.push({ b64: item.b64_json });
    }
  }
  return out;
}

// 实测：完成响应里 task_id 与 output_images 并存（先判图片）；提交响应会提前报 SUCCEED
// 而任务仍在跑（有 task_id 且未失败一律以 /v1/tasks 轮询结果为准）
function resolveResponse(json) {
  const taskId =
    typeof json?.task_id === "string" && json.task_id !== "" ? json.task_id : undefined;
  const images = imagesOf(json);
  if (images.length > 0) return { kind: "ready", taskId, images };
  const status = statusOf(json);
  if (FAILED.includes(status)) {
    return {
      kind: "failed",
      status,
      taskId,
      message: json?.message ?? json?.errors ?? "任务失败",
    };
  }
  if (taskId !== undefined) return { kind: "pending", status, taskId };
  if (DONE.includes(status)) {
    return { kind: "failed", status, taskId, message: "任务已完成但响应中没有图片数据" };
  }
  return { kind: "pending", status, taskId };
}

function taskFailed(config, result) {
  throw cliError(
    "E_PROVIDER_ERROR",
    `modelscope 任务失败（status=${result.status || "unknown"}）`,
    {
      source: "modelscope",
      ...(result.taskId === undefined ? {} : { taskId: result.taskId }),
      message: scrub(String(result.message), config.key),
    },
  );
}

async function pollTask(config, taskId, deadline) {
  const url = `${config.baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`;
  for (;;) {
    const result = resolveResponse(
      await requestJson(config, url, { headers: { "x-modelscope-task-type": "image_generation" } }),
    );
    if (result.kind === "failed") taskFailed(config, result);
    if (result.kind === "ready") return result;
    if (Date.now() + config.pollIntervalMs > deadline) {
      throw cliError("E_PROVIDER_ERROR", "modelscope 任务等待超时", {
        source: "modelscope",
        taskId,
        hint: "任务可能仍在运行；积分/算力已占用，勿盲目重发",
      });
    }
    await sleep(config.pollIntervalMs);
  }
}

export async function generateImage(config, options) {
  requireKey(config);
  const json = await requestJson(config, `${config.baseUrl}/v1/images/generations`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-modelscope-async-mode": "true" },
    body: JSON.stringify(buildSubmitBody(options)),
  });
  const submitted = resolveResponse(json);
  if (submitted.kind === "failed") taskFailed(config, submitted);

  const deadline = Date.now() + config.timeoutMs;
  if (submitted.kind === "ready") {
    if (submitted.images.length > 1) {
      throw cliError(
        "E_PROVIDER_ERROR",
        `modelscope 返回 ${submitted.images.length} 张图，本命令只支持单图`,
        {
          source: "modelscope",
        },
      );
    }
    return { ...submitted.images[0], taskId: submitted.taskId };
  }
  if (submitted.taskId === undefined) {
    throw cliError("E_PROVIDER_ERROR", "modelscope 响应缺少 task_id 与图片数据", {
      source: "modelscope",
      body: scrub(JSON.stringify(json).slice(0, 300), config.key),
    });
  }
  const done = await pollTask(config, submitted.taskId, deadline);
  if (done.images.length > 1) {
    throw cliError(
      "E_PROVIDER_ERROR",
      `modelscope 返回 ${done.images.length} 张图，本命令只支持单图`,
      {
        source: "modelscope",
      },
    );
  }
  return { ...done.images[0], taskId: submitted.taskId };
}

export async function fetchImageBytes(config, ref) {
  if (typeof ref.b64 === "string") return Buffer.from(ref.b64, "base64");
  let res;
  try {
    // 结果 URL 多为 OSS 直链：不携带 apikey
    res = await fetch(ref.url, { signal: AbortSignal.timeout(config.timeoutMs) });
  } catch (err) {
    throw cliError("E_PROVIDER_ERROR", `modelscope 图片下载失败：${String(err?.message ?? err)}`, {
      source: "modelscope",
      url: ref.url,
    });
  }
  if (!res.ok) {
    throw cliError("E_PROVIDER_ERROR", `modelscope 图片下载失败（HTTP ${res.status}）`, {
      source: "modelscope",
      url: ref.url,
    });
  }
  return Buffer.from(await res.arrayBuffer());
}
