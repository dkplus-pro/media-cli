import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { transcribeClip } from "./ark.mjs";
import { detectSilences, extractClipBase64, probeDuration } from "./audio.mjs";
import { resolveFfmpeg, resolveFfprobe } from "./bin.mjs";
import { getConfig, MODEL_VAR } from "./config.mjs";
import { cliError } from "./errors.mjs";
import { buildPrompt, parseOptions } from "./options.mjs";
import { mapLimit } from "./pool.mjs";
import { planSegments } from "./segments.mjs";
import { buildSrt, countCues, joinText } from "./srt.mjs";

function sec(t) {
  return Math.round(t * 1000) / 1000;
}

// 并发分段里单段失败会拖垮整条命令，报错时补上「第几段/哪一秒区间」便于定位
function annotate(err, seg, index) {
  const code = typeof err?.code === "string" ? err.code : "E_PROVIDER_ERROR";
  const window = `${sec(seg.start)}-${sec(seg.end)}s`;
  return cliError(code, `第 ${index + 1} 段（${window}）失败：${String(err?.message ?? err)}`, {
    segment: index + 1,
    window,
    ...(typeof err?.details === "object" && err.details !== null ? err.details : {}),
  });
}

export async function transcribeWithDoubao(ctx, args) {
  if (!args.input) {
    throw cliError("E_MISSING_ARGUMENT", "缺少必填 --input", { option: "--input" });
  }
  const input = String(args.input);
  const opts = parseOptions(args);
  const info = await stat(input).catch(() => null);
  if (!info?.isFile()) {
    throw cliError("E_MISSING_ARGUMENT", `输入不存在：${input}`, {
      option: "--input",
      value: input,
    });
  }

  // 早取 config：缺 key 要在起 ffmpeg/上传音频之前就以干净错误退出
  const config = getConfig();
  const model = opts.model ?? config.model;
  if (!model) {
    throw cliError("E_CONFIG", `缺少豆包模型 id：设置 ${MODEL_VAR} 或用 --model 指定`, {
      var: MODEL_VAR,
      hint: "GET /models 里取 status 非 Shutdown 且 input_modalities 含 audio 的型号",
    });
  }
  const ffmpeg = resolveFfmpeg();
  const ffprobe = resolveFfprobe();
  const durationSec = await probeDuration(ffprobe, input);

  const silences = durationSec <= opts.maxSegmentSeconds ? [] : await detectSilences(ffmpeg, input);
  const segments = planSegments({
    durationSec,
    silences,
    targetSec: opts.segmentSeconds,
    maxSec: opts.maxSegmentSeconds,
  });
  if (segments.length === 0) {
    throw cliError("E_PROVIDER_ERROR", `输入无可转写内容：${input}`, {
      source: "ffprobe",
      durationSec,
    });
  }

  const prompt = buildPrompt(opts);
  const tmp = await mkdtemp(path.join(os.tmpdir(), "doubao-"));
  let done;
  try {
    done = await mapLimit(segments, opts.concurrency, async (seg, i) => {
      try {
        const audioBase64 = await extractClipBase64(ffmpeg, input, {
          start: seg.start,
          end: seg.end,
          outPath: path.join(tmp, `seg-${i}.mp3`),
        });
        const res = await transcribeClip(config, {
          audioBase64,
          format: "mp3",
          prompt,
          model,
        });
        return { ...seg, text: res.text, usage: res.usage };
      } catch (err) {
        throw annotate(err, seg, i);
      }
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  const content = opts.format === "srt" ? buildSrt(done) : `${joinText(done)}\n`;
  if (content.trim() === "") {
    throw cliError("E_PROVIDER_ERROR", "doubao 未返回可写入的转写内容", {
      reason: "empty_result",
      segments: segments.length,
    });
  }
  const output = args.output ? String(args.output) : `${input}.${opts.format}`;
  await writeFile(output, content, "utf8");
  const written = await stat(output);

  if (opts.format === "srt" && segments.length > 1) {
    ctx.warnings.add({
      code: "E_TIMELINE_APPROXIMATE",
      message:
        "SRT 段边界来自静音检测（准确），段内各行时间按字数比例估算（近似）；需逐句精确时间戳请用 media-transcribe",
      plugin: "doubao",
    });
  }

  const tokens = done.reduce(
    (acc, item) => ({
      promptTokens: acc.promptTokens + (item.usage?.promptTokens ?? 0),
      completionTokens: acc.completionTokens + (item.usage?.completionTokens ?? 0),
      audioTokens: acc.audioTokens + (item.usage?.audioTokens ?? 0),
    }),
    { promptTokens: 0, completionTokens: 0, audioTokens: 0 },
  );

  return {
    path: output,
    format: opts.format,
    model,
    durationSec: sec(durationSec),
    segments: segments.length,
    ...(opts.format === "srt" ? { cues: countCues(content) } : {}),
    language: opts.language,
    bytes: written.size,
    tokens,
  };
}
