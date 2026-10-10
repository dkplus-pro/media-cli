import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cli } from "./helpers/cli.js";
import { ffmpegBin, hasFfmpeg } from "./helpers/ffmpeg.js";

const execFileAsync = promisify(execFile);

interface Reply {
  status: number;
  body: string;
}

interface Mock {
  endpoint: string;
  hits: number;
  bodies: string[];
  close: () => Promise<void>;
}

// 与 doubao-media-transcribe e2e 同型的 Ark mock：按命中次序回放
function startMock(replies: Reply[]): Promise<Mock> {
  return new Promise((resolve) => {
    const state = { hits: 0, bodies: [] as string[] };
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        state.bodies.push(Buffer.concat(chunks).toString("utf8"));
        const reply = replies[Math.min(state.hits, replies.length - 1)];
        state.hits += 1;
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(reply.body);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        endpoint: `http://127.0.0.1:${port}`,
        get hits() {
          return state.hits;
        },
        bodies: state.bodies,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function okReply(content: unknown): Reply {
  const text = typeof content === "string" ? content : JSON.stringify(content);
  return {
    status: 200,
    body: JSON.stringify({
      choices: [{ message: { content: text }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { audio_tokens: 38 },
      },
    }),
  };
}

function failReply(status: number): Reply {
  return { status, body: JSON.stringify({ error: { message: `mock-${status}` } }) };
}

const MODEL = "doubao-seed-2-0-mini-260428";

function doubaoEnv(endpoint: string): Record<string, string> {
  return { DOUBAO_API_KEY: "test-key", DOUBAO_BASE_URL: endpoint, DOUBAO_TRANSCRIBE_MODEL: MODEL };
}

function parse(stdout: string): Record<string, never> {
  return JSON.parse(stdout) as Record<string, never>;
}

// 模型返回的最小合法分析体
function fakeAnalysis(overrides: Record<string, unknown> = {}) {
  return {
    isMusic: true,
    hasVocals: false,
    genre: ["Cinematic"],
    emotion: { primary: "温暖治愈", secondary: [], intensity: "中" },
    tempo: { bpm: 64, feel: "慢板" },
    key: null,
    instruments: ["钢琴"],
    structure: [{ startSec: 0, endSec: 6, label: "全曲", emotion: "平静", intensity: "低" }],
    videoFit: { scenes: ["vlog"], moods: ["温馨"], unsuitable: ["促销"], suggestedUse: "直接铺底" },
    highlight: { startSec: 0, endSec: 6, reason: "唯一段落" },
    oneLineSummary: "一段安静的钢琴曲。",
    ...overrides,
  };
}

const T = 60_000;
describe.runIf(hasFfmpeg)("doubao-music-analysis e2e", () => {
  let dir = "";
  let short = "";

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "doubao-music-e2e-"));
    short = path.join(dir, "song.wav");
    await execFileAsync(ffmpegBin(), [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=6",
      "-ar",
      "16000",
      "-ac",
      "1",
      short,
    ]);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it(
    "短曲单请求：请求体带 base64 音频与中文分析指令，JSON 落盘且 data 契约齐备",
    async () => {
      const mock = await startMock([okReply(fakeAnalysis())]);
      const out = path.join(dir, "song.music.json");
      const run = await cli(
        ["--json", "doubao-music-analysis", "--input", short, "--output", out],
        doubaoEnv(mock.endpoint),
      );
      expect(run.code).toBe(0);
      const body = parse(run.stdout) as { data: Record<string, unknown>; warnings: unknown[] };
      expect(body.warnings).toEqual([]);
      expect(body.data).toMatchObject({
        path: out,
        model: MODEL,
        durationSec: 6,
        chunks: 1,
        requests: 1,
        tokens: { promptTokens: 100, completionTokens: 20, audioTokens: 38 },
        bytes: (await readFile(out)).length,
      });
      expect(body.data.analysis).toEqual(fakeAnalysis());

      // 落盘文件 = 分析对象本身（pretty JSON）
      expect(JSON.parse(await readFile(out, "utf8"))).toEqual(fakeAnalysis());

      const request = JSON.parse(mock.bodies[0]) as {
        model: string;
        messages: { content: { type: string; input_audio?: { format: string } }[] }[];
      };
      expect(request.model).toBe(MODEL);
      expect(request.messages[0].content.map((p) => p.type)).toEqual(["input_audio", "text"]);
      expect(request.messages[0].content[0].input_audio?.format).toBe("mp3");
      expect(mock.hits).toBe(1);
      await mock.close();
    },
    T,
  );

  it("长曲切段并发 + 文本合并请求：合并请求不含音频，时间轴告警按合并结果判定", async () => {
    const long = path.join(dir, "long.wav");
    await execFileAsync(ffmpegBin(), [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=620",
      "-ar",
      "8000",
      "-ac",
      "1",
      long,
    ]);
    const mock = await startMock([
      okReply({ isMusic: true, structure: [{ startSec: 0, endSec: 5 }], notes: "n" }),
      okReply({ isMusic: true, structure: [{ startSec: 0, endSec: 5 }], notes: "n" }),
      okReply({ isMusic: true, structure: [{ startSec: 0, endSec: 5 }], notes: "n" }),
      // 合并结果时间轴只覆盖到 10s → 触发 E_TIMELINE_APPROXIMATE
      okReply(fakeAnalysis({ structure: [{ startSec: 0, endSec: 10, label: "全曲" }] })),
    ]);
    const run = await cli(
      [
        "--json",
        "doubao-music-analysis",
        "--input",
        long,
        "--segment-seconds",
        "300",
        "--concurrency",
        "1",
      ],
      doubaoEnv(mock.endpoint),
    );
    expect(run.code).toBe(0);
    const body = parse(run.stdout) as {
      data: Record<string, unknown>;
      warnings: { code: string }[];
    };
    // 620s / 300s → 3 段 + 1 次合并 = 4 个请求
    expect(body.data.chunks).toBe(3);
    expect(body.data.requests).toBe(4);
    expect(mock.hits).toBe(4);
    expect(body.warnings.map((w) => w.code)).toContain("E_TIMELINE_APPROXIMATE");

    // 合并请求是纯文本（content 为字符串，无 input_audio）
    const mergeRequest = JSON.parse(mock.bodies[3]) as {
      messages: { content: unknown }[];
    };
    expect(typeof mergeRequest.messages[0].content).toBe("string");
    const mergeText = String(mergeRequest.messages[0].content);
    expect(mergeText).not.toContain("input_audio");
    expect(mergeText).toContain("全曲 620 秒");
    // 各段以绝对秒区间的段头喂给合并请求（段内 structure 保持相对时间）
    expect(mergeText).toContain("【第 2 段｜全曲 300-600 秒】");
    await mock.close();
    await rm(long, { force: true });
  }, 120_000);

  it(
    "文件夹批量：results 逐文件落盘、不支持扩展名被忽略、坏文件进 failed 不中断",
    async () => {
      const folder = path.join(dir, "batch");
      await mkdir(folder, { recursive: true });
      await execFileAsync(ffmpegBin(), [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=330:duration=3",
        "-ar",
        "16000",
        "-ac",
        "1",
        path.join(folder, "a.mp3"),
      ]);
      await execFileAsync(ffmpegBin(), [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=550:duration=3",
        "-ar",
        "16000",
        "-ac",
        "1",
        path.join(folder, "b.wav"),
      ]);
      await writeFile(path.join(folder, "corrupt.mp3"), "这不是音频");
      await writeFile(path.join(folder, "ignore.txt"), "文本文件");

      const mock = await startMock([okReply(fakeAnalysis())]);
      const outDir = path.join(dir, "music-out");
      const run = await cli(
        ["--json", "doubao-music-analysis", "--input", folder, "--output", outDir],
        doubaoEnv(mock.endpoint),
      );
      expect(run.code).toBe(0);
      const body = parse(run.stdout) as {
        data: {
          outputDir: string;
          total: number;
          results: { file: string; path: string; analysis: unknown }[];
          failed: { file: string; reason: string }[];
        };
      };
      expect(body.data.total).toBe(3); // a.mp3 + b.wav + corrupt.mp3（ignore.txt 被扩展名过滤）
      expect(body.data.results).toHaveLength(2);
      expect(body.data.failed).toHaveLength(1);
      expect(body.data.failed[0]?.file).toContain("corrupt.mp3");
      for (const r of body.data.results) {
        expect(JSON.parse(await readFile(r.path, "utf8"))).toEqual(fakeAnalysis());
      }
      expect(body.data.results.map((r) => r.path).every((p) => p.startsWith(outDir))).toBe(true);
      await mock.close();
    },
    T,
  );

  it(
    "isMusic=false 触发 E_NOT_MUSIC 警告；模型两次都输出非 JSON → E_PROVIDER_ERROR bad_json",
    async () => {
      const notMusic = await startMock([
        okReply(fakeAnalysis({ isMusic: false, hasVocals: false })),
      ]);
      const run = await cli(
        ["--json", "doubao-music-analysis", "--input", short],
        doubaoEnv(notMusic.endpoint),
      );
      expect(run.code).toBe(0);
      const body = parse(run.stdout) as { warnings: { code: string }[] };
      expect(body.warnings.map((w) => w.code)).toContain("E_NOT_MUSIC");
      await notMusic.close();

      const garbage = await startMock([okReply("抱歉我无法分析这段音频")]);
      const run2 = await cli(
        ["--json", "doubao-music-analysis", "--input", short],
        doubaoEnv(garbage.endpoint),
      );
      expect(run2.code).toBe(3);
      const error = (parse(run2.stdout) as { error: { code: string; details: { reason: string } } })
        .error;
      expect(error.code).toBe("E_PROVIDER_ERROR");
      expect(error.details.reason).toBe("bad_json");
      expect(garbage.hits).toBe(2); // 非 JSON 只重试一次
      await garbage.close();
    },
    T,
  );

  it(
    "401 立即失败 → E_CONFIG；缺 input → E_MISSING_ARGUMENT；输入不存在 → 退出码 2",
    async () => {
      const denied = await startMock([failReply(401)]);
      const bad = await cli(
        ["--json", "doubao-music-analysis", "--input", short],
        doubaoEnv(denied.endpoint),
      );
      expect(bad.code).toBe(3);
      expect((parse(bad.stdout) as { error: { code: string } }).error.code).toBe("E_CONFIG");
      expect(denied.hits).toBe(1);
      await denied.close();

      const mock = await startMock([okReply(fakeAnalysis())]);
      const noInput = await cli(["--json", "doubao-music-analysis"], doubaoEnv(mock.endpoint));
      expect(noInput.code).toBe(2);
      const missing = await cli(
        ["--json", "doubao-music-analysis", "--input", path.join(dir, "nope.mp3")],
        doubaoEnv(mock.endpoint),
      );
      expect(missing.code).toBe(2);
      // 用法错误不触发任何请求
      expect(mock.hits).toBe(0);
      await mock.close();
    },
    T,
  );

  it(
    "spec 输出包含 doubao-music-analysis 的全部选项",
    async () => {
      const run = await cli(["--json", "spec"]);
      expect(run.code).toBe(0);
      const spec = parse(run.stdout) as {
        data: { commands: { name: string; options?: { flags: string }[] }[] };
      };
      const cmd = spec.data.commands.find((c) => c.name === "doubao-music-analysis");
      expect(cmd?.options?.map((o) => o.flags)).toEqual([
        "--input <path>",
        "--output <path>",
        "--model <id>",
        "--segment-seconds <n>",
        "--concurrency <n>",
        "--recursive",
      ]);
    },
    T,
  );
});
