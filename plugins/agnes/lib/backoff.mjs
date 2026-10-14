// 容量退避的「等多久」：阶梯 + provider 明示时长的解析（从 client.mjs 拆出，AGENTS.md §6 300 行约束）

// 索引 = 已重试次数，超出取最后一档（§3.3）。
// 实测（2026-10 真云）：20 秒内连发 3 次提交会**自己**把免费额度打成 429（旧阶梯 1s/2s 正是如此），
// 而 429 约 3.5 分钟自愈、间隔 ≥75s 完全不触发 → 首档 20s 起步，累计 450s 覆盖住恢复窗口；
// 总时长仍由 AGNES_TIMEOUT_MS 的总 deadline 收敛（client.mjs 里逐次校验），不会无限等。
export const QUEUE_BACKOFF_MS = [20000, 40000, 60000, 90000, 120000, 120000];

export function backoffFor(retryIndex) {
  return QUEUE_BACKOFF_MS[Math.min(retryIndex, QUEUE_BACKOFF_MS.length - 1)];
}

// retry-after 值换算：非法/负数一律当没给（宁可用自己的阶梯，也不要 NaN 或负睡眠）
function scaledMs(value, factor) {
  if (value === undefined || value === null || value === "") return undefined;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return undefined;
  return Math.round(num * factor);
}

// Retry-After header：允许秒数或 HTTP-date 两种形态
export function retryAfterHeaderMs(res) {
  const raw = typeof res?.headers?.get === "function" ? res.headers.get("retry-after") : null;
  if (raw === null || raw === undefined || raw === "") return undefined;
  const secs = scaledMs(raw, 1000);
  if (secs !== undefined) return secs;
  const at = Date.parse(String(raw));
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

// 等价字段：不同网关把等待时长塞在 body 里（顶层 / error / data），单位有 ms 也有 s
function retryAfterBodyMs(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  for (const holder of [parsed, parsed?.error, parsed?.data]) {
    if (holder === null || typeof holder !== "object") continue;
    const ms = scaledMs(holder.retry_after_ms ?? holder.retryAfterMs, 1);
    if (ms !== undefined) return ms;
    const secs = scaledMs(holder.retry_after ?? holder.retryAfter, 1000);
    if (secs !== undefined) return secs;
  }
  return undefined;
}

/** provider 明确说了等多久就照它等（header 优先于 body 字段），否则回退退避阶梯 */
export function retryWaitMs(got, retryIndex) {
  if (typeof got.retryAfterMs === "number") {
    return { waitMs: got.retryAfterMs, waitSource: "retry-after" };
  }
  const fromBody = retryAfterBodyMs(got.text);
  if (fromBody !== undefined) return { waitMs: fromBody, waitSource: "retry_after" };
  return { waitMs: backoffFor(retryIndex), waitSource: "backoff_ladder" };
}
