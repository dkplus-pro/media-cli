import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cli } from "./helpers/cli.ts";
import { msEnv, PNG_BYTES, parseError, startMock } from "./helpers/modelscope-mock.ts";

const KEY_A = "ms-pool-a-secret";
const KEY_B = "ms-pool-b-secret";

// 起点是随机的（多进程并发时天然分摊 key），所以断言只锁「最终用了哪把 key」，不锁尝试次数
function poolEnv(endpoint: string) {
  return msEnv(endpoint, { MODELSCOPE_API_KEY: "", MODELSCOPE_KEY_POOL: `${KEY_A}, ${KEY_B}` });
}

describe("modelscope-image-gen 多 key 池", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "modelscope-pool-e2e-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("提交撞 429 换下一把 key，且轮询沿用成功的那把", async () => {
    const mock = await startMock((req, endpoint) => {
      if (req.key === KEY_A) return { status: 429, body: { errors: { message: "rate limit" } } };
      if (req.path === "/v1/images/generations") {
        return { status: 200, body: { task_status: "PENDING", task_id: "t-pool" } };
      }
      if (req.path === "/v1/tasks/t-pool") {
        return {
          status: 200,
          body: { task_status: "SUCCEED", output_images: [`${endpoint}/img.png`] },
        };
      }
      return { status: 200, body: "PNG" };
    });
    try {
      const out = path.join(dir, "rotate.png");
      const r = await cli(
        ["--json", "modelscope-image-gen", "--prompt", "x", "--output", out],
        poolEnv(mock.endpoint),
      );
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout) as { data: { keyIndex: number; taskId: string } };
      expect(parsed.data.keyIndex).toBe(1);
      expect(parsed.data.taskId).toBe("t-pool");
      expect((await readFile(out)).equals(PNG_BYTES)).toBe(true);
      // 提交期可能试过 A，但任务归属 B，轮询与后续请求不得再出现 A
      const poll = mock.requests.find((q) => q.path === "/v1/tasks/t-pool");
      expect(poll?.key).toBe(KEY_B);
      expect(
        mock.requests
          .filter((q) => q.key === KEY_A)
          .every((q) => q.path === "/v1/images/generations"),
      ).toBe(true);
      expect(r.stdout).not.toContain(KEY_A);
      expect(r.stdout).not.toContain(KEY_B);
    } finally {
      await mock.close();
    }
  });

  it("逗号池按声明顺序解析（含空格），第二把坏不影响第一把", async () => {
    const mock = await startMock((req, endpoint) => {
      if (req.key === KEY_B) return { status: 429, body: { errors: { message: "rate limit" } } };
      if (req.path === "/v1/images/generations") {
        return { status: 200, body: { data: [{ url: `${endpoint}/img.png` }] } };
      }
      return { status: 200, body: "PNG" };
    });
    try {
      const out = path.join(dir, "first.png");
      const r = await cli(
        ["--json", "modelscope-image-gen", "--prompt", "x", "--output", out],
        poolEnv(mock.endpoint),
      );
      expect(r.code).toBe(0);
      expect((JSON.parse(r.stdout) as { data: { keyIndex: number } }).data.keyIndex).toBe(0);
      // KEY_B 带空格：trim 后仍要能命中；成功那次必须落在 KEY_A 上
      expect(
        mock.requests.some((q) => q.key === KEY_A && q.path === "/v1/images/generations"),
      ).toBe(true);
    } finally {
      await mock.close();
    }
  });

  it("全部 key 都被限流 → E_PROVIDER_ERROR 带逐把 attempts 且不泄漏任何 key", async () => {
    const mock = await startMock(() => ({
      status: 429,
      body: { errors: { message: `rate limit for ${KEY_A}` } },
    }));
    try {
      const r = await cli(
        ["--json", "modelscope-image-gen", "--prompt", "x"],
        poolEnv(mock.endpoint),
      );
      expect(r.code).toBe(3);
      const err = parseError(r);
      expect(err.code).toBe("E_PROVIDER_ERROR");
      expect(err.details?.keyCount).toBe(2);
      expect(err.details?.attempts).toHaveLength(2);
      expect(r.stdout + r.stderr).not.toContain(KEY_A);
      expect(r.stdout + r.stderr).not.toContain(KEY_B);
      expect(mock.requests).toHaveLength(2);
    } finally {
      await mock.close();
    }
  });

  it("参数类 400 不轮换 key（换账号无意义）", async () => {
    const mock = await startMock(() => ({
      status: 400,
      body: { errors: { message: "size format should be WxH" } },
    }));
    try {
      const r = await cli(
        ["--json", "modelscope-image-gen", "--prompt", "x"],
        poolEnv(mock.endpoint),
      );
      expect(r.code).toBe(3);
      expect(parseError(r).details?.status).toBe(400);
      expect(mock.requests).toHaveLength(1);
    } finally {
      await mock.close();
    }
  });

  it("轮询撞 429 用同一把 key 续等，不作废已付费的任务", async () => {
    let polls = 0;
    const mock = await startMock((req, endpoint) => {
      if (req.path === "/v1/images/generations") {
        return { status: 200, body: { task_status: "PENDING", task_id: "t-flaky" } };
      }
      if (req.path === "/v1/tasks/t-flaky") {
        polls += 1;
        if (polls === 1) return { status: 429, body: { errors: { message: "rate limit" } } };
        return {
          status: 200,
          body: { task_status: "SUCCEED", output_images: [`${endpoint}/img.png`] },
        };
      }
      return { status: 200, body: "PNG" };
    });
    try {
      const out = path.join(dir, "flaky.png");
      const r = await cli(
        ["--json", "modelscope-image-gen", "--prompt", "x", "--output", out],
        poolEnv(mock.endpoint),
      );
      expect(r.code).toBe(0);
      expect(polls).toBeGreaterThanOrEqual(2);
      const pollReqs = mock.requests.filter((q) => q.path === "/v1/tasks/t-flaky");
      expect(new Set(pollReqs.map((q) => q.key)).size).toBe(1);
      expect((await readFile(out)).equals(PNG_BYTES)).toBe(true);
    } finally {
      await mock.close();
    }
  });
});
