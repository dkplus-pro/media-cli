import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cli } from "./helpers/cli.ts";
import { msEnv, parseError, startMock } from "./helpers/modelscope-mock.ts";

describe("modelscope-image 失败语义（本地 mock）", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "modelscope-err-e2e-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
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
      expect(err.message).toContain("model unavailable");
    } finally {
      await mock.close();
    }
  });

  it("失败载荷是 errors 对象 → 摊平成人话并带 requestId（不再 [object Object]）", async () => {
    const mock = await startMock((req) =>
      req.path === "/v1/images/generations"
        ? { status: 200, body: { task_status: "PENDING", task_id: "task-obj" } }
        : {
            status: 200,
            body: {
              task_status: "FAILED",
              task_id: "task-obj",
              errors: { message: "gpu oom, retry later", request_id: "req-777" },
            },
          },
    );
    try {
      const r = await cli(
        ["--json", "modelscope-image-gen", "--prompt", "x"],
        msEnv(mock.endpoint),
      );
      expect(r.code).toBe(3);
      const err = parseError(r);
      expect(err.message).toContain("gpu oom, retry later");
      expect(err.message).not.toContain("[object Object]");
      expect(err.details?.requestId).toBe("req-777");
      expect(JSON.parse(String(err.details?.raw))).toMatchObject({ task_status: "FAILED" });
    } finally {
      await mock.close();
    }
  });

  it("失败载荷是 errors 数组 / 只有裸对象 → 仍能拼出原因", async () => {
    const mock = await startMock((req) =>
      req.path === "/v1/images/generations"
        ? { status: 200, body: { task_status: "PENDING", task_id: "task-arr" } }
        : {
            status: 200,
            body: {
              task_status: "FAILED",
              task_id: "task-arr",
              errors: [{ code: "E1", message: "nsfw detected" }, { message: "seed rejected" }],
            },
          },
    );
    try {
      const r = await cli(
        ["--json", "modelscope-image-gen", "--prompt", "x"],
        msEnv(mock.endpoint),
      );
      expect(r.code).toBe(3);
      const err = parseError(r);
      expect(err.message).toContain("nsfw detected; seed rejected");
      expect(err.message).not.toContain("[object Object]");
    } finally {
      await mock.close();
    }
  });

  it("用法错误：缺 --prompt 与 --size/--steps/--guidance 非法（退出码 2，不发请求）", async () => {
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

      // 网关实测每边 [64,2048]：超界本地先拦，不去吃远端 400
      const tooBig = await cli(
        ["--json", "modelscope-image-gen", "--prompt", "x", "--size", "2752x1536"],
        msEnv(mock.endpoint),
      );
      expect(tooBig.code).toBe(2);
      expect(parseError(tooBig).message).toContain("2048");

      const tooSmall = await cli(
        ["--json", "modelscope-image-gen", "--prompt", "x", "--size", "1024x32"],
        msEnv(mock.endpoint),
      );
      expect(tooSmall.code).toBe(2);
      expect(parseError(tooSmall).code).toBe("E_INVALID_OPTION");

      const badRatio = await cli(
        ["--json", "modelscope-image-gen", "--prompt", "x", "--ratio", "5:4"],
        msEnv(mock.endpoint),
      );
      expect(badRatio.code).toBe(2);
      expect(parseError(badRatio).code).toBe("E_INVALID_OPTION");

      const bothSizeAndRatio = await cli(
        [
          "--json",
          "modelscope-image-gen",
          "--prompt",
          "x",
          "--size",
          "1024x1024",
          "--ratio",
          "1:1",
        ],
        msEnv(mock.endpoint),
      );
      expect(bothSizeAndRatio.code).toBe(2);
      expect(parseError(bothSizeAndRatio).code).toBe("E_INVALID_OPTION");

      expect(mock.requests).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });
});
