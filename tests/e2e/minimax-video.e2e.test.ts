import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cli } from "./helpers/cli.js";
import {
  type MockBehavior,
  MP4_BYTES,
  minimaxEnv,
  parseData,
  parseError,
  requestJson,
  startMock,
} from "./helpers/provider-mock.js";

vi.setConfig({ testTimeout: 30_000 });

const CREATE_OK = { task_id: "task-1", base_resp: { status_code: 0, status_msg: "success" } };

describe("minimax-video e2e", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "minimax-video-e2e-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("创建→running→succeeded，mp4 无鉴权下载并回传任务字段", async () => {
    let queries = 0;
    const behavior: MockBehavior = (req, endpoint) => {
      if (req.method === "POST" && req.path === "/v2/video_generation") {
        return { body: CREATE_OK };
      }
      if (req.method === "GET" && req.path === "/v2/query/video_generation/task-1") {
        queries += 1;
        if (queries === 1) {
          return { body: { task: { status: "running" }, base_resp: { status_code: 0 } } };
        }
        return {
          body: {
            task: {
              status: "succeeded",
              content: { url: `${endpoint}/files/out.mp4` },
              created_at: "2026-10-18T00:00:00Z",
              updated_at: "2026-10-18T00:02:00Z",
              usage: { total_seconds: 5 },
            },
            base_resp: { status_code: 0 },
          },
        };
      }
      if (req.path === "/files/out.mp4") {
        return { binary: MP4_BYTES, headers: { "content-type": "video/mp4" } };
      }
      return { status: 404, body: { message: `unexpected ${req.method} ${req.path}` } };
    };
    const mock = await startMock(behavior);
    const out = path.join(dir, "video.mp4");
    const run = await cli(
      ["--json", "minimax-video", "--prompt", "海边日落", "--poll-interval", "1", "--output", out],
      minimaxEnv(mock.endpoint),
    );
    expect(run.code).toBe(0);
    expect(parseData(run)).toEqual({
      path: out,
      bytes: MP4_BYTES.length,
      model: "MiniMax-H3",
      taskId: "task-1",
      durationSec: 5,
      resolution: "768P",
      ratio: "16:9",
      createdAt: "2026-10-18T00:00:00Z",
      updatedAt: "2026-10-18T00:02:00Z",
      usage: { total_seconds: 5 },
    });

    // 0 创建 / 1-2 轮询 / 3 下载
    expect(mock.requests).toHaveLength(4);
    expect(mock.requests[0].path).toBe("/v2/video_generation");
    expect(mock.requests[0].method).toBe("POST");
    expect(mock.requests[0].key).toBe("minimax-test-key");
    expect(requestJson(mock, 0)).toEqual({
      model: "MiniMax-H3",
      content: [{ type: "text", text: "海边日落" }],
      resolution: "768P",
      duration: 5,
      ratio: "16:9",
    });
    expect(mock.requests[1]).toMatchObject({
      method: "GET",
      path: "/v2/query/video_generation/task-1",
      key: "minimax-test-key",
    });
    expect(mock.requests[2].path).toBe("/v2/query/video_generation/task-1");
    expect(mock.requests[3]).toMatchObject({ method: "GET", path: "/files/out.mp4", key: "" });
    expect(await readFile(out)).toEqual(MP4_BYTES);
    await mock.close();
  });

  it("模型/时长/分辨率/比例覆盖都进创建请求", async () => {
    const mock = await startMock((req, endpoint) => {
      if (req.method === "POST") return { body: { task_id: "task-2" } };
      if (req.path === "/v2/query/video_generation/task-2") {
        return {
          body: {
            task: { status: "succeeded", content: { url: `${endpoint}/files/v.mp4` } },
          },
        };
      }
      return { binary: MP4_BYTES };
    });
    const out = path.join(dir, "max.mp4");
    const run = await cli(
      [
        "--json",
        "minimax-video",
        "--prompt",
        "p",
        "--model",
        "MiniMax-H3-Max",
        "--duration",
        "10",
        "--resolution",
        "480p",
        "--ratio",
        "9:16",
        "--poll-interval",
        "1",
        "--output",
        out,
      ],
      minimaxEnv(mock.endpoint),
    );
    expect(run.code).toBe(0);
    expect(parseData(run)).toMatchObject({
      model: "MiniMax-H3-Max",
      durationSec: 10,
      resolution: "480P",
      ratio: "9:16",
    });
    expect(requestJson(mock, 0)).toEqual({
      model: "MiniMax-H3-Max",
      content: [{ type: "text", text: "p" }],
      resolution: "480P",
      duration: 10,
      ratio: "9:16",
    });
    await mock.close();
  });

  it("任务 failed → E_PROVIDER_ERROR，带 taskId/status 且错误文本已遮蔽 key", async () => {
    const mock = await startMock((req) => {
      if (req.method === "POST") return { body: { task_id: "task-f" } };
      return {
        body: {
          task: {
            status: "failed",
            error: { code: 1026, message: "content failed key=minimax-test-key" },
          },
        },
      };
    });
    const run = await cli(
      [
        "--json",
        "minimax-video",
        "--prompt",
        "p",
        "--poll-interval",
        "1",
        "--output",
        path.join(dir, "fail.mp4"),
      ],
      minimaxEnv(mock.endpoint),
    );
    expect(run.code).toBe(3);
    const error = parseError(run);
    expect(error.code).toBe("E_PROVIDER_ERROR");
    expect(error.details).toMatchObject({
      source: "minimax-video",
      taskId: "task-f",
      taskStatus: "failed",
      taskError: { code: 1026, message: "content failed key=***" },
    });
    expect(mock.requests).toHaveLength(2);
    expect(run.stdout).not.toContain("minimax-test-key");
    await mock.close();
  });

  it("总预算耗尽 → E_PROVIDER_ERROR reason=timeout，仍保留 taskId", async () => {
    const mock = await startMock((req) => {
      if (req.method === "POST") return { body: { task_id: "task-t" } };
      return { body: { task: { status: "queued" } } };
    });
    const run = await cli(
      [
        "--json",
        "minimax-video",
        "--prompt",
        "p",
        "--poll-interval",
        "20",
        "--timeout",
        "400",
        "--output",
        path.join(dir, "timeout.mp4"),
      ],
      minimaxEnv(mock.endpoint),
    );
    expect(run.code).toBe(3);
    const error = parseError(run);
    expect(error.code).toBe("E_PROVIDER_ERROR");
    expect(error.details).toMatchObject({
      source: "minimax-video",
      taskId: "task-t",
      reason: "timeout",
    });
    expect(mock.requests.length).toBeGreaterThan(1);
    await mock.close();
  });

  it("本地参数校验零请求：模型白名单、时长、分辨率、ratio", async () => {
    const mock = await startMock(() => ({ body: { task_id: "never" } }));
    const cases = [
      ["--model", "MiniMax-H3-Max", "--duration", "4"],
      ["--model", "MiniMax-H3-Max", "--resolution", "2K"],
      ["--model", "MiniMax-Hailuo"],
      ["--ratio", "adaptive"],
      ["--resolution", "1080P"],
    ];
    for (const extra of cases) {
      const run = await cli(
        ["--json", "minimax-video", "--prompt", "p", ...extra],
        minimaxEnv(mock.endpoint),
      );
      expect(run.code, extra.join(" ")).toBe(2);
      expect(parseError(run).code, extra.join(" ")).toBe("E_INVALID_OPTION");
    }
    const noPrompt = await cli(["--json", "minimax-video"], minimaxEnv(mock.endpoint));
    expect(noPrompt.code).toBe(2);
    expect(parseError(noPrompt).code).toBe("E_MISSING_ARGUMENT");
    expect(mock.requests).toHaveLength(0);
    await mock.close();
  });

  it("spec 列出 minimax-video 的全部选项", async () => {
    const run = await cli(["--json", "spec"]);
    expect(run.code).toBe(0);
    const spec = parseData<{
      commands: { name: string; source: string; options?: { flags: string }[] }[];
    }>(run);
    const command = spec.commands.find((item) => item.name === "minimax-video");
    expect(command?.source).toBe("plugin:minimax");
    expect(command?.options?.map((option) => option.flags)).toEqual([
      "--prompt <text>",
      "--model <id>",
      "--duration <sec>",
      "--resolution <r>",
      "--ratio <r>",
      "--poll-interval <ms>",
      "--timeout <ms>",
      "--output <path>",
    ]);
  });
});
