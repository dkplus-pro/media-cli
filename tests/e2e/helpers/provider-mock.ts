import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { CliRun } from "./cli.ts";

// 真实 8x16 PNG：用于校验 data.size 取真实像素而非请求值
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
  /** 不含 query 的 pathname，用于路由断言 */
  path: string;
  /** query string（不含 ?） */
  query: string;
  headers: Record<string, string | string[] | undefined>;
  key: string;
  /** utf8 文本（JSON 或 multipart 结构；二进制参考图可能带替换字符） */
  body: string;
  raw: Buffer;
}

export interface MockReply {
  status?: number;
  /** 序列化成 JSON 的响应体；与 binary 二选一 */
  body?: unknown;
  /** 原样写回的二进制（图片/音频/视频） */
  binary?: Buffer;
  headers?: Record<string, string>;
}

export type MockBehavior = (req: MockRequest, endpoint: string) => MockReply | Promise<MockReply>;

export interface Mock {
  endpoint: string;
  requests: MockRequest[];
  close: () => Promise<void>;
}

// 本地 mock：行为函数完全决定响应；requests 记录每次请求供断言
export function startMock(behavior: MockBehavior): Promise<Mock> {
  return new Promise((resolve) => {
    const requests: MockRequest[] = [];
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        void (async () => {
          const rawUrl = req.url ?? "";
          const [path, query = ""] = rawUrl.split("?");
          const raw = Buffer.concat(chunks);
          const item: MockRequest = {
            method: req.method ?? "",
            path,
            query,
            headers: req.headers,
            key: String(req.headers.authorization ?? "").replace("Bearer ", ""),
            body: raw.toString("utf8"),
            raw,
          };
          requests.push(item);
          const port = (server.address() as AddressInfo).port;
          const reply = await behavior(item, `http://127.0.0.1:${port}`);
          const headers: Record<string, string> = { ...(reply.headers ?? {}) };
          let payload: Buffer;
          if (reply.binary !== undefined) {
            payload = reply.binary;
            headers["content-type"] ??= "application/octet-stream";
          } else {
            payload = Buffer.from(JSON.stringify(reply.body ?? {}));
            headers["content-type"] ??= "application/json";
          }
          res.writeHead(reply.status ?? 200, headers);
          res.end(payload);
        })();
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

// 按调用次序回放；最后一次重复（用于「401 一次即停」「429 后恢复」这类断言）
export function sequence(replies: MockReply[]): MockBehavior {
  let index = 0;
  return () => replies[Math.min(index++, replies.length - 1)];
}

export function requestJson(mock: Mock, index = 0): Record<string, unknown> {
  const raw = mock.requests[index]?.body;
  if (raw === undefined) {
    throw new Error(`mock 只收到 ${mock.requests.length} 个请求，取不到第 ${index} 个`);
  }
  return JSON.parse(raw) as Record<string, unknown>;
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

/**
 * 本机 ~/.zshrc 里有真实 provider key：每个 env 构造器都用假 key 覆盖，
 * 并用 undefined 删掉继承来的变量（helpers/cli.ts 中 undefined = 从环境删除），
 * 避免 mock 用例误打真云并扣费。
 */
export function bananaEnv(
  endpoint: string,
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    BANANA_IMAGE_API_KEY: "banana-test-key",
    BANANA_IMAGE_API_BASE: endpoint,
    BANANA_IMAGE_MODEL: undefined,
    BANANA_IMAGE_QUALITY: undefined,
    BANANA_IMAGE_MODERATION: undefined,
    BANANA_IMAGE_OUTPUT_FORMAT: undefined,
    BANANA_IMAGE_TIMEOUT_MS: "5000",
    ...extra,
  };
}

export function minimaxEnv(
  endpoint: string,
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    MINIMAX_API_KEY: "minimax-test-key",
    MINIMAX_API_BASE_URL: endpoint,
    MINIMAX_API_BASR_URL: undefined,
    MINIMAX_SPEECH_MODEL: undefined,
    MINIMAX_MUSIC_MODEL: undefined,
    MINIMAX_VIDEO_MODEL: undefined,
    ...extra,
  };
}

export function doubaoImageEnv(
  endpoint: string,
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    DOUBAO_API_KEY: "doubao-test-key",
    DOUBAO_BASE_URL: endpoint,
    DOUBAO_IMAGE_MODEL: undefined,
    DOUBAO_TRANSCRIBE_MODEL: undefined,
    DOUBAO_VISION_MODEL: undefined,
    ...extra,
  };
}
