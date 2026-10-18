import { decodeAudio, outputPathOf, writeOutput } from "./audio.mjs";
import { assertBaseResp, requestJson } from "./client.mjs";
import { DEFAULT_MUSIC_MODEL, loadConfig, parseNumberOption } from "./config.mjs";
import { cliError } from "./errors.mjs";

const PROMPT_MAX = 2_000;
const LYRICS_MAX = 3_500;
// 同步接口：全曲响应体可达 10MB，实测 >30s，默认给 10 分钟
const MUSIC_TIMEOUT_MS = 600_000;

function textOf(value) {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function optionalText(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function numberOrUndefined(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function assertLength(value, limit, option) {
  const actual = Array.from(value).length;
  if (actual > limit) {
    throw cliError("E_INVALID_OPTION", `${option} 超过 ${limit} 字符（当前 ${actual}）`, {
      option,
      limit,
      actual,
    });
  }
}

export function parseMusicArgs(args = {}, config = {}) {
  const instrumental = Boolean(args.instrumental);
  const lyricsOptimizer = Boolean(args.lyricsOptimizer);

  const prompt = textOf(args.prompt);
  if (prompt !== undefined) assertLength(prompt, PROMPT_MAX, "--prompt");
  if (instrumental && prompt === undefined) {
    throw cliError("E_MISSING_ARGUMENT", "纯音乐（--instrumental）必须提供 --prompt 描述风格", {
      option: "--prompt",
    });
  }

  const lyrics = textOf(args.lyrics);
  if (lyrics !== undefined) assertLength(lyrics, LYRICS_MAX, "--lyrics");
  if (!instrumental && !lyricsOptimizer && lyrics === undefined) {
    throw cliError(
      "E_MISSING_ARGUMENT",
      "缺少 --lyrics：传歌词、加 --lyrics-optimizer 自动生成，或用 --instrumental 生成纯音乐",
      { option: "--lyrics" },
    );
  }

  const timeoutMs = parseNumberOption(args.timeout, "--timeout", {
    min: 1,
    integer: true,
    fallback: MUSIC_TIMEOUT_MS,
  });
  const model = optionalText(args.model) ?? optionalText(config.musicModel) ?? DEFAULT_MUSIC_MODEL;

  return {
    model,
    ...(prompt === undefined ? {} : { prompt }),
    ...(lyrics === undefined ? {} : { lyrics }),
    instrumental,
    lyricsOptimizer,
    timeoutMs,
  };
}

// 只发已验证字段：audio_setting / stream / output_format 一律不发（实测会 400）
export function buildMusicBody(input) {
  const { model, prompt, lyrics, instrumental, lyricsOptimizer } = input;
  return {
    model,
    ...(typeof prompt === "string" && prompt !== "" ? { prompt } : {}),
    ...(typeof lyrics === "string" && lyrics !== "" ? { lyrics } : {}),
    ...(instrumental ? { is_instrumental: true } : {}),
    ...(lyricsOptimizer ? { lyrics_optimizer: true } : {}),
  };
}

export async function runMusic(ctx, args) {
  const config = loadConfig();
  const input = parseMusicArgs(args, config);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const defaultName = `minimax-music-${stamp}.mp3`;
  // 输出目录先预检：路径问题在发网络前失败，不白烧额度
  await outputPathOf(ctx, args.output, defaultName);

  ctx.logger.info("MiniMax 音乐生成中（同步接口，通常 30s+，请耐心等待）");
  const payload = await requestJson(config, {
    method: "POST",
    path: "/v1/music_generation",
    body: buildMusicBody(input),
    timeoutMs: input.timeoutMs,
    source: "minimax-music",
  });
  assertBaseResp(payload, "minimax-music", config);

  const buf = await decodeAudio(config, payload, input.timeoutMs);
  const output = await writeOutput(ctx, args.output, defaultName, buf);

  const extra = payload?.extra_info ?? {};
  const durationMs = numberOrUndefined(extra.music_duration);
  const sampleRate = numberOrUndefined(extra.music_sample_rate);
  const channels = numberOrUndefined(extra.music_channel);
  const bitrate = numberOrUndefined(extra.bitrate);
  const traceId =
    typeof payload?.trace_id === "string" && payload.trace_id !== "" ? payload.trace_id : undefined;

  return {
    path: output,
    bytes: buf.length,
    model: input.model,
    format: "mp3",
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(sampleRate === undefined ? {} : { sampleRate }),
    ...(channels === undefined ? {} : { channels }),
    ...(bitrate === undefined ? {} : { bitrate }),
    ...(traceId === undefined ? {} : { traceId }),
  };
}
