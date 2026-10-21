import { setTimeout as sleep } from "node:timers/promises";
import { assertBaseResp, clipText, requestJson, scrubKey } from "./client.mjs";
import { cliError } from "./errors.mjs";

// minimax 两类视频任务（生成 / 再生）共用的生命周期：提交 → 轮询 → 下载。
// 两个端点路径不同、其余语义一致，故把差异收敛成 source/path 参数，流程收敛在这里。

// 生成与再生共用 H3 的查询端点（官方：再生任务走同一套 query/list/cancel）
export const QUERY_PREFIX = "/v2/query/video_generation/";

export function hasValue(value) {
  return value !== undefined && value !== null;
}

function remainingMs(deadline) {
  return Math.max(1, deadline - Date.now());
}

function timeoutError(source, taskId) {
  return cliError(
    "E_PROVIDER_ERROR",
    `${source} 任务轮询超时（taskId=${taskId}），任务可能仍在运行：请稍后查询或重试`,
    { source, taskId, reason: "timeout" },
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

function taskFailure(source, config, taskId, taskStatus, task) {
  const message = clipText(scrubKey(errorMessageOf(task?.error), config.apiKey));
  const taskError = scrubTaskError(task?.error, config.apiKey);
  return cliError(
    "E_PROVIDER_ERROR",
    `${source} 任务失败（status=${taskStatus}）${message === "" ? "" : `：${message}`}`,
    {
      source,
      taskId,
      taskStatus,
      ...(taskError === undefined ? {} : { taskError }),
    },
  );
}

export async function createVideoTask(config, options) {
  const { source, path: taskPath, body, deadline } = options;
  let payload;
  try {
    payload = await requestJson(config, {
      method: "POST",
      path: taskPath,
      body,
      timeoutMs: remainingMs(deadline),
      source,
    });
  } catch (err) {
    if (err?.details?.reason === "timeout") {
      throw cliError("E_PROVIDER_ERROR", `${source} 提交请求超时，任务可能已创建但未拿到 taskId`, {
        source,
        reason: "timeout",
      });
    }
    throw err;
  }
  assertBaseResp(payload, source, config);

  const taskId = typeof payload?.task_id === "string" ? payload.task_id.trim() : "";
  if (taskId === "") {
    throw cliError("E_PROVIDER_ERROR", `${source} 提交响应缺少 task_id`, { source });
  }
  return taskId;
}

export async function pollVideoTask(config, options) {
  const { source, taskId, pollIntervalMs, deadline } = options;
  for (;;) {
    if (Date.now() >= deadline) throw timeoutError(source, taskId);
    let payload;
    try {
      payload = await requestJson(config, {
        method: "GET",
        path: `${QUERY_PREFIX}${encodeURIComponent(taskId)}`,
        timeoutMs: remainingMs(deadline),
        source,
      });
    } catch (err) {
      // 单次查询撞上总 deadline：按「任务可能仍在跑」上报，并保留 taskId
      if (err?.details?.reason === "timeout") throw timeoutError(source, taskId);
      throw err;
    }
    assertBaseResp(payload, source, config);

    const task = payload?.task ?? {};
    const status = typeof task.status === "string" ? task.status.toLowerCase() : "";
    if (status === "succeeded") {
      const url = typeof task.content?.url === "string" ? task.content.url : "";
      if (url === "") {
        throw cliError("E_PROVIDER_ERROR", `${source} 任务成功但缺少下载地址`, {
          source,
          taskId,
          taskStatus: status,
        });
      }
      return { task, url };
    }
    if (status === "failed" || status === "cancelled" || status === "canceled") {
      throw taskFailure(source, config, taskId, status, task);
    }
    // queued / running / 未知状态一律继续等，由总 deadline 收敛
    if (Date.now() + pollIntervalMs > deadline) throw timeoutError(source, taskId);
    await sleep(pollIntervalMs);
  }
}

export async function downloadVideoFile(config, options) {
  const { source, url, taskId, deadline } = options;
  if (Date.now() >= deadline) throw timeoutError(source, taskId);
  let res;
  try {
    // 成片 URL 是对象存储直链：不带 Authorization
    res = await fetch(url, { signal: AbortSignal.timeout(remainingMs(deadline)) });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw cliError(
        "E_PROVIDER_ERROR",
        `${source} 成片下载超时（taskId=${taskId}），视频已生成但未落盘`,
        {
          source,
          taskId,
          reason: "timeout",
          url,
        },
      );
    }
    const message = clipText(scrubKey(err?.message ?? err, config.apiKey));
    throw cliError("E_PROVIDER_ERROR", `${source} 成片下载失败：${message}`, {
      source,
      taskId,
      reason: "network",
      url,
    });
  }
  if (!res.ok) {
    throw cliError("E_PROVIDER_ERROR", `${source} 成片下载失败（HTTP ${res.status}）`, {
      source,
      taskId,
      status: res.status,
      url,
    });
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) {
    throw cliError("E_PROVIDER_ERROR", `${source} 成片下载结果为空`, { source, taskId, url });
  }
  return buf;
}
