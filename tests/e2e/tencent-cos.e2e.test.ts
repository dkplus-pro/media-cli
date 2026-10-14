import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CliRun, cli } from "./helpers/cli.ts";

const FILE_BYTES = Buffer.from("cos-upload-payload");

interface MockRequest {
  method: string;
  path: string;
  contentType: string;
  auth: string;
  body: Buffer;
}

interface Mock {
  endpoint: string;
  host: string;
  requests: MockRequest[];
  close: () => Promise<void>;
}

// COS mock：接受任意 PUT 并回 ETag；failWith 非空时统一回该状态码（用于 403 等）
function startMock(status: number, message: string): Promise<Mock> {
  return new Promise((resolve) => {
    const requests: MockRequest[] = [];
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", async () => {
        requests.push({
          method: req.method ?? "",
          path: (req.url ?? "").split("?")[0],
          contentType: String(req.headers["content-type"] ?? ""),
          auth: String(req.headers.authorization ?? ""),
          body: Buffer.concat(chunks),
        });
        if (status === 200) {
          res.writeHead(200, { ETag: '"mock-etag-value"', "content-type": "application/xml" });
          res.end("<PutObjectResult/>");
        } else {
          res.writeHead(status, { "content-type": "application/xml" });
          res.end(`<Error><Code>AccessDenied</Code><Message>${message}</Message></Error>`);
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        endpoint: `http://127.0.0.1:${port}`,
        host: `127.0.0.1:${port}`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function cosEnv(
  host: string,
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    TENCENT_SECRET_ID: "sid-test-value",
    TENCENT_SECRET_KEY: "skey-test-value",
    COS_REGION: "ap-guangzhou",
    COS_ENV: "prod",
    COS_PROD_BUCKET: "ai4love-1300000000",
    COS_PROD_PREFIX: "tmp/",
    CDN_PURGE_URL_PROD: "https://cdn.ai4love.cn/tmp/dist/index.html",
    COS_TEST_BUCKET: "ai4love-dev-1300000000",
    COS_TEST_PREFIX: "tmp/dev/",
    CDN_PURGE_URL_TEST: "https://devcdn.ai4love.cn/tmp/dist/index.html",
    // 把 SDK 请求指向本地 mock（真实 COS 不参与 e2e）
    TENCENT_COS_DOMAIN: host,
    TENCENT_COS_TIMEOUT_MS: "5000",
    ...extra,
  };
}

function parseError(r: CliRun): {
  code: string;
  message: string;
  details?: Record<string, unknown>;
} {
  return JSON.parse(r.stdout).error;
}

function parseData(r: CliRun): Record<string, unknown> {
  return JSON.parse(r.stdout).data;
}

let dir: string;
let file: string;

beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "media-cos-")));
  file = path.join(dir, "参考 图.png");
  await writeFile(file, FILE_BYTES);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("tencent-cos-upload e2e（本地 COS mock）", () => {
  it("默认 key：PUT 上传字节一致，URL 用 CDN 域名 origin + 前缀 + slug 文件名", async () => {
    const mock = await startMock(200, "unused");
    try {
      const r = await cli(["--json", "tencent-cos-upload", "--file", file], cosEnv(mock.host));
      expect(r.code).toBe(0);
      expect(mock.requests).toHaveLength(1);
      const sent = mock.requests[0];
      expect(sent.method).toBe("PUT");
      expect(sent.body.equals(FILE_BYTES)).toBe(true);
      expect(sent.contentType).toBe("image/png");

      const data = parseData(r);
      expect(String(data.key)).toMatch(/^tmp\/file-[0-9T:.Z-]+\.png$/);
      expect(data.url).toBe(`https://cdn.ai4love.cn/${data.key}`);
      expect(data).toMatchObject({
        bucket: "ai4love-1300000000",
        region: "ap-guangzhou",
        env: "prod",
        bytes: FILE_BYTES.length,
        contentType: "image/png",
        etag: '"mock-etag-value"',
      });
    } finally {
      await mock.close();
    }
  });

  it("--env test 换池：test 桶、test 前缀与 test 域名", async () => {
    const mock = await startMock(200, "unused");
    try {
      const r = await cli(
        ["--json", "tencent-cos-upload", "--file", file, "--env", "test"],
        cosEnv(mock.host),
      );
      expect(r.code).toBe(0);
      const data = parseData(r);
      expect(String(data.key)).toMatch(/^tmp\/dev\//);
      expect(data.url).toBe(`https://devcdn.ai4love.cn/${data.key}`);
      expect(data).toMatchObject({ bucket: "ai4love-dev-1300000000", env: "test" });
    } finally {
      await mock.close();
    }
  });

  it("--key 指定对象名（仍带池前缀），--content-type 覆盖推断", async () => {
    const mock = await startMock(200, "unused");
    try {
      const r = await cli(
        [
          "--json",
          "tencent-cos-upload",
          "--file",
          file,
          "--key",
          "a/b.png",
          "--content-type",
          "application/octet-stream",
        ],
        cosEnv(mock.host),
      );
      expect(r.code).toBe(0);
      expect(mock.requests[0].path).toBe("/tmp/a/b.png");
      expect(mock.requests[0].contentType).toBe("application/octet-stream");
      expect(parseData(r).url).toBe("https://cdn.ai4love.cn/tmp/a/b.png");
    } finally {
      await mock.close();
    }
  });

  it("上传失败 → E_PROVIDER_ERROR 带 source/status，且输出不含 SecretKey", async () => {
    const mock = await startMock(403, "SignatureDoesNotMatch demo");
    try {
      const r = await cli(["--json", "tencent-cos-upload", "--file", file], cosEnv(mock.host));
      expect(r.code).toBe(3);
      const err = parseError(r);
      expect(err.code).toBe("E_PROVIDER_ERROR");
      expect(err.details).toMatchObject({
        source: "tencent-cos",
        status: 403,
        bucket: "ai4love-1300000000",
      });
      expect(`${r.stdout}${r.stderr}`).not.toContain("skey-test-value");
    } finally {
      await mock.close();
    }
  });

  it("用法与配置错误：不发任何请求", async () => {
    const mock = await startMock(200, "unused");
    try {
      const noFile = await cli(["--json", "tencent-cos-upload"], cosEnv(mock.host));
      expect(noFile.code).toBe(2);
      expect(parseError(noFile).code).toBe("E_MISSING_ARGUMENT");

      const missing = await cli(
        ["--json", "tencent-cos-upload", "--file", path.join(dir, "nope.png")],
        cosEnv(mock.host),
      );
      expect(missing.code).toBe(2);
      expect(parseError(missing).code).toBe("E_MISSING_ARGUMENT");

      const isDir = await cli(["--json", "tencent-cos-upload", "--file", dir], cosEnv(mock.host));
      expect(isDir.code).toBe(2);
      expect(parseError(isDir).code).toBe("E_INVALID_OPTION");

      const badEnv = await cli(
        ["--json", "tencent-cos-upload", "--file", file, "--env", "staging"],
        cosEnv(mock.host),
      );
      expect(badEnv.code).toBe(2);
      expect(parseError(badEnv).code).toBe("E_INVALID_OPTION");

      for (const bad of ["/abs.png", "../escape.png", "a b.png", "中文.png"]) {
        const badKey = await cli(
          ["--json", "tencent-cos-upload", "--file", file, "--key", bad],
          cosEnv(mock.host),
        );
        expect(badKey.code).toBe(2);
        expect(parseError(badKey).code).toBe("E_INVALID_OPTION");
      }

      const badPool = cosEnv(mock.host, { COS_ENV: "staging" });
      const poolInvalid = await cli(["--json", "tencent-cos-upload", "--file", file], badPool);
      expect(poolInvalid.code).toBe(3);
      expect(parseError(poolInvalid).code).toBe("E_CONFIG");

      // 显式置 undefined = 从继承环境中删除（避免本机真实凭据泄漏进错误分支）
      const noId = cosEnv(mock.host, { TENCENT_SECRET_ID: undefined });
      expect(
        parseError(await cli(["--json", "tencent-cos-upload", "--file", file], noId)).code,
      ).toBe("E_CONFIG");

      expect(mock.requests).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });

  it("未设 COS_ENV 且未传 --env → 默认落 prod 池", async () => {
    const mock = await startMock(200, "unused");
    try {
      const noPool = cosEnv(mock.host, { COS_ENV: undefined });
      const r = await cli(["--json", "tencent-cos-upload", "--file", file], noPool);
      expect(r.code).toBe(0);
      expect(mock.requests).toHaveLength(1);
      expect(parseData(r)).toMatchObject({
        env: "prod",
        bucket: "ai4love-1300000000",
        region: "ap-guangzhou",
      });
      expect(String(parseData(r).key)).toMatch(/^tmp\//);
    } finally {
      await mock.close();
    }
  });
});
