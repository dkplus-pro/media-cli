import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agnesEnv,
  emptyErrorEnvelope,
  MP4_BYTES,
  parseData,
  parseError,
  REAL_PNG,
  rateLimitedReply,
  requestBody,
  startMock,
  VIDEO_POLL_ENDPOINT,
  VIDEO_SUBMIT_ENDPOINT,
  videoQueueFullReply,
} from "./helpers/agnes-mock.ts";
import type { CliRun } from "./helpers/cli.ts";
import { cli } from "./helpers/cli.ts";

interface Warn {
  code: string;
  message: string;
  plugin?: string;
}

// --json 下壳屏蔽 logger 的 info/warn（src/core/output/logger.ts:19,22），
// 所以重试进度的可见通道是 envelope 的 warnings[]
const warningsOf = (r: CliRun): Warn[] => (JSON.parse(r.stdout) as { warnings: Warn[] }).warnings;

// retry-ledger.mjs 里那条被两条出口共用的账本短语（Bug 2：措辞与数字都必须一模一样）
const PHRASE_RE = /已原地退避重试 \d+ 次（[^）]*）/;
const REJECTED_RE = /未放行请求 (\d+) 次/;
const RETRIED_RE = /已原地退避重试 (\d+) 次/;
const WAITED_RE = /实际累计等待 (\d+)ms/;

function phraseOf(text: string): string {
  const match = PHRASE_RE.exec(text);
  if (match === null) throw new Error(`文案里没有共用的账本短语：${text}`);
  return match[0];
}

function numOf(text: string, re: RegExp): number {
  const match = re.exec(text);
  if (match === null) throw new Error(`文案里抠不到 /${re.source}/：${text}`);
  return Number(match[1]);
}

const IMG = (i: number) => `https://cdn.example.com/ref-${i}.png`;
const AUDIO = "https://cdn.example.com/voice.mp3";
const FRAME = "https://cdn.example.com/f1.png";
const FRAME2 = "https://cdn.example.com/f2.png";

const KEY_A = "ag-vid-a-secret";
const KEY_B = "ag-vid-b-secret";

/**
 * 提交 → 轮询 → 下载 的完整桩。
 * ⚠️ 提交响应体的字段名与轮询路径都还是**待实测**（§1.2 V0），这里按官方文档形态给：
 * 提交回 `{ id }`，轮询走 `GET /agnesapi?video_id=&model_name=`，完成体取**顶层 url**，
 * 并故意同时带 internal_status:"pending" 证明它被忽略（§1.2 明确要求忽略）。
 * 计数器活在闭包里：一个用例一个 stub 实例，别在每个请求上重建。
 */
function videoStub(completes = true) {
  let polls = 0;
  return (req: { path: string }, endpoint: string) => {
    if (req.path === VIDEO_SUBMIT_ENDPOINT) {
      return { status: 200, body: { id: "vid-42", status: "queued" } };
    }
    if (req.path === VIDEO_POLL_ENDPOINT) {
      polls += 1;
      if (!completes || polls < 2) {
        return { status: 200, body: { status: "queued", internal_status: "pending" } };
      }
      return {
        status: 200,
        body: {
          status: "completed",
          url: `${endpoint}/clip.mp4`,
          internal_status: "pending",
          internal_progress: 30,
        },
      };
    }
    return { status: 200, body: "MP4" };
  };
}

const pollFast = { AGNES_POLL_INTERVAL_MS: "10" };

describe("agnes-video e2e（本地 mock，绝不打真云）", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "agnes-video-e2e-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("提交 + 轮询成功：从顶层 url 取值（忽略 internal_status）并落盘", async () => {
    const mock = await startMock(videoStub());
    try {
      const out = path.join(dir, "clip.mp4");
      const r = await cli(
        [
          "--json",
          "agnes-video",
          "--prompt",
          "a red cube rotating on white background",
          "--output",
          out,
        ],
        agnesEnv(mock.endpoint, pollFast),
      );
      expect(r.code, r.stdout + r.stderr).toBe(0);
      const data = parseData<{
        path: string;
        bytes: number;
        model: string;
        taskId: string;
        mode: string;
        seconds: number;
        size: string;
        aspectRatio: string;
        status: string;
        sourceUrl: string;
        keyIndex: number;
      }>(r);
      expect(data.path).toBe(out);
      expect(data.bytes).toBe(MP4_BYTES.length);
      expect(data.model).toBe("agnes-video-2.5-flash");
      expect(data.taskId).toBe("vid-42");
      expect(data.mode).toBe("text");
      expect(data.seconds).toBe(5);
      expect(data.size).toBe("720P");
      expect(data.aspectRatio).toBe("16:9");
      expect(data.status).toBe("completed");
      expect(data.sourceUrl).toBe(`${mock.endpoint}/clip.mp4`);
      expect(data.keyIndex).toBe(0);
      expect((await readFile(out)).equals(MP4_BYTES)).toBe(true);

      // 提交体：seconds 是字符串、mode 必填、没有 videos/n 字段（§1.2）
      const submit = mock.requests.find((q) => q.path === VIDEO_SUBMIT_ENDPOINT);
      expect(submit?.method).toBe("POST");
      expect(JSON.parse(submit?.body ?? "")).toEqual({
        model: "agnes-video-2.5-flash",
        prompt: "a red cube rotating on white background",
        mode: "text",
        seconds: "5",
        size: "720P",
        aspect_ratio: "16:9",
      });
      // 轮询在 /agnesapi（不在 /v1 下）且带 video_id + model_name 查询参数
      const poll = mock.requests.find((q) => q.path === VIDEO_POLL_ENDPOINT);
      expect(poll?.method).toBe("GET");
      expect(poll?.query).toContain("video_id=vid-42");
      expect(poll?.query).toContain("model_name=agnes-video-2.5-flash");
      // 结果文件与 image 一样走独立域：下载不带 Authorization
      expect(mock.requests.find((q) => q.path === "/clip.mp4")?.key).toBe("");
      expect(r.stdout + r.stderr).not.toContain("ag-test-secret-key");
    } finally {
      await mock.close();
    }
  });

  it("--no-wait：只提交不轮询，data 只有任务信息", async () => {
    const mock = await startMock(videoStub());
    try {
      const r = await cli(
        ["--json", "agnes-video", "--prompt", "x", "--no-wait"],
        agnesEnv(mock.endpoint, pollFast),
      );
      expect(r.code, r.stdout + r.stderr).toBe(0);
      const data = parseData<{ taskId: string; mode: string; size: string; path?: string }>(r);
      expect(data.taskId).toBe("vid-42");
      expect(data.mode).toBe("text");
      expect(data.size).toBe("720P");
      expect(data.path).toBeUndefined();
      expect(mock.requests.map((q) => q.path)).toEqual([VIDEO_SUBMIT_ENDPOINT]);
    } finally {
      await mock.close();
    }
  });

  it("reference 模式：--images/--audios 透传，--seconds 与 --seed 原样进体", async () => {
    const mock = await startMock(videoStub());
    try {
      const r = await cli(
        [
          "--json",
          "agnes-video",
          "--prompt",
          "<Picture 1> turns into <Picture 2> while <Audio 1> plays",
          "--images",
          IMG(1),
          IMG(2),
          "--audios",
          AUDIO,
          "--seconds",
          "8",
          "--aspect-ratio",
          "9:16",
          "--seed",
          "123",
          "--output",
          path.join(dir, "ref.mp4"),
        ],
        agnesEnv(mock.endpoint, pollFast),
      );
      expect(r.code, r.stdout + r.stderr).toBe(0);
      expect(requestBody(mock)).toEqual({
        model: "agnes-video-2.5-flash",
        prompt: "<Picture 1> turns into <Picture 2> while <Audio 1> plays",
        mode: "reference",
        seconds: "8",
        size: "720P",
        aspect_ratio: "9:16",
        images: [IMG(1), IMG(2)],
        audios: [AUDIO],
        seed: 123,
      });
      expect(parseData<{ mode: string; seconds: number }>(r)).toMatchObject({
        mode: "reference",
        seconds: 8,
      });
    } finally {
      await mock.close();
    }
  });

  it("keyframe 模式：first_frame/last_frame 成对透传", async () => {
    const mock = await startMock(videoStub());
    try {
      const r = await cli(
        [
          "--json",
          "agnes-video",
          "--prompt",
          "x",
          "--first-frame",
          FRAME,
          "--last-frame",
          FRAME2,
          "--output",
          path.join(dir, "kf.mp4"),
        ],
        agnesEnv(mock.endpoint, pollFast),
      );
      expect(r.code, r.stdout + r.stderr).toBe(0);
      const body = requestBody(mock) as Record<string, unknown>;
      expect(body.mode).toBe("keyframe");
      expect(body.first_frame).toBe(FRAME);
      expect(body.last_frame).toBe(FRAME2);
      expect(body).not.toHaveProperty("images");
    } finally {
      await mock.close();
    }
  });

  it("本地素材/张数上限/成对缺失/枚举非法：全部本地预检，0 次网络", async () => {
    const mock = await startMock(videoStub());
    try {
      const localFile = path.join(dir, "local.png");
      await writeFile(localFile, REAL_PNG);
      const cases: [string, string[]][] = [
        // video 只收公网 URL（D20），本地路径给「先上传」的可执行指引
        ["E_INVALID_OPTION", ["--images", localFile]],
        ["E_INVALID_OPTION", ["--first-frame", "/tmp/f1.png"]],
        // 实测上限：images 5、audios 3
        ["E_INVALID_OPTION", ["--images", ...Array.from({ length: 6 }, (_, i) => IMG(i))]],
        ["E_INVALID_OPTION", ["--audios", AUDIO, AUDIO, AUDIO, AUDIO]],
        // keyframe 必须成对；reference 至少要给素材
        ["E_MISSING_ARGUMENT", ["--mode", "keyframe", "--first-frame", FRAME]],
        ["E_MISSING_ARGUMENT", ["--mode", "reference"]],
        // size 只有 720P（其他值 provider 直接 400 "size must be 720P"）
        ["E_INVALID_OPTION", ["--size", "1080P"]],
        ["E_INVALID_OPTION", ["--seconds", "13"]],
        ["E_INVALID_OPTION", ["--aspect-ratio", "5:4"]],
        ["E_INVALID_OPTION", ["--mode", "hybrid"]],
        ["E_MISSING_ARGUMENT", []],
      ];
      for (const [code, extra] of cases) {
        const args = ["--json", "agnes-video", "--prompt", "x"];
        if (extra.length === 0) args.splice(2, 2);
        const r = await cli([...args, ...extra], agnesEnv(mock.endpoint));
        expect(r.code, extra.join(" ")).toBe(2);
        expect(parseError(r).code, extra.join(" ")).toBe(code);
      }
      const localPath = await cli(
        ["--json", "agnes-video", "--prompt", "x", "--images", localFile],
        agnesEnv(mock.endpoint),
      );
      expect(parseError(localPath).message).toContain("tencent-cos-upload");
      expect(mock.requests).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });

  it("轮询钉住提交那把 key：KEY_A 提交撞 401 → KEY_B 成功，轮询只用 KEY_B", async () => {
    const stub = videoStub();
    const mock = await startMock((req, endpoint) => {
      if (req.path === VIDEO_SUBMIT_ENDPOINT && req.key === KEY_A) {
        return { status: 401, body: { error: { message: "invalid key" } } };
      }
      return stub(req, endpoint);
    });
    try {
      const r = await cli(
        ["--json", "agnes-video", "--prompt", "x", "--output", path.join(dir, "pinned.mp4")],
        agnesEnv(mock.endpoint, {
          AGNES_API_KEY: "",
          AGNES_KEY_POOL: `${KEY_A}, ${KEY_B}`,
          ...pollFast,
        }),
      );
      expect(r.code, r.stdout + r.stderr).toBe(0);
      expect(parseData<{ keyIndex: number }>(r).keyIndex).toBe(1);
      const polls = mock.requests.filter((q) => q.path === VIDEO_POLL_ENDPOINT);
      expect(polls.length).toBeGreaterThan(0);
      // 任务属于提交它的账号：轮询不得再出现 KEY_A（D23）
      expect(new Set(polls.map((q) => q.key))).toEqual(new Set([KEY_B]));
      expect(r.stdout + r.stderr).not.toContain(KEY_A);
      expect(r.stdout + r.stderr).not.toContain(KEY_B);
    } finally {
      await mock.close();
    }
  });

  it("轮询撞 429 继续等同一把 key，不作废已付费的生成（且 --json 下看得见抖动）", async () => {
    let polls = 0;
    const mock = await startMock((req, endpoint) => {
      if (req.path === VIDEO_SUBMIT_ENDPOINT) {
        return { status: 200, body: { id: "vid-429", status: "queued" } };
      }
      if (req.path === VIDEO_POLL_ENDPOINT) {
        polls += 1;
        if (polls === 1) return { status: 429, body: { error: { message: "too many requests" } } };
        return { status: 200, body: { status: "completed", url: `${endpoint}/ok.mp4` } };
      }
      return { status: 200, body: "MP4" };
    });
    try {
      const r = await cli(
        ["--json", "agnes-video", "--prompt", "x", "--output", path.join(dir, "429.mp4")],
        agnesEnv(mock.endpoint, pollFast),
      );
      expect(r.code, r.stdout + r.stderr).toBe(0);
      expect(polls).toBeGreaterThanOrEqual(2);
      expect(parseData<{ sourceUrl: string }>(r).sourceUrl).toContain("/ok.mp4");
      // B4：轮询期的抖动同样要进 envelope
      expect(warningsOf(r).map((w) => w.code)).toContain("E_PROVIDER_RETRY");
      expect(warningsOf(r).find((w) => w.code === "E_PROVIDER_RETRY")?.message).toContain(
        "poll_unavailable×1",
      );
    } finally {
      await mock.close();
    }
  });

  it("B1 回归（视频通道）：503→503→429→200 单 key 提交成功，恰好 4 次提交且同一把 key", async () => {
    let posts = 0;
    const mock = await startMock((req) => {
      if (req.path !== VIDEO_SUBMIT_ENDPOINT) return { status: 200, body: "MP4" };
      posts += 1;
      if (posts === 1 || posts === 2) return videoQueueFullReply();
      if (posts === 3) return rateLimitedReply();
      return { status: 200, body: { id: "vid-cap", status: "queued" } };
    });
    try {
      const r = await cli(
        ["--json", "agnes-video", "--prompt", "x", "--no-wait"],
        agnesEnv(mock.endpoint, { AGNES_MAX_RETRIES: "6", AGNES_TIMEOUT_MS: "60000" }),
      );
      expect(r.code, r.stdout + r.stderr).toBe(0);
      const submits = mock.requests.filter((q) => q.path === VIDEO_SUBMIT_ENDPOINT);
      expect(submits).toHaveLength(4);
      expect(new Set(submits.map((q) => q.key))).toEqual(new Set(["ag-test-secret-key"]));
      expect(parseData<{ taskId: string }>(r).taskId).toBe("vid-cap");
      const retry = warningsOf(r).find((w) => w.code === "E_PROVIDER_RETRY");
      expect(retry?.message).toMatch(/退避重试 3 次/);
      expect(retry?.message).toContain("queue_full×2");
      expect(retry?.message).toContain("rate_limit×1");
    } finally {
      await mock.close();
    }
  }, 30000);

  it("B2/B3：视频通道一直满 → attempts 留住每条 503，消息用 provider 原文（不写死 image queue）", async () => {
    const mock = await startMock((req) =>
      req.path === VIDEO_SUBMIT_ENDPOINT ? videoQueueFullReply() : { status: 200, body: "MP4" },
    );
    try {
      const r = await cli(
        ["--json", "agnes-video", "--prompt", "x", "--no-wait"],
        agnesEnv(mock.endpoint, { AGNES_MAX_RETRIES: "2" }),
      );
      expect(r.code).toBe(3);
      const err = parseError(r);
      expect(err.details).toMatchObject({
        source: "agnes",
        reason: "queue_full_exhausted",
        keyCount: 1,
      });
      const attempts = err.details?.attempts as { status: number; message: string }[];
      expect(attempts).toHaveLength(3);
      expect(attempts.every((a) => a.status === 503)).toBe(true);
      expect(attempts[0].message).toContain("video queue is full");
      expect(err.message).toContain("video queue is full");
      // 旧实现在这里写死 "image queue is full"
      expect(JSON.stringify(err.details) + err.message).not.toContain("image queue is full");
      // Bug 2：warning（envelope）与 error.message 共用同一条账本短语——
      // 同一个 run 里绝不能再出现「重试 8 次」与「重试 9 次」两个数
      const retry = warningsOf(r).find((w) => w.code === "E_PROVIDER_RETRY");
      expect(retry).toBeDefined();
      expect(err.message).toContain(phraseOf(retry?.message ?? ""));
      expect(numOf(err.message, RETRIED_RE)).toBe(numOf(retry?.message ?? "", RETRIED_RE));
      expect(numOf(err.message, REJECTED_RE)).toBe(numOf(retry?.message ?? "", REJECTED_RE));
      // Bug 1：maxRetries=2 → 三次被拒只睡了前两步（Retry-After: 0 → 每步 0ms），
      // 收尾那次没补发也不该计，所以重试 2 次 ≠ 未放行请求 3 次
      expect(err.message).toContain("已原地退避重试 2 次");
      expect(err.message).toContain("未放行请求 3 次，含首次提交");
      expect(r.stdout + r.stderr).not.toContain("ag-test-secret-key");
    } finally {
      await mock.close();
    }
  }, 30000);

  it("Bug 3：轮询 200 体里只有数字 code（code:0 / code:200）不再误杀已付费的生成", async () => {
    let polls = 0;
    const mock = await startMock((req, endpoint) => {
      if (req.path === VIDEO_SUBMIT_ENDPOINT) {
        return { status: 200, body: { id: "vid-num", status: "queued" } };
      }
      if (req.path === VIDEO_POLL_ENDPOINT) {
        polls += 1;
        // 旧写法把数字 stringify 成 "0"/"200" 当成非空原因 → videoFailed 抛错 → 白烧一次额度
        if (polls === 1) return { status: 200, body: { error: { code: 0 } } };
        if (polls === 2) return { status: 200, body: { error: { code: 200 }, data: null } };
        return { status: 200, body: { status: "completed", url: `${endpoint}/paid.mp4` } };
      }
      return { status: 200, body: "MP4" };
    });
    try {
      const out = path.join(dir, "num-code.mp4");
      const r = await cli(
        ["--json", "agnes-video", "--prompt", "x", "--output", out],
        agnesEnv(mock.endpoint, pollFast),
      );
      expect(r.code, r.stdout + r.stderr).toBe(0);
      const data = parseData<{ sourceUrl: string; status: string }>(r);
      expect(data.sourceUrl).toBe(`${mock.endpoint}/paid.mp4`);
      expect(data.status).toBe("completed");
      expect(polls).toBe(3);
      // 纯数字骨架连「抖动」都不算（没有人话原因）：账本里不该冒出一次重试
      expect(warningsOf(r).map((w) => w.code)).not.toContain("E_PROVIDER_RETRY");
    } finally {
      await mock.close();
    }
  });

  it("Bug 3：轮询 200 体里的 task not found（code:404）当空窗继续等，且账本看得见", async () => {
    let polls = 0;
    const mock = await startMock((req, endpoint) => {
      if (req.path === VIDEO_SUBMIT_ENDPOINT) {
        return { status: 200, body: { id: "vid-lag", status: "queued" } };
      }
      if (req.path === VIDEO_POLL_ENDPOINT) {
        polls += 1;
        // 真云实测未知 id 的轮询体：200 + {"error":{"code":404,"message":"task not found (request id: …)"}}
        if (polls <= 2) {
          return {
            status: 200,
            body: {
              error: { code: 404, message: "task not found (request id: req-lag)" },
              data: null,
            },
          };
        }
        return { status: 200, body: { status: "completed", url: `${endpoint}/lag.mp4` } };
      }
      return { status: 200, body: "MP4" };
    });
    try {
      const r = await cli(
        ["--json", "agnes-video", "--prompt", "x", "--output", path.join(dir, "lag.mp4")],
        agnesEnv(mock.endpoint, pollFast),
      );
      expect(r.code, r.stdout + r.stderr).toBe(0);
      expect(parseData<{ sourceUrl: string }>(r).sourceUrl).toContain("/lag.mp4");
      expect(polls).toBe(3);
      const retry = warningsOf(r).find((w) => w.code === "E_PROVIDER_RETRY");
      expect(retry?.message).toContain("task_missing×2");
      // 两次空窗都真的睡了一轮再重发 → 重试 2 次 = 未放行 2 次，等待 = 2 × 轮询间隔
      expect(numOf(retry?.message ?? "", RETRIED_RE)).toBe(2);
      expect(numOf(retry?.message ?? "", REJECTED_RE)).toBe(2);
      expect(numOf(retry?.message ?? "", WAITED_RE)).toBe(2 * 10);
      expect(retry?.message).toContain("task not found");
      expect(r.stdout + r.stderr).not.toContain("ag-test-secret-key");
    } finally {
      await mock.close();
    }
  });

  it("Bug 1：轮询超时前的最后一步不睡，累计等待只算真睡过的那些轮", async () => {
    const mock = await startMock((req) => {
      if (req.path === VIDEO_SUBMIT_ENDPOINT) {
        return { status: 200, body: { id: "vid-wait", status: "queued" } };
      }
      // 每次都回「暂时查不到」，直到总 deadline 收敛（AGNES_TIMEOUT_MS=5000）
      if (req.path === VIDEO_POLL_ENDPOINT) {
        return {
          status: 200,
          body: { error: { code: 404, message: "task not found (request id: req-wait)" } },
        };
      }
      return { status: 200, body: "MP4" };
    });
    try {
      const r = await cli(
        ["--json", "agnes-video", "--prompt", "x", "--output", path.join(dir, "wait.mp4")],
        agnesEnv(mock.endpoint, { AGNES_POLL_INTERVAL_MS: "50" }),
      );
      expect(r.code).toBe(3);
      const err = parseError(r);
      expect(err.details).toMatchObject({ reason: "timeout", taskId: "vid-wait" });
      const retry = warningsOf(r).find((w) => w.code === "E_PROVIDER_RETRY");
      expect(retry).toBeDefined();
      const rejected = numOf(retry?.message ?? "", REJECTED_RE);
      expect(rejected).toBeGreaterThan(2);
      // 收尾那一次抖动之后没睡就抛错了 → 等待与重试都比抖动记录少一步
      expect(numOf(retry?.message ?? "", RETRIED_RE)).toBe(rejected - 1);
      expect(numOf(retry?.message ?? "", WAITED_RE)).toBe((rejected - 1) * 50);
      // 抖动次数与超时错误里的 misses 同源（同一本账）
      expect(err.details?.taskNotFoundResponses).toBe(rejected);
    } finally {
      await mock.close();
    }
  }, 30000);

  it("B5：轮询回全空 error 骨架且载荷裹在 data 里 → 不误杀任务，最终从 data.url 取到结果", async () => {
    let polls = 0;
    const mock = await startMock((req, endpoint) => {
      if (req.path === VIDEO_SUBMIT_ENDPOINT) {
        return { status: 200, body: { id: "vid-env", status: "queued" } };
      }
      if (req.path === VIDEO_POLL_ENDPOINT) {
        polls += 1;
        // 第 1 次：网关的空 error 骨架（旧写法在这里就判死，白烧一次额度）
        if (polls === 1) return emptyErrorEnvelope;
        // 第 2 次：completed 裹在 data 里（旧写法只读顶层 status/url，永远等不到）
        return {
          status: 200,
          body: { data: { status: "completed", url: `${endpoint}/nested.mp4` }, error: null },
        };
      }
      return { status: 200, body: "MP4" };
    });
    try {
      const out = path.join(dir, "nested.mp4");
      const r = await cli(
        ["--json", "agnes-video", "--prompt", "x", "--output", out],
        agnesEnv(mock.endpoint, pollFast),
      );
      expect(r.code, r.stdout + r.stderr).toBe(0);
      const data = parseData<{ sourceUrl: string; status: string; bytes: number }>(r);
      expect(data.sourceUrl).toBe(`${mock.endpoint}/nested.mp4`);
      expect(data.status).toBe("completed");
      expect((await readFile(out)).equals(MP4_BYTES)).toBe(true);
      expect(polls).toBe(2);
    } finally {
      await mock.close();
    }
  });

  it("B5：轮询撞 400 task not exist（最终一致性空窗）继续等，不作废已付费的生成", async () => {
    let polls = 0;
    const mock = await startMock((req, endpoint) => {
      if (req.path === VIDEO_SUBMIT_ENDPOINT) {
        return { status: 200, body: { id: "vid-miss", status: "queued" } };
      }
      if (req.path === VIDEO_POLL_ENDPOINT) {
        polls += 1;
        // 实测备选路由 GET {base}/v1/videos/{id} 对刚提交的任务回 400 "task not exist"
        if (polls <= 3) {
          return {
            status: 400,
            body: { code: "", message: "task not exist (request id: req-miss)", data: null },
          };
        }
        return { status: 200, body: { status: "completed", url: `${endpoint}/late.mp4` } };
      }
      return { status: 200, body: "MP4" };
    });
    try {
      const r = await cli(
        ["--json", "agnes-video", "--prompt", "x", "--output", path.join(dir, "late.mp4")],
        agnesEnv(mock.endpoint, pollFast),
      );
      expect(r.code, r.stdout + r.stderr).toBe(0);
      expect(parseData<{ sourceUrl: string }>(r).sourceUrl).toContain("/late.mp4");
      expect(polls).toBe(4);
      const retry = warningsOf(r).find((w) => w.code === "E_PROVIDER_RETRY");
      expect(retry?.message).toContain("task_missing×3");
    } finally {
      await mock.close();
    }
  });

  it("B5：轮询撞 400 但确是参数错 → 仍然立即失败（宽容不许变成漏判）", async () => {
    const mock = await startMock((req) => {
      if (req.path === VIDEO_SUBMIT_ENDPOINT) {
        return { status: 200, body: { id: "vid-400", status: "queued" } };
      }
      return {
        status: 400,
        body: { error: { message: "model_name has invalid value", code: "invalid_request" } },
      };
    });
    try {
      const r = await cli(
        ["--json", "agnes-video", "--prompt", "x", "--output", path.join(dir, "400.mp4")],
        agnesEnv(mock.endpoint, pollFast),
      );
      expect(r.code).toBe(3);
      const err = parseError(r);
      expect(err.details).toMatchObject({ status: 400, taskId: "vid-400" });
      expect(err.message).toContain("model_name has invalid value");
      expect(mock.requests.filter((q) => q.path === VIDEO_POLL_ENDPOINT)).toHaveLength(1);
    } finally {
      await mock.close();
    }
  });

  it("status=failed 或非空 error → E_PROVIDER_ERROR 带 taskId，且不落盘", async () => {
    const mock = await startMock((req) => {
      if (req.path === VIDEO_SUBMIT_ENDPOINT) {
        return { status: 200, body: { id: "vid-bad", status: "queued" } };
      }
      if (req.path === VIDEO_POLL_ENDPOINT) {
        return {
          status: 200,
          body: { status: "failed", error: { message: "content policy rejected" } },
        };
      }
      return { status: 200, body: "MP4" };
    });
    try {
      const out = path.join(dir, "bad.mp4");
      const r = await cli(
        ["--json", "agnes-video", "--prompt", "x", "--output", out],
        agnesEnv(mock.endpoint, pollFast),
      );
      expect(r.code).toBe(3);
      const err = parseError(r);
      expect(err.code).toBe("E_PROVIDER_ERROR");
      expect(err.details?.taskId).toBe("vid-bad");
      expect(err.message).toContain("content policy rejected");
      expect(await readFile(out).catch(() => null)).toBeNull();
    } finally {
      await mock.close();
    }
  });

  it("提交撞 400：不重试不换 key（detail 形态摊平成人话）", async () => {
    const mock = await startMock(() => ({
      status: 400,
      body: { detail: "images length must not exceed 5" },
    }));
    try {
      const r = await cli(
        ["--json", "agnes-video", "--prompt", "x", "--images", IMG(1)],
        agnesEnv(mock.endpoint),
      );
      expect(r.code).toBe(3);
      const err = parseError(r);
      expect(err.code).toBe("E_PROVIDER_ERROR");
      expect(err.details?.status).toBe(400);
      expect(String(err.details?.message)).toContain("images length must not exceed 5");
      expect(mock.requests.filter((q) => q.path === VIDEO_SUBMIT_ENDPOINT)).toHaveLength(1);
      expect(mock.requests).toHaveLength(1);
    } finally {
      await mock.close();
    }
  });

  it("轮询到 deadline 仍未完成 → E_PROVIDER_ERROR timeout（非交互绝不挂死）", async () => {
    const mock = await startMock(videoStub(false));
    try {
      const r = await cli(
        ["--json", "agnes-video", "--prompt", "x", "--output", path.join(dir, "slow.mp4")],
        agnesEnv(mock.endpoint, { AGNES_POLL_INTERVAL_MS: "50" }),
      );
      expect(r.code).toBe(3);
      const err = parseError(r);
      expect(err.code).toBe("E_PROVIDER_ERROR");
      expect(err.details).toMatchObject({ source: "agnes", reason: "timeout", taskId: "vid-42" });
      expect(mock.requests.filter((q) => q.path === VIDEO_POLL_ENDPOINT).length).toBeGreaterThan(2);
    } finally {
      await mock.close();
    }
  }, 30000);
});
