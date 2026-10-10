import { cliError } from "./errors.mjs";

// 越界夹取 + 非数字报错 + 缺省兜底；转写与音乐分析共用
export function parseBoundedNumber(raw, option, { min, max, fallback }) {
  if (raw === undefined || raw === true || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw cliError("E_INVALID_OPTION", `${option} 必须是数字，得到：${raw}`, {
      option,
      value: raw,
    });
  }
  const clamped = Math.round(Math.min(max, Math.max(min, n)));
  if (clamped !== n) {
    return clamped; // 越界取边界值，AI 调用方不需要为 0.5px 级别的手抖重试
  }
  return clamped;
}

export function parseFormat(raw) {
  const format = raw ?? "srt";
  if (format !== "srt" && format !== "txt") {
    throw cliError("E_INVALID_OPTION", `--format 仅支持 srt|txt，得到：${format}`, {
      option: "--format",
      value: format,
    });
  }
  return format;
}

export function parseOptions(args) {
  const segmentSeconds = parseBoundedNumber(args.segmentSeconds, "--segment-seconds", {
    min: 10,
    max: 120,
    fallback: 30,
  });
  return {
    format: parseFormat(args.format),
    segmentSeconds,
    // 单段硬上限：超过 ~45s 的音频一次请求延迟陡增且易超时
    maxSegmentSeconds: Math.min(120, Math.round(segmentSeconds * 1.5)),
    concurrency: parseBoundedNumber(args.concurrency, "--concurrency", {
      min: 1,
      max: 8,
      fallback: 4,
    }),
    language: args.language ?? "auto",
    extraPrompt: typeof args.prompt === "string" ? args.prompt : undefined,
    model: typeof args.model === "string" && args.model !== "" ? args.model : undefined,
  };
}

const BASE_PROMPT =
  "你是字幕转写引擎。听这段音频并逐句转写为文字：保持音频里的原语言原文，不要翻译、不要解释、不要总结；每句独占一行，只输出转写文本。";

export function buildPrompt({ language, extraPrompt }) {
  const parts = [BASE_PROMPT];
  if (language && language !== "auto") parts.push(`转写语言：${language}。`);
  if (extraPrompt) parts.push(`补充要求：${extraPrompt}`);
  return parts.join("");
}
