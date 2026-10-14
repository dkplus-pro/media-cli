import { describeFailure, reasonOfText, requestIdOf, scrub } from "./error-text.mjs";
import { cliError } from "./errors.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 换 key 才有意义的失败：鉴权失效（key 被吊销/过期）与按 key 计的限流；5xx 与网络抖动一并重试
const ROTATE_STATUS = new Set([401, 403, 429]);

// 请求层不抛错：由调用方按 transport/status 决定换 key、续等还是直接失败
async function tryRequestJson(config, url, init, key) {
  let res;
  try {
    res = await fetch(url, {
      ...init,
      headers: { authorization: `Bearer ${key}`, ...init.headers },
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (err) {
    return { ok: false, transport: "network", status: 0, text: String(err?.message ?? err) };
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) return { ok: false, transport: "http", status: res.status, text };
  try {
    return { ok: true, json: JSON.parse(text) };
  } catch {
    return { ok: false, transport: "malformed", status: res.status, text };
  }
}

// 参数类 4xx：换 key 无意义，直接收敛为一次失败
function isFatalHttp(got) {
  return (
    got.transport === "http" &&
    !ROTATE_STATUS.has(got.status) &&
    got.status < 500 &&
    got.status !== 0
  );
}

function httpError(config, got, extra) {
  if (got.transport === "malformed") {
    return cliError("E_PROVIDER_ERROR", "modelscope 响应不是合法 JSON", {
      source: "modelscope",
      body: scrub(got.text.slice(0, 300), config.keys),
      ...extra,
    });
  }
  const reason = reasonOfText(got.text);
  return cliError(
    "E_PROVIDER_ERROR",
    `modelscope 请求失败（HTTP ${got.status}）${reason === "" ? "" : `：${reason}`}`,
    {
      source: "modelscope",
      ...(got.status === 0 ? {} : { status: got.status }),
      body: scrub(got.text.slice(0, 300), config.keys),
      ...extra,
    },
  );
}

// 提交期在 key 池内随机起点、逐个重试；返回提交成功的那把 key 的下标
async function submitGeneration(config, body) {
  const total = config.keys.length;
  const start = Math.floor(Math.random() * total);
  const attempts = [];
  for (let i = 0; i < total; i++) {
    const keyIndex = (start + i) % total;
    const got = await tryRequestJson(
      config,
      `${config.baseUrl}/v1/images/generations`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-modelscope-async-mode": "true" },
        body: JSON.stringify(body),
      },
      config.keys[keyIndex],
    );
    if (got.ok) return { json: got.json, keyIndex };
    if (got.transport === "malformed") throw httpError(config, got);
    const reason = reasonOfText(got.text);
    attempts.push({
      keyIndex,
      ...(got.status === 0 ? {} : { status: got.status }),
      message: scrub(reason, config.keys),
    });
    if (isFatalHttp(got)) throw httpError(config, got, { attempts });
  }
  const last = attempts[attempts.length - 1];
  throw cliError(
    "E_PROVIDER_ERROR",
    `modelscope ${total} 把 key 均不可用${last?.message ? `：${last.message}` : ""}`,
    {
      source: "modelscope",
      keyCount: total,
      attempts,
    },
  );
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
    // 失败载荷形态不统一：可能在 message / errors（对象或数组）/ 顶层，统一交给 describeFailure 摊平
    return {
      kind: "failed",
      status,
      taskId,
      message: json?.message ?? json?.errors ?? json?.logs ?? json,
      payload: json,
    };
  }
  if (taskId !== undefined) return { kind: "pending", status, taskId };
  if (DONE.includes(status)) {
    return {
      kind: "failed",
      status,
      taskId,
      message: "任务已完成但响应中没有图片数据",
      payload: json,
    };
  }
  return { kind: "pending", status, taskId };
}

function taskFailed(config, result) {
  const reason = (describeFailure(result.message) || "任务失败").slice(0, 300);
  const requestId = requestIdOf(result.payload);
  throw cliError(
    "E_PROVIDER_ERROR",
    `modelscope 任务失败（status=${result.status || "unknown"}）：${scrub(reason, config.keys)}`,
    {
      source: "modelscope",
      ...(result.taskId === undefined ? {} : { taskId: result.taskId }),
      ...(requestId === undefined ? {} : { requestId }),
      message: scrub(reason, config.keys),
      // 原文兜底：网关哪天换错误结构时不至于什么信息都拿不到
      raw: scrub(JSON.stringify(result.payload ?? null), config.keys).slice(0, 800),
    },
  );
}

function timeoutError(taskId) {
  return cliError("E_PROVIDER_ERROR", "modelscope 任务等待超时", {
    source: "modelscope",
    taskId,
    hint: "任务可能仍在运行；积分/算力已占用，勿盲目重发",
  });
}

// 任务只属于提交它的那个账号，所以轮询固定用同一把 key，不轮换
async function pollTask(config, taskId, keyIndex, deadline) {
  const url = `${config.baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`;
  for (;;) {
    const got = await tryRequestJson(
      config,
      url,
      { headers: { "x-modelscope-task-type": "image_generation" } },
      config.keys[keyIndex],
    );
    if (!got.ok) {
      // 轮询期的限流/抖动不该作废一次已付费的生成：同一把 key 续等，由 deadline 收敛
      if (got.transport === "malformed" || isFatalHttp(got)) {
        throw httpError(config, got, { taskId });
      }
    } else {
      const result = resolveResponse(got.json);
      if (result.kind === "failed") taskFailed(config, result);
      if (result.kind === "ready") return result;
    }
    if (Date.now() + config.pollIntervalMs > deadline) throw timeoutError(taskId);
    await sleep(config.pollIntervalMs);
  }
}

function singleImage(images, taskId, keyIndex) {
  if (images.length > 1) {
    throw cliError("E_PROVIDER_ERROR", `modelscope 返回 ${images.length} 张图，本命令只支持单图`, {
      source: "modelscope",
    });
  }
  return { ...images[0], taskId, keyIndex };
}

export async function generateImage(config, options) {
  const { json, keyIndex } = await submitGeneration(config, buildSubmitBody(options));
  const submitted = resolveResponse(json);
  if (submitted.kind === "failed") taskFailed(config, submitted);
  if (submitted.kind === "ready") return singleImage(submitted.images, submitted.taskId, keyIndex);
  if (submitted.taskId === undefined) {
    throw cliError("E_PROVIDER_ERROR", "modelscope 响应缺少 task_id 与图片数据", {
      source: "modelscope",
      body: scrub(JSON.stringify(json).slice(0, 300), config.keys),
    });
  }
  const done = await pollTask(config, submitted.taskId, keyIndex, Date.now() + config.timeoutMs);
  return singleImage(done.images, submitted.taskId, keyIndex);
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

function buildSubmitBody({ model, prompt, size, negativePrompt, steps, guidance, seed, refUrls }) {
  const body = { model, prompt, size };
  if (negativePrompt !== undefined) body.negative_prompt = negativePrompt;
  if (steps !== undefined) body.steps = steps;
  if (guidance !== undefined) body.guidance = guidance;
  if (seed !== undefined) body.seed = seed;
  // 单图传字符串、多图传 URL 数组（实测两张数组各图特征都被消费，模型卡片称上限 10 张）
  if (refUrls !== undefined) body.image_url = refUrls.length === 1 ? refUrls[0] : refUrls;
  return body;
}
