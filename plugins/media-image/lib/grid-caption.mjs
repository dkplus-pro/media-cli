import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildEqualCells,
  mergeCaptions,
  readJsonFile,
  SOURCE_NONE,
  validateCaptions,
  validateCells,
} from "./cells-io.mjs";
import { cliError } from "./errors.mjs";
import { resolveImageFormat } from "./format.mjs";
import { barForCell, buildCaptionSvg } from "./grid-bars.mjs";
import { detectGrid } from "./grid-detect.mjs";
import { layoutCaption, layoutFallbackStack } from "./text-layout.mjs";
import { autoFontSize } from "./watermark.mjs";

// 黑条的构造与 SVG 组装住在 grid-bars.mjs，这里再导出一次，grid-caption 仍是这条链的门面
export { barForCell, buildBarNodes, buildCaptionSvg } from "./grid-bars.mjs";

// 宫格加字幕（§6.2）：每格底部叠半透明黑条 + 白字居中 + 自动换行 + 自动字号，**不改变整图尺寸**；
// 三级定位全失败时走兜底版式（整图底部向外扩一条黑边，字幕按 index 逐行堆叠）。
// 渲染 = 一张满画布 SVG（N 个 rect + text）一次 composite；用户文本一律过 escapeXml，
// 颜色只可能是 COLOR_RE 放行后的值（选项解析见 cells-io.mjs 的 parseGridCaptionArgs）。

// 字幕重编码沿用 media-watermark 的档位（jpeg/webp 高画质，png 无损）
function encode(pipeline, format) {
  switch (format) {
    case "jpeg":
      return pipeline.jpeg({ quality: 92, mozjpeg: true });
    case "webp":
      return pipeline.webp({ quality: 90 });
    default:
      return pipeline.png({ compressionLevel: 9 });
  }
}

// 定位三级优先级（D32）：--cells > --cols/--rows 等分 > 本地自动检测。
// 全失败时返回 cells:null，由上层走 fallback-bottom —— 绝不猜个版式把字压到错误的地方
export async function resolveGridCells({ sharp, ctx, inputAbs, cwd, canvas, opts }) {
  if (opts.cellsPath === null && opts.captionsPath === null) {
    throw cliError(
      "E_MISSING_ARGUMENT",
      "缺少字幕文本：--cells 或 --captions 至少给一个（宫格坐标可用 doubao-grid-locate --output 生成）",
      { option: "--captions" },
    );
  }
  let cells = null;
  let source = null;
  let captions = [];
  // 只警告的小重叠（§2 规则 6 的分级结果）：由调用方 commands.mjs 统一发警告，这里不碰输出流
  let overlaps = { total: 0, minor: [], severe: [] };
  if (opts.cellsPath !== null) {
    const doc = await readJsonFile(path.resolve(cwd, opts.cellsPath), "--cells");
    const validated = validateCells(doc, {
      actual: canvas,
      option: "--cells",
      allowOverlap: opts.allowOverlap === true,
      maxOverlap: opts.maxOverlap,
    });
    cells = validated.cells;
    source = validated.source;
    overlaps = validated.overlaps;
  }
  if (opts.captionsPath !== null) {
    const doc = await readJsonFile(path.resolve(cwd, opts.captionsPath), "--captions", {
      allowArray: true,
    });
    captions = validateCaptions(doc, { option: "--captions" });
  }

  if (cells === null && opts.division !== null) {
    cells = buildEqualCells(canvas.width, canvas.height, opts.division.cols, opts.division.rows);
    source = "manual";
  } else if (cells === null && opts.locate) {
    const detected = await detectGrid(sharp, inputAbs, {
      bgTol: opts.bgTol,
      minGutter: opts.minGutter,
    });
    if (detected.ok) {
      cells = detected.cells;
      source = "auto";
      ctx.logger.debug(`本地宫格检测 ${cells.length} 格，confidence=${detected.confidence}`);
    } else {
      ctx.logger.info(`本地宫格检测未通过（${detected.reason}），按设计走 fallback-bottom`);
    }
  }

  // 三级全失败：source 明确落 "none"（§2 枚举的第四值），不再回 null 让调用方猜
  if (cells === null) return { cells: null, source: SOURCE_NONE, captions, overlaps };
  // 合并结果整体透传（withText / cellCount / missingCells / droppedIndexes 供警告用：
  // 一条自洽的警告要同时知道「哪些格没字幕」和「哪些字幕没格子」）
  const merged = mergeCaptions(cells, captions);
  return { ...merged, source, captions, overlaps };
}

// 正常版式：每格底部（或顶部）叠半透明黑条 + 白字，整图尺寸不变
export async function renderInCell({ sharp, input, output, canvas, cells, style }) {
  const format = resolveImageFormat(output);
  const bars = [];
  const truncated = [];
  for (const cell of cells) {
    const text = typeof cell.text === "string" ? cell.text : "";
    if (text.trim() === "") continue;
    // 测量用 opacity=1：只关心字形包围盒，几何与最终渲染一致
    const plan = await layoutCaption(sharp, {
      text,
      font: style.font,
      color: style.textColor,
      opacity: 1,
      maxWidth: cell.w,
      maxHeight: cell.h,
      padding: style.padding,
      startFontSize: autoFontSize(cell.w, cell.h),
      // §2 的 cells[].fontSize 语义就是「覆盖自动字号」：优先该格指定值，其次 --font-size，最后自动档
      fontSize: cell.fontSize ?? style.fontSize,
    });
    if (plan.truncated && plan.lines.length > 0) truncated.push(cell.index);
    if (plan.lines.length === 0) continue;
    bars.push(
      barForCell(cell, plan, {
        position: cell.position ?? style.position,
        padding: style.padding,
        align: cell.align ?? "center",
      }),
    );
  }

  const pipeline = sharp(input).rotate();
  // rotate 先于 composite（sharp 固定管线顺序）；没有条可画时干脆不合成
  if (bars.length > 0) {
    const svg = buildCaptionSvg({ ...canvas, bars, ...style });
    pipeline.composite([{ input: Buffer.from(svg), left: 0, top: 0 }]);
  }
  const { data, info } = await encode(pipeline, format).toBuffer({ resolveWithObject: true });
  await writeFile(output, data);

  return {
    path: output,
    bytes: info.size,
    width: info.width,
    height: info.height,
    cells: cells.length,
    bars: bars.length,
    layout: "in-cell",
    // F7：每格字号是各自算出来的，报「最小值」冒充 fontSize 会骗到调用方（实测报 14、多数条画 26–34）。
    // 于是 minFontSize/maxFontSize 说清聚合口径，真实值一律看 fontSizePerCell。
    minFontSize: minFontSizeOf(bars),
    maxFontSize: maxFontSizeOf(bars),
    fontSizePerCell: bars.map((bar) => ({ index: bar.index, fontSize: bar.fontSize })),
    lines: bars.reduce((n, bar) => n + bar.lines.length, 0),
    truncated: truncated.length,
    truncatedCells: truncated,
    ...(bars.length === 0 ? { empty: true } : {}),
  };
}

function minFontSizeOf(bars) {
  if (bars.length === 0) return null;
  return bars.reduce((min, bar) => Math.min(min, bar.fontSize), bars[0].fontSize);
}

function maxFontSizeOf(bars) {
  if (bars.length === 0) return null;
  return bars.reduce((max, bar) => Math.max(max, bar.fontSize), bars[0].fontSize);
}

// 兜底版式：整图底部**向外扩**一条黑边，N 条字幕按 index 顺序逐行居中堆叠（输出图变高）
export async function renderFallback({ sharp, input, output, canvas, texts, style }) {
  const format = resolveImageFormat(output);
  const stack = await layoutFallbackStack(sharp, {
    texts,
    width: canvas.width,
    height: canvas.height,
    font: style.font,
    color: style.textColor,
    opacity: 1,
    padding: style.padding,
    fontSize: style.fontSize,
  });
  const lines = stack.blocks.flatMap((block) => block.lines);
  const barHeight = Math.max(1, Math.ceil(stack.barHeight));
  const truncatedBlocks = stack.blocks.filter((block) => block.overflow).length;

  // 一行都排不出来（字幕全空）时不外扩也不合成，只重编码，免得产出一条空白黑边
  if (lines.length === 0) {
    const { data, info } = await encode(sharp(input).rotate(), format).toBuffer({
      resolveWithObject: true,
    });
    await writeFile(output, data);
    return {
      path: output,
      bytes: info.size,
      width: info.width,
      height: info.height,
      cells: 0,
      captions: texts.length,
      bars: 0,
      layout: "fallback-bottom",
      // 一行都没画：字号一律 null，与 in-cell 的空产出同一口径
      minFontSize: null,
      maxFontSize: null,
      lines: 0,
      truncated: 0,
      empty: true,
    };
  }

  const bar = {
    x: 0,
    y: 0,
    width: canvas.width,
    height: barHeight,
    lines,
    fontSize: stack.fontSize,
    lineHeight: stack.lineHeight,
    padding: style.padding,
    align: "center",
  };
  const svg = buildCaptionSvg({
    width: canvas.width,
    height: barHeight,
    bars: [bar],
    font: style.font,
    textColor: style.textColor,
    opacity: style.opacity,
  });

  const pipeline = sharp(input)
    .rotate()
    // jpeg 没有 alpha 通道，扩展条直接铺实黑；png/webp 铺透明底再由半透明 rect 覆盖，
    // 拿到用户要的「半透明黑底」而不是整块死黑
    .extend({
      bottom: barHeight,
      background:
        format === "jpeg" ? { r: 0, g: 0, b: 0, alpha: 1 } : { r: 0, g: 0, b: 0, alpha: 0 },
    });
  // 扩展条只有 canvas.width × barHeight，落在新画布底部，不会比底图更大
  pipeline.composite([{ input: Buffer.from(svg), left: 0, top: canvas.height }]);
  const { data, info } = await encode(pipeline, format).toBuffer({ resolveWithObject: true });
  await writeFile(output, data);

  return {
    path: output,
    bytes: info.size,
    width: info.width,
    height: info.height,
    originalHeight: canvas.height,
    cells: 0,
    captions: texts.length,
    bars: 1,
    layout: "fallback-bottom",
    // 兜底版式整条只有一个字号：min 与 max 同值，字段名与 in-cell 保持一致
    minFontSize: stack.fontSize,
    maxFontSize: stack.fontSize,
    lines: lines.length,
    truncated: truncatedBlocks,
  };
}
