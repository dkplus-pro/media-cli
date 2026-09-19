import { cliError } from "./config.mjs";

async function request({ apiKey, baseUrl }, { path, method = "GET", body, query }) {
  const url = `${baseUrl}${path}${query ? `?${query}` : ""}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (err) {
    throw cliError("E_PROVIDER_ERROR", `suno 网络请求失败：${String(err?.message ?? err)}`, {
      reason: "network_error",
    });
  }
  const text = await res.text().catch(() => "");
  if (res.status === 401 || res.status === 403) {
    throw cliError("E_CONFIG", `SUNO_API_KEY 无效（HTTP ${res.status}）`, {
      var: "SUNO_API_KEY",
      status: res.status,
    });
  }
  if (res.status === 402) {
    throw cliError("E_PROVIDER_ERROR", "suno 积分不足", {
      reason: "insufficient_points",
      status: res.status,
    });
  }
  if (!res.ok) {
    throw cliError("E_PROVIDER_ERROR", `suno 请求失败（HTTP ${res.status}）`, {
      status: res.status,
      body: text.slice(0, 200),
    });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw cliError("E_PROVIDER_ERROR", "suno 响应不是合法 JSON", { reason: "bad_response" });
  }
}

// 归一化：对外只暴露 data.{status,result...} 的语义字段
function normalizeTask(payload, id) {
  const data = payload?.data ?? {};
  const result = data.result ?? {};
  const fileInfo = result.fileInfo ?? {};
  return {
    taskId: id,
    status: data.status,
    title: result.title ?? data.title,
    durationSec: fileInfo.duration,
    audioUrl: fileInfo.mp3Url,
    coverUrl: fileInfo.cosUrl,
    customId: result.custom_id,
  };
}

export function createSunoClient(config) {
  return {
    async generateMusic(body) {
      const payload = await request(config, {
        path: "/api/v1/music/generate",
        method: "POST",
        body,
      });
      return payload?.data?.task_ids ?? [];
    },
    async generateSound(body) {
      const payload = await request(config, {
        path: "/api/v1/music/sound",
        method: "POST",
        body,
      });
      return payload?.data?.task_ids ?? [];
    },
    async getTask(id) {
      const payload = await request(config, {
        path: "/api/v1/music/task",
        query: `id=${encodeURIComponent(id)}`,
      });
      return normalizeTask(payload, id);
    },
    async getBalance() {
      const payload = await request(config, { path: "/api/v1/points/balance" });
      return payload?.data?.remaining_points;
    },
  };
}
