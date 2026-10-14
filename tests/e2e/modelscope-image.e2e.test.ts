import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cli } from "./helpers/cli.ts";
import { msEnv, PNG_BYTES, REAL_PNG, startMock } from "./helpers/modelscope-mock.ts";

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
      expect(JSON.parse(r.stdout).data.refUrls).toBeUndefined();
    } finally {
      await mock.close();
    }
  });

  it("--ratio 映射到网关可用的最大档（比例精确、每边 ≤2048）", async () => {
    const mock = await startMock(() => ({
      status: 200,
      body: { data: [{ b64_json: PNG_BYTES.toString("base64") }] },
    }));
    try {
      const cases = {
        "1:1": "2048x2048",
        "16:9": "2048x1152",
        "9:16": "1152x2048",
        "3:2": "2016x1344",
      };
      for (const [ratio, size] of Object.entries(cases)) {
        const r = await cli(
          [
            "--json",
            "modelscope-image-gen",
            "--prompt",
            "x",
            "--ratio",
            ratio,
            "--output",
            path.join(dir, `ratio-${ratio.replace(":", "-")}.png`),
          ],
          msEnv(mock.endpoint),
        );
        expect(r.code).toBe(0);
        expect(JSON.parse(mock.requests[mock.requests.length - 1].body).size).toBe(size);
        expect(JSON.parse(r.stdout).data.size).toBe(size);
      }
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
