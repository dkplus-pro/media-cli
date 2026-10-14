import { httpError, isFatalHttp, rotateKeys, tryRequestJson } from "./client.mjs";
import { errorFieldText, parseMaybeJson, reasonOfText, requestIdOf, scrub } from "./error-text.mjs";
import { cliError } from "./errors.mjs";
import { stampWait } from "./retry-ledger.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SUBMIT_PATH = "/v1/videos";
// ⚠️ §1.2：官方文档的轮询路径不在 /v1 下（很反常，且是否需要 auth 未实测），待 V0 探测确认。
// 目前按文档实现并带上 Bearer（多带一个 header 不会被拒），失败时轮询错误会如实上报
const POLL_PATH = "/agnesapi";

/**
 * 字段位置按 §1.2 文档：`seconds` 是**字符串**（"4"–"12"）、`size` 只有 "720P"、
 * `mode` 必填、`images`/`audios` 是公网 URL 数组、`first_frame`/`last_frame` 成对。
 * 不发 `videos`（provider 明确不支持），也不发 `n`（固定 1）。
 */
export function buildVideoBody({
  model,
  prompt,
  mode,
  seconds,
  size,
  aspectRatio,
  images,
  audios,
  firstFrame,
  lastFrame,
  seed,
}) {
  const body = {
    model,
    prompt,
    mode,
    seconds: String(seconds),
    size,
    aspect_ratio: aspectRatio,
  };
  if (images !== undefined && images.length > 0) body.images = images;
  if (audios !== undefined && audios.length > 0) body.audios = audios;
  if (firstFrame !== undefined) body.first_frame = firstFrame;
  if (lastFrame !== undefined) body.last_frame = lastFrame;
  if (seed !== undefined) body.seed = seed;
  return body;
}

// 提交响应体字段名**待实测**（§1.2 V0），所以按常见形态逐个挖；挖不到就报结构化错误
export function taskIdOf(json) {
  const data = json?.data;
  for (const value of [
    json?.id,
    json?.video_id,
    json?.task_id,
    data?.id,
    data?.video_id,
    data?.task_id,
    typeof data === "string" ? data : undefined,
  ]) {
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

/**
 * 任务载荷既可能铺在顶层，也可能裹在 `data` 下（实测这网关每个错误体都带 `"data":null`，
 * 成功体则常把业务字段裹在里面）→ 两处都认，且 null/数组时不误钻（B5）。
 */
export function taskPayloadOf(json) {
  const data = json?.data;
  const wrapped =
    data !== null &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    (data.status !== undefined || data.url !== undefined || data.error !== undefined);
  return wrapped ? data : (json ?? {});
}

/**
 * 轮询期的「任务记录还没可见」必须当抖动（B5、Bug 3）：
 *   - 备选路由 `GET {base}/v1/videos/{id}` 对刚提交的任务回 **HTTP 400** "task not exist"
 *     （最终一致性空窗），而 isFatalHttp 把 400 判成参数错直接抛 → 一次空窗就作废已付费的生成；
 *   - 真云实测未知 id 的轮询还会把同一句话裹成 **200** 体里的
 *     `{"error":{"code":404,"message":"task not found (request id: …)"}}`。
 * 404 同理（只可能是记录尚不可见）；其他 4xx 仍是终态，照旧失败。
 * 这条正则是两处判定的唯一口径（isTransientTaskMiss 看 HTTP 层，pollOutcome 看 200 体）。
 */
const TASK_MISS_RE = /task\s*not\s*(?:found|exist)|task_not_exist|not\s*exist|任务不存在/i;

/**
 * 完成判定（§1.2）：`status === "completed"` 时取**顶层 `url`**（裹在 data 里也认）；
 * `internal_status` / `internal_progress` 一律忽略（实测示例里 status 已 completed 而
 * internal_status 仍是 pending，照它判等会永远等不到）。
 * 判失败要**两个条件之一**：非空且是人话的 error 文本，或显式的终态 status。
 * 两类骨架都不算失败（除非 status 自己就是终态）：
 *   - 全空 error（`{"error":{"code":"","message":""}}`，B5）
 *   - 只有数字 code/status（`{"error":{"code":0}}`、`{"error":{"code":200}}`，Bug 3）——
 *     那是状态码不是原因，error-text.mjs 已把它摊平成空串，光凭它判死等于白烧一次额度
 * 「task not found / task not exist」那类文本也不判死，当空窗继续等（见 TASK_MISS_RE）。
 */
export function pollOutcome(json) {
  const payload = taskPayloadOf(json);
  const status = String(payload?.status ?? "").toLowerCase();
  const terminal = ["failed", "error", "canceled", "cancelled"].includes(status);
  // 根级与 data 里的错误都认：裹在 data 里时根级仍可能挂着真错，不能只挖一层
  const errorText =
    errorFieldText(json?.error) ||
    errorFieldText(json?.errors) ||
    errorFieldText(payload?.error) ||
    errorFieldText(payload?.errors);
  if (errorText !== "" && !TASK_MISS_RE.test(errorText)) {
    return { kind: "failed", status, reason: errorText };
  }
  // 实测（未知 id 轮询）：这网关会把「任务记录还查不到」裹成 **200** 体里的
  // {"error":{"code":404,"message":"task not found (request id: …)"}}。
  // 它与 HTTP 400/404 那层空窗同构（isTransientTaskMiss 同一条正则），必须继续等而不是判死（Bug 3）；
  // 但 provider 明确给了终态 status 时仍以终态为准（空窗不背判死的锅，也不豁免真失败）。
  if (errorText !== "" && !terminal) {
    return { kind: "pending", status, url: undefined, transientReason: errorText };
  }
  if (terminal) {
    // 终态也要有人话原因：errorFieldText 绝不把空壳/数字骨架 stringify 成 JSON 冒充原因，
    // 只剩骨架时如实说「任务 failed」（B3 的口径：宁可不编造）
    return { kind: "failed", status, reason: errorFieldText(payload) || `任务 ${status}` };
  }
  const url = typeof payload?.url === "string" && payload.url !== "" ? payload.url : undefined;
  if (status === "completed" || status === "succeed" || status === "success") {
    if (url === undefined) {
      return { kind: "failed", status, reason: "任务已完成但响应里没有 url 字段" };
    }
    return { kind: "ready", status, url };
  }
  return { kind: "pending", status, url };
}

function videoTimeoutError(taskId, poll) {
  return cliError("E_PROVIDER_ERROR", "agnes 视频任务等待超时", {
    source: "agnes",
    reason: "timeout",
    taskId,
    ...(poll.misses === 0
      ? {}
      : { taskNotFoundResponses: poll.misses, lastPollMessage: poll.last }),
    hint: "任务可能仍在生成；额度已占用，稍后用 --no-wait 提交过的 taskId 再查",
  });
}

// 抖动文本一律 scrub：provider 的错误体里会回显 key（AGENTS.md §4 / §3.3）
function pollReason(config, got) {
  const reason = scrub(errorFieldText(parseMaybeJson(got.text)), config.keys).slice(0, 200);
  return reason === "" ? `HTTP ${got.status || "network"}` : reason;
}

// HTTP 层的「任务还查不到」判定（正则与判据见上面 TASK_MISS_RE）
export function isTransientTaskMiss(got) {
  if (got.ok) return false;
  if (got.status === 404) return true;
  return got.status === 400 && TASK_MISS_RE.test(reasonOfText(got.text));
}

function videoFailed(config, taskId, result) {
  const reason = scrub(result.reason || "任务失败", config.keys).slice(0, 300);
  throw cliError(
    "E_PROVIDER_ERROR",
    `agnes 视频任务失败（status=${result.status || "unknown"}）：${reason}`,
    {
      source: "agnes",
      taskId,
      ...(result.status === "" ? {} : { status: result.status }),
      message: reason,
    },
  );
}

/** 提交视频任务：与生图同一套 key 轮换 + 容量（429/503）退避策略（B1 修正 D22）。 */
export async function submitVideo(config, options) {
  const body = buildVideoBody(options);
  const deadline = options.deadline ?? Date.now() + config.timeoutMs;
  const { json, keyIndex } = await rotateKeys(config, {
    deadline,
    logger: options.logger,
    progress: options.progress,
    send: (key) =>
      tryRequestJson(
        config,
        `${config.baseUrl}${SUBMIT_PATH}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        key,
      ),
  });
  const requestId = requestIdOf(json);
  const taskId = taskIdOf(json);
  if (taskId === undefined) {
    throw cliError("E_PROVIDER_ERROR", "agnes 视频提交响应里没有任务 id（字段名待实测）", {
      source: "agnes",
      reason: "no_task_id",
      keyIndex,
      ...(requestId === undefined ? {} : { requestId }),
      body: scrub(JSON.stringify(json).slice(0, 300), config.keys),
    });
  }
  return { taskId, keyIndex, ...(requestId === undefined ? {} : { requestId }) };
}

/**
 * 轮询钉住提交那把 key（D23：任务属于提交它的账号）。
 * 限流/5xx/网络抖动/「task not exist」空窗/200 体里的 task not found 一律继续等，
 * 由总 deadline 收敛——不作废一次已付费的生成（B5、Bug 3）。
 * 抖动同时逐次 warn（stderr）并记进 progress 账本（B4）：--json 下壳把 info 与 warn 都屏蔽，
 * 只靠 stderr 的话 200 秒的重试风暴在调用方看来就是彻底的空输出。
 * Bug 1：抖动行只在**确认还会再睡一轮**时才把这一轮的等待计入账本；超时抛错前的最后一次
 * 不睡，所以它既不计等待、也不算一次重试（口径与 client.mjs 完全一致，见 retry-ledger.mjs）。
 */
export async function pollVideo(config, { taskId, model, keyIndex, deadline, logger, progress }) {
  const url = `${config.baseUrl}${POLL_PATH}?video_id=${encodeURIComponent(taskId)}&model_name=${encodeURIComponent(model)}`;
  const key = config.keys[keyIndex];
  const waitMs = config.pollIntervalMs;
  const poll = { misses: 0, last: "" };
  // 抖动先攒着，落账要等到确认「真会再睡一轮」之后（同一份判定同时决定 return 还是 sleep）
  let pending = null;
  const note = (kind, status, message) => {
    poll.misses += kind === "task_missing" ? 1 : 0;
    poll.last = message;
    pending = { kind, status, message };
    logger?.warn(
      `agnes ${kind === "task_missing" ? "轮询暂时查不到任务" : "轮询抖动"}（HTTP ${status}），继续等：${message}`,
    );
  };
  for (;;) {
    const got = await tryRequestJson(config, url, {}, key);
    if (got.ok) {
      const result = pollOutcome(got.json);
      if (result.kind === "failed") videoFailed(config, taskId, result);
      if (result.kind === "ready") {
        const requestId = requestIdOf(got.json);
        logger?.info(`agnes 视频完成（status=${result.status}）`);
        return {
          url: result.url,
          status: result.status,
          ...(requestId === undefined ? {} : { requestId }),
        };
      }
      // 200 体里的「task not found」也是空窗（实测未知 id 就这么回），同样记账继续等
      if (result.transientReason !== undefined) {
        note("task_missing", got.status, result.transientReason);
      }
    } else if (isTransientTaskMiss(got)) {
      note("task_missing", got.status, pollReason(config, got));
    } else if (got.transport === "malformed" || isFatalHttp(got)) {
      throw httpError(config, got, { taskId });
    } else {
      note("poll_unavailable", got.status, pollReason(config, got));
    }
    // 本轮之后还会不会睡，只读一次时钟：落账与超时判定共用它，二者不可能给出矛盾的账
    const willWaitAgain = Date.now() + waitMs <= deadline;
    if (pending !== null) {
      progress?.record(
        stampWait(pending, {
          waitMs,
          waitSource: "poll_interval",
          willWait: willWaitAgain,
        }),
      );
      pending = null;
    }
    if (!willWaitAgain) throw videoTimeoutError(taskId, poll);
    await sleep(waitMs);
  }
}
