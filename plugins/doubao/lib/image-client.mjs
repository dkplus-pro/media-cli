import { cliError } from "./errors.mjs";

// doubao-image-gen 的 HTTP 层：请求 /images/generations、取件下载、错误体摊平。
// 从 lib/image.mjs 拆出（该文件已到 300 行拆分线，见 AGENTS.md §6）。
// 错误码只复用已登记的 E_CONFIG / E_PROVIDER_ERROR（D43），细节放 details。

export const SOURCE = "doubao-image";

export function scrub(text, apiKey) {
  const raw = String(text ?? "");
  return apiKey && apiKey.length > 0 ? raw.split(apiKey).join("***") : raw;
}

// 从 provider 的错误体里摊平出人能读的原因（OpenAI 兼容的 error.message / error / message）
export function providerMessageOf(text) {
  const raw = String(text ?? "").trim();
  if (raw === "") return "";
  try {
    const payload = JSON.parse(raw);
    const error = payload?.error;
    if (typeof error === "string" && error.trim() !== "") return error.trim();
    if (typeof error?.message === "string" && error.message.trim() !== "") {
      return error.message.trim();
    }
    if (typeof payload?.message === "string" && payload.message.trim() !== "") {
      return payload.message.trim();
    }
  } catch {
    // 非 JSON 响应体，保留原文
  }
  return raw.slice(0, 300);
}

function networkError(err, timeoutMs, action) {
  const timeout = err?.name === "AbortError" || err?.name === "TimeoutError";
  return cliError(
    "E_PROVIDER_ERROR",
    timeout
      ? `doubao ${action}超时（${timeoutMs}ms）`
      : `doubao ${action}网络请求失败：${String(err?.message ?? err)}`,
    { source: SOURCE, reason: timeout ? "timeout" : "network_error" },
  );
}

async function fetchOnce(url, init, timeoutMs, action) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw networkError(err, timeoutMs, action);
  }
}

export async function requestGeneration(config, body, timeoutMs) {
  const res = await fetchOnce(
    `${config.baseUrl}/images/generations`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    },
    timeoutMs,
    "生图请求",
  );
  const text = await res.text().catch(() => "");
  const message = scrub(providerMessageOf(text), config.apiKey);
  if (res.status === 401 || res.status === 403) {
    throw cliError("E_CONFIG", `DOUBAO_API_KEY 无效或无生图权限（HTTP ${res.status}）`, {
      var: "DOUBAO_API_KEY",
      status: res.status,
      ...(message === "" ? {} : { providerMessage: message }),
    });
  }
  if (!res.ok) {
    throw cliError(
      "E_PROVIDER_ERROR",
      `doubao 生图请求失败（HTTP ${res.status}）${message === "" ? "" : `：${message}`}`,
      {
        source: SOURCE,
        status: res.status,
        ...(message === "" ? {} : { providerMessage: message }),
      },
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw cliError("E_PROVIDER_ERROR", "doubao 生图响应不是合法 JSON", {
      source: SOURCE,
      reason: "bad_response",
      body: scrub(text.slice(0, 300), config.apiKey),
    });
  }
}

// 结果 URL 是 TOS 签名直链：不携带 Authorization，避免把 key 发给对象存储
export async function fetchImageBytes(url, timeoutMs) {
  const res = await fetchOnce(url, { method: "GET" }, timeoutMs, "图片下载");
  if (!res.ok) {
    throw cliError("E_PROVIDER_ERROR", `doubao 图片下载失败（HTTP ${res.status}）`, {
      source: SOURCE,
      status: res.status,
      url,
    });
  }
  try {
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    throw networkError(err, timeoutMs, "图片下载");
  }
}

export function imageOf(payload) {
  const item = Array.isArray(payload?.data) ? payload.data[0] : undefined;
  if (typeof item?.b64_json === "string" && item.b64_json !== "") {
    return { buf: Buffer.from(item.b64_json, "base64") };
  }
  if (typeof item?.url === "string" && item.url !== "") {
    return { url: item.url };
  }
  return null;
}
