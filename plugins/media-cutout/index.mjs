import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { resolveCutoutBin } from "./lib/config.mjs";
import { cliError } from "./lib/errors.mjs";
import { enumerateInputs } from "./lib/files.mjs";
import { cutoutOne, readPngSize } from "./lib/runner.mjs";

function clampPadding(raw) {
  if (raw === undefined) return 32;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw cliError("E_INVALID_OPTION", `--padding 必须是非负数字，得到：${raw}`, {
      option: "--padding",
      value: raw,
    });
  }
  return Math.round(n);
}

async function cutout(ctx, args) {
  if (!args.input) {
    throw cliError("E_MISSING_ARGUMENT", "缺少必填 --input", { option: "--input" });
  }
  const padding = clampPadding(args.padding);
  const crop = args.crop !== false; // --no-crop → crop === false

  // 引擎解析先于输入探测（错误分支可无条件测 E_MISSING_DEPENDENCY）
  const bin = await resolveCutoutBin();

  let inputStat;
  try {
    inputStat = statSync(args.input);
  } catch {
    throw cliError("E_MISSING_ARGUMENT", `输入不存在：${args.input}`, {
      option: "--input",
      value: args.input,
    });
  }
  const isDirectory = inputStat.isDirectory();

  const inputs = enumerateInputs(args.input, { recursive: Boolean(args.recursive) });
  if (inputs.length === 0) {
    throw cliError(
      "E_INVALID_OPTION",
      `输入目录中没有可处理的图片（jpg/jpeg/png/webp）：${args.input}`,
      {
        option: "--input",
        value: args.input,
      },
    );
  }

  if (isDirectory) {
    const outputDir = path.resolve(ctx.cwd, args.output ?? "cutout");
    const results = [];
    const failed = [];
    for (const { path: file, relative } of inputs) {
      const target = path.join(outputDir, relative.replace(/\.(jpe?g|png|webp)$/i, ".png"));
      try {
        mkdirSync(path.dirname(target), { recursive: true });
        await cutoutOne(bin, { input: file, output: target, padding: crop ? padding : -1 });
        const size = readPngSize(target);
        results.push({
          path: target,
          width: size.width,
          height: size.height,
          cropped: crop,
          padding: crop ? padding : 0,
        });
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

  // 单文件：默认旁路 <input>-cutout.png
  const output = args.output
    ? path.resolve(ctx.cwd, args.output)
    : `${args.input.replace(/\.(jpe?g|png|webp)$/i, "")}-cutout.png`;
  await cutoutOne(bin, { input: args.input, output, padding: crop ? padding : -1 });
  const size = readPngSize(output);
  return {
    path: output,
    width: size.width,
    height: size.height,
    cropped: crop,
    padding: crop ? padding : 0,
  };
}

export default {
  name: "media-cutout",
  version: "0.1.0",
  commands: [
    {
      name: "media-cutout",
      description: "本地抠图（macOS Vision）：去背景产透明 PNG，默认裁剪到主体并留边距",
      options: [
        { flags: "--input <path>", description: "图片文件或文件夹（文件夹支持批量）" },
        {
          flags: "--output <path>",
          description: "输出文件/目录（单文件默认 <input>-cutout.png，文件夹默认 ./cutout）",
        },
        { flags: "--padding <px>", description: "主体边距像素（默认 32，仅裁剪模式）" },
        { flags: "--no-crop", description: "不裁剪，保留原始画布尺寸" },
        { flags: "--recursive", description: "文件夹输入时递归子目录（默认仅一级）" },
      ],
      handler: cutout,
    },
  ],
};
