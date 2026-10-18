import { describe, expect, it } from "vitest";
import { decodeAudio } from "../../plugins/minimax/lib/audio.mjs";
import { mapBaseRespError } from "../../plugins/minimax/lib/client.mjs";
import { loadConfig, normalizeBase, parseNumberOption } from "../../plugins/minimax/lib/config.mjs";
import { buildMusicBody, parseMusicArgs } from "../../plugins/minimax/lib/music.mjs";
import { buildSpeechBody, parseSpeechArgs } from "../../plugins/minimax/lib/speech.mjs";
import { buildVideoBody, parseVideoParams } from "../../plugins/minimax/lib/video.mjs";

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
    });
    expect(
      loadConfig({
        MINIMAX_API_KEY: "k",
        MINIMAX_SPEECH_MODEL: "speech-x",
        MINIMAX_MUSIC_MODEL: "music-x",
        MINIMAX_VIDEO_MODEL: "MiniMax-H3-Max",
      }),
    ).toMatchObject({
      speechModel: "speech-x",
      musicModel: "music-x",
      videoModel: "MiniMax-H3-Max",
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
