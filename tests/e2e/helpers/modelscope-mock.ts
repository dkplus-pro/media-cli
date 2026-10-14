import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { CliRun } from "./cli.ts";

export const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

// 真实 8x16 PNG：用于校验 data.size 取真实像素而非请求值
export const REAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAQCAYAAAArij59AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFklEQVQokWP4z8DwHx9lGFXwfwSFAwAJef8BqE9SmQAAAABJRU5ErkJggg==",
  "base64",
);

export interface MockRequest {
  method: string;
  path: string;
  key: string;
  body: string;
}

export interface Mock {
  endpoint: string;
  requests: MockRequest[];
  close: () => Promise<void>;
}

// 本地 mock：路由交由 behavior 决定；key 用于区分「是否携带了不该携带的凭证」
export function startMock(
  behavior: (req: MockRequest, endpoint: string) => { status: number; body: unknown },
): Promise<Mock> {
  return new Promise((resolve) => {
    const requests: MockRequest[] = [];
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const rawUrl = req.url ?? "";
        const item: MockRequest = {
          method: req.method ?? "",
          path: rawUrl.split("?")[0],
          key: (req.headers.authorization ?? "").replace("Bearer ", ""),
          body: Buffer.concat(chunks).toString("utf8"),
        };
        requests.push(item);
        const reply = behavior(item, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
        const payload =
          reply.body === "PNG" ? PNG_BYTES : JSON.stringify(reply.body ?? { error: "empty" });
        res.writeHead(reply.status, {
          "content-type": reply.body === "PNG" ? "image/png" : "application/json",
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

export function msEnv(
  endpoint: string,
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    MODELSCOPE_BASE_URL: endpoint,
    MODELSCOPE_API_KEY: "ms-test-secret-key",
    MODELSCOPE_IMAGE_MODEL: "Qwen/Qwen-Image-2.1",
    MODELSCOPE_POLL_INTERVAL_MS: "10",
    MODELSCOPE_TIMEOUT_MS: "5000",
    // 池优先于单 key：默认删掉继承来的 KEY_POOL，避免本机真实 token 泄漏进 mock 用例
    // （helpers/cli.ts 对 undefined 值 = 从继承环境中删除）；需要池的用例经 extra 显式传
    MODELSCOPE_KEY_POOL: undefined,
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

// 参考图用例的桩响应：任何提交都直接回一张图
export const refStub = () => ({
  status: 200,
  body: { data: [{ b64_json: PNG_BYTES.toString("base64") }] },
});
