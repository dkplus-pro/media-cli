import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeAudio } from "../../plugins/minimax/lib/audio.mjs";
import { mapBaseRespError } from "../../plugins/minimax/lib/client.mjs";
import { loadConfig, normalizeBase, parseNumberOption } from "../../plugins/minimax/lib/config.mjs";
import { buildMusicBody, parseMusicArgs } from "../../plugins/minimax/lib/music.mjs";
import { buildSpeechBody, parseSpeechArgs } from "../../plugins/minimax/lib/speech.mjs";
import { buildVideoBody, parseVideoParams } from "../../plugins/minimax/lib/video.mjs";
import {
  detectMediaMode,
  resolveBaseVideo,
  resolveVideoMedia,
  summarizeMedia,
} from "../../plugins/minimax/lib/video-media.mjs";
import { buildRegenBody, parseRegenParams } from "../../plugins/minimax/lib/video-regen.mjs";

interface CodedError {
  code: string;
  details?: Record<string, unknown>;
}

function coded(fn: () => unknown): CodedError {
  try {
    fn();
  } catch (err) {
    return err as CodedError;
  }
  throw new Error("预期抛错但函数正常返回");
}

async function codedAsync(fn: () => Promise<unknown>): Promise<CodedError> {
  try {
    await fn();
  } catch (err) {
    return err as CodedError;
  }
  throw new Error("预期抛错但函数正常返回");
}

describe("minimax 配置", () => {
  it("base 归一：默认值、末尾 /v1 与斜杠、非法协议", () => {
    expect(normalizeBase("")).toBe("https://api.minimaxi.com");
    expect(normalizeBase("https://api.minimaxi.com/v1/")).toBe("https://api.minimaxi.com");
    expect(normalizeBase("https://api.minimax.io/")).toBe("https://api.minimax.io");
    expect(coded(() => normalizeBase("ftp://x.com")).code).toBe("E_CONFIG");
    expect(coded(() => normalizeBase("not-a-url")).code).toBe("E_CONFIG");
  });

  it("缺 key → E_CONFIG；BASR 拼写作为别名，主名优先", () => {
    expect(coded(() => loadConfig({})).details?.var).toBe("MINIMAX_API_KEY");
    const alias = loadConfig({
      MINIMAX_API_KEY: "k",
      MINIMAX_API_BASR_URL: "https://alias.example/v1",
    });
    expect(alias.baseUrl).toBe("https://alias.example");
    const primary = loadConfig({
      MINIMAX_API_KEY: "k",
      MINIMAX_API_BASE_URL: "https://primary.example/v1",
      MINIMAX_API_BASR_URL: "https://alias.example/v1",
    });
    expect(primary.baseUrl).toBe("https://primary.example");
  });

  it("三个模型默认值与 env 覆盖", () => {
    expect(loadConfig({ MINIMAX_API_KEY: "k" })).toMatchObject({
      speechModel: "speech-2.8-hd",
      musicModel: "music-3.0",
      videoModel: "MiniMax-H3",
      videoRegenModel: "MiniMax-H3",
    });
    expect(
      loadConfig({
        MINIMAX_API_KEY: "k",
        MINIMAX_SPEECH_MODEL: "speech-x",
        MINIMAX_MUSIC_MODEL: "music-x",
        MINIMAX_VIDEO_MODEL: "MiniMax-H3-Max",
        MINIMAX_VIDEO_REGEN_MODEL: "MiniMax-H3-Regeneration",
      }),
    ).toMatchObject({
      speechModel: "speech-x",
      musicModel: "music-x",
      videoModel: "MiniMax-H3-Max",
      videoRegenModel: "MiniMax-H3-Regeneration",
    });
  });

  it("parseNumberOption 的范围/开闭区间/整数口径", () => {
    expect(parseNumberOption(undefined, "--x", { min: 1, fallback: 5 })).toBe(5);
    expect(coded(() => parseNumberOption("0", "--vol", { min: 0, minExclusive: true })).code).toBe(
      "E_INVALID_OPTION",
    );
    expect(coded(() => parseNumberOption("1.5", "--pitch", { integer: true })).code).toBe(
      "E_INVALID_OPTION",
    );
  });
});

describe("minimax 语音", () => {
  it("默认参数与语音体不含 audio_setting/output_format", () => {
    const input = parseSpeechArgs({ text: "你好" }, {});
    expect(input).toMatchObject({
      text: "你好",
      voice: "female-shaonv",
      speed: 1,
      vol: 1,
      pitch: 0,
      model: "speech-2.8-hd",
    });
    const body = buildSpeechBody(input) as Record<string, unknown>;
    expect(body).toEqual({
      model: "speech-2.8-hd",
      text: "你好",
      stream: false,
      voice_setting: { voice_id: "female-shaonv", speed: 1, vol: 1, pitch: 0 },
    });
    expect(body).not.toHaveProperty("audio_setting");
    expect(JSON.stringify(body)).not.toContain("output_format");
  });

  it("emotion/模型覆盖与非法取值", () => {
    expect(
      parseSpeechArgs(
        { text: "hi", emotion: "calm", model: "speech-custom" },
        { speechModel: "env-model" },
      ),
    ).toMatchObject({ emotion: "calm", model: "speech-custom" });
    expect(coded(() => parseSpeechArgs({ text: "hi", emotion: "joyful" })).code).toBe(
      "E_INVALID_OPTION",
    );
  });

  it("缺 text、超长 text、数值越界全部本地拒绝", () => {
    expect(coded(() => parseSpeechArgs({})).code).toBe("E_MISSING_ARGUMENT");
    expect(coded(() => parseSpeechArgs({ text: "啊".repeat(10_001) })).code).toBe(
      "E_INVALID_OPTION",
    );
    expect(coded(() => parseSpeechArgs({ text: "hi", speed: 2.1 })).code).toBe("E_INVALID_OPTION");
    expect(coded(() => parseSpeechArgs({ text: "hi", vol: 0 })).code).toBe("E_INVALID_OPTION");
    expect(coded(() => parseSpeechArgs({ text: "hi", pitch: 13 })).code).toBe("E_INVALID_OPTION");
  });
});

describe("minimax 音乐", () => {
  it("纯音乐：prompt 必填，体里有 is_instrumental 且无歌词", () => {
    expect(coded(() => parseMusicArgs({ instrumental: true })).code).toBe("E_MISSING_ARGUMENT");
    const input = parseMusicArgs({ instrumental: true, prompt: "钢琴曲" }, {});
    expect(input.timeoutMs).toBe(600_000);
    expect(buildMusicBody(input)).toEqual({
      model: "music-3.0",
      prompt: "钢琴曲",
      is_instrumental: true,
    });
  });

  it("非纯音乐：歌词或 lyrics-optimizer 二选一", () => {
    expect(coded(() => parseMusicArgs({ prompt: "摇滚" })).code).toBe("E_MISSING_ARGUMENT");
    const optimized = parseMusicArgs({ prompt: "摇滚", lyricsOptimizer: true }, {});
    expect(buildMusicBody(optimized)).toMatchObject({ lyrics_optimizer: true });
    const sung = parseMusicArgs({ prompt: "摇滚", lyrics: "第一句" }, {});
    expect(buildMusicBody(sung)).toMatchObject({ lyrics: "第一句" });
    expect(buildMusicBody(sung)).not.toHaveProperty("audio_setting");
    expect(JSON.stringify(buildMusicBody(sung))).not.toContain("output_format");
  });

  it("prompt/lyrics 超长与 timeout 非法 → E_INVALID_OPTION", () => {
    expect(coded(() => parseMusicArgs({ lyrics: "a", prompt: "x".repeat(2001) })).code).toBe(
      "E_INVALID_OPTION",
    );
    expect(coded(() => parseMusicArgs({ lyrics: "x".repeat(3501) })).code).toBe("E_INVALID_OPTION");
    expect(coded(() => parseMusicArgs({ lyrics: "a", timeout: 0 })).code).toBe("E_INVALID_OPTION");
  });
});

describe("minimax 视频", () => {
  it("默认 H3 5s/768P/16:9，体结构符合 v2", () => {
    const input = parseVideoParams({ prompt: "海边日落" }, {});
    expect(input).toMatchObject({
      model: "MiniMax-H3",
      durationSec: 5,
      resolution: "768P",
      ratio: "16:9",
      pollIntervalMs: 5_000,
      timeoutMs: 900_000,
    });
    expect(buildVideoBody(input)).toEqual({
      model: "MiniMax-H3",
      content: [{ type: "text", text: "海边日落" }],
      resolution: "768P",
      duration: 5,
      ratio: "16:9",
    });
  });

  it("H3/H3-Max 的 duration 与 resolution 白名单分别校验", () => {
    expect(coded(() => parseVideoParams({ prompt: "p", duration: 16 })).code).toBe(
      "E_INVALID_OPTION",
    );
    expect(coded(() => parseVideoParams({ prompt: "p", resolution: "480P" })).code).toBe(
      "E_INVALID_OPTION",
    );
    expect(
      parseVideoParams(
        { prompt: "p", model: "MiniMax-H3-Max", duration: 5, resolution: "480P" },
        {},
      ),
    ).toMatchObject({ durationSec: 5, resolution: "480P" });
    expect(
      coded(() => parseVideoParams({ prompt: "p", model: "MiniMax-H3-Max", duration: 4 }, {})).code,
    ).toBe("E_INVALID_OPTION");
    expect(
      coded(() => parseVideoParams({ prompt: "p", model: "MiniMax-H3-Max", resolution: "2K" }, {}))
        .code,
    ).toBe("E_INVALID_OPTION");
  });

  it("ratio 枚举不含 adaptive，未知模型与缺 prompt 本地拒绝", () => {
    expect(coded(() => parseVideoParams({ prompt: "p", ratio: "adaptive" })).code).toBe(
      "E_INVALID_OPTION",
    );
    expect(coded(() => parseVideoParams({ prompt: "p", model: "MiniMax-Hailuo" })).code).toBe(
      "E_INVALID_OPTION",
    );
    expect(coded(() => parseVideoParams({})).code).toBe("E_MISSING_ARGUMENT");
  });
});

describe("minimax 视频再生", () => {
  it("--source-task-id 与 --base-video 二选一，互斥/缺失/多余 prompt 都本地拒", () => {
    expect(coded(() => parseRegenParams({})).code).toBe("E_MISSING_ARGUMENT");
    expect(
      coded(() => parseRegenParams({ sourceTaskId: "t1", baseVideo: "https://cdn/a.mp4" })).code,
    ).toBe("E_INVALID_OPTION");
    expect(coded(() => parseRegenParams({ sourceTaskId: "t1", prompt: "p" })).code).toBe(
      "E_INVALID_OPTION",
    );
    expect(coded(() => parseRegenParams({ baseVideo: "https://cdn/a.mp4" })).code).toBe(
      "E_MISSING_ARGUMENT",
    );
  });

  it("默认模型 H3、resolution 固定 2K，source_task_id 体只带四项", () => {
    const input = parseRegenParams({ sourceTaskId: "src-768p" }, {});
    expect(input).toMatchObject({
      method: "source_task_id",
      model: "MiniMax-H3",
      resolution: "2K",
      pollIntervalMs: 5_000,
      timeoutMs: 900_000,
    });
    expect(buildRegenBody(input)).toEqual({
      model: "MiniMax-H3",
      resolution: "2K",
      source_task_id: "src-768p",
    });
  });

  it("base_video 模式：content 为 text + role=base_video，且拒绝超长 prompt", () => {
    const input = parseRegenParams({ baseVideo: "https://cdn/src.mp4", prompt: "升到 2K" }, {});
    expect(input).toMatchObject({ method: "base_video", prompt: "升到 2K" });
    expect(buildRegenBody(input, { url: "https://cdn/src.mp4" })).toEqual({
      model: "MiniMax-H3",
      resolution: "2K",
      content: [
        { type: "text", text: "升到 2K" },
        { type: "video_url", video_url: { url: "https://cdn/src.mp4" }, role: "base_video" },
      ],
    });
    expect(
      coded(() => parseRegenParams({ baseVideo: "https://cdn/src.mp4", prompt: "a".repeat(7001) }))
        .code,
    ).toBe("E_INVALID_OPTION");
  });

  it("env/--model 覆盖与 aigc_watermark 只在显式给出时进请求体", () => {
    expect(
      parseRegenParams({ sourceTaskId: "t" }, { videoRegenModel: "MiniMax-H3-Regeneration" }).model,
    ).toBe("MiniMax-H3-Regeneration");
    expect(
      parseRegenParams({ sourceTaskId: "t", model: "custom" }, { videoRegenModel: "env" }).model,
    ).toBe("custom");
    expect(buildRegenBody(parseRegenParams({ sourceTaskId: "t" }, {}))).not.toHaveProperty(
      "aigc_watermark",
    );
    expect(
      buildRegenBody(parseRegenParams({ sourceTaskId: "t", aigcWatermark: true }, {})),
    ).toMatchObject({ aigc_watermark: true });
  });

  it("--base-video 复用视频通道：URL 透传、六种 scheme 与本地内联摘要", async () => {
    const passed = await resolveBaseVideo("https://cdn/src.mp4", "/tmp");
    expect(passed).toEqual({
      url: "https://cdn/src.mp4",
      summary: "https://cdn/src.mp4",
      bytes: 0,
    });
    const missing = await codedAsync(() => resolveBaseVideo("/tmp/nope.mp4", "/tmp"));
    expect(missing.code).toBe("E_MISSING_ARGUMENT");
    const scheme = await codedAsync(() => resolveBaseVideo("file:///tmp/a.mp4", "/tmp"));
    expect(scheme.code).toBe("E_INVALID_OPTION");
  });
});

describe("minimax 视频多模态输入", () => {
  it("场景判定：无媒体 t2v、有帧 i2v、只有参考 r2v、空白项忽略", () => {
    expect(detectMediaMode({})).toBe("t2v");
    expect(detectMediaMode({ firstFrame: "https://cdn/a.png" })).toBe("i2v");
    expect(detectMediaMode({ lastFrame: "https://cdn/a.png" })).toBe("i2v");
    expect(detectMediaMode({ refAudio: ["https://cdn/a.mp3"] })).toBe("r2v");
    expect(detectMediaMode({ refImage: ["", "  "] })).toBe("t2v");
  });

  it("ratio 按场景分档：i2v 钉 adaptive、r2v 默认 adaptive 可覆盖、t2v 仍拒", () => {
    expect(parseVideoParams({ prompt: "p", firstFrame: "https://cdn/a.png" }, {}).ratio).toBe(
      "adaptive",
    );
    expect(parseVideoParams({ prompt: "p", refImage: "https://cdn/a.png" }, {}).ratio).toBe(
      "adaptive",
    );
    expect(
      parseVideoParams({ prompt: "p", refImage: "https://cdn/a.png", ratio: "9:16" }, {}).ratio,
    ).toBe("9:16");
    expect(
      parseVideoParams({ prompt: "p", firstFrame: "https://cdn/a.png", ratio: "16:9" }, {}),
    ).toMatchObject({ ratio: "adaptive", ratioIgnored: true });
    expect(parseVideoParams({ prompt: "p" }, {}).ratioIgnored).toBe(false);
  });

  it("prompt 超 7000 字符本地即拒（provider 原文 content[0].text too long）", () => {
    expect(coded(() => parseVideoParams({ prompt: "a".repeat(7001) })).code).toBe(
      "E_INVALID_OPTION",
    );
    expect(parseVideoParams({ prompt: "a".repeat(7000) }, {}).prompt).toHaveLength(7000);
  });

  it("buildVideoBody 把媒体项接在 text 之后；无媒体时请求体逐字段不变", () => {
    const input = parseVideoParams({ prompt: "p" }, {});
    expect(buildVideoBody(input)).toEqual({
      model: "MiniMax-H3",
      content: [{ type: "text", text: "p" }],
      resolution: "768P",
      duration: 5,
      ratio: "16:9",
    });
    expect(
      buildVideoBody(input, {
        content: [{ type: "image_url", image_url: { url: "u" }, role: "first_frame" }],
      }).content,
    ).toEqual([
      { type: "text", text: "p" },
      { type: "image_url", image_url: { url: "u" }, role: "first_frame" },
    ]);
  });

  it("aigc_watermark 与 extra 只在显式给出时进请求体", () => {
    expect(buildVideoBody(parseVideoParams({ prompt: "p" }, {}))).not.toHaveProperty(
      "aigc_watermark",
    );
    expect(
      buildVideoBody(parseVideoParams({ prompt: "p", aigcWatermark: true }, {})),
    ).toMatchObject({ aigc_watermark: true });
    expect(
      buildVideoBody(
        parseVideoParams({ prompt: "p", model: "MiniMax-H3-Max", promptExpansion: "quality" }, {}),
      ),
    ).toMatchObject({ extra: { prompt_expansion_mode: "quality" } });
  });

  it("prompt-expansion 仅 H3-Max：H3 拒绝、非法枚举与文档警告的 balance 都拒", () => {
    expect(coded(() => parseVideoParams({ prompt: "p", promptExpansion: "quality" })).code).toBe(
      "E_INVALID_OPTION",
    );
    expect(
      coded(() =>
        parseVideoParams({ prompt: "p", model: "MiniMax-H3-Max", promptExpansion: "balance" }, {}),
      ).code,
    ).toBe("E_INVALID_OPTION");
  });
});

describe("minimax 媒体解析", () => {
  let cwd = "";

  beforeAll(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "minimax-media-"));
    await sharp({
      create: { width: 512, height: 384, channels: 3, background: "#334455" },
    })
      .png()
      .toFile(path.join(cwd, "ok.png"));
    await sharp({
      create: { width: 100, height: 100, channels: 3, background: "#112233" },
    })
      .png()
      .toFile(path.join(cwd, "tiny.png"));
    await writeFile(path.join(cwd, "wide.jpg"), Buffer.from([1]));
    await writeFile(path.join(cwd, "big.png"), Buffer.from([1]));
    await truncate(path.join(cwd, "big.png"), 31 * 1024 * 1024);
  });
  afterAll(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("URL 与 mm_file:// 原样透传，不读盘", async () => {
    const frame = await resolveVideoMedia({ firstFrame: "https://cdn/a.png" }, cwd);
    expect(frame.content).toEqual([
      { type: "image_url", image_url: { url: "https://cdn/a.png" }, role: "first_frame" },
    ]);
    expect(frame.media).toEqual({ first_frame: ["https://cdn/a.png"] });
    const refs = await resolveVideoMedia(
      { refImage: "https://cdn/i.png", refAudio: "mm_file://f-1" },
      cwd,
    );
    expect(refs.content).toEqual([
      { type: "image_url", image_url: { url: "https://cdn/i.png" }, role: "reference_image" },
      { type: "audio_url", audio_url: { url: "mm_file://f-1" }, role: "reference_audio" },
    ]);
    expect(refs.mode).toBe("r2v");
  });

  it("本地 png 内联成 data URI，摘要只带字节数", async () => {
    const { content, media, mode } = await resolveVideoMedia({ firstFrame: "ok.png" }, cwd);
    expect(mode).toBe("i2v");
    expect(String(content[0]?.image_url?.url)).toMatch(/^data:image\/png;base64,/);
    expect(media.first_frame).toEqual([
      expect.stringMatching(/^data:image\/png;base64,\d+ bytes$/),
    ]);
    expect(summarizeMedia("https://cdn/a.png", 0)).toBe("https://cdn/a.png");
  });

  it("图片每边须落在 [256,5760]：100x100 本地即拒（provider 提交期不拦）", async () => {
    const err = await codedAsync(() => resolveVideoMedia({ firstFrame: "tiny.png" }, cwd));
    expect(err.code).toBe("E_INVALID_OPTION");
    expect(err.details).toMatchObject({ width: 100, height: 100, minEdge: 256 });
  });

  it("格式白名单与单张上限：.jpg 内容非 jpeg 也按扩展名收，超 30MB 拒", async () => {
    const { content } = await resolveVideoMedia({ refImage: "wide.jpg" }, cwd);
    expect(String(content[0]?.image_url?.url)).toMatch(/^data:image\/jpeg;base64,/);
    const err = await codedAsync(() => resolveVideoMedia({ firstFrame: "big.png" }, cwd));
    expect(err.code).toBe("E_INVALID_OPTION");
    expect(err.details).toMatchObject({ maxBytes: 30 * 1024 * 1024 });
  });

  it("尾帧缺首帧、帧与参考混用、超张数 → E_INVALID_OPTION（读文件之前就拒）", async () => {
    expect(
      (await codedAsync(() => resolveVideoMedia({ lastFrame: "https://cdn/a.png" }, cwd))).code,
    ).toBe("E_INVALID_OPTION");
    expect(
      (await codedAsync(() => resolveVideoMedia({ firstFrame: "a.png", refImage: "b.png" }, cwd)))
        .code,
    ).toBe("E_INVALID_OPTION");
    const ten = Array.from({ length: 10 }, (_, i) => `https://cdn/${i}.png`);
    const err = await codedAsync(() => resolveVideoMedia({ refImage: ten }, cwd));
    expect(err.code).toBe("E_INVALID_OPTION");
    expect(err.details).toMatchObject({ max: 9 });
  });

  it("data URI 直传与其他 scheme（file://）一律本地拒", async () => {
    expect(
      (await codedAsync(() => resolveVideoMedia({ firstFrame: "data:image/png;base64,AAA" }, cwd)))
        .code,
    ).toBe("E_INVALID_OPTION");
    expect(
      (await codedAsync(() => resolveVideoMedia({ firstFrame: "file:///tmp/a.png" }, cwd))).code,
    ).toBe("E_INVALID_OPTION");
  });
});

describe("minimax 错误映射与音频解码", () => {
  it("base_resp：0 成功，1004/2049 鉴权，1008 余额，1002/1039 限流，2013 参数", () => {
    expect(mapBaseRespError(0, "ok")).toBeUndefined();
    expect(mapBaseRespError(1004, "bad key")?.code).toBe("E_CONFIG");
    expect(mapBaseRespError(2049, "bad key")?.code).toBe("E_CONFIG");
    const balance = mapBaseRespError(1008, "no money");
    expect(balance?.code).toBe("E_PROVIDER_ERROR");
    expect(balance?.details?.reason).toBe("insufficient_balance");
    expect(mapBaseRespError(1002, "slow down")?.details?.reason).toBe("rate_limited");
    expect(mapBaseRespError(1039, "slow down")?.details?.reason).toBe("rate_limited");
    expect(mapBaseRespError(2013, "bad params")?.details?.reason).toBe("invalid_params");
    expect(mapBaseRespError(9999, "other")?.code).toBe("E_PROVIDER_ERROR");
  });

  it("hex 音频解码；非法 hex 与空音频 → E_PROVIDER_ERROR", async () => {
    const config = { apiKey: "key" };
    expect(await decodeAudio(config, { data: { audio: "00ff10" } })).toEqual(
      Buffer.from([0x00, 0xff, 0x10]),
    );
    await expect(decodeAudio(config, { data: { audio: "zz" } })).rejects.toMatchObject({
      code: "E_PROVIDER_ERROR",
    });
    await expect(decodeAudio(config, { data: {} })).rejects.toMatchObject({
      code: "E_PROVIDER_ERROR",
    });
  });
});
