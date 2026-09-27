import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { compressOne } from "./lib/compress.mjs";
import { cliError } from "./lib/errors.mjs";
import { defaultSidecar, enumerateInputs } from "./lib/files.mjs";
import { SUPPORTED_EXTENSIONS } from "./lib/format.mjs";
import {
  parseAngle,
  parseColor,
  parseFontSize,
  parseOpacity,
  parseQuality,
  parseSpacing,
  parseText,
} from "./lib/options.mjs";
import { loadSharp } from "./lib/sharp.mjs";
import { createWatermarker } from "./lib/watermark.mjs";

function resolveInput(input) {
  if (!input) {
    throw cliError("E_MISSING_ARGUMENT", "缺少必填 --input", { option: "--input" });
  }
  let info;
  try {
    info = statSync(input);
  } catch {
    throw cliError("E_MISSING_ARGUMENT", `输入不存在：${input}`, {
      option: "--input",
      value: input,
    });
  }
  if (!info.isFile() && !info.isDirectory()) {
    throw cliError("E_INVALID_OPTION", `输入既不是文件也不是目录：${input}`, {
      option: "--input",
      value: input,
    });
  }
  return info.isDirectory();
}

// 两个命令共享的批量骨架：单文件直接处理，文件夹逐张处理（单张失败不中断，记入 failed）
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

async function compress(ctx, args) {
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

async function watermark(ctx, args) {
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

export default {
  name: "media-image",
  version: "0.1.0",
  commands: [
    {
      name: "media-compress",
      description: "压缩图片体积（不改变分辨率、不转格式），支持文件与文件夹批量",
      options: [
        { flags: "--input <path>", description: "图片文件或文件夹（jpg/jpeg/png/webp）" },
        {
          flags: "--output <path>",
          description: "输出文件/目录（单文件默认 <name>.min.<ext>，文件夹默认 ./min）",
        },
        {
          flags: "--quality <1-100>",
          description: "有损格式质量（默认 80；PNG 为无损优化不受影响）",
        },
        { flags: "--recursive", description: "文件夹输入时递归子目录（默认仅一级）" },
      ],
      handler: compress,
    },
    {
      name: "media-watermark",
      description:
        "图片平铺斜角文字水印（默认 30°），支持字体/文案/间距/透明度/字号/颜色，支持文件与文件夹批量",
      options: [
        { flags: "--input <path>", description: "图片文件或文件夹（jpg/jpeg/png/webp）" },
        { flags: "--text <text>", description: "水印文案（必填）" },
        {
          flags: "--font <family>",
          description: "字体族（默认 sans-serif，由系统 fontconfig 解析）",
        },
        { flags: "--angle <deg>", description: "旋转角度，-360~360（默认 30）" },
        { flags: "--spacing <px>", description: "相邻水印间距像素（默认 80）" },
        { flags: "--opacity <0-1>", description: "透明度 (0, 1]（默认 0.3）" },
        { flags: "--font-size <px>", description: "字号像素（默认按图片最短边自适应）" },
        { flags: "--color <color>", description: "文字颜色（默认 #ffffff）" },
        {
          flags: "--output <path>",
          description: "输出文件/目录（单文件默认 <name>.watermark.<ext>，文件夹默认 ./watermark）",
        },
        { flags: "--recursive", description: "文件夹输入时递归子目录（默认仅一级）" },
      ],
      handler: watermark,
    },
  ],
};
