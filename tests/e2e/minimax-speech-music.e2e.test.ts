import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cli } from "./helpers/cli.js";
import {
  minimaxEnv,
  parseData,
  parseError,
  requestJson,
  sequence,
  startMock,
} from "./helpers/provider-mock.js";

vi.setConfig({ testTimeout: 30_000 });

// 偶数长度的合法 hex，对应用途只是「有字节可落盘」
const HEX_AUDIO = "4944330400ff10";
const AUDIO_BYTES = Buffer.from(HEX_AUDIO, "hex");

describe("minimax-speech e2e", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "minimax-audio-e2e-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("默认 speech-2.8-hd：hex 落盘、请求体无 audio_setting/output_format", async () => {
    const mock = await startMock(() => ({
      body: {
        data: { audio: HEX_AUDIO },
        extra_info: { audio_length: 1234, audio_sample_rate: 32_000, usage_characters: 2 },
        trace_id: "trace-s",
      },
    }));
    const out = path.join(dir, "speech.mp3");
    const run = await cli(
      ["--json", "minimax-speech", "--text", "你好", "--output", out],
      minimaxEnv(mock.endpoint),
    );
    expect(run.code).toBe(0);
    expect(parseData(run)).toEqual({
      path: out,
      bytes: AUDIO_BYTES.length,
      model: "speech-2.8-hd",
      voice: "female-shaonv",
      format: "mp3",
      durationMs: 1234,
      sampleRate: 32_000,
      usageCharacters: 2,
      traceId: "trace-s",
    });
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0].method).toBe("POST");
    expect(mock.requests[0].path).toBe("/v1/t2a_v2");
    expect(mock.requests[0].key).toBe("minimax-test-key");
    const body = requestJson(mock);
    expect(body).toEqual({
      model: "speech-2.8-hd",
      text: "你好",
      stream: false,
      voice_setting: { voice_id: "female-shaonv", speed: 1, vol: 1, pitch: 0 },
    });
    expect(body).not.toHaveProperty("audio_setting");
    expect(JSON.stringify(body)).not.toContain("output_format");
    expect(await readFile(out)).toEqual(AUDIO_BYTES);
    expect(run.stdout).not.toContain("minimax-test-key");
    await mock.close();
  });

  it("voice/emotion/模型覆盖都进请求体", async () => {
    const mock = await startMock(() => ({ body: { data: { audio: HEX_AUDIO } } }));
    const out = path.join(dir, "speech-custom.mp3");
    const run = await cli(
      [
        "--json",
        "minimax-speech",
        "--text",
        "hi",
        "--voice",
        "male-qn-qingse",
        "--speed",
        "1.2",
        "--vol",
        "2",
        "--pitch",
        "-3",
        "--emotion",
        "calm",
        "--model",
        "speech-2.6-hd",
        "--output",
        out,
      ],
      minimaxEnv(mock.endpoint),
    );
    expect(run.code).toBe(0);
    expect(parseData(run)).toMatchObject({ model: "speech-2.6-hd", voice: "male-qn-qingse" });
    expect(requestJson(mock)).toEqual({
      model: "speech-2.6-hd",
      text: "hi",
      stream: false,
      voice_setting: {
        voice_id: "male-qn-qingse",
        speed: 1.2,
        vol: 2,
        pitch: -3,
        emotion: "calm",
      },
    });
    await mock.close();
  });

  it("base_resp 1004 → E_CONFIG，key 原文不外泄", async () => {
    const mock = await startMock(() => ({
      body: { base_resp: { status_code: 1004, status_msg: "invalid key minimax-test-key" } },
    }));
    const run = await cli(
      ["--json", "minimax-speech", "--text", "hi", "--output", path.join(dir, "x.mp3")],
      minimaxEnv(mock.endpoint),
    );
    expect(run.code).toBe(3);
    const error = parseError(run);
    expect(error.code).toBe("E_CONFIG");
    expect(error.details?.var).toBe("MINIMAX_API_KEY");
    expect(error.details?.baseRespCode).toBe(1004);
    expect(mock.requests).toHaveLength(1);
    expect(run.stdout).not.toContain("minimax-test-key");
    await mock.close();
  });

  it("base_resp 1008 → E_PROVIDER_ERROR + insufficient_balance", async () => {
    const mock = await startMock(
      sequence([{ body: { base_resp: { status_code: 1008, status_msg: "余额不足" } } }]),
    );
    const run = await cli(
      ["--json", "minimax-speech", "--text", "hi", "--output", path.join(dir, "x.mp3")],
      minimaxEnv(mock.endpoint),
    );
    expect(run.code).toBe(3);
    const error = parseError(run);
    expect(error.code).toBe("E_PROVIDER_ERROR");
    expect(error.details?.reason).toBe("insufficient_balance");
    expect(error.details?.baseRespMsg).toBe("余额不足");
    await mock.close();
  });
});

describe("minimax-music e2e", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "minimax-music-e2e-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("纯音乐：is_instrumental 生效，返回 extra_info 元数据", async () => {
    const mock = await startMock(() => ({
      body: {
        data: { audio: HEX_AUDIO },
        extra_info: {
          music_duration: 30_000,
          music_sample_rate: 44_100,
          music_channel: 2,
          bitrate: 256_000,
          music_size: 1234,
        },
        trace_id: "trace-m",
      },
    }));
    const out = path.join(dir, "music.mp3");
    const run = await cli(
      ["--json", "minimax-music", "--instrumental", "--prompt", "轻快钢琴", "--output", out],
      minimaxEnv(mock.endpoint),
    );
    expect(run.code).toBe(0);
    expect(parseData(run)).toEqual({
      path: out,
      bytes: AUDIO_BYTES.length,
      model: "music-3.0",
      format: "mp3",
      durationMs: 30_000,
      sampleRate: 44_100,
      channels: 2,
      bitrate: 256_000,
      traceId: "trace-m",
    });
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0].path).toBe("/v1/music_generation");
    expect(mock.requests[0].key).toBe("minimax-test-key");
    const body = requestJson(mock);
    expect(body).toEqual({
      model: "music-3.0",
      prompt: "轻快钢琴",
      is_instrumental: true,
    });
    expect(body).not.toHaveProperty("audio_setting");
    expect(JSON.stringify(body)).not.toContain("output_format");
    expect(await readFile(out)).toEqual(AUDIO_BYTES);
    await mock.close();
  });

  it("--lyrics-optimizer：只发 lyrics_optimizer，不要求歌词", async () => {
    const mock = await startMock(() => ({ body: { data: { audio: HEX_AUDIO } } }));
    const run = await cli(
      [
        "--json",
        "minimax-music",
        "--prompt",
        "摇滚",
        "--lyrics-optimizer",
        "--output",
        path.join(dir, "opt.mp3"),
      ],
      minimaxEnv(mock.endpoint),
    );
    expect(run.code).toBe(0);
    expect(requestJson(mock)).toEqual({
      model: "music-3.0",
      prompt: "摇滚",
      lyrics_optimizer: true,
    });
    await mock.close();
  });

  it("本地校验零请求：缺歌词、纯音乐缺 prompt、输出目录不存在", async () => {
    const mock = await startMock(() => ({ body: { data: { audio: HEX_AUDIO } } }));
    const noLyrics = await cli(
      ["--json", "minimax-music", "--prompt", "摇滚", "--output", path.join(dir, "a.mp3")],
      minimaxEnv(mock.endpoint),
    );
    expect(noLyrics.code).toBe(2);
    expect(parseError(noLyrics).code).toBe("E_MISSING_ARGUMENT");

    const noPrompt = await cli(
      ["--json", "minimax-music", "--instrumental", "--output", path.join(dir, "b.mp3")],
      minimaxEnv(mock.endpoint),
    );
    expect(noPrompt.code).toBe(2);
    expect(parseError(noPrompt).code).toBe("E_MISSING_ARGUMENT");

    const badOut = await cli(
      [
        "--json",
        "minimax-music",
        "--lyrics",
        "第一句",
        "--output",
        path.join(dir, "missing", "c.mp3"),
      ],
      minimaxEnv(mock.endpoint),
    );
    expect(badOut.code).toBe(2);
    expect(parseError(badOut).code).toBe("E_INVALID_OPTION");
    expect(parseError(badOut).details?.option).toBe("--output");

    const noKey = await cli(["--json", "minimax-music", "--lyrics", "第一句"], {
      ...minimaxEnv(mock.endpoint),
      MINIMAX_API_KEY: "",
    });
    expect(noKey.code).toBe(3);
    expect(parseError(noKey).code).toBe("E_CONFIG");
    expect(mock.requests).toHaveLength(0);
    await mock.close();
  });

  it("spec 列出 minimax 三命令与语音/音乐选项", async () => {
    const run = await cli(["--json", "spec"]);
    expect(run.code).toBe(0);
    const spec = parseData<{
      commands: { name: string; source: string; options?: { flags: string }[] }[];
    }>(run);
    const minimax = spec.commands.filter((item) => item.name.startsWith("minimax-"));
    expect(minimax.map((item) => item.name)).toEqual([
      "minimax-speech",
      "minimax-music",
      "minimax-video",
    ]);
    expect(minimax.every((item) => item.source === "plugin:minimax")).toBe(true);

    const speech = minimax.find((item) => item.name === "minimax-speech");
    expect(speech?.options?.map((option) => option.flags)).toEqual([
      "--text <text>",
      "--voice <id>",
      "--speed <n>",
      "--vol <n>",
      "--pitch <n>",
      "--emotion <e>",
      "--model <id>",
      "--output <path>",
    ]);
    const music = minimax.find((item) => item.name === "minimax-music");
    expect(music?.options?.map((option) => option.flags)).toEqual([
      "--prompt <text>",
      "--lyrics <text>",
      "--instrumental",
      "--lyrics-optimizer",
      "--model <id>",
      "--output <path>",
      "--timeout <ms>",
    ]);
  });
});
