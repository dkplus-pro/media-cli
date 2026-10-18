import { decodeAudio, outputPathOf, writeOutput } from "./audio.mjs";
import { assertBaseResp, requestJson } from "./client.mjs";
import { DEFAULT_SPEECH_MODEL, loadConfig, parseNumberOption } from "./config.mjs";
import { cliError } from "./errors.mjs";

const TEXT_MAX = 10_000;
const DEFAULT_VOICE = "female-shaonv";
// 同步接口：一句话通常在数秒内返回，留 300s 足够覆盖长文本
const SPEECH_TIMEOUT_MS = 300_000;

export const EMOTIONS = [
  "happy",
  "sad",
  "angry",
  "fearful",
  "disgusted",
  "surprised",
  "calm",
  "fluent",
  "whisper",
];

function optionalText(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function numberOrUndefined(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

export function parseSpeechArgs(args = {}, config = {}) {
  const text = typeof args.text === "string" ? args.text : "";
  if (text.trim() === "") {
    throw cliError("E_MISSING_ARGUMENT", "缺少必填 --text", { option: "--text" });
  }
  // 按 Unicode 码点计数：汉字与常用标点各算 1，与用户直觉一致
  const actual = Array.from(text).length;
  if (actual > TEXT_MAX) {
    throw cliError("E_INVALID_OPTION", `--text 超过 ${TEXT_MAX} 字符（当前 ${actual}）`, {
      option: "--text",
      limit: TEXT_MAX,
      actual,
    });
  }

  const voice = optionalText(args.voice) ?? DEFAULT_VOICE;
  const speed = parseNumberOption(args.speed, "--speed", { min: 0.5, max: 2, fallback: 1 });
  const vol = parseNumberOption(args.vol, "--vol", {
    min: 0,
    max: 10,
    minExclusive: true,
    fallback: 1,
  });
  const pitch = parseNumberOption(args.pitch, "--pitch", {
    min: -12,
    max: 12,
    integer: true,
    fallback: 0,
  });

  const emotion = optionalText(args.emotion);
  if (emotion !== undefined && !EMOTIONS.includes(emotion)) {
    throw cliError("E_INVALID_OPTION", `--emotion 仅支持 ${EMOTIONS.join("|")}`, {
      option: "--emotion",
      value: emotion,
    });
  }

  const model =
    optionalText(args.model) ?? optionalText(config.speechModel) ?? DEFAULT_SPEECH_MODEL;
  return { text, voice, speed, vol, pitch, ...(emotion === undefined ? {} : { emotion }), model };
}

// 只发已验证字段：audio_setting / output_format 一律不发（实测组合校验会 400）
export function buildSpeechBody({ model, text, voice, speed = 1, vol = 1, pitch = 0, emotion }) {
  return {
    model,
    text,
    stream: false,
    voice_setting: {
      voice_id: voice,
      speed,
      vol,
      pitch,
      ...(typeof emotion === "string" && emotion !== "" ? { emotion } : {}),
    },
  };
}

export async function runSpeech(ctx, args) {
  const config = loadConfig();
  const input = parseSpeechArgs(args, config);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const defaultName = `minimax-speech-${stamp}.mp3`;
  // 输出目录先预检：路径问题在发网络前失败，不白烧额度
  await outputPathOf(ctx, args.output, defaultName);

  const payload = await requestJson(config, {
    method: "POST",
    path: "/v1/t2a_v2",
    body: buildSpeechBody(input),
    timeoutMs: SPEECH_TIMEOUT_MS,
    source: "minimax-speech",
  });
  assertBaseResp(payload, "minimax-speech", config);

  const buf = await decodeAudio(config, payload, SPEECH_TIMEOUT_MS);
  const output = await writeOutput(ctx, args.output, defaultName, buf);

  const extra = payload?.extra_info ?? {};
  const durationMs = numberOrUndefined(extra.audio_length);
  const sampleRate = numberOrUndefined(extra.audio_sample_rate);
  const usageCharacters = numberOrUndefined(extra.usage_characters);
  const traceId =
    typeof payload?.trace_id === "string" && payload.trace_id !== "" ? payload.trace_id : undefined;

  return {
    path: output,
    bytes: buf.length,
    model: input.model,
    voice: input.voice,
    format: "mp3",
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(sampleRate === undefined ? {} : { sampleRate }),
    ...(usageCharacters === undefined ? {} : { usageCharacters }),
    ...(traceId === undefined ? {} : { traceId }),
  };
}
