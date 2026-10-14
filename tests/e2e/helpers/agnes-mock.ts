import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { CliRun } from "./cli.ts";

export const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

// 真实 8x16 PNG：用于校验 data.size 报真实像素而非请求值（D21 显式 WxH 会被降采样）
export const REAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAQCAYAAAArij59AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFklEQVQokWP4z8DwHx9lGFXwfwSFAwAJef8BqE9SmQAAAABJRU5ErkJggg==",
  "base64",
);

// 视频不做解码校验（不调 sharp），一段假的 ftyp 头就够落盘断言
export const MP4_BYTES = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 1, 2, 3, 4,
]);

export interface MockRequest {
  method: string;
  path: string;
  /** query string（不含 ?）：video 的轮询参数在 URL 上，必须单独记 */
  query: string;
  key: string;
  body: string;
}

export interface Mock {
  endpoint: string;
  requests: MockRequest[];
  close: () => Promise<void>;
}

export interface MockReply {
  status: number;
  body: unknown;
  /** 响应头：容量类用例要带真实的 Retry-After（退避阶梯已改成 20s 起，测试必须靠它压秒） */
  headers?: Record<string, string>;
}

// 本地 mock：路由交由 behavior 决定；key 用于区分「是否携带了不该携带的凭证」
export function startMock(
  behavior: (req: MockRequest, endpoint: string) => MockReply,
): Promise<Mock> {
  return new Promise((resolve) => {
    const requests: MockRequest[] = [];
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const rawUrl = req.url ?? "";
        const [pathname, search = ""] = rawUrl.split("?");
        const item: MockRequest = {
          method: req.method ?? "",
          path: pathname,
          query: search,
          key: (req.headers.authorization ?? "").replace("Bearer ", ""),
          body: Buffer.concat(chunks).toString("utf8"),
        };
        requests.push(item);
        const reply = behavior(item, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
        const binary = reply.body === "PNG" ? PNG_BYTES : reply.body === "MP4" ? MP4_BYTES : null;
        const payload = binary ?? JSON.stringify(reply.body ?? { error: "empty" });
        res.writeHead(reply.status, {
          "content-type":
            reply.body === "PNG"
              ? "image/png"
              : reply.body === "MP4"
                ? "video/mp4"
                : "application/json",
          ...(reply.headers ?? {}),
        });
        res.end(payload);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        endpoint: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/**
 * ⚠️ 本机 ~/.zshrc 里有**真** AGNES_API_KEY / AGNES_KEY_POOL：
 * 必须用假 key 覆盖，并用 undefined 删掉继承来的池变量（helpers/cli.ts 里 undefined = 从环境删除），
 * 否则 mock 用例会把请求打到真云并真扣费（media-20 踩过的坑，§9.1）。
 * extra 最后展开，池/超时用例按需覆盖。
 */
export function agnesEnv(
  endpoint: string,
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    AGNES_BASE_URL: endpoint,
    AGNES_API_KEY: "ag-test-secret-key",
    AGNES_KEY_POOL: undefined,
    AGNES_IMAGE_MODEL: "agnes-image-2.5-flash",
    AGNES_VIDEO_MODEL: "agnes-video-2.5-flash",
    AGNES_TIMEOUT_MS: "5000",
    AGNES_MAX_RETRIES: "2",
    ...extra,
  };
}

export function parseError(r: CliRun): {
  code: string;
  message: string;
  details?: Record<string, unknown>;
} {
  return (
    JSON.parse(r.stdout) as {
      error: { code: string; message: string; details?: Record<string, unknown> };
    }
  ).error;
}

export function parseData<T = Record<string, unknown>>(r: CliRun): T {
  return (JSON.parse(r.stdout) as { data: T }).data;
}

// 第 index 个请求的 JSON 体；取不到就明确失败，别让后面的断言报出看不懂的 undefined
export function requestBody(mock: Mock, index = 0): unknown {
  const raw = mock.requests[index]?.body;
  if (raw === undefined) {
    throw new Error(`mock 只收到 ${mock.requests.length} 个请求，取不到第 ${index} 个`);
  }
  return JSON.parse(raw);
}

// 实测（§1.1）成功体：data[0].url + 根级 created/task_id；revised_prompt 是空字符串
export function imageReply(endpoint: string, name = "out.png") {
  return {
    status: 200,
    body: {
      data: [{ url: `${endpoint}/${name}`, b64_json: "", revised_prompt: "" }],
      created: 1700000000,
      task_id: "task-mock",
    },
  };
}

export function b64Reply(payload: Buffer = PNG_BYTES) {
  return {
    status: 200,
    body: { data: [{ url: "", b64_json: payload.toString("base64"), revised_prompt: "" }] },
  };
}

// 实测（§1.1）队列满体：503，type/param 为空串、code 为 null，1–3s 快速失败。
// retryAfterSeconds：把等待时长用标准 Retry-After 头明示——退避阶梯改成 20s 起步后，
// 容量类用例必须靠它把等待压到 0s（否则一个用例要跑几分钟）；真实 provider 也发这个头
export function queueFullReply(
  message = "image queue is full",
  retryAfterSeconds: number | null = 0,
) {
  return {
    status: 503,
    body: {
      error: {
        message: `${message}, please retry later (request id: req-queue-1)`,
        type: "",
        param: "",
        code: null,
      },
    },
    // null = 不发 Retry-After（用来验证「没有明示时长时走自己的阶梯」这条路径）
    ...(retryAfterSeconds === null
      ? {}
      : { headers: { "retry-after": String(retryAfterSeconds) } }),
  };
}

// 实测（2026-10 真云）视频通道饱和体：同一时刻图片通道 200 → per-lane 容量，与 key 无关
export const videoQueueFullReply = (retryAfterSeconds = 0) =>
  queueFullReply("video queue is full", retryAfterSeconds);

// 实测（2026-10 真云）：20 秒内连发 3 次提交 → 503 翻成 429 rate_limit_exceeded，约 3.5 分钟
// 自愈。旧代码把 429 判成「换 key」，单 key 池第一次 429 就当场死掉（计划 D22 的错处）
export function rateLimitedReply(retryAfterSeconds = 0) {
  return {
    status: 429,
    body: {
      error: {
        message:
          "You've reached the API rate limit for free users. Upgrade to a Token Plan (request id: req-429-1)",
        type: "AgnesAI_error",
        param: "",
        code: "rate_limit_exceeded",
      },
    },
    headers: { "retry-after": String(retryAfterSeconds) },
  };
}

// 实测：这网关会回全空 error 骨架（{"error":{"code":"","message":""}}）——
// 轮询侧旧写法把空壳当终态失败，等于误杀已付费的任务
export const emptyErrorEnvelope = {
  status: 200,
  body: { error: { code: "", message: "" }, data: { status: "running", internal_progress: 5 } },
};

// 实测（§1.1）参数错体：400 + OpenAI 风格 error 对象（provider 侧错误 type 是 AgnesAI_error）
export function badRequestReply(message: string, type = "invalid_request") {
  return { status: 400, body: { error: { message, type, param: "", code: "invalid_request" } } };
}

export const IMAGE_ENDPOINT = "/v1/images/generations";
export const VIDEO_SUBMIT_ENDPOINT = "/v1/videos";
export const VIDEO_POLL_ENDPOINT = "/agnesapi";
