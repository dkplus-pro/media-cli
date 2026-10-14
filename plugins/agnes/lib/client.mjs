import { retryAfterHeaderMs, retryWaitMs } from "./backoff.mjs";
import { errorFieldText, parseMaybeJson, reasonOfText, requestIdOf, scrub } from "./error-text.mjs";
import { cliError } from "./errors.mjs";
import { retryTally, retryTallyPhrase, stampWait } from "./retry-ledger.mjs";

// 阶梯与 retry-after 解析拆在 lib/backoff.mjs（AGENTS.md §6 的 300 行约束）；
// 对外仍从 client.mjs 再导出，调用方与测试的 import 面不变
export { backoffFor, QUEUE_BACKOFF_MS } from "./backoff.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const QUEUE_FULL_STATUS = 503;
export const RATE_LIMIT_STATUS = 429;

// 只有鉴权失效（key 被吊销/过期）才值得换下一把；5xx（容量类除外）与网络抖动一并换 key
const ROTATE_STATUS = new Set([401, 403]);
// 容量类失败：provider 侧通道饱和，与 key 无关
// ⚠️ 本行**取代计划 D22**（原文把 429 归入换 key）：2026-10 真云实测视频通道饱和
// 66 分钟 / 46 次仍 503，而同一时刻图片通道 200 → per-lane 容量问题，不是鉴权也不是额度；
// 按 D22 换 key 时单 key 池「遍历一圈」当场走完，首个 429 就抛 allKeysFailed，
// AGNES_MAX_RETRIES 形同废纸（实测 AGNES_MAX_RETRIES=20 却在 16.7s / 3 次提交后死掉）。
const CAPACITY_STATUS = new Set([QUEUE_FULL_STATUS, RATE_LIMIT_STATUS]);

// 请求层不抛错：由调用方按 transport/status 决定换 key、退避重试还是直接失败
export async function tryRequestJson(config, url, init, key) {
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
  if (!res.ok) {
    const retryAfterMs = retryAfterHeaderMs(res);
    return {
      ok: false,
      transport: "http",
      status: res.status,
      text,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  }
  try {
    return { ok: true, json: JSON.parse(text) };
  } catch {
    return { ok: false, transport: "malformed", status: res.status, text };
  }
}

// 队列满（503，或正文自陈 queue is full）
export function isQueueFull(got) {
  if (got.ok) return false;
  if (got.status === QUEUE_FULL_STATUS) return true;
  return /queue is full/i.test(reasonOfText(got.text));
}

// 容量类 = 队列满 ∪ 429 限流：两者都只在同一把 key 上原地退避（见 CAPACITY_STATUS 注释）
export function isCapacityError(got) {
  if (got.ok) return false;
  if (CAPACITY_STATUS.has(got.status)) return true;
  return isQueueFull(got) || /rate limit/i.test(reasonOfText(got.text));
}

// 参数类 4xx（含实测的 400）：换 key 与退避重试都没意义，直接收敛为一次失败
export function isFatalHttp(got) {
  return (
    got.transport === "http" &&
    !ROTATE_STATUS.has(got.status) &&
    !isCapacityError(got) &&
    got.status < 500 &&
    got.status !== 0
  );
}

// provider 原文摊平：只认**非空**错误字段（message/detail/code…）。
// 实测这网关会回 {"error":{"code":"","message":""}} 这种全空骨架，照旧写法会把 JSON
// 骨架当成人话塞进 message（B3：宁可退化成 `HTTP 503` 也不编造原因，原文仍留在 details.body）
function attemptMessage(config, got) {
  return scrub(errorFieldText(parseMaybeJson(got.text)), config.keys).slice(0, 300);
}

function statusDetails(got) {
  return got.status === 0 ? {} : { status: got.status };
}

export function malformedError(config, got, extra) {
  return cliError("E_PROVIDER_ERROR", "agnes 响应不是合法 JSON", {
    source: "agnes",
    reason: "malformed",
    body: scrub(got.text.slice(0, 300), config.keys),
    ...extra,
  });
}

// 400 一类参数错：details.message 是摊平后的人话（provider 原文），details.requestId 便于报障
export function httpError(config, got, extra) {
  if (got.transport === "malformed") return malformedError(config, got, extra);
  const reason = attemptMessage(config, got);
  const requestId = requestIdOf(safeJson(config, got.text));
  return cliError(
    "E_PROVIDER_ERROR",
    `agnes 请求失败（HTTP ${got.status}）${reason === "" ? "" : `：${reason}`}`,
    {
      source: "agnes",
      ...statusDetails(got),
      ...(reason === "" ? {} : { message: reason }),
      ...(requestId === undefined ? {} : { requestId }),
      body: scrub(got.text.slice(0, 300), config.keys),
      ...extra,
    },
  );
}

function safeJson(config, text) {
  const parsed = parseMaybeJson(text);
  return typeof parsed === "string" ? reasonOfText(scrub(parsed, config.keys)) : parsed;
}

// B3：通道名（image/video）一律照 provider 原文，绝不写死我们没观察到的那一侧
function capacityExhaustedError(config, attempts, lastGot) {
  const requestId = requestIdOf(safeJson(config, lastGot.text));
  const cause = attemptMessage(config, lastGot);
  // Bug 2：重试次数只从账本算（口径见 retry-ledger.mjs），与 progress 的 warning 同源，
  // 二者不可能一个说 8、一个说 9。rotate 条目不是容量被拒，不参与这本账。
  const tally = retryTally(attempts.filter((a) => a.kind !== "rotate"));
  return cliError(
    "E_PROVIDER_ERROR",
    `agnes 容量饱和，同一把 key 上${retryTallyPhrase(tally)}，provider 仍未放行` +
      `${cause === "" ? "" : `：${cause}`}`,
    {
      source: "agnes",
      reason: "queue_full_exhausted",
      maxRetries: config.maxRetries,
      keyCount: config.keys.length,
      // 结构化同一份账：调用方按 waitedMs 估重试预算，不必再从消息里抠数字（Bug 1）
      rejected: tally.rejected,
      retried: tally.retries,
      waitedMs: tally.waitedMs,
      attempts,
      ...(requestId === undefined ? {} : { requestId }),
      hint:
        "provider 侧通道容量饱和/限流，与 key 无关；可加大 AGNES_MAX_RETRIES 或 AGNES_TIMEOUT_MS，" +
        "或降低并发、隔几分钟再跑（实测 429 约 3.5 分钟自愈）",
    },
  );
}

// B2：单 key 池说「1 把 key 均不可用」是误导——把真实原因与请求次数摊开，不甩锅给 key
function allKeysFailed(config, attempts) {
  const last = attempts[attempts.length - 1];
  const cause = last?.message ?? "";
  const note =
    config.keys.length === 1
      ? `key 池只有 1 把（无从换 key），已发起 ${attempts.length} 次请求仍失败`
      : `key 池 ${config.keys.length} 把已全部试过（${attempts.length} 次请求）仍失败`;
  return cliError("E_PROVIDER_ERROR", `agnes ${note}${cause === "" ? "" : `：${cause}`}`, {
    source: "agnes",
    reason: "all_keys_failed",
    keyCount: config.keys.length,
    attempts,
  });
}

/**
 * 同一把 key 上的容量退避重试（B1）：429 与 503 都原地退避，撞满 AGNES_MAX_RETRIES
 * 或下一步会越过总 deadline 才让位给 key 轮换。每次被拒都记进调用方共享的 attempts，
 * 所以最终错误里 503/429 的原文一条都不会丢（B2）。
 * Bug 1：「这次被拒之后到底会不会睡」必须在落账前定死——旧写法先按阶梯把 waitMs 记进账本，
 * 再在 `retry >= maxRetries` / 越过 deadline 两处直接 return，于是账本里多出一笔从没执行的等待
 * （真云实测三次：报 810000/330000/210000ms，实睡 690100/210000/120000ms，差额正好是那一步）。
 */
async function withCapacityRetry(config, { send, keyIndex, logger, progress, deadline, attempts }) {
  for (let retry = 0; ; retry++) {
    const got = await send(config.keys[keyIndex], keyIndex);
    if (got.ok || !isCapacityError(got)) return got;
    const { waitMs, waitSource } = retryWaitMs(got, retry);
    // 预算与 deadline 的判定合进同一个布尔，落账与 return/sleep 共用它（口径见 retry-ledger.mjs）
    const willWait = retry < config.maxRetries && Date.now() + waitMs <= deadline;
    const attempt = stampWait(
      {
        keyIndex,
        kind: got.status === RATE_LIMIT_STATUS ? "rate_limit" : "queue_full",
        ...statusDetails(got),
        // B3：原因照 provider 原文；原文是空骨架时退化成 `HTTP 503`，绝不编造通道名
        message: attemptMessage(config, got) || `HTTP ${got.status}`,
      },
      { waitMs, waitSource, willWait },
    );
    attempts.push(attempt);
    progress?.record(attempt);
    if (!willWait) return got;
    // B4：逐次 warn 走 stderr（human 与 --json --verbose 可见）；纯 --json 下壳连 warn 一起
    // 屏蔽（src/core/output/logger.ts:19,22），所以同一份账本还须经 progress 汇总成 envelope
    // 的 warnings[] —— 不许在这里直接写流（§4.1）
    logger?.warn(
      `agnes 容量饱和（HTTP ${got.status}），${waitMs}ms 后同 key 重试` +
        `（第 ${retry + 1}/${config.maxRetries} 次，等待取自 ${waitSource}）`,
    );
    await sleep(waitMs);
  }
}

/**
 * 提交期：随机起点、在 key 池内遍历一圈（D23）。
 * 429/503 容量 → 同一把 key 原地退避，用完这把 key 的预算才换下一把（B1，取代 D22）；
 * 401/403/5xx(非容量)/网络错 → 换下一把；400 一类参数错 → 立即抛错，既不重试也不换 key。
 * 返回成功那次的响应体与 keyIndex（异步任务的轮询必须钉住这把 key）。
 */
export async function rotateKeys(config, { send, logger, progress, deadline }) {
  const total = config.keys.length;
  const start = Math.floor(Math.random() * total);
  const attempts = [];
  let lastCapacity;
  for (let i = 0; i < total; i++) {
    const keyIndex = (start + i) % total;
    const got = await withCapacityRetry(config, {
      send,
      keyIndex,
      logger,
      progress,
      deadline,
      attempts,
    });
    if (got.ok) return { json: got.json, keyIndex };
    if (got.transport === "malformed") throw malformedError(config, got, { attempts });
    if (isCapacityError(got)) {
      // attempts 已由 withCapacityRetry 逐次记满，这里只留最后一次的响应用于取名/取 id
      lastCapacity = got;
      continue;
    }
    if (isFatalHttp(got)) throw httpError(config, got, { attempts });
    attempts.push({
      keyIndex,
      kind: "rotate",
      ...statusDetails(got),
      message: attemptMessage(config, got),
    });
  }
  if (lastCapacity !== undefined) throw capacityExhaustedError(config, attempts, lastCapacity);
  throw allKeysFailed(config, attempts);
}

// 结果文件是另一个域（实测 platform-outputs.agnes-ai.space），沿用 modelscope 做法：不带 Authorization
export async function downloadBytes(config, url, stage) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(config.timeoutMs) });
  } catch (err) {
    throw cliError(
      "E_PROVIDER_ERROR",
      `agnes 结果下载失败：${scrub(String(err?.message ?? err), config.keys)}`,
      { source: "agnes", ...(stage === undefined ? {} : { stage }), url },
    );
  }
  if (!res.ok) {
    throw cliError("E_PROVIDER_ERROR", `agnes 结果下载失败（HTTP ${res.status}）`, {
      source: "agnes",
      ...(stage === undefined ? {} : { stage }),
      status: res.status,
      url,
    });
  }
  return Buffer.from(await res.arrayBuffer());
}
