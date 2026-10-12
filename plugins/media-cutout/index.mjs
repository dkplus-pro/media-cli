import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { resolveCutoutBin, resolvePartCropBin } from "./lib/config.mjs";
import { cliError } from "./lib/errors.mjs";
import { enumerateInputs } from "./lib/files.mjs";
import { cropPartOne, cutoutOne, readPngSize } from "./lib/runner.mjs";

// 部位 → 中文含义（同时作为 --part 的合法值白名单）
const PARTS = {
  head: "人头（脸框向上含发际、向下到肩）",
  hat: "帽子（脸部上方区域）",
  top: "上半身衣服（肩到腰）",
  bottom: "下半身衣服（腰到脚踝）",
  outfit: "上下衣服搭配（肩到脚踝）",
  gloves: "手袜（手腕向外的手部区域）",
  shoes: "鞋子（脚踝到画面底部）",
  socks: "袜子（小腿到脚踝）",
};

function clampPadding(raw, fallback) {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw cliError("E_INVALID_OPTION", `--padding 必须是非负数字，得到：${raw}`, {
      option: "--padding",
      value: raw,
    });
  }
  return Math.round(n);
}

function collectInputs(input, { recursive }) {
  let inputStat;
  try {
    inputStat = statSync(input);
  } catch {
    throw cliError("E_MISSING_ARGUMENT", `输入不存在：${input}`, {
      option: "--input",
      value: input,
    });
  }
  const inputs = enumerateInputs(input, { recursive });
  if (inputs.length === 0) {
    throw cliError(
      "E_INVALID_OPTION",
      `输入目录中没有可处理的图片（jpg/jpeg/png/webp）：${input}`,
      {
        option: "--input",
        value: input,
      },
    );
  }
  return { isDirectory: inputStat.isDirectory(), inputs };
}

async function cutout(ctx, args) {
  if (!args.input) {
    throw cliError("E_MISSING_ARGUMENT", "缺少必填 --input", { option: "--input" });
  }
  const padding = clampPadding(args.padding, 32);
  const crop = args.crop !== false; // --no-crop → crop === false

  // 引擎解析先于输入探测（错误分支可无条件测 E_MISSING_DEPENDENCY）
  const bin = await resolveCutoutBin();
  const { isDirectory, inputs } = collectInputs(args.input, {
    recursive: Boolean(args.recursive),
  });

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

async function cropPart(ctx, args) {
  if (!args.input) {
    throw cliError("E_MISSING_ARGUMENT", "缺少必填 --input", { option: "--input" });
  }
  if (!args.part) {
    throw cliError("E_MISSING_ARGUMENT", `缺少必填 --part（${Object.keys(PARTS).join("|")}）`, {
      option: "--part",
    });
  }
  if (!Object.hasOwn(PARTS, args.part)) {
    throw cliError("E_INVALID_OPTION", `不支持的部位：${args.part}`, {
      option: "--part",
      value: args.part,
      allowed: Object.keys(PARTS),
    });
  }
  const part = args.part;
  const padding = clampPadding(args.padding, 0);

  const bin = await resolvePartCropBin();
  const { isDirectory, inputs } = collectInputs(args.input, {
    recursive: Boolean(args.recursive),
  });

  if (isDirectory) {
    const outputDir = path.resolve(ctx.cwd, args.output ?? `cut-${part}`);
    const results = [];
    const failed = [];
    for (const { path: file, relative } of inputs) {
      const target = path.join(outputDir, relative.replace(/\.(jpe?g|png|webp)$/i, ".png"));
      try {
        mkdirSync(path.dirname(target), { recursive: true });
        await cropPartOne(bin, { input: file, output: target, part, padding });
        const size = readPngSize(target);
        results.push({ path: target, part, width: size.width, height: size.height, padding });
        ctx.logger.info(`已处理 ${relative} → ${target}`);
      } catch (err) {
        failed.push({ file, reason: err?.message ?? String(err) });
      }
    }
    if (results.length === 0) {
      throw cliError("E_PROVIDER_ERROR", `全部图片都没有匹配到 ${part}（${PARTS[part]}）`, {
        failed,
      });
    }
    return { part, outputDir, results, failed, total: inputs.length };
  }

  const output = args.output
    ? path.resolve(ctx.cwd, args.output)
    : `${args.input.replace(/\.(jpe?g|png|webp)$/i, "")}-${part}.png`;
  await cropPartOne(bin, { input: args.input, output, part, padding });
  const size = readPngSize(output);
  return { path: output, part, width: size.width, height: size.height, padding };
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
    {
      name: "media-cut-part",
      description:
        "人体部位裁剪（macOS Vision）：只裁出人头/帽子/上半身/下半身/搭配/手袜/鞋子/袜子，产透明 PNG",
      options: [
        { flags: "--input <path>", description: "图片文件或文件夹（文件夹支持批量）" },
        { flags: "--part <part>", description: `部位：${Object.keys(PARTS).join("|")}` },
        {
          flags: "--output <path>",
          description: "输出文件/目录（单文件默认 <input>-<part>.png，文件夹默认 ./cut-<part>）",
        },
        { flags: "--padding <px>", description: "部位边距像素（默认 0）" },
        { flags: "--recursive", description: "文件夹输入时递归子目录（默认仅一级）" },
      ],
      handler: cropPart,
    },
  ],
};
