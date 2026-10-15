import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MockRequest } from "./helpers/agnes-mock.ts";
import {
  agnesEnv,
  b64Reply,
  badRequestReply,
  IMAGE_ENDPOINT,
  imageReply,
  PNG_BYTES,
  parseData,
  parseError,
  queueFullReply,
  REAL_PNG,
  rateLimitedReply,
  requestBody,
  startMock,
  videoQueueFullReply,
} from "./helpers/agnes-mock.ts";
import type { CliRun } from "./helpers/cli.ts";
import { cli } from "./helpers/cli.ts";

// 轮询/超时类用例实测会跑到 5s 以上（全量并发时更慢），整文件放宽到 30s。
vi.setConfig({ testTimeout: 30_000 });

const KEY_A = "ag-pool-a-secret";
const KEY_B = "ag-pool-b-secret";
const CDN = "https://cdn.example.com/ref-apple.png";

interface Warn {
  code: string;
  message: string;
  plugin?: string;
}

// --json 的调用方（AI/管道）唯一能读到进度的地方：envelope 的 warnings[]
// （壳在 json 模式把 logger 的 info 与 warn 都屏蔽，见 src/core/output/logger.ts:19,22）
function warningsOf(r: CliRun): Warn[] {
  return (JSON.parse(r.stdout) as { warnings: Warn[] }).warnings;
}

// retry-ledger.mjs 里那条被两条出口共用的账本短语（warning 与 error.message 必须一模一样）
const PHRASE_RE = /已原地退避重试 \d+ 次（[^）]*）/;
function phraseOf(text: string): string {
  const match = PHRASE_RE.exec(text);
  if (match === null) throw new Error(`文案里没有共用的账本短语：${text}`);
  return match[0];
}

// 落到 mock 的行为：提交 → imageReply，其余路径（结果图下载）→ PNG 哨兵
const imageFlow = (req: MockRequest, endpoint: string) =>
  req.method === "POST" ? imageReply(endpoint) : { status: 200, body: "PNG" };

describe("agnes-image e2e（本地 mock，绝不打真云）", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "agnes-image-e2e-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("文生图成功：同步响应 → 落盘、data 契约字段、请求体字段位置", async () => {
    const mock = await startMock(imageFlow);
    try {
      const out = path.join(dir, "t2i.png");
      const r = await cli(
        ["--json", "agnes-image", "--prompt", "a red apple on a white table", "--output", out],
        agnesEnv(mock.endpoint),
      );
      expect(r.code).toBe(0);
      const data = parseData<{
        path: string;
        bytes: number;
        model: string;
        size: string;
        requested: string;
        ratio: string;
        mode: string;
        keyIndex: number;
        taskId: string;
        sourceUrl: string;
        refUrls?: unknown;
      }>(r);
      expect(data.path).toBe(out);
      expect(data.bytes).toBe(PNG_BYTES.length);
      expect(data.model).toBe("agnes-image-2.5-flash");
      // 档位模式：期望像素本地推不出来（依赖 ratio 与 16 对齐），mock 的假 PNG 解不出尺寸 → 退回请求值
      expect(data.size).toBe("4K");
      expect(data.requested).toBe("4K");
      expect(data.ratio).toBe("1:1");
      expect(data.mode).toBe("t2i");
      expect(data.keyIndex).toBe(0);
      expect(data.taskId).toBe("task-mock");
      expect(data.sourceUrl).toContain(`${mock.endpoint}/out.png`);
      expect(data.refUrls).toBeUndefined();
      expect((await readFile(out)).equals(PNG_BYTES)).toBe(true);

      const post = mock.requests.find((q) => q.path === IMAGE_ENDPOINT);
      expect(post?.method).toBe("POST");
      expect(post?.key).toBe("ag-test-secret-key");
      expect(JSON.parse(post?.body ?? "")).toEqual({
        model: "agnes-image-2.5-flash",
        prompt: "a red apple on a white table",
        size: "4K",
        ratio: "1:1",
        extra_body: { response_format: "url" },
      });
      // 结果域与 apihub 不同域：下载不携带 Authorization（§3.4）
      expect(mock.requests.find((q) => q.path === "/out.png")?.key).toBe("");
    } finally {
      await mock.close();
    }
  });

  it("本地文件 --ref：内联 data URI（不需要先上传 CDN），mode=i2i，data 只回摘要", async () => {
    const mock = await startMock(() => b64Reply());
    try {
      const ref = path.join(dir, "ref-apple.png");
      await writeFile(ref, REAL_PNG);
      const r = await cli(
        [
          "--json",
          "agnes-image",
          "--prompt",
          "keep composition, make it blue glass",
          "--ref",
          ref,
          "--size",
          "1K",
          "--format",
          "b64",
          "--output",
          path.join(dir, "i2i.png"),
        ],
        agnesEnv(mock.endpoint),
      );
      expect(r.code).toBe(0);
      const body = requestBody(mock) as {
        extra_body: { image: string[]; response_format: string };
        size: string;
        ratio?: string;
      };
      expect(body.extra_body.image).toEqual([
        `data:image/png;base64,${REAL_PNG.toString("base64")}`,
      ]);
      expect(body.extra_body.response_format).toBe("b64_json");
      // 档位形态才发 ratio；WxH 形态不发（§3.4）
      expect(body.size).toBe("1K");
      expect(body.ratio).toBe("1:1");
      const data = parseData<{ mode: string; refUrls: string[]; sourceUrl?: string }>(r);
      expect(data.mode).toBe("i2i");
      // §9.7：base64 原文绝不进 data，只留 `data:<mime>;base64,<长度>bytes` 摘要
      expect(data.refUrls).toEqual([
        `data:image/png;base64,${REAL_PNG.toString("base64").length}bytes`,
      ]);
      expect(r.stdout).not.toContain(REAL_PNG.toString("base64").slice(0, 32));
      expect(data.sourceUrl).toBeUndefined();
    } finally {
      await mock.close();
    }
  });

  it("公网 URL --ref：原样透传并按序回显", async () => {
    const mock = await startMock(() => b64Reply());
    try {
      const r = await cli(
        [
          "--json",
          "agnes-image",
          "--prompt",
          "x",
          "--ref",
          CDN,
          "--output",
          path.join(dir, "u.png"),
        ],
        agnesEnv(mock.endpoint),
      );
      expect(r.code).toBe(0);
      expect((requestBody(mock) as { extra_body: { image: string[] } }).extra_body.image).toEqual([
        CDN,
      ]);
      expect(parseData<{ refUrls: string[] }>(r).refUrls).toEqual([CDN]);
    } finally {
      await mock.close();
    }
  });

  it("参考图上限 6 张：第 7 张本地即拒，不发网络", async () => {
    const mock = await startMock(imageFlow);
    try {
      const refs = Array.from({ length: 7 }, (_, i) => `${CDN}?i=${i}`);
      const r = await cli(
        ["--json", "agnes-image", "--prompt", "x", "--ref", ...refs],
        agnesEnv(mock.endpoint),
      );
      expect(r.code).toBe(2);
      const err = parseError(r);
      expect(err.code).toBe("E_INVALID_OPTION");
      expect(err.message).toContain("6");
      expect(err.details).toMatchObject({ option: "--ref", max: 6, value: 7 });
      expect(mock.requests).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });

  it("prompt 10001 字符：本地预检 400 前先拦（D26），不发网络", async () => {
    const mock = await startMock(imageFlow);
    try {
      const r = await cli(
        ["--json", "agnes-image", "--prompt", "字".repeat(10001)],
        agnesEnv(mock.endpoint),
      );
      expect(r.code).toBe(2);
      const err = parseError(r);
      expect(err.code).toBe("E_INVALID_OPTION");
      expect(err.details).toMatchObject({ option: "--prompt", limit: 10000, actual: 10001 });
      expect(mock.requests).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });

  it("--size 8K / WxH+--ratio / 输出目录缺失 / 缺 prompt：全是本地用法错，0 次网络", async () => {
    const mock = await startMock(imageFlow);
    try {
      const cases: [string, string[]][] = [
        ["E_INVALID_OPTION", ["--size", "8K"]],
        ["E_INVALID_OPTION", ["--size", "2048x1152", "--ratio", "16:9"]],
        ["E_INVALID_OPTION", ["--output", path.join(dir, "no-such-dir", "a.png")]],
        ["E_MISSING_ARGUMENT", []],
      ];
      for (const [code, extra] of cases) {
        const args = ["--json", "agnes-image", "--prompt", "x"];
        // 缺 prompt 的用例走到「必填缺失」分支
        if (code === "E_MISSING_ARGUMENT") args.splice(2, 2);
        const r = await cli([...args, ...extra], agnesEnv(mock.endpoint));
        expect(r.code, extra.join(" ")).toBe(2);
        expect(parseError(r).code, extra.join(" ")).toBe(code);
      }
      expect(mock.requests).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });

  it("503 队列满一次后 200：同 key 退避重试并成功，且 --json 的 envelope 里看得见重试（B4/D22 修正）", async () => {
    let posts = 0;
    const mock = await startMock((req, endpoint) => {
      if (req.method !== "POST") return { status: 200, body: "PNG" };
      posts += 1;
      return posts === 1 ? queueFullReply() : imageReply(endpoint);
    });
    try {
      const out = path.join(dir, "retry.png");
      const r = await cli(
        ["--json", "agnes-image", "--prompt", "x", "--output", out],
        agnesEnv(mock.endpoint),
      );
      expect(r.code).toBe(0);
      expect(mock.requests.filter((q) => q.path === IMAGE_ENDPOINT)).toHaveLength(2);
      expect(parseData<{ bytes: number }>(r).bytes).toBe(PNG_BYTES.length);
      // B4：重试对 --json 调用方必须可见——壳屏蔽 info/warn，所以走 envelope 的 warnings[]
      const warnings = warningsOf(r);
      expect(warnings.map((w) => w.code)).toContain("E_PROVIDER_RETRY");
      expect(warnings.find((w) => w.code === "E_PROVIDER_RETRY")).toMatchObject({
        plugin: "agnes",
      });
      expect(warnings.find((w) => w.code === "E_PROVIDER_RETRY")?.message).toMatch(
        /退避重试 1 次.*queue_full×1/,
      );
      // Bug 1：这一次被拒后真的补发过（Retry-After: 0 → 等待 0ms），报告与真实行为一致
      expect(warnings.find((w) => w.code === "E_PROVIDER_RETRY")?.message).toContain(
        "未放行请求 1 次",
      );
      // stdout 仍是单个 JSON 文档（AGENTS.md §4：进度只走 warnings/stderr，不污染 stdout）
      expect(() => JSON.parse(r.stdout)).not.toThrow();
    } finally {
      await mock.close();
    }
  }, 30000);

  it("B4：重试进度在 human 模式与 --json --verbose 都落到 stderr（且 stdout 不被污染）", async () => {
    let posts = 0;
    const mock = await startMock((req, endpoint) => {
      if (req.method !== "POST") return { status: 200, body: "PNG" };
      posts += 1;
      if (posts <= 2) return queueFullReply();
      posts = 0;
      return imageReply(endpoint);
    });
    try {
      const human = await cli(
        ["agnes-image", "--prompt", "x", "--output", path.join(dir, "human.png")],
        agnesEnv(mock.endpoint),
      );
      expect(human.code, human.stderr).toBe(0);
      // 逐次 warn：两条 503 → 两条 [warn]
      expect(
        human.stderr.split("\n").filter((line) => line.includes("[warn]")).length,
      ).toBeGreaterThanOrEqual(2);
      expect(human.stderr).toMatch(/HTTP 503.*同 key 重试/s);

      const jsonQuiet = await cli(
        ["--json", "agnes-image", "--prompt", "x", "--output", path.join(dir, "quiet.png")],
        agnesEnv(mock.endpoint),
      );
      expect(jsonQuiet.code).toBe(0);
      expect(warningsOf(jsonQuiet).map((w) => w.code)).toContain("E_PROVIDER_RETRY");
      const jsonVerbose = await cli(
        [
          "--json",
          "--verbose",
          "agnes-image",
          "--prompt",
          "x",
          "--output",
          path.join(dir, "v.png"),
        ],
        agnesEnv(mock.endpoint),
      );
      expect(jsonVerbose.code).toBe(0);
      expect(jsonVerbose.stderr).toMatch(/HTTP 503.*同 key 重试/s);
      // --verbose 也不许往 stdout 写第二份东西
      expect(() => JSON.parse(jsonVerbose.stdout)).not.toThrow();
    } finally {
      await mock.close();
    }
  }, 30000);

  it("B1 回归：503→503→429→200 单 key 必须成功且发满 4 次请求（旧代码第 3 次就 allKeysFailed）", async () => {
    let posts = 0;
    const mock = await startMock((req, endpoint) => {
      if (req.method !== "POST") return { status: 200, body: "PNG" };
      posts += 1;
      if (posts === 1 || posts === 2) return videoQueueFullReply();
      if (posts === 3) return rateLimitedReply();
      return imageReply(endpoint);
    });
    try {
      const out = path.join(dir, "capacity.png");
      const r = await cli(
        ["--json", "agnes-image", "--prompt", "x", "--output", out],
        agnesEnv(mock.endpoint, { AGNES_MAX_RETRIES: "6", AGNES_TIMEOUT_MS: "60000" }),
      );
      expect(r.code, r.stdout + r.stderr).toBe(0);
      const posted = mock.requests.filter((q) => q.path === IMAGE_ENDPOINT);
      expect(posted).toHaveLength(4);
      // 全程同一把 key：容量问题换 key 无用（实测同刻图片通道 200、视频通道 503）
      expect(new Set(posted.map((q) => q.key))).toEqual(new Set(["ag-test-secret-key"]));
      expect(parseData<{ bytes: number }>(r).bytes).toBe(PNG_BYTES.length);
      // 全程不带真 key 原文（warning 里的 provider 文本也必须过 scrub）
      expect(r.stdout + r.stderr).not.toContain("ag-test-secret-key");
      // B4：三次容量失败在 --json 下必须汇总成一条 E_PROVIDER_RETRY warning（含 503×2 + 429×1）
      const retry = warningsOf(r).find((w) => w.code === "E_PROVIDER_RETRY");
      expect(retry?.message).toMatch(/退避重试 3 次/);
      expect(retry?.message).toContain("queue_full×2");
      expect(retry?.message).toContain("rate_limit×1");
      // Bug 1：三次被拒各睡了一步（Retry-After: 0），累计等待就是这三步之和 = 0ms
      expect(retry?.message).toContain("实际累计等待 0ms");
    } finally {
      await mock.close();
    }
  }, 30000);

  it("503 持续：退避预算耗尽 → E_PROVIDER_ERROR，attempts 留住每一条 503/429（B2），始终同一把 key", async () => {
    const mock = await startMock((req) =>
      req.method === "POST" ? queueFullReply("video queue is full") : { status: 200, body: "PNG" },
    );
    try {
      const r = await cli(["--json", "agnes-image", "--prompt", "x"], agnesEnv(mock.endpoint));
      expect(r.code).toBe(3);
      const err = parseError(r);
      expect(err.code).toBe("E_PROVIDER_ERROR");
      expect(err.details).toMatchObject({
        source: "agnes",
        reason: "queue_full_exhausted",
        keyCount: 1,
      });
      // AGNES_MAX_RETRIES=2 → 首发 + 2 次重试 = 3 次请求，全部同一把 key（换 key 无用，B1）
      expect(mock.requests).toHaveLength(3);
      expect(new Set(mock.requests.map((q) => q.key))).toEqual(new Set(["ag-test-secret-key"]));
      const attempts = err.details?.attempts as {
        status: number;
        message: string;
        retryAfterMs: number;
        waitSource: string;
        waited: boolean;
        waitedMs: number;
      }[];
      // B2：旧实现在这里丢掉了 withQueueRetry 的 attempts，只剩 rotateKeys 自己那条
      expect(attempts).toHaveLength(3);
      expect(attempts.map((a) => a.status)).toEqual([503, 503, 503]);
      // mock 发了 Retry-After: 0 → 等待取自 provider 明示，而不是阶梯
      expect(attempts[0]).toMatchObject({ retryAfterMs: 0, waitSource: "retry-after" });
      // Bug 1：前两步真睡过（0ms 也算睡过），最后一步预算用尽没再发请求 → 不计等待不计重试
      expect(attempts.map((a) => a.waited)).toEqual([true, true, false]);
      expect(attempts.map((a) => a.waitedMs)).toEqual([0, 0, 0]);
      // B3：通道名照 provider 原文，不许写死 image
      expect(attempts[0].message).toContain("video queue is full");
      expect(JSON.stringify(err.details)).not.toContain("image queue is full");
      // 实测（§1.1）：request id 内联在 message 文本里
      expect(err.details?.requestId).toBe("req-queue-1");
      // B2：单 key 池不再甩锅给「1 把 key 均不可用」
      expect(err.message).not.toMatch(/把 key 均不可用/);
      // Bug 2：措辞分开点名两个数——重试 2 次（首次提交之后的补发）vs 未放行请求 3 次（含首次）
      expect(err.message).toContain("同一把 key 上已原地退避重试 2 次");
      expect(err.message).toContain("未放行请求 3 次，含首次提交");
      // Bug 1（结构化同一份账）：调用方不必抠文案就能估重试预算
      expect(err.details).toMatchObject({ retried: 2, rejected: 3, waitedMs: 0 });
      // B4：失败路径的 warnings 也在 envelope 里（与 details.attempts 互补）
      expect(warningsOf(r).map((w) => w.code)).toContain("E_PROVIDER_RETRY");
      // Bug 2：warning 与 error.message 共用同一条账本短语，不可能一个说 2 一个说 3
      const retry = warningsOf(r).find((w) => w.code === "E_PROVIDER_RETRY");
      expect(err.message).toContain(phraseOf(retry?.message ?? ""));
    } finally {
      await mock.close();
    }
  }, 30000);

  it("没有 Retry-After 时走自己的阶梯：首档 20s 会越过 5s deadline → 立即放弃（不睡爆、不连发）", async () => {
    const mock = await startMock((req) =>
      req.method === "POST"
        ? queueFullReply("image queue is full", null)
        : { status: 200, body: "PNG" },
    );
    try {
      const r = await cli(["--json", "agnes-image", "--prompt", "x"], agnesEnv(mock.endpoint));
      expect(r.code).toBe(3);
      const err = parseError(r);
      // 旧阶梯这里会睡 1s/2s 连发三次（实测正是这种连发把 503 打成 429）；
      // 新阶梯首档 20s，超出 AGNES_TIMEOUT_MS=5000 的 deadline → 一次请求就收敛
      expect(mock.requests.filter((q) => q.path === IMAGE_ENDPOINT)).toHaveLength(1);
      const attempts = err.details?.attempts as {
        retryAfterMs: number;
        waitSource: string;
        waited: boolean;
        waitedMs: number;
      }[];
      expect(attempts[0]).toMatchObject({ retryAfterMs: 20000, waitSource: "backoff_ladder" });
      // Bug 1 的真云形态：计划等 20000ms 但那一步从没执行 → 累计等待必须是 0，不是 20000
      expect(attempts[0]).toMatchObject({ waited: false, waitedMs: 0 });
      const retry = warningsOf(r).find((w) => w.code === "E_PROVIDER_RETRY");
      expect(retry?.message).toContain("退避重试 0 次");
      expect(retry?.message).toContain("实际累计等待 0ms");
      expect(err.message).toContain("实际累计等待 0ms");
    } finally {
      await mock.close();
    }
  }, 30000);

  it("400 参数错：立即失败，不重试也不换 key", async () => {
    const mock = await startMock(() => badRequestReply('model "agnes-image-3.0" not found'));
    try {
      const r = await cli(["--json", "agnes-image", "--prompt", "x"], agnesEnv(mock.endpoint));
      expect(r.code).toBe(3);
      const err = parseError(r);
      expect(err.code).toBe("E_PROVIDER_ERROR");
      expect(err.details?.status).toBe(400);
      expect(String(err.details?.message)).toContain("not found");
      expect(mock.requests.filter((q) => q.path === IMAGE_ENDPOINT)).toHaveLength(1);
      expect(mock.requests).toHaveLength(1);
      // 参数错不是容量问题：不得出现退避重试的 warn
      expect(r.stderr).not.toContain("同 key 重试");
    } finally {
      await mock.close();
    }
  });

  it("key 池：第一把 401 换第二把，data.keyIndex 只回下标", async () => {
    const mock = await startMock((req, endpoint) => {
      if (req.key === KEY_A) return { status: 401, body: { error: { message: "no key here" } } };
      return imageFlow(req, endpoint);
    });
    try {
      const out = path.join(dir, "pool.png");
      const r = await cli(
        ["--json", "agnes-image", "--prompt", "x", "--output", out],
        agnesEnv(mock.endpoint, { AGNES_API_KEY: "", AGNES_KEY_POOL: `${KEY_A}, ${KEY_B}` }),
      );
      expect(r.code).toBe(0);
      // 起点随机，但成功那次必然落在第二把上，所以 keyIndex 是确定的
      expect(parseData<{ keyIndex: number }>(r).keyIndex).toBe(1);
      expect(mock.requests.some((q) => q.key === KEY_B && q.path === IMAGE_ENDPOINT)).toBe(true);
      expect(r.stdout + r.stderr).not.toContain(KEY_A);
      expect(r.stdout + r.stderr).not.toContain(KEY_B);
    } finally {
      await mock.close();
    }
  });

  it("全池 401：E_PROVIDER_ERROR 带 keyCount/attempts，provider 回显的 key 被 scrub", async () => {
    const mock = await startMock(() => ({
      status: 401,
      body: { error: { message: "invalid api key ag-test-secret-key", type: "AgnesAI_error" } },
    }));
    try {
      const r = await cli(["--json", "agnes-image", "--prompt", "x"], agnesEnv(mock.endpoint));
      expect(r.code).toBe(3);
      const err = parseError(r);
      expect(err.code).toBe("E_PROVIDER_ERROR");
      expect(err.details?.keyCount).toBe(1);
      expect(err.details?.attempts).toHaveLength(1);
      // B2：单 key 池说清「无从换 key」而不是笼统的「1 把 key 均不可用」
      expect(err.message).toContain("key 池只有 1 把");
      expect(err.details).toMatchObject({ reason: "all_keys_failed" });
      expect(r.stdout + r.stderr).not.toContain("ag-test-secret-key");
      expect(mock.requests).toHaveLength(1);
    } finally {
      await mock.close();
    }
  });

  it("显式 --size 被降采样：data.size 报真实像素并附 E_SIZE_MISMATCH 警告（D21）", async () => {
    const mock = await startMock(() => b64Reply(REAL_PNG));
    try {
      const out = path.join(dir, "down.png");
      const r = await cli(
        [
          "--json",
          "agnes-image",
          "--prompt",
          "x",
          "--size",
          "2048x1152",
          "--format",
          "b64",
          "--output",
          out,
        ],
        agnesEnv(mock.endpoint),
      );
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout) as {
        data: { size: string; requested: string; ratio?: string };
        warnings: { code: string; plugin?: string; message: string }[];
      };
      expect(parsed.data.size).toBe("8x16");
      expect(parsed.data.requested).toBe("2048x1152");
      expect(parsed.data.ratio).toBeUndefined();
      expect(parsed.warnings.map((w) => w.code)).toContain("E_SIZE_MISMATCH");
      expect(parsed.warnings.find((w) => w.code === "E_SIZE_MISMATCH")?.plugin).toBe("agnes");
      expect((await readFile(out)).equals(REAL_PNG)).toBe(true);
    } finally {
      await mock.close();
    }
  });

  it("档位模式（4K）即使真实像素不同也不告警：只把实测像素写进 data.size", async () => {
    const mock = await startMock(() => b64Reply(REAL_PNG));
    try {
      const r = await cli(
        [
          "--json",
          "agnes-image",
          "--prompt",
          "x",
          "--format",
          "b64",
          "--output",
          path.join(dir, "tier.png"),
        ],
        agnesEnv(mock.endpoint),
      );
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout) as { data: { size: string }; warnings: unknown[] };
      expect(parsed.data.size).toBe("8x16");
      expect(parsed.warnings).toEqual([]);
    } finally {
      await mock.close();
    }
  });

  it("默认输出名：agnes-<ISO时间戳>.png 落在 cwd", async () => {
    const mock = await startMock(imageFlow);
    try {
      const outDir = path.join(dir, "default-out");
      await mkdir(outDir, { recursive: true });
      const r = await cli(
        ["--json", "agnes-image", "--prompt", "x"],
        agnesEnv(mock.endpoint),
        outDir,
      );
      expect(r.code).toBe(0);
      const data = parseData<{ path: string }>(r);
      expect(path.basename(data.path)).toMatch(/^agnes-\d{4}-\d{2}-\d{2}T[\d-]+Z\.png$/);
      // macOS tmpdir 会被 realpath 解析为 /private/var
      expect(path.dirname(data.path)).toBe(await realpath(outDir));
    } finally {
      await mock.close();
    }
  });
});
