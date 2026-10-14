import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { describePartialInput, overlapWarningText } from "./cells-io.mjs";
import { parseGridCaptionArgs } from "./cells-options.mjs";
import { compressOne } from "./compress.mjs";
import { cliError } from "./errors.mjs";
import {
  canvasSize,
  createFaceCoverer,
  parseAtList,
  parseMinConfidence,
  parseScale,
} from "./face-cover.mjs";
import { resolveFacesBin } from "./faces-bin.mjs";
import { defaultSidecar, enumerateInputs, resolveInput } from "./files.mjs";
import { resolveImageFormat, SUPPORTED_EXTENSIONS } from "./format.mjs";
import { renderFallback, renderInCell, resolveGridCells } from "./grid-caption.mjs";
import {
  parseAngle,
  parseColor,
  parseDpi,
  parseFontSize,
  parseImageFormat,
  parseMargin,
  parseOpacity,
  parseOrder,
  parseOrientation,
  parsePageSize,
  parseQuality,
  parseSpacing,
  parseText,
} from "./options.mjs";
import { mergeToPdf } from "./pdf-merge.mjs";
import { loadSharp } from "./sharp.mjs";
import { createWatermarker } from "./watermark.mjs";

// compress/watermark/face-cover 共享的批量骨架：单文件直接处理，文件夹逐张处理（单张失败不中断，记入 failed）
async function runBatch(ctx, args, { defaultDirName, sidecarTag, processOne }) {
  const isDirectory = resolveInput(args.input);
  const outputDir = isDirectory ? path.resolve(ctx.cwd, args.output ?? defaultDirName) : null;
  const inputAbs = path.resolve(ctx.cwd, args.input);
  // 默认输出目录落在输入目录内时，枚举阶段排除，防止二次运行吃到上次产物
  const excludeUnder =
    outputDir !== null && (outputDir === inputAbs || outputDir.startsWith(`${inputAbs}${path.sep}`))
      ? outputDir
      : null;

  const inputs = enumerateInputs(args.input, {
    recursive: Boolean(args.recursive),
    excludeUnder,
  });
  if (inputs.length === 0) {
    throw cliError(
      "E_INVALID_OPTION",
      `输入目录中没有可处理的图片（${SUPPORTED_EXTENSIONS.join("/")}）：${args.input}`,
      { option: "--input", value: args.input },
    );
  }

  if (!isDirectory) {
    const output = args.output
      ? path.resolve(ctx.cwd, args.output)
      : defaultSidecar(args.input, sidecarTag);
    return { path: output, ...(await processOne(args.input, output)) };
  }

  const results = [];
  const failed = [];
  for (const { path: file, relative } of inputs) {
    const target = path.join(outputDir, relative);
    try {
      mkdirSync(path.dirname(target), { recursive: true });
      results.push({ path: target, ...(await processOne(file, target)) });
      ctx.logger.info(`已处理 ${relative} → ${target}`);
    } catch (err) {
      failed.push({ file, reason: err?.message ?? String(err) });
    }
  }
  if (results.length === 0) {
    throw cliError("E_PROVIDER_ERROR", "全部图片处理失败", { failed });
  }
  return { outputDir, results, failed, total: inputs.length };
}

export async function compress(ctx, args) {
  const quality = parseQuality(args.quality, 80);
  const sharp = await loadSharp();
  const data = await runBatch(ctx, args, {
    defaultDirName: "min",
    sidecarTag: "min",
    processOne: (file, output) => compressOne(sharp, file, output, { quality }),
  });
  if ("results" in data) {
    let bytesBefore = 0;
    let bytesAfter = 0;
    for (const r of data.results) {
      bytesBefore += r.bytesBefore;
      bytesAfter += r.bytesAfter;
    }
    return { ...data, quality, bytesBefore, bytesAfter, savedBytes: bytesBefore - bytesAfter };
  }
  return { ...data, quality };
}

export async function watermark(ctx, args) {
  const opts = {
    text: parseText(args.text),
    font:
      typeof args.font === "string" && args.font.trim() !== "" ? args.font.trim() : "sans-serif",
    angle: parseAngle(args.angle, 30),
    spacing: parseSpacing(args.spacing, 80),
    opacity: parseOpacity(args.opacity, 0.3),
    fontSize: parseFontSize(args.fontSize),
    color: parseColor(args.color, "#ffffff"),
  };
  const sharp = await loadSharp();
  const apply = createWatermarker(sharp, opts);
  const data = await runBatch(ctx, args, {
    defaultDirName: "watermark",
    sidecarTag: "watermark",
    processOne: (file, output) => apply(file, output),
  });
  // opts.fontSize 为 null 表示自动；单文件以实际处理结果为准（fontSize 已按图片解析）
  const echo = { ...opts, fontSize: opts.fontSize ?? null };
  if ("results" in data) {
    return { ...data, ...echo };
  }
  return { ...echo, ...data };
}

// 白圆遮脸：Apple Vision 本地检脸（离线、无模型下载）+ sharp 叠实心圆
export async function faceCover(ctx, args) {
  const scale = parseScale(args.scale);
  const minConfidence = parseMinConfidence(args.minConfidence);
  const color = parseColor(args.color, "#FFFFFF");
  const manual = parseAtList(args.at);
  const sharp = await loadSharp();

  // 引擎解析先于文件系统探测（与 media-cutout 同序）：无 --at 时不可用即失败；
  // 传了 --at 则降级为警告——人工坐标本来就不需要检测器
  let bin = null;
  try {
    bin = await resolveFacesBin();
  } catch (err) {
    if (manual.length === 0) throw err;
    ctx.warnings.add({
      code: typeof err?.code === "string" ? err.code : "E_MISSING_DEPENDENCY",
      message: `人脸检测引擎不可用，仅按 --at 人工圆遮脸：${err?.message ?? err}`,
      plugin: "media-image",
    });
  }

  const data = await runBatch(ctx, args, {
    defaultDirName: "face-cover",
    sidecarTag: "covered",
    processOne: createFaceCoverer({ sharp, ctx, bin, scale, minConfidence, manual, color }),
  });
  const echo = { scale, minConfidence, color, manualCircles: manual.length };
  return "results" in data ? { ...data, ...echo } : { ...echo, ...data };
}

export async function toPdf(ctx, args) {
  return mergeToPdf(ctx, {
    input: args.input,
    output: args.output,
    recursive: Boolean(args.recursive),
    skipBroken: Boolean(args.skipBroken),
    order: parseOrder(args.order),
    page: parsePageSize(args.page),
    orientation: parseOrientation(args.orientation),
    imageFormat: parseImageFormat(args.imageFormat),
    dpi: parseDpi(args.dpi),
    margin: parseMargin(args.margin),
    quality: parseQuality(args.quality, 85),
  });
}

// 输出路径：缺省 <name>.captioned.<ext>；--output 是目录时把旁路文件名放进去；父目录不存在即拒
function captionOutputPath(cwd, inputAbs, raw) {
  const sidecar = defaultSidecar(inputAbs, "captioned");
  if (raw === null) return sidecar;
  const out = path.resolve(cwd, raw);
  if (existsSync(out) && statSync(out).isDirectory()) {
    return path.join(out, path.basename(sidecar));
  }
  if (!existsSync(path.dirname(out))) {
    throw cliError("E_INVALID_OPTION", `--output 的父目录不存在：${path.dirname(out)}`, {
      option: "--output",
      value: raw,
    });
  }
  return out;
}

function warn(ctx, code, message) {
  ctx.warnings.add({ code, message, plugin: "media-image" });
}

// 单图输入（本命令不做目录批量）：不存在 → E_MISSING_ARGUMENT，目录/坏扩展名 → E_INVALID_OPTION
function singleImageInput(cwd, raw) {
  if (raw === "") {
    throw cliError("E_MISSING_ARGUMENT", "缺少必填 --input", { option: "--input" });
  }
  const abs = path.resolve(cwd, raw);
  resolveInput(abs);
  if (statSync(abs).isDirectory()) {
    throw cliError(
      "E_INVALID_OPTION",
      "media-grid-caption 只处理单张图片（字幕文本与图一一对应，批量语义不清）",
      { option: "--input", value: raw },
    );
  }
  resolveImageFormat(abs);
  return abs;
}

// 宫格加字幕（§6.2）：定位优先级 --cells > --cols/--rows > 本地检测 > fallback-bottom（D32）
export async function gridCaption(ctx, args) {
  const opts = parseGridCaptionArgs(args);
  const inputAbs = singleImageInput(ctx.cwd, opts.input);
  const sharp = await loadSharp();
  const canvas = await canvasSize(sharp, inputAbs);
  const output = captionOutputPath(ctx.cwd, inputAbs, opts.output);
  const style = {
    font: opts.font,
    fontSize: opts.fontSize,
    textColor: opts.textColor,
    opacity: opts.opacity,
    padding: opts.padding,
    position: opts.position,
  };
  const echo = { ...style, input: inputAbs };
  const placed = await resolveGridCells({ sharp, ctx, inputAbs, cwd: ctx.cwd, canvas, opts });

  // 三级全失败 → 兜底：底部向外扩半透明黑条，N 条字幕按 index 顺序逐行居中，exit 0
  // data.source 落 "none"（§2 枚举第四值），不再输出 null（F5）
  if (placed.cells === null) {
    const texts = placed.captions
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((item) => item.text);
    const data = await renderFallback({ sharp, input: inputAbs, output, canvas, texts, style });
    warn(
      ctx,
      "E_GRID_NOT_DETECTED",
      "未能定位宫格（未给 --cells/--cols/--rows 且本地检测失败），字幕已外扩到整图底部：规则宫格可加 --cols/--rows 等分，倾斜或错位的分镜页请用 doubao-grid-locate 生成 --cells",
    );
    if (data.truncated > 0) {
      warn(ctx, "E_TEXT_TRUNCATED", `兜底字幕有 ${data.truncated} 条超出 4 行，已截断加 …`);
    }
    return { ...echo, ...data, source: placed.source };
  }

  // 条数不匹配只警告不失败（§6.2）：**一条**自洽的警告同时说清「哪些格没字幕」与
  // 「哪些字幕没有对应格」——F6 的实测矛盾来自两条警告各按不同口径（匹配数 / 未匹配数）计数
  const partial = describePartialInput(placed);
  if (partial !== null) warn(ctx, "E_PARTIAL_INPUT", partial);

  // F2/F3：小重叠（占较小格面积 ≤ --max-overlap）不是错误 —— 视觉模型的坐标放大回原图必然带
  // 几像素薄条。过去这里一律 E_INVALID_OPTION 拒收，等于把兄弟命令 doubao-grid-locate 的产物打回去。
  // 现在照常渲染并留一条警告；大幅重叠仍由 validateCells 抛 E_INVALID_OPTION（exit 2）。
  const minorOverlaps = placed.overlaps?.minor ?? [];
  if (minorOverlaps.length > 0) {
    warn(ctx, "E_CELLS_OVERLAP", overlapWarningText("--cells", minorOverlaps, opts.maxOverlap));
  }

  const data = await renderInCell({
    sharp,
    input: inputAbs,
    output,
    canvas,
    cells: placed.cells,
    style,
  });
  if (data.truncated > 0) {
    warn(
      ctx,
      "E_TEXT_TRUNCATED",
      `第 ${data.truncatedCells.join("/")} 格字幕超过 4 行，已截断加 …（可用 --font-size 调小或 --padding 调小）`,
    );
  }
  // truncatedCells 只服务于上面那条人类可读的警告；data 里保留 truncated 计数即可（§6.2 的 data 清单）
  // minorOverlaps/maxOverlap 同理：重叠已经被 §2 的分级放行到「警告」这一档，就必须让调用方
  // （人或 AI）能从 data 里直接看到「有几组、阈值是多少」，而不是只去 parse stderr
  const { truncatedCells: _drop, ...rest } = data;
  return {
    ...echo,
    ...rest,
    source: placed.source,
    minorOverlaps: minorOverlaps.length,
    maxOverlap: opts.maxOverlap,
  };
}
