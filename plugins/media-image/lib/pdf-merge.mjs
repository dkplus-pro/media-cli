import { mkdirSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { cliError } from "./errors.mjs";
import { enumerateInputs, resolveInput } from "./files.mjs";
import { SUPPORTED_EXTENSIONS } from "./format.mjs";
import { sortInputs } from "./natural-order.mjs";
import { encodePageImage, loadPdfLib, pageGeometry, savePdf } from "./pdf.mjs";
import { loadSharp } from "./sharp.mjs";

// 默认输出：<单文件同名>.pdf 落在原文件旁；<目录名>.pdf 落在 cwd
function defaultOutput(input, isDirectory) {
  if (!isDirectory) {
    const ext = path.extname(input);
    return `${input.slice(0, input.length - ext.length)}.pdf`;
  }
  const name = path.basename(path.resolve(input));
  return `${name || "merged"}.pdf`;
}

function resolveOutput(ctx, args, isDirectory) {
  const output = path.resolve(ctx.cwd, args.output ?? defaultOutput(args.input, isDirectory));
  if (!output.toLowerCase().endsWith(".pdf")) {
    throw cliError("E_INVALID_OPTION", `--output 必须是 .pdf 文件路径：${args.output}`, {
      option: "--output",
      value: args.output,
    });
  }
  let info;
  try {
    info = statSync(output);
  } catch {
    info = undefined;
  }
  if (info?.isDirectory()) {
    throw cliError("E_INVALID_OPTION", `--output 是目录，需要 .pdf 文件路径：${output}`, {
      option: "--output",
      value: args.output ?? output,
    });
  }
  return output;
}

// 图片 → 单个 PDF：整目录合成为多页文档，页面顺序默认按文件名自然序
export async function mergeToPdf(ctx, args) {
  const isDirectory = resolveInput(args.input);
  const inputs = enumerateInputs(args.input, { recursive: Boolean(args.recursive) });
  if (inputs.length === 0) {
    throw cliError(
      "E_INVALID_OPTION",
      `输入目录中没有可处理的图片（${SUPPORTED_EXTENSIONS.join("/")}）：${args.input}`,
      { option: "--input", value: args.input },
    );
  }
  const ordered = sortInputs(inputs, args.order);
  const output = resolveOutput(ctx, args, isDirectory);

  const [sharp, pdfLib] = await Promise.all([loadSharp(), loadPdfLib()]);
  const { PDFDocument } = pdfLib;
  const pages = [];
  const items = [];
  const skipped = [];

  for (const source of ordered) {
    let encoded;
    try {
      encoded = await encodePageImage(sharp, source.path, {
        imageFormat: args.imageFormat,
        quality: args.quality,
      });
    } catch (err) {
      if (!args.skipBroken) {
        throw cliError("E_PROVIDER_ERROR", `图片解码失败：${source.relative}`, {
          source: "sharp",
          file: source.path,
          reason: err?.message ?? String(err),
        });
      }
      skipped.push({ file: source.path, reason: err?.message ?? String(err) });
      continue;
    }
    const margin = args.page === "image" ? 0 : args.margin;
    const geometry = pageGeometry({
      imageWidth: encoded.width,
      imageHeight: encoded.height,
      page: args.page,
      dpi: args.dpi,
      margin,
      orientation: args.orientation,
    });
    pages.push({ bytes: encoded.bytes, imageFormat: args.imageFormat, ...geometry });
    items.push({ file: source.path, width: encoded.width, height: encoded.height, ...geometry });
    ctx.logger.info(
      `已加入第 ${pages.length} 页 ${source.relative}（${encoded.width}x${encoded.height}）`,
    );
  }

  if (pages.length === 0) {
    throw cliError("E_PROVIDER_ERROR", "全部图片解码失败，未生成 PDF", { skipped });
  }

  let bytes;
  try {
    bytes = await savePdf(PDFDocument, pages);
  } catch (err) {
    throw cliError("E_PROVIDER_ERROR", `PDF 组装失败：${err?.message ?? err}`, {
      source: "pdf-lib",
      pageCount: pages.length,
    });
  }
  mkdirSync(path.dirname(output), { recursive: true });
  await writeFile(output, bytes);

  if (skipped.length > 0) {
    ctx.warnings.add({
      code: "E_PARTIAL_INPUT",
      message: `跳过 ${skipped.length} 张无法解码的图片，PDF 只含 ${pages.length} 页`,
      plugin: "media-image",
    });
  }

  return {
    output,
    pageCount: pages.length,
    bytes: bytes.length,
    order: args.order,
    page: args.page,
    dpi: args.dpi,
    margin: args.page === "image" ? 0 : args.margin,
    orientation: args.orientation,
    imageFormat: args.imageFormat,
    quality: args.imageFormat === "png" ? null : args.quality,
    items,
    ...(skipped.length > 0 ? { skipped } : {}),
  };
}
