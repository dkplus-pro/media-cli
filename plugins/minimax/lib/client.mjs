import { cliError } from "./errors.mjs";

// 语音/音乐单次同步请求的兜底预算；视频按自己的总 deadline 覆盖
export const DEFAULT_TIMEOUT_MS = 300_000;

// key 可能被 provider 回显在错误文本里：一律先遮蔽，再进 message/details（AGENTS.md §4）
export function scrubKey(text, key) {
  const value = String(text ?? "");
  if (typeof key !== "string" || key.length < 8) return value;
  return value.split(key).join("***");
}

export function clipText(text, max = 300) {
  const value = String(text ?? "").trim();
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

// provider 的错误原因可能铺在 base_resp.status_msg / error.message / message 里
function providerMessageOf(text) {
  if (typeof text !== "string" || text.trim() === "") return "";
  try {
    const payload = JSON.parse(text);
    const candidates = [
      payload?.base_resp?.status_msg,
      payload?.error?.message,
      payload?.message,
      payload?.msg,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
    }
  } catch {
    // 非 JSON 响应体：保留原文
  }
  return text.trim();
}

function httpFailure(config, { status, text, source }) {
  const providerMessage = clipText(scrubKey(providerMessageOf(text), config.apiKey));
  if (status === 401 || status === 403) {
    throw cliError("E_CONFIG", `MiniMax 鉴权失败（HTTP ${status}），请检查 MINIMAX_API_KEY`, {
      var: "MINIMAX_API_KEY",
      source,
      status,
      providerMessage,
    });
  }
  if (status === 429) {
    throw cliError("E_PROVIDER_ERROR", `${source} 被限流（HTTP 429），请稍后重试`, {
      source,
      status,
      reason: "rate_limited",
      providerMessage,
    });
  }
  const suffix = providerMessage === "" ? "" : `：${providerMessage}`;
  throw cliError("E_PROVIDER_ERROR", `${source} 请求失败（HTTP ${status}）${suffix}`, {
    source,
    status,
    providerMessage,
  });
}

// base_resp.status_code → 已登记错误码。code 0 返回 undefined（调用方按成功处理）
// 1004/2049：key 无效；1008：余额不足；1002/1039：限流；2013：参数异常
export function mapBaseRespError(statusCode, statusMsg, source = "minimax", apiKey) {
  const code = Number(statusCode);
  if (!Number.isFinite(code) || code === 0) return undefined;
  const detail = clipText(scrubKey(typeof statusMsg === "string" ? statusMsg.trim() : "", apiKey));
  const suffix = detail === "" ? "" : `：${detail}`;
  const meta = {
    source,
    baseRespCode: code,
    ...(detail === "" ? {} : { baseRespMsg: detail }),
  };
  if (code === 1004 || code === 2049) {
    return cliError("E_CONFIG", `MINIMAX_API_KEY 无效或未授权（base_resp ${code}）${suffix}`, {
      var: "MINIMAX_API_KEY",
      ...meta,
    });
  }
  if (code === 1008) {
    return cliError("E_PROVIDER_ERROR", `MiniMax 账户余额不足（base_resp ${code}）${suffix}`, {
      reason: "insufficient_balance",
      ...meta,
    });
  }
  if (code === 1002 || code === 1039) {
    return cliError("E_PROVIDER_ERROR", `MiniMax 请求被限流（base_resp ${code}）${suffix}`, {
      reason: "rate_limited",
      ...meta,
    });
  }
  if (code === 2013) {
    return cliError("E_PROVIDER_ERROR", `MiniMax 参数不合法（base_resp ${code}）${suffix}`, {
      reason: "invalid_params",
      ...meta,
    });
  }
  return cliError("E_PROVIDER_ERROR", `MiniMax 返回错误（base_resp ${code}）${suffix}`, meta);
}

// 音频侧 200 也可能是失败：必须再查 base_resp；缺失 base_resp 时信任 HTTP 层
export function assertBaseResp(payload, source = "minimax", config) {
  const baseResp = payload?.base_resp;
  const code = Number(baseResp?.status_code ?? 0);
  if (!Number.isFinite(code) || code === 0) return payload;
  throw mapBaseRespError(code, baseResp?.status_msg, source, config?.apiKey);
}

function budgetOf(timeoutMs) {
  const value = Number(timeoutMs);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : DEFAULT_TIMEOUT_MS;
}

// 统一 JSON 请求：Bearer 鉴权、超时、HTTP 状态摊平；不写流、不退出
export async function requestJson(config, options = {}) {
  const {
    method = "POST",
    path: requestPath,
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    source = "minimax",
  } = options;
  const budget = budgetOf(timeoutMs);
  const headers = { authorization: `Bearer ${config.apiKey}` };
  if (body !== undefined) headers["content-type"] = "application/json";

  let res;
  try {
    res = await fetch(`${config.baseUrl}${requestPath}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(budget),
    });
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    const message = clipText(scrubKey(err?.message ?? err, config.apiKey));
    if (timedOut) {
      throw cliError("E_PROVIDER_ERROR", `${source} 请求超时（${budget}ms）`, {
        source,
        reason: "timeout",
        timeoutMs: budget,
      });
    }
    throw cliError("E_PROVIDER_ERROR", `${source} 网络请求失败：${message}`, {
      source,
      reason: "network",
      providerMessage: message,
    });
  }

  const text = await res.text().catch(() => "");
  if (!res.ok) httpFailure(config, { status: res.status, text, source });
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw cliError("E_PROVIDER_ERROR", `${source} 响应不是合法 JSON`, {
      source,
      status: res.status,
      providerMessage: clipText(scrubKey(text, config.apiKey)),
    });
  }
}
