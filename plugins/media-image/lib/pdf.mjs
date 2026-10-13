import { cliError } from "./errors.mjs";

// 固定页面尺寸（pt，1pt = 1/72 英寸），竖向 [宽, 高]；横向由 orientation 推导
export const PAGE_SIZES = {
  a4: [595.28, 841.89],
  letter: [612, 792],
};

let pdfLibPromise;

// 懒加载 pdf-lib：只在真正合并时引入，不拖慢其他命令启动
export async function loadPdfLib() {
  if (!pdfLibPromise) {
    pdfLibPromise = import("pdf-lib").catch((err) => {
      pdfLibPromise = undefined;
      throw cliError("E_MISSING_DEPENDENCY", `pdf-lib 加载失败：${err?.message ?? err}`, {
        dependency: "pdf-lib",
        hint: "重新安装：npm i -g @dkplus/media-cli（或在本仓库 pnpm install）",
      });
    });
  }
  return pdfLibPromise;
}

const round2 = (n) => Math.round(n * 100) / 100;

// 页面几何：page=image 时页面即图片按 dpi 换算的尺寸（满幅）；固定尺寸时等比缩放居中，
// orientation=auto 依图片横竖自动翻转为横向页
export function pageGeometry({ imageWidth, imageHeight, page, dpi, margin, orientation }) {
  if (page === "image") {
    const pageWidth = round2((imageWidth * 72) / dpi);
    const pageHeight = round2((imageHeight * 72) / dpi);
    return {
      pageWidth,
      pageHeight,
      drawX: 0,
      drawY: 0,
      drawWidth: pageWidth,
      drawHeight: pageHeight,
    };
  }
  const [shortSide, longSide] = PAGE_SIZES[page];
  const landscape =
    orientation === "landscape" || (orientation === "auto" && imageWidth > imageHeight);
  const pageWidth = landscape ? longSide : shortSide;
  const pageHeight = landscape ? shortSide : longSide;
  const availW = pageWidth - margin * 2;
  const availH = pageHeight - margin * 2;
  if (availW <= 0 || availH <= 0) {
    throw cliError("E_INVALID_OPTION", `--margin ${margin} 使页面 ${page} 无可用绘图区域`, {
      option: "--margin",
      value: margin,
      hint: `页面短边 ${round2(shortSide)}pt，margin 需小于其一半`,
    });
  }
  const scale = Math.min(availW / imageWidth, availH / imageHeight);
  const drawWidth = round2(imageWidth * scale);
  const drawHeight = round2(imageHeight * scale);
  return {
    pageWidth: round2(pageWidth),
    pageHeight: round2(pageHeight),
    drawX: round2((pageWidth - drawWidth) / 2),
    drawY: round2((pageHeight - drawHeight) / 2),
    drawWidth,
    drawHeight,
  };
}

// 逐页解码：按 EXIF 方向摆正后统一转码；jpeg 路径把透明像素压白底（PDF 页不透明，避免黑块）
export async function encodePageImage(sharp, file, { imageFormat, quality }) {
  const base = sharp(file, { failOn: "error" }).rotate();
  if (imageFormat === "png") {
    const { data, info } = await base
      .toFormat("png", { compressionLevel: 9 })
      .toBuffer({ resolveWithObject: true });
    return { bytes: data, width: info.width, height: info.height };
  }
  const { data, info } = await base
    .flatten({ background: "#ffffff" })
    .toFormat("jpeg", { quality, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return { bytes: data, width: info.width, height: info.height };
}

// pages 为「已解码字节 + 页面几何」列表：逐页嵌入并按顺序落页，返回 PDF 字节
export async function savePdf(PDFDocument, pages) {
  const doc = await PDFDocument.create();
  doc.setProducer("media-cli");
  for (const { bytes, imageFormat, ...geometry } of pages) {
    const image = imageFormat === "png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    const sheet = doc.addPage([geometry.pageWidth, geometry.pageHeight]);
    sheet.drawImage(image, {
      x: geometry.drawX,
      y: geometry.drawY,
      width: geometry.drawWidth,
      height: geometry.drawHeight,
    });
  }
  return doc.save();
}
