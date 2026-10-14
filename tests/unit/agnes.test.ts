import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import manifest from "../../plugins/agnes/index.mjs";
import { retryWaitMs } from "../../plugins/agnes/lib/backoff.mjs";
import {
  backoffFor,
  isCapacityError,
  isFatalHttp,
  isQueueFull,
  QUEUE_BACKOFF_MS,
  rotateKeys,
} from "../../plugins/agnes/lib/client.mjs";
import { parseImageSize } from "../../plugins/agnes/lib/commands.mjs";
import { DEFAULT_BASE_URL, loadConfig, parseKeys } from "../../plugins/agnes/lib/env.mjs";
import {
  describeFailure,
  errorFieldText,
  reasonOfText,
  requestIdOf,
  scrub,
} from "../../plugins/agnes/lib/error-text.mjs";
import { buildImageBody } from "../../plugins/agnes/lib/image.mjs";
import { defaultOutputName, summarizeRefs } from "../../plugins/agnes/lib/output.mjs";
import { createRetryProgress } from "../../plugins/agnes/lib/progress.mjs";
import {
  assertCount,
  assertPublicUrls,
  resolveRef,
  splitRefs,
  toDataUri,
} from "../../plugins/agnes/lib/refs.mjs";
import { retryTally, retryTallyPhrase, stampWait } from "../../plugins/agnes/lib/retry-ledger.mjs";
import {
  buildVideoBody,
  isTransientTaskMiss,
  pollOutcome,
  pollVideo,
  taskIdOf,
  taskPayloadOf,
} from "../../plugins/agnes/lib/video.mjs";

interface CliErr extends Error {
  code: string;
  details?: Record<string, unknown>;
}

// client.mjs 的 tryRequestJson 返回形态（单测里手工造，不走网络）
interface FakeGot {
  ok: boolean;
  transport?: string;
  status?: number;
  text?: string;
  json?: unknown;
  retryAfterMs?: number;
}

// 账本行（retry-ledger.mjs 的 stampWait 产物）：retryAfterMs 是「计划等多久」，
// waited/waitedMs 才是「真睡了没、睡了多久」——Bug 1 的全部要害在这两个字段上
interface CapacityAttempt {
  keyIndex: number;
  status: number;
  message: string;
  retryAfterMs: number;
  waitSource: string;
  waited: boolean;
  waitedMs: number;
}

// 与 tencent-cos.test.ts 同风格：把抛出的鸭子类型错误取回来做断言，而不是用 toThrow 只看个码
function capture(fn: () => unknown): CliErr {
  try {
    fn();
  } catch (err) {
    return err as CliErr;
  }
  throw new Error("expected a coded error");
}

async function captureAsync(fn: () => Promise<unknown>): Promise<CliErr> {
  try {
    await fn();
  } catch (err) {
    return err as CliErr;
  }
  throw new Error("expected a coded error");
}

// 实测（2026-10 真云）容量类响应：503 queue full 与 429 rate_limit_exceeded 同族
// retryAfterMs=0 → 单测里让退避真的睡 0ms（阶梯已改成 20s 起步）
const capacityReply = (status: number, message: string): FakeGot => ({
  ok: false,
  transport: "http",
  status,
  retryAfterMs: 0,
  text: JSON.stringify({
    error: { message, type: status === 429 ? "AgnesAI_error" : "", param: "", code: null },
    data: null,
  }),
});

function fakeLogger() {
  const warns: string[] = [];
  const infos: string[] = [];
  return {
    warns,
    logger: { warn: (m: string) => warns.push(m), info: (m: string) => infos.push(m) },
  };
}

const okReply = (json: unknown): FakeGot => ({ ok: true, json });

function scripted(seq: FakeGot[]) {
  const state = { sent: 0, keysUsed: [] as string[] };
  const send = async (key: string) => {
    state.keysUsed.push(key);
    return seq[Math.min(state.sent++, seq.length - 1)];
  };
  return { state, send };
}

// 容量被拒 + provider 明示的等待时长（用几十毫秒的短值：真睡下去，但用例只跑百毫秒级）
const waitedCapacityReply = (status: number, message: string, waitMs: number): FakeGot => ({
  ...capacityReply(status, message),
  retryAfterMs: waitMs,
});

// 账本文案里三个数的抠法：progress 的 E_PROVIDER_RETRY warning 与 client 的 E_PROVIDER_ERROR
// 消息共用 retry-ledger.mjs 的同一句话，所以两条文案都能用同一组正则读出同一个数（Bug 1/Bug 2）
const RETRIED_RE = /已原地退避重试 (\d+) 次/;
const REJECTED_RE = /未放行请求 (\d+) 次/;
const WAITED_RE = /实际累计等待 (\d+)ms/;
const PHRASE_RE = /已原地退避重试 \d+ 次（[^）]*）/;

function numOf(text: string, re: RegExp): number {
  const match = re.exec(text);
  if (match === null) throw new Error(`账本文案里抠不到 /${re.source}/：${text}`);
  return Number(match[1]);
}

function phraseOf(text: string): string {
  const match = PHRASE_RE.exec(text);
  if (match === null) throw new Error(`文案里没有共用的账本短语：${text}`);
  return match[0];
}

describe("agnes env 契约（§3.2）", () => {
  it("缺 key 且没有池 → E_CONFIG，details.var 指向 AGNES_API_KEY", () => {
    const err = capture(() => loadConfig({}));
    expect(err.code).toBe("E_CONFIG");
    expect(err.details?.var).toBe("AGNES_API_KEY");
  });

  it("AGNES_KEY_POOL 为空串视为未设置，退回单 key（.zshrc 里常写空占位）", () => {
    expect(parseKeys({ AGNES_KEY_POOL: "  ", AGNES_API_KEY: "k1" })).toEqual(["k1"]);
  });

  it("池优先于单 key，逗号分隔并按 trim 去空白", () => {
    expect(parseKeys({ AGNES_KEY_POOL: " k1 , k2 ,,k3", AGNES_API_KEY: "ignored" })).toEqual([
      "k1",
      "k2",
      "k3",
    ]);
  });

  it("默认值：base url 不带 /v1、模型 id 内置、超时 360s、轮询 2s、重试 6 次", () => {
    const config = loadConfig({ AGNES_API_KEY: "k" });
    expect(config).toEqual({
      baseUrl: DEFAULT_BASE_URL,
      keys: ["k"],
      imageModel: "agnes-image-2.5-flash",
      videoModel: "agnes-video-2.5-flash",
      timeoutMs: 360000,
      pollIntervalMs: 2000,
      maxRetries: 6,
    });
  });

  it("D24：误填带 /v1 与尾斜杠的 base url 都能裁掉", () => {
    const trim = (value: string) =>
      loadConfig({ AGNES_API_KEY: "k", AGNES_BASE_URL: value }).baseUrl;
    expect(trim("https://apihub.agnes-ai.com/v1")).toBe("https://apihub.agnes-ai.com");
    expect(trim("https://apihub.agnes-ai.com/v1/")).toBe("https://apihub.agnes-ai.com");
    expect(trim("http://127.0.0.1:9911/")).toBe("http://127.0.0.1:9911");
    // D24 的裁法是「尾部那一段 /v1 一律裁掉」，所以带子路径并恰好以 /v1 结尾的 base 也会被裁；
    // mock 用例走的是无路径 endpoint，不受影响
    expect(trim("http://127.0.0.1:9911/api/v1/")).toBe("http://127.0.0.1:9911/api");
    expect(trim("http://127.0.0.1:9911/api/v3")).toBe("http://127.0.0.1:9911/api/v3");
  });

  it("模型 id 可被 env 覆盖（空串退回内置默认），超时非法 → E_CONFIG", () => {
    const config = loadConfig({
      AGNES_API_KEY: "k",
      AGNES_IMAGE_MODEL: "agnes-image-2.1-flash",
      AGNES_VIDEO_MODEL: "custom-video",
      AGNES_TIMEOUT_MS: "1234",
      AGNES_POLL_INTERVAL_MS: "50",
      AGNES_MAX_RETRIES: "0",
    });
    expect(config.imageModel).toBe("agnes-image-2.1-flash");
    expect(config.videoModel).toBe("custom-video");
    expect(config.timeoutMs).toBe(1234);
    expect(config.pollIntervalMs).toBe(50);
    expect(config.maxRetries).toBe(0);
    expect(capture(() => loadConfig({ AGNES_API_KEY: "k", AGNES_TIMEOUT_MS: "0" })).code).toBe(
      "E_CONFIG",
    );
    expect(capture(() => loadConfig({ AGNES_API_KEY: "k", AGNES_BASE_URL: "ftp://x" })).code).toBe(
      "E_CONFIG",
    );
  });
});

describe("agnes 错误文本摊平（§1.1 载荷形态不统一）", () => {
  it("describeFailure 挖出 {error:{message}} / {detail} / 纯字符串三种形态", () => {
    expect(
      describeFailure({
        error: {
          message: 'size has invalid value "8K"; must be one of: 1K, 2K, 3K, 4K, or WIDTHxHEIGHT',
          type: "invalid_request",
          param: "",
          code: "invalid_request",
        },
      }),
    ).toContain('size has invalid value "8K"');
    expect(describeFailure({ detail: "size must be 720P" })).toBe("size must be 720P");
    expect(describeFailure("  boom  ")).toBe("boom");
    expect(describeFailure({ errors: [{ message: "a" }, { message: "b" }] })).toBe("a; b");
    expect(describeFailure(undefined)).toBe("");
  });

  it("reasonOfText 对非 JSON 文本原样返回，超长截到 300 字符", () => {
    expect(reasonOfText('{"error":{"message":"nope"}}')).toBe("nope");
    expect(reasonOfText("plain text")).toBe("plain text");
    expect(reasonOfText(`{"message":"${"x".repeat(500)}"}`)).toHaveLength(300);
  });

  it("errorFieldText：全空 error 骨架返回空串，绝不 stringify 空壳冒充原因（B5 的地基）", () => {
    expect(errorFieldText({ error: { code: "", message: "" } })).toBe("");
    expect(errorFieldText({ error: { code: "", message: "" }, data: null })).toBe("");
    expect(errorFieldText([])).toBe("");
    expect(errorFieldText(null)).toBe("");
    expect(errorFieldText({ error: { message: "video queue is full" } })).toBe(
      "video queue is full",
    );
    // 只有 code 也算信号（不能整个丢掉）
    expect(errorFieldText({ error: { message: "", code: "rate_limit_exceeded" } })).toBe(
      "rate_limit_exceeded",
    );
  });

  it("errorFieldText（Bug 3）：数字/纯数字状态码不是人话原因，一律摊成空串", () => {
    // 真云实测：这网关会把 HTTP 状态码塞进 error.code —— {"error":{"code":404,"message":"…"}}
    // 以及只有数字的骨架 {"error":{"code":0}} / {"error":{"code":200}}。
    // 旧写法把数字 stringify 成非空文本，轮询侧就据此把已付费的任务判死
    expect(errorFieldText({ error: { code: 0 } })).toBe("");
    expect(errorFieldText({ error: { code: 200 } })).toBe("");
    expect(errorFieldText({ error: { code: 404 } })).toBe("");
    expect(errorFieldText({ error: { message: "", code: 404 } })).toBe("");
    expect(errorFieldText({ code: "404", message: "" })).toBe(""); // 字符串形态的状态码同样不算
    expect(errorFieldText({ error: 404 })).toBe("");
    expect(errorFieldText(0)).toBe("");
    expect(errorFieldText(true)).toBe("");
    expect(errorFieldText({ errors: [{ code: 500 }, { code: 502 }] })).toBe("");
    // 语义 code 与非数字文本照旧算信号（宽容不许变成漏判）
    expect(errorFieldText({ error: { code: 404, message: "task not found" } })).toBe(
      "task not found",
    );
    expect(errorFieldText({ error: { code: 400, message: "gpu oom" } })).toBe("gpu oom");
  });

  it("scrub 把长度 ≥8 的 key 从任意文本里抹掉", () => {
    expect(scrub("auth failed for ag-test-secret-key", ["ag-test-secret-key"])).toBe(
      "auth failed for ***",
    );
    expect(scrub("短 key 不参与替换", ["abc"])).toBe("短 key 不参与替换");
  });

  it("requestIdOf 兼容独立字段与 message 内联的 (request id: …)", () => {
    expect(requestIdOf({ request_id: "req-1" })).toBe("req-1");
    expect(
      requestIdOf({
        error: { message: "image queue is full, please retry later (request id: req-9f2c)" },
      }),
    ).toBe("req-9f2c");
    expect(requestIdOf("bad key (request id: req-7)")).toBe("req-7");
    // id / video_id 是任务 id，不能被当成 requestId
    expect(requestIdOf({ id: "vid-1", status: "queued" })).toBeUndefined();
    expect(requestIdOf(undefined)).toBeUndefined();
  });
});

describe("agnes 容量类 vs 换 key 的判据（B1 修正计划 D22）", () => {
  it("503 queue full 与 429 rate limit 同族：都算容量类，换 key 无意义", () => {
    expect(isQueueFull({ ok: false, transport: "http", status: 503, text: "{}" })).toBe(true);
    expect(
      isQueueFull({
        ok: false,
        transport: "http",
        status: 429,
        text: '{"error":{"message":"image queue is full, please retry later"}}',
      }),
    ).toBe(true);
    expect(isQueueFull({ ok: false, transport: "http", status: 500, text: "boom" })).toBe(false);
    expect(isQueueFull({ ok: true, json: {} })).toBe(false);
    // 429 光是状态码就够判容量（不必依赖正文措辞）——D22 当年正是漏在这里
    expect(isCapacityError({ ok: false, transport: "http", status: 429, text: "{}" })).toBe(true);
    expect(isCapacityError({ ok: false, transport: "http", status: 503, text: "{}" })).toBe(true);
    expect(
      isCapacityError({
        ok: false,
        transport: "http",
        status: 429,
        text: '{"error":{"code":"rate_limit_exceeded","message":"rate limit"}}',
      }),
    ).toBe(true);
    expect(isCapacityError({ ok: false, transport: "http", status: 401, text: "{}" })).toBe(false);
    expect(isCapacityError({ ok: false, transport: "http", status: 500, text: "boom" })).toBe(
      false,
    );
    expect(isCapacityError({ ok: true, json: {} })).toBe(false);
  });

  it("400 是参数错（唯一不重试不换 key）；401/403/5xx/网络错才换 key；429 不再算参数错", () => {
    expect(isFatalHttp({ ok: false, transport: "http", status: 400, text: "{}" })).toBe(true);
    expect(isFatalHttp({ ok: false, transport: "http", status: 401, text: "{}" })).toBe(false);
    // B1 的核心回归：旧代码把 429 判成 fatal-with-rotation，单 key 池直接死
    expect(isFatalHttp({ ok: false, transport: "http", status: 429, text: "{}" })).toBe(false);
    expect(isFatalHttp({ ok: false, transport: "http", status: 503, text: "{}" })).toBe(false);
    expect(isFatalHttp({ ok: false, transport: "http", status: 500, text: "x" })).toBe(false);
    expect(isFatalHttp({ ok: false, transport: "network", status: 0, text: "timeout" })).toBe(
      false,
    );
  });

  it("退避阶梯必须跨过实测 3.5 分钟的 429 恢复窗口，且首档不再 1s/2s 连发（B1）", () => {
    expect(backoffFor(0)).toBe(20000);
    expect(backoffFor(5)).toBe(120000);
    expect(backoffFor(99)).toBe(120000);
    // 实测：20 秒内连发 3 次提交会自己打出 429 → 首档必须 ≥20s
    expect(QUEUE_BACKOFF_MS[0]).toBeGreaterThanOrEqual(20000);
    // 实测：429 约 3.5 分钟自愈 → 累计等待要能熬过它（总时长另有 deadline 收敛）
    const cumulative = QUEUE_BACKOFF_MS.reduce((sum, ms) => sum + ms, 0);
    expect(cumulative).toBeGreaterThanOrEqual(210000);
  });

  it("provider 明示的等待时长优先于阶梯：header > body 字段 > 阶梯", () => {
    const base = { ok: false, transport: "http", status: 503 } as FakeGot;
    expect(retryWaitMs({ ...base, retryAfterMs: 120000, text: "{}" }, 0)).toEqual({
      waitMs: 120000,
      waitSource: "retry-after",
    });
    // header 赢过 body（两个都在时以协议头为准）
    expect(
      retryWaitMs({ ...base, retryAfterMs: 90000, text: '{"error":{"retry_after_ms":2500}}' }, 0)
        .waitSource,
    ).toBe("retry-after");
    expect(
      retryWaitMs({ ...base, text: '{"error":{"message":"m","retry_after_ms":2500}}' }, 0),
    ).toEqual({ waitMs: 2500, waitSource: "retry_after" });
    // 秒形态与非法值（负数/空串）——非法就退回阶梯，绝不睡负数
    expect(retryWaitMs({ ...base, text: '{"retry_after":3}' }, 0).waitMs).toBe(3000);
    expect(retryWaitMs({ ...base, text: '{"retry_after":-3}' }, 1)).toEqual({
      waitMs: 40000,
      waitSource: "backoff_ladder",
    });
    expect(retryWaitMs({ ...base, text: "not json" }, 2).waitMs).toBe(60000);
  });
});

describe("rotateKeys 的容量退避（B1/B2/B3/B4 的确定性回归）", () => {
  const oneKey = { keys: ["ag-test-secret-key"], maxRetries: 6, timeoutMs: 360000 };
  const far = Date.now() + 600000;

  it("B1 回归：503→503→429→200 在单 key 池上必须成功，且发满 4 次请求（旧代码第 3 次就死）", async () => {
    const { state, send } = scripted([
      capacityReply(503, "video queue is full, please retry later (request id: req-1)"),
      capacityReply(503, "video queue is full, please retry later (request id: req-2)"),
      capacityReply(429, "You've reached the API rate limit for free users (request id: req-3)"),
      okReply({ data: [{ url: "https://cdn/out.png" }] }),
    ]);
    const { warns, logger } = fakeLogger();
    const out = await rotateKeys(oneKey, { send, logger, deadline: far });
    expect(state.sent).toBe(4);
    expect(new Set(state.keysUsed)).toEqual(new Set(["ag-test-secret-key"]));
    expect(out.keyIndex).toBe(0);
    expect(out.json).toEqual({ data: [{ url: "https://cdn/out.png" }] });
    // B4：每一次容量失败都必须 warn 出来（--json 下 info 会被壳屏蔽）
    expect(warns).toHaveLength(3);
    expect(warns.map((w) => /HTTP (\d+)/.exec(w)?.[1])).toEqual(["503", "503", "429"]);
    expect(warns[0]).toContain("同 key 重试");
  });

  it("B2/B3：预算用尽 → attempts 留住每一条 503/429 原文，消息不甩锅 key、不编造通道名", async () => {
    const { state, send } = scripted([
      capacityReply(503, "video queue is full, please retry later (request id: req-a)"),
      capacityReply(429, "You've reached the API rate limit for free users (request id: req-b)"),
      capacityReply(503, "video queue is full, please retry later (request id: req-c)"),
    ]);
    const { logger } = fakeLogger();
    const err = await captureAsync(() =>
      rotateKeys({ ...oneKey, maxRetries: 2 }, { send, logger, deadline: far }),
    );
    expect(err.code).toBe("E_PROVIDER_ERROR");
    expect(state.sent).toBe(3);
    const attempts = err.details?.attempts as CapacityAttempt[];
    expect(attempts.map((a) => a.status)).toEqual([503, 429, 503]);
    expect(attempts[0].message).toContain("video queue is full");
    expect(attempts.map((a) => a.keyIndex)).toEqual([0, 0, 0]);
    expect(err.message).toContain("video queue is full");
    // Bug 2：措辞把「提交次数（未放行请求，含首次）」与「重试次数（首次之后的补发）」分开点名
    expect(err.message).toContain("同一把 key 上已原地退避重试 2 次");
    expect(err.message).toContain("未放行请求 3 次");
    expect(err.message).not.toMatch(/把 key 均不可用/);
    // B3：旧代码在这里硬编码 "image queue is full"
    expect(err.message + JSON.stringify(attempts)).not.toContain("image queue is full");
    expect(err.details).toMatchObject({
      source: "agnes",
      reason: "queue_full_exhausted",
      keyCount: 1,
      maxRetries: 2,
      requestId: "req-c",
    });
  });

  it("deadline 收敛：provider 明示的 retry-after 会越过总 deadline 时立即放弃（不睡爆）", async () => {
    const { state, send } = scripted([
      { ...capacityReply(429, "rate limit"), retryAfterMs: 120000 },
      capacityReply(429, "rate limit"),
    ]);
    const { logger } = fakeLogger();
    const err = await captureAsync(() =>
      rotateKeys({ ...oneKey, maxRetries: 6 }, { send, logger, deadline: Date.now() + 1000 }),
    );
    expect(state.sent).toBe(1);
    const attempts = err.details?.attempts as CapacityAttempt[];
    expect(attempts[0]).toMatchObject({ retryAfterMs: 120000, waitSource: "retry-after" });
    // Bug 1：这一步从没 sleep 就 return 了，所以它既不计等待、也不算一次重试
    expect(attempts[0]).toMatchObject({ waited: false, waitedMs: 0 });
  });

  it("key 不泄漏：容量重试的 message/attempts 全程 scrub", async () => {
    const { send } = scripted([
      capacityReply(503, "video queue is full, ag-test-secret-key rejected"),
    ]);
    const { logger } = fakeLogger();
    const err = await captureAsync(() =>
      rotateKeys({ ...oneKey, maxRetries: 1 }, { send, logger, deadline: far }),
    );
    expect(JSON.stringify(err.details)).not.toContain("ag-test-secret-key");
    expect(err.message).not.toContain("ag-test-secret-key");
  });

  it("401/403/5xx 仍换下一把 key（B1 没把换 key 能力改没）", async () => {
    const config = { keys: ["k1", "k2"], maxRetries: 6, timeoutMs: 360000 };
    const { logger } = fakeLogger();
    const out = await rotateKeys(config, {
      send: async (key: string) =>
        key === "k1"
          ? {
              ok: false,
              transport: "http",
              status: 401,
              text: '{"error":{"message":"invalid key"}}',
            }
          : okReply({ data: [{ url: "u" }] }),
      logger,
      deadline: far,
    });
    // 起点随机，但成功那次一定落在 k2 → keyIndex 确定
    expect(out.keyIndex).toBe(1);
  });

  it("400 参数错：恰好一次请求，不重试也不换 key", async () => {
    const config = { keys: ["k1", "k2"], maxRetries: 6, timeoutMs: 360000 };
    const { state, send } = scripted([
      {
        ok: false,
        transport: "http",
        status: 400,
        text: '{"error":{"message":"size must be 720P","code":"invalid_request"}}',
      },
    ]);
    const { logger } = fakeLogger();
    const err = await captureAsync(() => rotateKeys(config, { send, logger, deadline: far }));
    expect(state.sent).toBe(1);
    expect(err.message).toContain("size must be 720P");
    expect(err.details).toMatchObject({ status: 400 });
  });
});

describe("agnes 重试账本口径（Bug 1：累计等待只算真睡过的那几步）", () => {
  const oneKey = { keys: ["ag-test-secret-key"], maxRetries: 6, timeoutMs: 360000 };
  const far = Date.now() + 600000;

  it("预算耗尽：报的累计等待 = 真睡过的两步（40+50），不含被放弃的第三步（60）", async () => {
    const { state, send } = scripted([
      waitedCapacityReply(503, "video queue is full (request id: r1)", 40),
      waitedCapacityReply(429, "rate limit (request id: r2)", 50),
      waitedCapacityReply(503, "video queue is full (request id: r3)", 60),
    ]);
    const progress = createRetryProgress();
    const started = Date.now();
    const err = await captureAsync(() =>
      rotateKeys({ ...oneKey, maxRetries: 2 }, { send, progress, deadline: far }),
    );
    // 真睡了 40+50：用挂钟兜住「账本说睡过就真的睡过」这条正向证据
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    expect(state.sent).toBe(3);
    const attempts = err.details?.attempts as CapacityAttempt[];
    // 计划值照旧留档（便于对照 Retry-After），但计账只看真执行的那两步
    expect(attempts.map((a) => a.retryAfterMs)).toEqual([40, 50, 60]);
    expect(attempts.map((a) => a.waited)).toEqual([true, true, false]);
    expect(attempts.map((a) => a.waitedMs)).toEqual([40, 50, 0]);
    const warning = progress.summaryWarning();
    expect(warning).toBeDefined();
    expect(numOf(warning?.message ?? "", WAITED_RE)).toBe(90);
    expect(numOf(warning?.message ?? "", RETRIED_RE)).toBe(2);
    expect(numOf(warning?.message ?? "", REJECTED_RE)).toBe(3);
    // 旧写法会把没执行的第三步也算进去，报成 150ms（实测真云三次分别高估 120000/120000/90000）
    expect(warning?.message).not.toContain("累计等待 150ms");
    // 结构化同一份账：调用方不必从文案里抠数字就能估重试预算
    expect(err.details).toMatchObject({ retried: 2, rejected: 3, waitedMs: 90 });
  });

  it("重试后成功：三次被拒各换来一次补发，重试就是 3 次、三步等待全进账", async () => {
    const { state, send } = scripted([
      waitedCapacityReply(503, "video queue is full (request id: r1)", 30),
      waitedCapacityReply(503, "video queue is full (request id: r2)", 30),
      waitedCapacityReply(429, "rate limit (request id: r3)", 30),
      okReply({ data: [{ url: "https://cdn/out.png" }] }),
    ]);
    const progress = createRetryProgress();
    const out = await rotateKeys({ ...oneKey, maxRetries: 6 }, { send, progress, deadline: far });
    expect(out.json).toEqual({ data: [{ url: "https://cdn/out.png" }] });
    expect(state.sent).toBe(4);
    const message = progress.summaryWarning()?.message ?? "";
    // 成功那次补发不在账本里（账本一行 = 一次未放行请求），所以这里重试次数 == 被拒次数
    expect(numOf(message, RETRIED_RE)).toBe(3);
    expect(numOf(message, REJECTED_RE)).toBe(3);
    expect(numOf(message, WAITED_RE)).toBe(90);
  });

  it("Bug 2：warning 与 E_PROVIDER_ERROR 里的重试数不可能各说各话", async () => {
    const { state, send } = scripted([
      waitedCapacityReply(503, "video queue is full (request id: r1)", 20),
      waitedCapacityReply(503, "video queue is full (request id: r2)", 20),
      waitedCapacityReply(429, "rate limit (request id: r3)", 20),
      waitedCapacityReply(503, "video queue is full (request id: r4)", 20),
    ]);
    const progress = createRetryProgress();
    const err = await captureAsync(() =>
      rotateKeys({ ...oneKey, maxRetries: 3 }, { send, progress, deadline: far }),
    );
    const warningMessage = progress.summaryWarning()?.message ?? "";
    // 同一条短语（含两个数与分桶）原样出现在两条出口里，措辞不可能再分叉
    expect(phraseOf(err.message)).toBe(phraseOf(warningMessage));
    expect(err.message).toContain(phraseOf(warningMessage));
    expect(numOf(err.message, RETRIED_RE)).toBe(numOf(warningMessage, RETRIED_RE));
    expect(numOf(err.message, REJECTED_RE)).toBe(numOf(warningMessage, REJECTED_RE));
    // 且与真实行为对齐：被拒 4 次 = 提交 4 次，重试 3 次 = 少一次补发
    expect(state.sent).toBe(4);
    expect(numOf(err.message, REJECTED_RE)).toBe(state.sent);
    expect(numOf(err.message, RETRIED_RE)).toBe(state.sent - 1);
  });

  it("轮询超时：抛错前那一步不睡，最后一次抖动记账的等待必须是 0（Bug 1 轮询侧）", async () => {
    const original = globalThis.fetch;
    // 实测未知 id 的轮询体：200 + {"error":{"code":404,"message":"task not found (…)"}}
    // —— 既不能判死（Bug 3），也不能把最后没睡的那一步计进累计等待（Bug 1）
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: { code: 404, message: "task not found (request id: r9)" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof globalThis.fetch;
    try {
      const progress = createRetryProgress();
      const pollConfig = {
        baseUrl: "http://127.0.0.1:1",
        keys: ["ag-test-secret-key"],
        pollIntervalMs: 40,
        timeoutMs: 5000,
        maxRetries: 6,
      };
      const err = await captureAsync(() =>
        pollVideo(pollConfig, {
          taskId: "vid-1",
          model: "m",
          keyIndex: 0,
          deadline: Date.now() + 130,
          progress,
        }),
      );
      expect(err.details).toMatchObject({ reason: "timeout", taskId: "vid-1" });
      const message = progress.summaryWarning()?.message ?? "";
      const rejected = numOf(message, REJECTED_RE);
      expect(rejected).toBeGreaterThan(1);
      // 不变量：累计等待 = (抖动次数 − 收尾那次没补发的) × 轮询间隔，且 misses 与账本行数一致
      expect(numOf(message, RETRIED_RE)).toBe(rejected - 1);
      expect(numOf(message, WAITED_RE)).toBe((rejected - 1) * 40);
      expect(err.details?.taskNotFoundResponses).toBe(rejected);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("stampWait/retryTally：没标 waited 的行宁缺毋滥，绝不安上等待", () => {
    const bailed = stampWait(
      { kind: "queue_full" },
      { waitMs: 20000, waitSource: "backoff_ladder", willWait: false },
    );
    expect(bailed).toEqual({
      kind: "queue_full",
      retryAfterMs: 20000,
      waitSource: "backoff_ladder",
      waited: false,
      waitedMs: 0,
    });
    // 旧形态账本（只有 retryAfterMs、没有 waited 标记）一律按「没等」处理：宁少报也不多报
    expect(retryTally([{ kind: "queue_full", retryAfterMs: 20000 }])).toEqual({
      rejected: 1,
      retries: 0,
      waitedMs: 0,
      parts: "queue_full×1",
    });
    // Retry-After: 0 也真补发过一次：算一次重试，但等待是 0ms（0 不等于没等）
    expect(
      retryTally([
        stampWait({ kind: "rate_limit" }, { waitMs: 0, waitSource: "retry-after", willWait: true }),
      ]),
    ).toMatchObject({ rejected: 1, retries: 1, waitedMs: 0 });
    expect(retryTallyPhrase(retryTally([bailed]))).toContain("已原地退避重试 0 次");
  });
});

describe("agnes 请求体构造（字段位置错了就 400，§3.4/§1.2）", () => {
  it("image：response_format 与 image 嵌在 extra_body，无参考图时不发 image", () => {
    expect(
      buildImageBody({
        model: "agnes-image-2.5-flash",
        prompt: "p",
        size: "4K",
        ratio: "1:1",
        refs: [],
        format: "url",
      }),
    ).toEqual({
      model: "agnes-image-2.5-flash",
      prompt: "p",
      size: "4K",
      ratio: "1:1",
      extra_body: { response_format: "url" },
    });
    const withRefs = buildImageBody({
      model: "m",
      prompt: "p",
      size: "1K",
      ratio: undefined,
      refs: ["data:image/png;base64,AAAA"],
      format: "b64_json",
    });
    expect(withRefs.extra_body).toEqual({
      response_format: "b64_json",
      image: ["data:image/png;base64,AAAA"],
    });
    expect(withRefs).not.toHaveProperty("tags");
    expect(withRefs).not.toHaveProperty("response_format");
  });

  it("video：seconds 发字符串、mode 必填、videos 永不出现", () => {
    const body = buildVideoBody({
      model: "agnes-video-2.5-flash",
      prompt: "p",
      mode: "reference",
      seconds: 8,
      size: "720P",
      aspectRatio: "16:9",
      images: ["https://cdn/a.png"],
      audios: [],
      firstFrame: undefined,
      lastFrame: undefined,
      seed: 7,
    });
    expect(body).toEqual({
      model: "agnes-video-2.5-flash",
      prompt: "p",
      mode: "reference",
      seconds: "8",
      size: "720P",
      aspect_ratio: "16:9",
      images: ["https://cdn/a.png"],
      seed: 7,
    });
    expect(body).not.toHaveProperty("videos");
    expect(body).not.toHaveProperty("audios");
  });

  it("taskIdOf 兼容未实测的多种字段形态（§1.2 V0 前不押字段名）", () => {
    expect(taskIdOf({ id: "v1" })).toBe("v1");
    expect(taskIdOf({ video_id: "v2" })).toBe("v2");
    expect(taskIdOf({ task_id: "v3" })).toBe("v3");
    expect(taskIdOf({ data: { id: "v4" } })).toBe("v4");
    expect(taskIdOf({ data: "v5" })).toBe("v5");
    expect(taskIdOf({ status: "queued" })).toBeUndefined();
  });

  it("pollOutcome：completed 取顶层 url 并忽略 internal_status；failed/非空 error 判失败", () => {
    expect(
      pollOutcome({
        status: "completed",
        url: "https://cdn/out.mp4",
        internal_status: "pending",
        internal_progress: 12,
      }),
    ).toEqual({ kind: "ready", status: "completed", url: "https://cdn/out.mp4" });
    expect(pollOutcome({ status: "queued", internal_status: "pending" })).toEqual({
      kind: "pending",
      status: "queued",
      url: undefined,
    });
    expect(pollOutcome({ status: "failed", error: { message: "seed not supported" } })).toEqual({
      kind: "failed",
      status: "failed",
      reason: "seed not supported",
    });
    expect(pollOutcome({ status: "completed" }).kind).toBe("failed");
  });

  it("pollOutcome（B5）：全空 error 骨架不判失败——旧写法会误杀已付费的任务", () => {
    expect(
      pollOutcome({ status: "running", error: { code: "", message: "" }, data: null }),
    ).toEqual({ kind: "pending", status: "running", url: undefined });
    expect(pollOutcome({ status: "processing", errors: {}, error: null })).toEqual({
      kind: "pending",
      status: "processing",
      url: undefined,
    });
    expect(pollOutcome({ status: "queued", errors: [] }).kind).toBe("pending");
    // 真错照样判死（不能把 B5 的宽容变成漏判）
    expect(pollOutcome({ status: "running", error: { message: "gpu oom" } })).toEqual({
      kind: "failed",
      status: "running",
      reason: "gpu oom",
    });
    expect(pollOutcome({ status: "canceled" }).kind).toBe("failed");
    expect(pollOutcome({ status: "cancelled" }).kind).toBe("failed");
  });

  it("pollOutcome（B5）：载荷裹在 data 里也认（实测每个错误体都带 data:null）", () => {
    expect(
      pollOutcome({ error: { code: "", message: "" }, data: { status: "completed", url: "u" } }),
    ).toEqual({ kind: "ready", status: "completed", url: "u" });
    expect(pollOutcome({ data: { status: "failed", error: { message: "policy" } } })).toEqual({
      kind: "failed",
      status: "failed",
      reason: "policy",
    });
    // data:null / data 是数组时不许误钻（image 的成功体就是 data:[…]）
    expect(taskPayloadOf({ status: "queued", data: null })).toEqual({
      status: "queued",
      data: null,
    });
    expect(taskPayloadOf({ data: [{ url: "x" }] })).toEqual({ data: [{ url: "x" }] });
    expect(taskPayloadOf({ data: { status: "completed", url: "y" } })).toEqual({
      status: "completed",
      url: "y",
    });
    // 裹在 data 里时根级的真错不能丢
    expect(pollOutcome({ error: { message: "root boom" }, data: { status: "queued" } })).toEqual({
      kind: "failed",
      status: "queued",
      reason: "root boom",
    });
  });

  it("pollOutcome（Bug 3）：只有数字 code 的骨架不判死；200 体里的 task not found 当抖动", () => {
    // 真云实测未知 id 的轮询回 **200** + {"error":{"code":404,"message":"task not found (…)"}}，
    // 而 {"error":{"code":0}} / {"error":{"code":200}} 这类只有数字的骨架也的确会出现。
    // 旧写法把数字 stringify 成非空文本 → videoFailed 抛错 → 白烧一次已扣费的生成
    expect(pollOutcome({ status: "running", error: { code: 0 } })).toEqual({
      kind: "pending",
      status: "running",
      url: undefined,
    });
    expect(pollOutcome({ status: "processing", error: { code: 200 }, data: null })).toEqual({
      kind: "pending",
      status: "processing",
      url: undefined,
    });
    const miss = pollOutcome({
      error: { code: 404, message: "task not found (request id: req-9)" },
      data: null,
    });
    expect(miss).toEqual({
      kind: "pending",
      status: "",
      url: undefined,
      transientReason: "task not found (request id: req-9)",
    });
    // 空窗也要留下抖动文本，供 pollVideo 记成 task_missing（否则调用方只看到一片安静）
    expect(
      pollOutcome({ data: { status: "queued", error: { code: 404, message: "task not exist" } } }),
    ).toEqual({
      kind: "pending",
      status: "queued",
      url: undefined,
      transientReason: "task not exist",
    });
    // 真错照旧判死：宽容不许变成漏判
    expect(pollOutcome({ status: "running", error: { code: 500, message: "gpu oom" } })).toEqual({
      kind: "failed",
      status: "running",
      reason: "gpu oom",
    });
    expect(
      pollOutcome({ status: "failed", error: { code: 404, message: "task not found" } }),
    ).toEqual(
      // 显式终态 status 仍然判死（哪怕 error 文本长得像空窗）
      { kind: "failed", status: "failed", reason: "task not found" },
    );
    expect(pollOutcome({ status: "canceled", error: { code: 0 } }).kind).toBe("failed");
  });

  it("isTransientTaskMiss（B5）：轮询期 task not exist 的 400/404 当抖动，其他 4xx 仍终态", () => {
    const miss = (status: number, message: string): FakeGot => ({
      ok: false,
      transport: "http",
      status,
      text: JSON.stringify({ code: "", message, data: null }),
    });
    expect(isTransientTaskMiss(miss(400, "task not exist (request id: r1)"))).toBe(true);
    expect(isTransientTaskMiss(miss(400, "Task Not Found"))).toBe(true);
    expect(isTransientTaskMiss(miss(400, "task_not_exist"))).toBe(true);
    expect(isTransientTaskMiss({ ok: false, transport: "http", status: 404, text: "" })).toBe(true);
    // 真参数错（实测 400 的 detail 形态）不能被宽容掉
    expect(isTransientTaskMiss(miss(400, "size must be 720P"))).toBe(false);
    expect(isTransientTaskMiss(miss(400, "images length must not exceed 5"))).toBe(false);
    expect(isTransientTaskMiss({ ok: false, transport: "http", status: 429, text: "{}" })).toBe(
      false,
    );
    expect(isTransientTaskMiss(okReply({}))).toBe(false);
  });
});

describe("agnes 选项与素材预处理", () => {
  it("parseImageSize：档位与 WxH 都收，8K/星号形式本地即拒", () => {
    expect(parseImageSize("4K")).toEqual({ size: "4K", tier: true });
    expect(parseImageSize("2048x1152")).toEqual({ size: "2048x1152", tier: false });
    expect(capture(() => parseImageSize("8K")).code).toBe("E_INVALID_OPTION");
    expect(capture(() => parseImageSize("2048*1152")).code).toBe("E_INVALID_OPTION");
  });

  it("splitRefs 把单值归一成数组并丢空项", () => {
    expect(splitRefs(undefined)).toEqual([]);
    expect(splitRefs("a")).toEqual(["a"]);
    expect(splitRefs([" a ", "", "  ", "b"])).toEqual(["a", "b"]);
  });

  it("assertCount 与 assertPublicUrls 只报错不发网络", () => {
    expect(assertCount(["a"], "--images", 5)).toEqual(["a"]);
    expect(assertCount(["a", "b", "c"], "--audios", 3)).toEqual(["a", "b", "c"]);
    expect(capture(() => assertCount(["a", "b", "c", "d"], "--audios", 3)).code).toBe(
      "E_INVALID_OPTION",
    );
    expect(assertPublicUrls(["https://cdn/a.png"], "--images")).toEqual(["https://cdn/a.png"]);
    const err = capture(() => assertPublicUrls(["/tmp/a.png"], "--images"));
    expect(err.code).toBe("E_INVALID_OPTION");
    expect(err.message).toContain("tencent-cos-upload");
    expect(capture(() => assertPublicUrls(["ftp://a"], "--images")).code).toBe("E_INVALID_OPTION");
  });

  it("data URI 进 data 时只回摘要，绝不回显 base64 原文", () => {
    const b64 = "A".repeat(2048);
    const [summary] = summarizeRefs([`data:image/png;base64,${b64}`, "https://cdn/a.png"]);
    expect(summary).toBe(`data:image/png;base64,${b64.length}bytes`);
    expect(summary).not.toContain(b64.slice(0, 64));
    expect(summarizeRefs(["https://cdn/a.png"])).toEqual(["https://cdn/a.png"]);
  });

  it("defaultOutputName 用 ISO 时间戳且不含冒号/点（可当文件名）", () => {
    expect(defaultOutputName("agnes")).toMatch(/^agnes-\d{4}-\d{2}-\d{2}T[\d-]+Z$/);
  });
});

describe("agnes 本地参考图转 data URI（D20）", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "agnes-unit-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("按扩展名推断 MIME：png/jpg/webp", async () => {
    const cases = { ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp" };
    for (const [ext, mime] of Object.entries(cases)) {
      const file = path.join(dir, `ref${ext}`);
      await writeFile(file, Buffer.from([1, 2, 3, 4]));
      expect(await toDataUri(file)).toBe(`data:${mime};base64,AQIDBA==`);
    }
  });

  it("resolveRef：URL 原样、其他 scheme 拒绝、无 scheme 当本地文件（相对 cwd）", async () => {
    await writeFile(path.join(dir, "cat.PNG"), Buffer.from([1, 2, 3, 4]));
    expect(await resolveRef("https://cdn/a.png", "--ref", dir)).toBe("https://cdn/a.png");
    expect(await resolveRef("cat.PNG", "--ref", dir)).toBe("data:image/png;base64,AQIDBA==");
    expect((await captureAsync(() => resolveRef("ftp://x/a.png", "--ref", dir))).code).toBe(
      "E_INVALID_OPTION",
    );
    expect((await captureAsync(() => resolveRef("missing.png", "--ref", dir))).code).toBe(
      "E_MISSING_ARGUMENT",
    );
    expect((await captureAsync(() => toDataUri(path.join(dir, "nope.png")))).code).toBe(
      "E_MISSING_ARGUMENT",
    );
  });

  it("不支持的扩展名 → E_INVALID_OPTION（不静默发 octet-stream）", async () => {
    await writeFile(path.join(dir, "doc.pdf"), Buffer.from([1]));
    const err = await captureAsync(() => toDataUri(path.join(dir, "doc.pdf")));
    expect(err.code).toBe("E_INVALID_OPTION");
    expect(err.message).toContain(".png");
  });
});

describe("agnes manifest（AGENTS.md §5 声明式契约）", () => {
  it("两个命令齐备：handler 是函数、选项都有 flags + description", () => {
    expect(manifest.name).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(manifest.version).toBeTruthy();
    expect(manifest.commands.map((c: { name: string }) => c.name)).toEqual([
      "agnes-image",
      "agnes-video",
    ]);
    for (const cmd of manifest.commands) {
      expect(typeof cmd.handler).toBe("function");
      expect(cmd.description.length).toBeGreaterThan(0);
      for (const opt of cmd.options ?? []) {
        expect(typeof opt.flags).toBe("string");
        expect(opt.description.length).toBeGreaterThan(0);
      }
    }
  });

  it("image 收本地文件与 URL（variadic），video 拒绝 --videos 并提供 --no-wait", () => {
    const flagsOf = (name: string) =>
      (manifest.commands.find((c: { name: string }) => c.name === name)?.options ?? []).map(
        (o: { flags: string }) => o.flags,
      );
    expect(flagsOf("agnes-image")).toContain("--ref <pathOrUrl...>");
    const video = flagsOf("agnes-video");
    // provider 明确不支持 videos（§1.2），manifest 里不能出现这个选项
    expect(video.some((f: string) => f.startsWith("--videos"))).toBe(false);
    expect(video).toContain("--no-wait");
    expect(video).toContain("--size <720P>");
    expect(video).not.toContain("--ratio <name>");
  });
});
