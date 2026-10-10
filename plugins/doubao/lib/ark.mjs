import { cliError } from "./errors.mjs";

const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const RETRY_BACKOFF_MS = [400, 1200];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : (part?.text ?? ""))).join("");
  }
  return "";
}

async function requestOnce(config, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    return await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// 一次调用 = 一个音频片段；分段任务并发跑，单段失败会拖垮整条命令，故对瞬时错误重试
export async function transcribeClip(config, { audioBase64, format, prompt, model }) {
  const body = {
    model: model ?? config.model,
    messages: [
      {
        role: "user",
        content: [
          { type: "input_audio", input_audio: { data: audioBase64, format } },
          { type: "text", text: prompt },
        ],
      },
    ],
  };

  let lastError = null;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_BACKOFF_MS[attempt - 1]);
    let res;
    try {
      res = await requestOnce(config, body);
    } catch (err) {
      const aborted = err?.name === "AbortError";
      lastError = cliError(
        "E_PROVIDER_ERROR",
        aborted
          ? `doubao 请求超时（${config.timeoutMs}ms）`
          : `doubao 网络请求失败：${String(err?.message ?? err)}`,
        { reason: aborted ? "timeout" : "network_error" },
      );
      continue;
    }
    const text = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw cliError("E_CONFIG", `DOUBAO_API_KEY 无效（HTTP ${res.status}）`, {
        var: "DOUBAO_API_KEY",
        status: res.status,
      });
    }
    if (RETRY_STATUSES.has(res.status)) {
      lastError = cliError("E_PROVIDER_ERROR", `doubao 请求失败（HTTP ${res.status}）`, {
        status: res.status,
        body: text.slice(0, 200),
      });
      continue;
    }
    if (!res.ok) {
      let message = text.slice(0, 300);
      try {
        message = JSON.stringify(JSON.parse(text)).slice(0, 300);
      } catch {
        // 非 JSON 响应体，保留原文
      }
      throw cliError(
        "E_PROVIDER_ERROR",
        `doubao 请求失败（HTTP ${res.status}）${message ? `：${message}` : ""}`,
        {
          status: res.status,
          body: message,
        },
      );
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw cliError("E_PROVIDER_ERROR", "doubao 响应不是合法 JSON", { reason: "bad_response" });
    }
    const content = extractText(payload);
    if (content.trim() === "") {
      throw cliError("E_PROVIDER_ERROR", "doubao 返回空转写内容", {
        reason: "empty_result",
        finishReason: payload?.choices?.[0]?.finish_reason ?? null,
      });
    }
    return {
      text: content,
      usage: {
        promptTokens: payload?.usage?.prompt_tokens ?? null,
        completionTokens: payload?.usage?.completion_tokens ?? null,
        audioTokens: payload?.usage?.prompt_tokens_details?.audio_tokens ?? null,
      },
    };
  }
  throw lastError ?? cliError("E_PROVIDER_ERROR", "doubao 请求失败", { reason: "unknown" });
}
