import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { batchOutputPath, defaultSidecar, enumerateInputs } from "./analysis-files.mjs";
import { extractJsonObject, prompts, structureCovers } from "./analysis-prompt.mjs";
import { chatWithRetry } from "./ark.mjs";
import { extractClipBase64, probeDuration } from "./audio.mjs";
import { resolveFfmpeg, resolveFfprobe } from "./bin.mjs";
import { getConfig, MODEL_VAR } from "./config.mjs";
import { cliError } from "./errors.mjs";
import { parseBoundedNumber } from "./options.mjs";
import { mapLimit } from "./pool.mjs";
import { planSegments } from "./segments.mjs";

// 整段单请求上限：实测 ~370s 音频单次约 112s，超过后超时风险陡增；更长曲子切段并发 + 合并
const SINGLE_REQUEST_MAX_SEC = 240;
// 分析是推理密集型（completion 远超转写），转写调优的默认 120s 超时不够用：给分析请求设超时下限
const ANALYSIS_TIMEOUT_FLOOR_MS = 180_000;
const DEFAULT_OUTPUT_DIR = "music-analysis";

export function parseAnalysisOptions(args) {
  return {
    segmentSeconds: parseBoundedNumber(args.segmentSeconds, "--segment-seconds", {
      min: 60,
      max: 300,
      fallback: 120,
    }),
    concurrency: parseBoundedNumber(args.concurrency, "--concurrency", {
      min: 1,
      max: 8,
      fallback: 4,
    }),
    model: typeof args.model === "string" && args.model !== "" ? args.model : undefined,
  };
}

function sumTokens(list) {
  return list.reduce(
    (acc, u) => ({
      promptTokens: acc.promptTokens + (u?.promptTokens ?? 0),
      completionTokens: acc.completionTokens + (u?.completionTokens ?? 0),
      audioTokens: acc.audioTokens + (u?.audioTokens ?? 0),
    }),
    { promptTokens: 0, completionTokens: 0, audioTokens: 0 },
  );
}

function audioBody(config, model, audioBase64, text) {
  return {
    model: model ?? config.model,
    messages: [
      {
        role: "user",
        content: [
          { type: "input_audio", input_audio: { data: audioBase64, format: "mp3" } },
          { type: "text", text },
        ],
      },
    ],
  };
}

// 请求一次分析并解析 JSON；模型偶发输出围栏/闲话，重申一次再要（仅一次）
async function requestAnalysisJson(config, buildBody) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const body = buildBody(
      attempt === 0 ? "" : "\n\n再次强调：只输出一个合法 JSON 对象本身，不要任何其他字符。",
    );
    const { text, usage } = await chatWithRetry(config, body);
    try {
      return { analysis: extractJsonObject(text), usage };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? cliError("E_PROVIDER_ERROR", "doubao 音乐分析失败", { reason: "bad_json" });
}

// 短曲：整段单请求，全局视角完整
async function analyzeWhole(config, model, ffmpeg, file, durationSec, tmpDir) {
  const audioBase64 = await extractClipBase64(ffmpeg, file, {
    start: 0,
    end: durationSec,
    outPath: path.join(tmpDir, "whole.mp3"),
  });
  const { analysis, usage } = await requestAnalysisJson(config, (suffix) =>
    audioBody(config, model, audioBase64, prompts.analysis + suffix),
  );
  return { analysis, usages: [usage], chunks: 1 };
}

// 长曲：定长切段并发分析（时间相对本段），再用一次纯文本请求合并成全局一致的完整分析
async function analyzeChunked(config, model, ffmpeg, file, durationSec, opts, tmpDir) {
  const segments = planSegments({
    durationSec,
    targetSec: opts.segmentSeconds,
    maxSec: opts.segmentSeconds,
  });
  const clips = [];
  for (const [i, seg] of segments.entries()) {
    const clipPath = path.join(tmpDir, `chunk-${i}.mp3`);
    const audioBase64 = await extractClipBase64(ffmpeg, file, {
      start: seg.start,
      end: seg.end,
      outPath: clipPath,
    });
    clips.push({ ...seg, audioBase64 });
  }

  const chunkResults = await mapLimit(clips, opts.concurrency, async (clip, i) => {
    try {
      return await requestAnalysisJson(config, (suffix) =>
        audioBody(
          config,
          model,
          clip.audioBase64,
          prompts.chunkPrompt(i, clips.length, clip.start, clip.end) + suffix,
        ),
      );
    } catch (err) {
      const window = `${clip.start}-${clip.end}s`;
      throw cliError(
        typeof err?.code === "string" ? err.code : "E_PROVIDER_ERROR",
        `第 ${i + 1} 段（${window}）分析失败：${String(err?.message ?? err)}`,
        { segment: i + 1, window },
      );
    }
  });

  const merge = await requestAnalysisJson(config, (suffix) => ({
    model: model ?? config.model,
    messages: [
      {
        role: "user",
        content:
          prompts.mergePrompt(
            chunkResults.map((r, i) => ({
              startSec: Math.round(clips[i].start),
              endSec: Math.round(clips[i].end),
              analysis: r.analysis,
            })),
            Math.round(durationSec),
          ) + suffix,
      },
    ],
  }));

  return {
    analysis: merge.analysis,
    usages: [...chunkResults.map((r) => r.usage), merge.usage],
    chunks: clips.length,
  };
}

// 单文件管线：探测时长 → 整段或切段+合并 → 语义兜底告警 → 返回分析与其元信息
async function analyzeOne({ file, ffmpeg, ffprobe, config, model, opts, ctx }) {
  const durationSec = await probeDuration(ffprobe, file);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "doubao-music-"));
  let done;
  try {
    done =
      durationSec <= SINGLE_REQUEST_MAX_SEC
        ? await analyzeWhole(config, model, ffmpeg, file, durationSec, tmpDir)
        : await analyzeChunked(config, model, ffmpeg, file, durationSec, opts, tmpDir);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  const { analysis } = done;
  if (analysis.isMusic === false) {
    ctx.warnings.add({
      code: "E_NOT_MUSIC",
      message: "输入疑似非音乐内容（isMusic=false），分析结果仅供参考",
      plugin: "doubao",
    });
  }
  if (!structureCovers(analysis.structure, durationSec)) {
    ctx.warnings.add({
      code: "E_TIMELINE_APPROXIMATE",
      message: "structure 时间轴未覆盖到音频结尾（模型时间戳为估算，长音频可能漂移），仅供参考",
      plugin: "doubao",
    });
  }
  return {
    analysis,
    durationSec: Math.round(durationSec * 1000) / 1000,
    chunks: done.chunks,
    requests: done.usages.length,
    tokens: sumTokens(done.usages),
  };
}

async function writeJsonFile(target, analysis) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(analysis, null, 2)}\n`, "utf8");
  return (await stat(target)).size;
}

export async function analyzeMusicWithDoubao(ctx, args) {
  if (!args.input) {
    throw cliError("E_MISSING_ARGUMENT", "缺少必填 --input", { option: "--input" });
  }
  const input = String(args.input);
  const opts = parseAnalysisOptions(args);
  const config = getConfig();
  const model = opts.model ?? config.model;
  if (!model) {
    throw cliError("E_CONFIG", `缺少豆包模型 id：设置 ${MODEL_VAR} 或用 --model 指定`, {
      var: MODEL_VAR,
      hint: "GET /models 里取 status 非 Shutdown 且 input_modalities 含 audio 的型号",
    });
  }
  const info = await stat(input).catch(() => null);
  if (!info?.isFile() && !info?.isDirectory()) {
    throw cliError("E_MISSING_ARGUMENT", `输入不存在：${input}`, {
      option: "--input",
      value: input,
    });
  }
  const ffmpeg = resolveFfmpeg();
  const ffprobe = resolveFfprobe();
  const inputs = enumerateInputs(input, { recursive: Boolean(args.recursive) });
  if (inputs.length === 0) {
    throw cliError("E_INVALID_OPTION", `输入目录中没有可分析的音频/视频文件：${input}`, {
      option: "--input",
      value: input,
    });
  }
  const shared = {
    ffmpeg,
    ffprobe,
    config: { ...config, timeoutMs: Math.max(config.timeoutMs, ANALYSIS_TIMEOUT_FLOOR_MS) },
    model,
    opts,
    ctx,
  };

  if (info.isFile()) {
    const output = args.output ? path.resolve(ctx.cwd, String(args.output)) : defaultSidecar(input);
    const outInfo = await stat(output).catch(() => null);
    if (outInfo?.isDirectory()) {
      throw cliError("E_INVALID_OPTION", `--output 是目录，单文件模式需要文件路径：${output}`, {
        option: "--output",
        value: output,
      });
    }
    const done = await analyzeOne({ file: input, ...shared });
    done.bytes = await writeJsonFile(output, done.analysis);
    return { path: output, model, ...done };
  }

  const outputDir = path.resolve(ctx.cwd, args.output ? String(args.output) : DEFAULT_OUTPUT_DIR);
  const results = [];
  const failed = [];
  await mapLimit(inputs, opts.concurrency, async ({ path: file, relative }) => {
    try {
      const target = batchOutputPath(outputDir, relative);
      const done = await analyzeOne({ file, ...shared });
      done.bytes = await writeJsonFile(target, done.analysis);
      results.push({ file, relative, path: target, model, ...done });
      ctx.logger.info(`已分析 ${relative} → ${target}`);
    } catch (err) {
      failed.push({ file, reason: err?.message ?? String(err) });
    }
  });
  if (results.length === 0) {
    throw cliError("E_PROVIDER_ERROR", "全部音乐分析失败", { failed });
  }
  return { outputDir, total: inputs.length, results, failed };
}
