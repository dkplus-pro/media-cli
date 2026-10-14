// agnes 的错误载荷形态不止一种：image 端是 {error:{message,type,code}}（OpenAI 风格，
// type 可能是 "AgnesAI_error"），video 端是 400 + 单个 detail 键，queue 满是 503 + 空 type。
// 直接 String(obj) 会打印成 [object Object]，这里统一压成一行人话，并顺手把 key 从文本里抹掉。

// 任何 provider 文本进 message/details/data 前都要过一遍：输出里永不出现 key 原文
export function scrub(text, keys) {
  let out = text;
  for (const key of keys) {
    if (key && key.length >= 8) out = out.split(key).join("***");
  }
  return out;
}

export function describeFailure(payload, depth = 0) {
  if (typeof payload === "string") return payload.trim();
  if (typeof payload === "number" || typeof payload === "boolean") return String(payload);
  if (depth > 4 || payload === undefined || payload === null) return "";
  if (Array.isArray(payload)) {
    return payload
      .map((item) => describeFailure(item, depth + 1))
      .filter(Boolean)
      .join("; ");
  }
  if (typeof payload === "object") {
    for (const field of ["message", "msg", "detail", "error", "errors", "logs"]) {
      const nested = describeFailure(payload[field], depth + 1);
      if (nested !== "") return nested;
    }
    return JSON.stringify(payload);
  }
  return "";
}

// error / errors 字段专用摊平。与 describeFailure 的唯一区别：**绝不**把空壳对象
// stringify 成 JSON 冒充错误文本——实测这网关会回 {"error":{"code":"","message":""}} 这种
// 全空字段（轮询时照 describeFailure 判就把正常任务当成终态失败，B5）。
// Bug 3 补第二道闸：**数字**（HTTP 状态码那类）同样不是人话原因。真云实测未知 id 的轮询体是
// {"error":{"code":404,"message":"task not found (request id: …)"}}，而 {"error":{"code":0}} /
// {"error":{"code":200}} 这种只有数字的骨架也的确会出现；旧写法把 0/200 stringify 成非空文本，
// video.mjs 就把它当终态 → 一次空窗作废已经扣费的生成。
const DIGITS_ONLY_RE = /^\d+$/;

export function errorFieldText(value, depth = 0) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  // 数字/布尔是状态那类东西，不是人话（Bug 3）；要文本请去 message/detail 那一层拿
  if (typeof value === "number" || typeof value === "boolean") return "";
  if (depth > 4) return "";
  if (Array.isArray(value)) {
    return value
      .map((item) => errorFieldText(item, depth + 1))
      .filter(Boolean)
      .join("; ");
  }
  if (typeof value !== "object") return "";
  for (const field of ["message", "msg", "detail", "reason", "error", "errors", "code", "logs"]) {
    const nested = errorFieldText(value[field], depth + 1);
    if (nested === "") continue;
    // code 常常就是 HTTP 状态码：数字已被摊成空串，字符串形态的纯数字（"404"）在这里一并拦掉，
    // 而 rate_limit_exceeded / invalid_request 这类语义 code 照旧算信号
    if (field === "code" && DIGITS_ONLY_RE.test(nested)) continue;
    return nested;
  }
  return "";
}

// 网关正文既可能是 JSON 也可能是纯文本：解析失败就原样当文本处理，绝不抛错
export function parseMaybeJson(text) {
  try {
    return JSON.parse(text ?? "");
  } catch {
    return typeof text === "string" ? text : "";
  }
}

export function reasonOfText(text) {
  return describeFailure(parseMaybeJson(text)).slice(0, 300);
}

// 实测（§1.1）：agnes 把请求 id 塞在 message 文本里（"… (request id: xxx)"），
// 而不是独立字段；两种形态都兼容，便于报障时对齐 provider 日志
const REQUEST_ID_RE = /request id:\s*([^)\s,]+)/i;
// 不认 id / video_id：那是任务 id 不是请求 id，混进 requestId 会误导报障
const ID_FIELDS = ["request_id", "requestId", "trace_id"];

export function requestIdOf(payload) {
  for (const field of ID_FIELDS) {
    const value = payload?.[field];
    if (typeof value === "string" && value !== "") return value;
  }
  const nested = payload?.errors?.request_id;
  if (typeof nested === "string" && nested !== "") return nested;
  const match = REQUEST_ID_RE.exec(describeFailure(payload));
  return match === null ? undefined : match[1];
}
