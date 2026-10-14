// ModelScope 的错误载荷形态不统一：message 可能是字符串、{errors:{message,request_id}}、errors[]，
// 直接 String(obj) 会打印成 [object Object]。这里统一压成一行人话，并顺手把 key 从任何文本里抹掉。

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

export function reasonOfText(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return describeFailure(parsed).slice(0, 300);
}

export function requestIdOf(payload) {
  const raw = payload?.request_id ?? payload?.errors?.request_id ?? payload?.trace_id;
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}
