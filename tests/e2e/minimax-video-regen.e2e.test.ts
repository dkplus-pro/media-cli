import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

describe("minimax-video-regen e2e", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "minimax-video-regen-e2e-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("--source-task-id：提交→running→succeeded，mp4 无鉴权下载并回传任务字段", async () => {
    let queries = 0;
    const behavior: MockBehavior = (req, endpoint) => {
      if (req.method === "POST" && req.path === "/v2/video_regeneration") {
        return { body: { task_id: "regen-1", base_resp: { status_code: 0 } } };
      }
      if (req.method === "GET" && req.path === "/v2/query/video_generation/regen-1") {
        queries += 1;
        if (queries === 1) {
          return { body: { task: { status: "running" }, base_resp: { status_code: 0 } } };
        }
        return {
          body: {
            task: {
              status: "succeeded",
              content: { url: `${endpoint}/files/2k.mp4` },
              created_at: "2026-10-19T00:00:00Z",
              updated_at: "2026-10-19T00:03:00Z",
              usage: { total_seconds: 5 },
            },
            base_resp: { status_code: 0 },
          },
        };
      }
      if (req.path === "/files/2k.mp4") {
        return { binary: MP4_BYTES, headers: { "content-type": "video/mp4" } };
      }
      return { status: 404, body: { message: `unexpected ${req.method} ${req.path}` } };
    };
    const mock = await startMock(behavior);
    const out = path.join(dir, "regen.mp4");
    const run = await cli(
      [
        "--json",
        "minimax-video-regen",
        "--source-task-id",
        "src-768p",
        "--poll-interval",
        "1",
        "--output",
        out,
      ],
      minimaxEnv(mock.endpoint),
    );
    expect(run.code).toBe(0);
    expect(parseData(run)).toEqual({
      path: out,
      bytes: MP4_BYTES.length,
      model: "MiniMax-H3",
      method: "source_task_id",
      taskId: "regen-1",
      resolution: "2K",
      sourceTaskId: "src-768p",
      createdAt: "2026-10-19T00:00:00Z",
      updatedAt: "2026-10-19T00:03:00Z",
      usage: { total_seconds: 5 },
    });

    // 0 创建 / 1-2 轮询 / 3 下载
    expect(mock.requests).toHaveLength(4);
    expect(mock.requests[0]).toMatchObject({
      method: "POST",
      path: "/v2/video_regeneration",
      key: "minimax-test-key",
    });
    expect(requestJson(mock, 0)).toEqual({
      model: "MiniMax-H3",
      resolution: "2K",
      source_task_id: "src-768p",
    });
    expect(mock.requests[1]).toMatchObject({
      method: "GET",
      path: "/v2/query/video_generation/regen-1",
      key: "minimax-test-key",
    });
    expect(mock.requests[3]).toMatchObject({ method: "GET", path: "/files/2k.mp4", key: "" });
    expect(await readFile(out)).toEqual(MP4_BYTES);
    await mock.close();
  });

  it("--base-video：content 为 text + role=base_video，本地文件内联只回字节摘要", async () => {
    const mock = await startMock((req, endpoint) => {
      if (req.method === "POST" && req.path === "/v2/video_regeneration") {
        return { body: { task_id: "regen-2" } };
      }
      if (req.path === "/v2/query/video_generation/regen-2") {
        return {
          body: { task: { status: "succeeded", content: { url: `${endpoint}/files/v.mp4` } } },
        };
      }
      if (req.path === "/files/v.mp4") {
        return { binary: MP4_BYTES, headers: { "content-type": "video/mp4" } };
      }
      return { status: 404, body: { message: `unexpected ${req.path}` } };
    });
    const srcPath = path.join(dir, "src-768p.mp4");
    await writeFile(srcPath, MP4_BYTES);
    const run = await cli(
      [
        "--json",
        "minimax-video-regen",
        "--base-video",
        "src-768p.mp4",
        "--prompt",
        "升到 2K",
        "--aigc-watermark",
        "--poll-interval",
        "1",
        "--output",
        path.join(dir, "from-file.mp4"),
      ],
      minimaxEnv(mock.endpoint),
      dir,
    );
    expect(run.code).toBe(0);
    const body = requestJson(mock, 0) as unknown as {
      resolution: string;
      aigc_watermark: boolean;
      content: { type: string; role?: string; video_url?: { url: string } }[];
    };
    expect(body.resolution).toBe("2K");
    expect(body.aigc_watermark).toBe(true);
    expect(body.content[0]).toEqual({ type: "text", text: "升到 2K" });
    expect(body.content[1]?.role).toBe("base_video");
    expect(body.content[1]?.video_url?.url).toMatch(/^data:video\/mp4;base64,/);
    const data = parseData(run);
    expect(data).toMatchObject({
      method: "base_video",
      baseVideo: expect.stringMatching(/^data:video\/mp4;base64,\d+ bytes$/),
    });
    // base64 原文绝不进 stdout
    expect(run.stdout).not.toContain("AAAAGGZ0eXBpc29t");
    await mock.close();
  });

  it("任务 failed → E_PROVIDER_ERROR，带 taskId/status 且错误文本已遮蔽 key", async () => {
    const mock = await startMock((req) => {
      if (req.method === "POST") return { body: { task_id: "regen-f" } };
      return {
        body: {
          task: {
            status: "failed",
            error: { code: 1026, message: "source task not 768P key=minimax-test-key" },
          },
        },
      };
    });
    const run = await cli(
      [
        "--json",
        "minimax-video-regen",
        "--source-task-id",
        "src-x",
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
      source: "minimax-video-regen",
      taskId: "regen-f",
      taskStatus: "failed",
      taskError: { code: 1026, message: "source task not 768P key=***" },
    });
    expect(mock.requests).toHaveLength(2);
    expect(run.stdout).not.toContain("minimax-test-key");
    await mock.close();
  });

  it("本地参数校验零请求：缺失/互斥/多余 prompt/超长/未知 scheme", async () => {
    const mock = await startMock(() => ({ body: { task_id: "never" } }));
    const cases: [string, string[]][] = [
      ["两者都缺", ["--json", "minimax-video-regen"]],
      [
        "两者同传",
        [
          "--json",
          "minimax-video-regen",
          "--source-task-id",
          "t",
          "--base-video",
          "https://cdn/a.mp4",
          "--prompt",
          "p",
        ],
      ],
      [
        "source 带 prompt",
        ["--json", "minimax-video-regen", "--source-task-id", "t", "--prompt", "p"],
      ],
      ["base 缺 prompt", ["--json", "minimax-video-regen", "--base-video", "https://cdn/a.mp4"]],
      [
        "prompt 超长",
        [
          "--json",
          "minimax-video-regen",
          "--base-video",
          "https://cdn/a.mp4",
          "--prompt",
          "a".repeat(7001),
        ],
      ],
      [
        "未知 scheme",
        ["--json", "minimax-video-regen", "--base-video", "file:///tmp/a.mp4", "--prompt", "p"],
      ],
    ];
    for (const [label, argv] of cases) {
      const run = await cli(argv, minimaxEnv(mock.endpoint), dir);
      expect(run.code, label).toBe(2);
      expect(["E_MISSING_ARGUMENT", "E_INVALID_OPTION"].includes(parseError(run).code), label).toBe(
        true,
      );
    }
    expect(mock.requests).toHaveLength(0);
    await mock.close();
  });

  it("spec 列出 minimax-video-regen 的全部选项", async () => {
    const run = await cli(["--json", "spec"]);
    expect(run.code).toBe(0);
    const spec = parseData<{
      commands: { name: string; source: string; options?: { flags: string }[] }[];
    }>(run);
    const command = spec.commands.find((item) => item.name === "minimax-video-regen");
    expect(command?.source).toBe("plugin:minimax");
    expect(command?.options?.map((option) => option.flags)).toEqual([
      "--source-task-id <id>",
      "--base-video <pathOrUrl>",
      "--prompt <text>",
      "--aigc-watermark",
      "--model <id>",
      "--poll-interval <ms>",
      "--timeout <ms>",
      "--output <path>",
    ]);
  });
});
