import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CliRun, cli } from "./helpers/cli.ts";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

// 真实 8x16 PNG：用于校验 data.size 取真实像素而非请求值
const REAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAQCAYAAAArij59AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFklEQVQokWP4z8DwHx9lGFXwfwSFAwAJef8BqE9SmQAAAABJRU5ErkJggg==",
  "base64",
);

interface MockRequest {
  method: string;
  path: string;
  key: string;
  body: string;
}

interface Mock {
  endpoint: string;
  requests: MockRequest[];
  close: () => Promise<void>;
}

// 本地 mock：路由交由 behavior 决定；key 用于区分「是否携带了不该携带的凭证」
function startMock(
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

function msEnv(endpoint: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    MODELSCOPE_BASE_URL: endpoint,
    MODELSCOPE_API_KEY: "ms-test-secret-key",
    MODELSCOPE_IMAGE_MODEL: "Qwen/Qwen-Image-2.1",
    MODELSCOPE_POLL_INTERVAL_MS: "10",
    MODELSCOPE_TIMEOUT_MS: "5000",
    ...extra,
  };
}

function parseError(r: CliRun): {
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

describe("modelscope-image e2e（本地 mock）", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "modelscope-image-e2e-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("同步返回 b64_json：落盘、payload 与契约字段正确", async () => {
    const mock = await startMock(() => ({
      status: 200,
      body: { data: [{ b64_json: PNG_BYTES.toString("base64") }] },
    }));
    try {
      const out = path.join(dir, "sync.png");
      const r = await cli(
        [
          "--json",
          "modelscope-image-gen",
          "--prompt",
          "a red apple",
          "--size",
          "1024x1536",
          "--output",
          out,
        ],
        msEnv(mock.endpoint),
      );
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout) as {
        ok: boolean;
        data: { path: string; bytes: number; model: string; size: string };
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.data.model).toBe("Qwen/Qwen-Image-2.1");
      expect(parsed.data.size).toBe("1024x1536");
      expect(parsed.data.bytes).toBe(PNG_BYTES.length);
      expect((await readFile(out)).equals(PNG_BYTES)).toBe(true);

      const req = mock.requests[0];
      expect(req.method).toBe("POST");
      expect(req.path).toBe("/v1/images/generations");
      expect(JSON.parse(req.body)).toEqual({
        model: "Qwen/Qwen-Image-2.1",
        prompt: "a red apple",
        size: "1024x1536",
      });
    } finally {
      await mock.close();
    }
  });

  it("真实图片尺寸与请求不符：data.size 报真实像素并附 E_SIZE_MISMATCH 警告", async () => {
    const mock = await startMock(() => ({
      status: 200,
      body: { data: [{ b64_json: REAL_PNG.toString("base64") }] },
    }));
    try {
      const out = path.join(dir, "real.png");
      const r = await cli(
        ["--json", "modelscope-image-gen", "--prompt", "x", "--output", out],
        msEnv(mock.endpoint),
      );
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout) as {
        data: { size: string };
        warnings: { code: string; message: string }[];
      };
      // 8x16 的真实 PNG，请求的是 1024x1024
      expect(parsed.data.size).toBe("8x16");
      expect(parsed.warnings.map((w) => w.code)).toContain("E_SIZE_MISMATCH");
    } finally {
      await mock.close();
    }
  });

  it("异步任务（ModelScope 真实形态）：先 RUNNING 后 SUCCEED，完成响应里 task_id 与 output_images 并存", async () => {
    let polls = 0;
    const mock = await startMock((req, endpoint) => {
      if (req.path === "/v1/images/generations") {
        // 实测网关：提交响应就提前报 SUCCEED，但图只在任务端点里
        return { status: 200, body: { task_status: "SUCCEED", task_id: "task-42" } };
      }
      if (req.path === "/v1/tasks/task-42") {
        polls += 1;
        if (polls < 2) {
          return { status: 200, body: { task_status: "RUNNING", task_id: "task-42", outputs: {} } };
        }
        return {
          status: 200,
          body: {
            task_status: "SUCCEED",
            task_id: "task-42",
            output_images: [`${endpoint}/out.png`],
          },
        };
      }
      return { status: 200, body: "PNG" };
    });
    try {
      const out = path.join(dir, "async.png");
      const r = await cli(
        ["--json", "modelscope-image-gen", "--prompt", "x", "--output", out],
        msEnv(mock.endpoint),
      );
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout) as {
        data: { taskId: string; sourceUrl: string; bytes: number };
      };
      expect(parsed.data.taskId).toBe("task-42");
      expect(parsed.data.sourceUrl).toContain("/out.png");
      expect((await readFile(out)).equals(PNG_BYTES)).toBe(true);

      const taskReq = mock.requests.find((q) => q.path === "/v1/tasks/task-42");
      expect(taskReq?.key).toBe("ms-test-secret-key");
      const imageReq = mock.requests.find((q) => q.path === "/out.png");
      expect(imageReq?.key).toBe("");
    } finally {
      await mock.close();
    }
  });

  it("文档化参数全量透传：size/steps/guidance/seed/negative_prompt", async () => {
    const mock = await startMock(() => ({
      status: 200,
      body: { data: [{ b64_json: PNG_BYTES.toString("base64") }] },
    }));
    try {
      const out = path.join(dir, "opts.png");
      const r = await cli(
        [
          "--json",
          "modelscope-image-gen",
          "--prompt",
          "x",
          "--model",
          "Other/Model",
          "--size",
          "1328x1328",
          "--steps",
          "40",
          "--guidance",
          "3.5",
          "--seed",
          "12345",
          "--negative-prompt",
          "blurry",
          "--output",
          out,
        ],
        msEnv(mock.endpoint),
      );
      expect(r.code).toBe(0);
      expect(JSON.parse(mock.requests[0].body)).toEqual({
        model: "Other/Model",
        prompt: "x",
        size: "1328x1328",
        steps: 40,
        guidance: 3.5,
        seed: 12345,
        negative_prompt: "blurry",
      });
    } finally {
      await mock.close();
    }
  });

  it("提交即出图（task_id 与 output_images 同响应）：不再轮询 tasks 端点", async () => {
    const mock = await startMock((req, endpoint) =>
      req.path === "/v1/images/generations"
        ? {
            status: 200,
            body: {
              task_status: "SUCCEED",
              task_id: "instant-1",
              output_images: [`${endpoint}/i.png`],
            },
          }
        : { status: 200, body: "PNG" },
    );
    try {
      const out = path.join(dir, "instant.png");
      const r = await cli(
        ["--json", "modelscope-image-gen", "--prompt", "x", "--output", out],
        msEnv(mock.endpoint),
      );
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout) as { data: { taskId: string; bytes: number } };
      expect(parsed.data.taskId).toBe("instant-1");
      expect((await readFile(out)).equals(PNG_BYTES)).toBe(true);
      expect(mock.requests.map((q) => q.path)).toEqual(["/v1/images/generations", "/i.png"]);
    } finally {
      await mock.close();
    }
  });

  it("缺 key / 缺 model → E_CONFIG 且不发请求", async () => {
    const mock = await startMock(() => ({ status: 200, body: {} }));
    try {
      const noKey = await cli(["--json", "modelscope-image-gen", "--prompt", "x"], {
        ...msEnv(mock.endpoint),
        MODELSCOPE_API_KEY: "",
      });
      expect(noKey.code).toBe(3);
      expect(parseError(noKey).code).toBe("E_CONFIG");

      const noModel = await cli(["--json", "modelscope-image-gen", "--prompt", "x"], {
        ...msEnv(mock.endpoint),
        MODELSCOPE_IMAGE_MODEL: "",
      });
      expect(noModel.code).toBe(3);
      expect(parseError(noModel).code).toBe("E_CONFIG");
      expect(mock.requests).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });

  it("401 报错：E_PROVIDER_ERROR 且不泄漏 apikey", async () => {
    const mock = await startMock(() => ({
      status: 401,
      body: { errors: { message: "Authentication failed, ms-test-secret-key leaked?" } },
    }));
    try {
      const r = await cli(
        ["--json", "modelscope-image-gen", "--prompt", "x"],
        msEnv(mock.endpoint),
      );
      expect(r.code).toBe(3);
      expect(parseError(r).code).toBe("E_PROVIDER_ERROR");
      expect(r.stdout + r.stderr).not.toContain("ms-test-secret-key");
    } finally {
      await mock.close();
    }
  });

  it("任务失败状态 → E_PROVIDER_ERROR 带 taskId", async () => {
    const mock = await startMock((req) =>
      req.path === "/v1/images/generations"
        ? { status: 200, body: { task_status: "PENDING", task_id: "task-99" } }
        : {
            status: 200,
            body: { task_status: "FAILED", task_id: "task-99", message: "model unavailable" },
          },
    );
    try {
      const r = await cli(
        ["--json", "modelscope-image-gen", "--prompt", "x"],
        msEnv(mock.endpoint),
      );
      expect(r.code).toBe(3);
      const err = parseError(r);
      expect(err.code).toBe("E_PROVIDER_ERROR");
      expect(err.details?.taskId).toBe("task-99");
    } finally {
      await mock.close();
    }
  });

  it("用法错误：缺 --prompt 与 --size 非法（退出码 2，不发请求）", async () => {
    const mock = await startMock(() => ({ status: 200, body: {} }));
    try {
      const noPrompt = await cli(["--json", "modelscope-image-gen"], msEnv(mock.endpoint));
      expect(noPrompt.code).toBe(2);
      expect(parseError(noPrompt).code).toBe("E_MISSING_ARGUMENT");

      const badSize = await cli(
        ["--json", "modelscope-image-gen", "--prompt", "x", "--size", "1024"],
        msEnv(mock.endpoint),
      );
      expect(badSize.code).toBe(2);
      expect(parseError(badSize).code).toBe("E_INVALID_OPTION");

      const badSteps = await cli(
        ["--json", "modelscope-image-gen", "--prompt", "x", "--steps", "abc"],
        msEnv(mock.endpoint),
      );
      expect(badSteps.code).toBe(2);
      expect(parseError(badSteps).code).toBe("E_INVALID_OPTION");

      // 网关只收 "WxH"（实测 "928*1664" 被拒），本地先拦
      const starSize = await cli(
        ["--json", "modelscope-image-gen", "--prompt", "x", "--size", "928*1664"],
        msEnv(mock.endpoint),
      );
      expect(starSize.code).toBe(2);
      expect(parseError(starSize).code).toBe("E_INVALID_OPTION");

      // 文档 guidance 范围 [1.5, 20]
      const badGuidance = await cli(
        ["--json", "modelscope-image-gen", "--prompt", "x", "--guidance", "1"],
        msEnv(mock.endpoint),
      );
      expect(badGuidance.code).toBe(2);
      expect(parseError(badGuidance).code).toBe("E_INVALID_OPTION");
      expect(mock.requests).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });

  it("默认输出名带时间戳与 URL 推断扩展名", async () => {
    const mock = await startMock((req, endpoint) =>
      req.path === "/v1/images/generations"
        ? { status: 200, body: { task_status: "PENDING", task_id: "t1" } }
        : req.path === "/v1/tasks/t1"
          ? {
              status: 200,
              body: { task_status: "SUCCEED", output_images: [`${endpoint}/gen.jpeg?sig=1`] },
            }
          : { status: 200, body: "PNG" },
    );
    try {
      const outDir = path.join(dir, "default-out");
      await mkdir(outDir, { recursive: true });
      const r = await cli(
        ["--json", "modelscope-image-gen", "--prompt", "x"],
        msEnv(mock.endpoint),
        outDir,
      );
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout) as { data: { path: string } };
      expect(path.basename(parsed.data.path)).toMatch(/^modelscope-.+\.jpeg$/);
      // macOS tmpdir 会被 realpath 解析为 /private/var
      expect(path.dirname(parsed.data.path)).toBe(await realpath(outDir));
    } finally {
      await mock.close();
    }
  });
});
