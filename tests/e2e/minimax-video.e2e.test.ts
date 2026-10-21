import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
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
      mode: "t2v",
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

  it("--first-frame 本地文件：内联成 data URI、ratio 钉成 adaptive、结果只回字节摘要", async () => {
    const behavior: MockBehavior = (req, endpoint) => {
      if (req.method === "POST" && req.path === "/v2/video_generation") {
        return { body: { task_id: "task-i2v" } };
      }
      if (req.path === "/v2/query/video_generation/task-i2v") {
        return {
          body: {
            task: {
              status: "succeeded",
              content: { url: `${endpoint}/files/i.mp4` },
              ratio: "4:3",
            },
          },
        };
      }
      if (req.path === "/files/i.mp4") {
        return { binary: MP4_BYTES, headers: { "content-type": "video/mp4" } };
      }
      return { status: 404, body: { message: `unexpected ${req.path}` } };
    };
    const mock = await startMock(behavior);
    await sharp({
      create: { width: 512, height: 384, channels: 3, background: "#cc3322" },
    })
      .png()
      .toFile(path.join(dir, "frame.png"));
    const run = await cli(
      [
        "--json",
        "minimax-video",
        "--prompt",
        "让它动起来",
        "--first-frame",
        "frame.png",
        "--poll-interval",
        "1",
        "--output",
        path.join(dir, "i2v.mp4"),
      ],
      minimaxEnv(mock.endpoint),
      dir,
    );
    expect(run.code).toBe(0);
    const body = requestJson(mock, 0) as unknown as {
      ratio: string;
      content: { type: string; role?: string; image_url?: { url: string } }[];
    };
    expect(body.ratio).toBe("adaptive");
    expect(body.content[0]).toEqual({ type: "text", text: "让它动起来" });
    expect(body.content[1]?.role).toBe("first_frame");
    expect(body.content[1]?.image_url?.url).toMatch(/^data:image\/png;base64,/);
    const data = parseData(run);
    expect(data).toMatchObject({
      mode: "i2v",
      actualRatio: "4:3",
      media: { first_frame: [expect.stringMatching(/^data:image\/png;base64,\d+ bytes$/)] },
    });
    // base64 原文绝不进 stdout
    expect(run.stdout).not.toContain("iVBORw0KGgo");
    await mock.close();
  });

  it("i2v 显式传 --ratio 被钉回 adaptive 并附 E_RATIO_IGNORED 警告", async () => {
    const mock = await startMock((req, endpoint) => {
      if (req.method === "POST") return { body: { task_id: "task-r" } };
      if (req.path === "/v2/query/video_generation/task-r") {
        return {
          body: { task: { status: "succeeded", content: { url: `${endpoint}/files/r.mp4` } } },
        };
      }
      return { binary: MP4_BYTES, headers: { "content-type": "video/mp4" } };
    });
    await sharp({
      create: { width: 640, height: 640, channels: 3, background: "#223344" },
    })
      .png()
      .toFile(path.join(dir, "sq.png"));
    const run = await cli(
      [
        "--json",
        "minimax-video",
        "--prompt",
        "p",
        "--first-frame",
        "sq.png",
        "--ratio",
        "16:9",
        "--poll-interval",
        "1",
        "--output",
        path.join(dir, "r.mp4"),
      ],
      minimaxEnv(mock.endpoint),
      dir,
    );
    expect(run.code).toBe(0);
    expect(requestJson(mock, 0)).toMatchObject({ ratio: "adaptive" });
    const envelope = JSON.parse(run.stdout) as { warnings: { code: string }[] };
    expect(envelope.warnings).toContainEqual(
      expect.objectContaining({ code: "E_RATIO_IGNORED", plugin: "minimax" }),
    );
    await mock.close();
  });

  it("r2v：URL 原样透传、content 顺序固定、ratio 默认 adaptive 且可显式覆盖", async () => {
    const mock = await startMock((req, endpoint) => {
      if (req.method === "POST") return { body: { task_id: "task-r2v" } };
      if (req.path === "/v2/query/video_generation/task-r2v") {
        return {
          body: { task: { status: "succeeded", content: { url: `${endpoint}/files/v.mp4` } } },
        };
      }
      return { binary: MP4_BYTES, headers: { "content-type": "video/mp4" } };
    });
    const run = await cli(
      [
        "--json",
        "minimax-video",
        "--prompt",
        "<Picture 1> 按 <Video 1> 的动作",
        "--ref-image",
        "https://cdn/i1.png",
        "--ref-video",
        "https://cdn/m1.mp4",
        "--ref-audio",
        "mm_file://f-123",
        "--poll-interval",
        "1",
        "--output",
        path.join(dir, "r2v.mp4"),
      ],
      minimaxEnv(mock.endpoint),
      dir,
    );
    expect(run.code).toBe(0);
    expect(requestJson(mock, 0)).toEqual({
      model: "MiniMax-H3",
      content: [
        { type: "text", text: "<Picture 1> 按 <Video 1> 的动作" },
        { type: "image_url", image_url: { url: "https://cdn/i1.png" }, role: "reference_image" },
        { type: "video_url", video_url: { url: "https://cdn/m1.mp4" }, role: "reference_video" },
        { type: "audio_url", audio_url: { url: "mm_file://f-123" }, role: "reference_audio" },
      ],
      resolution: "768P",
      duration: 5,
      ratio: "adaptive",
    });
    expect(parseData(run)).toMatchObject({ mode: "r2v" });

    const explicit = await cli(
      [
        "--json",
        "minimax-video",
        "--prompt",
        "p",
        "--ref-image",
        "https://cdn/i1.png",
        "--ratio",
        "9:16",
        "--aigc-watermark",
        "--poll-interval",
        "1",
        "--output",
        path.join(dir, "r2v2.mp4"),
      ],
      minimaxEnv(mock.endpoint),
      dir,
    );
    expect(explicit.code).toBe(0);
    // 两轮各 3 个请求（创建 / 轮询 / 下载），第二次的创建体在下标 3
    expect(requestJson(mock, 3)).toMatchObject({ ratio: "9:16", aigc_watermark: true });
    await mock.close();
  });

  it("媒体本地预检零请求：尾帧不成对、帧与参考混用、尺寸越界、超张数、未知 scheme", async () => {
    const mock = await startMock(() => ({ body: { task_id: "never" } }));
    const base = ["--json", "minimax-video", "--prompt", "p"];
    const cases: [string, string[]][] = [
      ["尾帧缺首帧", [...base, "--last-frame", "https://cdn/a.png"]],
      [
        "帧与参考混用",
        [...base, "--first-frame", "https://cdn/a.png", "--ref-image", "https://cdn/b.png"],
      ],
      [
        "参考图超 9 张",
        [...base, "--ref-image", ...Array.from({ length: 10 }, (_, i) => `https://cdn/${i}.png`)],
      ],
      [
        "参考视频超 3 段",
        [...base, "--ref-video", ...Array.from({ length: 4 }, (_, i) => `https://cdn/${i}.mp4`)],
      ],
      ["file:// 协议", [...base, "--first-frame", "file:///tmp/a.png"]],
    ];
    for (const [label, argv] of cases) {
      const run = await cli(argv, minimaxEnv(mock.endpoint), dir);
      expect(run.code, label).toBe(2);
      expect(parseError(run).code, label).toBe("E_INVALID_OPTION");
    }
    // 文件不存在走 E_MISSING_ARGUMENT（与其余用法错误的退出码同为 2）
    const missing = await cli(
      [...base, "--first-frame", "missing.png"],
      minimaxEnv(mock.endpoint),
      dir,
    );
    expect(missing.code).toBe(2);
    expect(parseError(missing).code).toBe("E_MISSING_ARGUMENT");
    // 尺寸越界要真读图：造一张 100x100 的合法 png
    await sharp({
      create: { width: 100, height: 100, channels: 3, background: "#112233" },
    })
      .png()
      .toFile(path.join(dir, "tiny.png"));
    const tiny = await cli([...base, "--first-frame", "tiny.png"], minimaxEnv(mock.endpoint), dir);
    expect(tiny.code).toBe(2);
    expect(parseError(tiny).code).toBe("E_INVALID_OPTION");
    expect(mock.requests).toHaveLength(0);
    await mock.close();
  });

  it("--prompt-expansion 仅 H3-Max：H3 本地即拒，Max 进 extra 字段", async () => {
    const mock = await startMock((req, endpoint) => {
      if (req.method === "POST") return { body: { task_id: "task-x" } };
      if (req.path === "/v2/query/video_generation/task-x") {
        return {
          body: { task: { status: "succeeded", content: { url: `${endpoint}/files/x.mp4` } } },
        };
      }
      return { binary: MP4_BYTES, headers: { "content-type": "video/mp4" } };
    });
    const wrongModel = await cli(
      ["--json", "minimax-video", "--prompt", "p", "--prompt-expansion", "quality"],
      minimaxEnv(mock.endpoint),
      dir,
    );
    expect(wrongModel.code).toBe(2);
    expect(parseError(wrongModel).code).toBe("E_INVALID_OPTION");

    const badEnum = await cli(
      [
        "--json",
        "minimax-video",
        "--prompt",
        "p",
        "--model",
        "MiniMax-H3-Max",
        "--prompt-expansion",
        "balance",
      ],
      minimaxEnv(mock.endpoint),
      dir,
    );
    expect(badEnum.code).toBe(2);

    const ok = await cli(
      [
        "--json",
        "minimax-video",
        "--prompt",
        "p",
        "--model",
        "MiniMax-H3-Max",
        "--prompt-expansion",
        "quality",
        "--poll-interval",
        "1",
        "--output",
        path.join(dir, "x.mp4"),
      ],
      minimaxEnv(mock.endpoint),
      dir,
    );
    expect(ok.code).toBe(0);
    // 前两次都在本地被拒、没发请求，所以创建体仍是下标 0
    expect(requestJson(mock, 0)).toMatchObject({
      model: "MiniMax-H3-Max",
      extra: { prompt_expansion_mode: "quality" },
    });
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
      "--first-frame <pathOrUrl>",
      "--last-frame <pathOrUrl>",
      "--ref-image <pathsOrUrls...>",
      "--ref-video <pathsOrUrls...>",
      "--ref-audio <pathsOrUrls...>",
      "--aigc-watermark",
      "--prompt-expansion <mode>",
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
