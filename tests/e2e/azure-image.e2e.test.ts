import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const BIN = fileURLToPath(new URL("../../dist/media-cli.js", import.meta.url));

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(args: string[], env: Record<string, string> = {}): Promise<CliRun> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [BIN, ...args], {
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

// ---- 本地 mock：按 Bearer key 区分账号行为（同 URL 多账号是合法配对） ----

interface RecordedRequest {
  key: string;
  path: string;
  query: string;
  body: Buffer;
  contentType?: string;
}

interface Mock {
  endpoint: string;
  hits: Record<string, number>;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

interface MockReply {
  status: number;
  body: string;
}

function startMock(
  behavior: (key: string, body: Buffer, contentType?: string) => MockReply,
): Promise<Mock> {
  return new Promise((resolve) => {
    const hits: Record<string, number> = {};
    const requests: RecordedRequest[] = [];
    const server: Server = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        const auth = req.headers.authorization ?? "";
        const key = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
        hits[key] = (hits[key] ?? 0) + 1;
        const rawUrl = req.url ?? "";
        requests.push({
          key,
          path: rawUrl.split("?")[0],
          query: rawUrl.split("?")[1] ?? "",
          body,
          contentType: req.headers["content-type"],
        });
        const reply = behavior(key, body, req.headers["content-type"]);
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(reply.body);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        endpoint: `http://127.0.0.1:${port}`,
        hits,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function okBody(revisedPrompt: string): MockReply {
  return {
    status: 200,
    body: JSON.stringify({
      data: [{ b64_json: PNG_BYTES.toString("base64"), revised_prompt: revisedPrompt }],
    }),
  };
}

function failBody(status: number): MockReply {
  return { status, body: JSON.stringify({ error: { message: `mock-${status}` } }) };
}

function azureEnv(endpoint: string, keys: string): Record<string, string> {
  return {
    AZURE_IMAGE_KEY_POOL: keys,
    AZURE_IMAGE_ENDPOINT_POOL: Array(keys.split(",").length).fill(endpoint).join(","),
  };
}

interface MultipartPart {
  name: string;
  filename?: string;
  data: Buffer;
}

function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const parts = body.toString("latin1").split(`--${boundary}`).slice(1, -1);
  return parts.map((part) => {
    const headerEnd = part.indexOf("\r\n\r\n");
    const headers = part.slice(0, headerEnd);
    const payload = part.slice(headerEnd + 4).replace(/\r\n$/, "");
    const name = /name="([^"]+)"/.exec(headers)?.[1] ?? "";
    const filename = /filename="([^"]+)"/.exec(headers)?.[1];
    return { name, filename, data: Buffer.from(payload, "latin1") };
  });
}

describe("azure-image e2e（本地 mock）", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "azure-image-e2e-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("纯文案 generations 成功：落盘、契约字段、请求体与 URL 均正确", async () => {
    const mock = await startMock((key) => okBody(`rp-${key}`));
    try {
      const out = path.join(dir, "gen.png");
      const r = await cli(["--json", "image-gen", "--prompt", "a red apple", "--output", out], {
        ...azureEnv(mock.endpoint, "secret-key-one"),
      });
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout) as {
        ok: boolean;
        data: {
          path: string;
          bytes: number;
          format: string;
          size: string;
          revisedPrompt: string;
          account: { index: number; endpoint: string };
        };
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.data.format).toBe("png");
      expect(parsed.data.size).toBe("1024x1024");
      expect(parsed.data.bytes).toBe(PNG_BYTES.length);
      expect(parsed.data.account.index).toBe(0);
      expect(parsed.data.account.endpoint).toBe(mock.endpoint);
      expect(parsed.data.revisedPrompt).toBe("rp-secret-key-one");
      expect((await readFile(out)).equals(PNG_BYTES)).toBe(true);

      const req = mock.requests[0];
      expect(req.path).toBe("/openai/deployments/gpt-image-2/images/generations");
      expect(req.query).toContain("api-version=2025-04-01-preview");
      expect(JSON.parse(req.body.toString())).toEqual({
        prompt: "a red apple",
        size: "1024x1024",
        quality: "auto",
        output_format: "png",
        n: 1,
      });
    } finally {
      await mock.close();
    }
  });

  it("参考图 edits 成功：multipart 含 image[] 字节与文本字段", async () => {
    const mock = await startMock(() => okBody("edited"));
    try {
      const refA = path.join(dir, "ref-a.bin");
      const refB = path.join(dir, "ref-b.bin");
      const REF_A = Buffer.from([1, 2, 3, 4, 5]);
      const REF_B = Buffer.from([9, 8, 7]);
      await writeFile(refA, REF_A);
      await writeFile(refB, REF_B);
      const out = path.join(dir, "edit.png");
      const r = await cli(
        ["--json", "image-gen", "--prompt", "with refs", "--ref", refA, refB, "--output", out],
        azureEnv(mock.endpoint, "secret-key-one"),
      );
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout) as { data: { path: string } };
      expect((await readFile(parsed.data.path)).equals(PNG_BYTES)).toBe(true);

      const req = mock.requests[0];
      expect(req.path).toBe("/openai/deployments/gpt-image-2/images/edits");
      const boundary = /boundary=([^;]+)/.exec(req.contentType ?? "")?.[1] ?? "";
      expect(boundary).not.toBe("");
      const parts = parseMultipart(req.body, boundary);
      const images = parts.filter((p) => p.name === "image[]");
      expect(images).toHaveLength(2);
      expect(images[0].data.equals(REF_A)).toBe(true);
      expect(images[1].data.equals(REF_B)).toBe(true);
      expect(parts.find((p) => p.name === "prompt")?.data.toString()).toBe("with refs");
      expect(parts.find((p) => p.name === "output_format")?.data.toString()).toBe("png");
    } finally {
      await mock.close();
    }
  });

  it("三账号 429/429/200：轮换到成功账号且请求次数符合语义", async () => {
    const mock = await startMock((key) =>
      key === "pool-key-three" ? okBody("rp-three") : failBody(429),
    );
    try {
      const out = path.join(dir, "rot.png");
      const r = await cli(["--json", "image-gen", "--prompt", "x", "--output", out], {
        ...azureEnv(mock.endpoint, "pool-key-one,pool-key-two,pool-key-three"),
      });
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout) as {
        data: { account: { index: number }; revisedPrompt: string };
      };
      expect(parsed.data.account.index).toBe(2);
      expect(parsed.data.revisedPrompt).toBe("rp-three");
      expect(mock.hits["pool-key-three"]).toBe(1);
      expect(mock.hits["pool-key-one"] ?? 0).toBeLessThanOrEqual(1);
      expect(mock.hits["pool-key-two"] ?? 0).toBeLessThanOrEqual(1);
    } finally {
      await mock.close();
    }
  });

  it("全池 429 → E_PROVIDER_ERROR，attempts 含每账号且不泄漏 key", async () => {
    const mock = await startMock(() => failBody(429));
    try {
      const r = await cli(["--json", "image-gen", "--prompt", "x"], {
        ...azureEnv(mock.endpoint, "secret-key-one,secret-key-two"),
      });
      expect(r.code).toBe(3);
      const parsed = JSON.parse(r.stdout) as {
        ok: boolean;
        error: { code: string; details: { attempts: { index: number; status: number }[] } };
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe("E_PROVIDER_ERROR");
      expect(parsed.error.details.attempts).toHaveLength(2);
      for (const attempt of parsed.error.details.attempts) {
        expect(Object.keys(attempt).sort()).toEqual(["index", "message", "status"]);
      }
      expect(r.stdout + r.stderr).not.toContain("secret-key-one");
      expect(r.stdout + r.stderr).not.toContain("secret-key-two");
    } finally {
      await mock.close();
    }
  });

  it("400 参数错误不轮换：总请求 1 次", async () => {
    const mock = await startMock(() => failBody(400));
    try {
      const r = await cli(["--json", "image-gen", "--prompt", "x"], {
        ...azureEnv(mock.endpoint, "secret-key-one,secret-key-two"),
      });
      expect(r.code).toBe(3);
      const parsed = JSON.parse(r.stdout) as { error: { code: string } };
      expect(parsed.error.code).toBe("E_PROVIDER_ERROR");
      const totalHits = Object.values(mock.hits).reduce((a, b) => a + b, 0);
      expect(totalHits).toBe(1);
    } finally {
      await mock.close();
    }
  });

  it("池配置错误 → E_CONFIG 且不发任何请求", async () => {
    const mock = await startMock(() => okBody("never"));
    try {
      const mismatch = await cli(["--json", "image-gen", "--prompt", "x"], {
        AZURE_IMAGE_KEY_POOL: "only-one-key",
        AZURE_IMAGE_ENDPOINT_POOL: `${mock.endpoint},${mock.endpoint}`,
      });
      expect(mismatch.code).toBe(3);
      expect((JSON.parse(mismatch.stdout) as { error: { code: string } }).error.code).toBe(
        "E_CONFIG",
      );

      const missing = await cli(["--json", "image-gen", "--prompt", "x"], {
        AZURE_IMAGE_KEY_POOL: "",
        AZURE_IMAGE_ENDPOINT_POOL: mock.endpoint,
      });
      expect((JSON.parse(missing.stdout) as { error: { code: string } }).error.code).toBe(
        "E_CONFIG",
      );

      const badUrl = await cli(["--json", "image-gen", "--prompt", "x"], {
        AZURE_IMAGE_KEY_POOL: "k",
        AZURE_IMAGE_ENDPOINT_POOL: "not-a-url",
      });
      expect((JSON.parse(badUrl.stdout) as { error: { code: string } }).error.code).toBe(
        "E_CONFIG",
      );
      expect(Object.values(mock.hits).reduce((a, b) => a + b, 0)).toBe(0);
    } finally {
      await mock.close();
    }
  });

  it("用法错误：缺 --prompt 与 --size 非法", async () => {
    const mock = await startMock(() => okBody("never"));
    try {
      const noPrompt = await cli(["--json", "image-gen"], azureEnv(mock.endpoint, "k1"));
      expect(noPrompt.code).toBe(2);
      expect((JSON.parse(noPrompt.stdout) as { error: { code: string } }).error.code).toBe(
        "E_MISSING_ARGUMENT",
      );
      const badSize = await cli(["--json", "image-gen", "--prompt", "x", "--size", "1024"], {
        ...azureEnv(mock.endpoint, "k1"),
      });
      expect(badSize.code).toBe(2);
      expect((JSON.parse(badSize.stdout) as { error: { code: string } }).error.code).toBe(
        "E_INVALID_OPTION",
      );
      expect(Object.values(mock.hits).reduce((a, b) => a + b, 0)).toBe(0);
    } finally {
      await mock.close();
    }
  });

  it("单账号连续 10 次调用稳定（随机起点烟测）", async () => {
    const mock = await startMock(() => okBody("stable"));
    try {
      const out = path.join(dir, "smoke.png");
      for (let i = 0; i < 10; i++) {
        const r = await cli(["--json", "image-gen", "--prompt", "x", "--output", out], {
          ...azureEnv(mock.endpoint, "secret-key-one"),
        });
        expect(r.code).toBe(0);
      }
      await expect(stat(out)).resolves.toBeTruthy();
    } finally {
      await mock.close();
    }
  }, 30_000);
});
