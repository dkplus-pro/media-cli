import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { cliError } from "./errors.mjs";
import { defaultSidecar, enumerateInputs } from "./files.mjs";

function invalid(option, expected, raw) {
  return cliError("E_INVALID_OPTION", `${option} ${expected}，得到：${raw}`, {
    option,
    value: raw,
  });
}

export function parseIntIn(option, raw, min, max, fallback) {
  if (raw === undefined) return fallback;
  const n = Math.round(Number(raw));
  if (!Number.isInteger(n) || n < min || n > max) {
    throw invalid(option, `必须是 ${min}-${max} 的整数`, raw);
  }
  return n;
}

export function parseOneOf(option, raw, allowed, fallback) {
  if (raw === undefined) return fallback;
  if (typeof raw !== "string" || !allowed.includes(raw)) {
    throw invalid(option, `仅支持 ${allowed.join("|")}`, raw);
  }
  return raw;
}

export function parseBitrate(option, raw, fallback) {
  if (raw === undefined) return fallback;
  if (typeof raw !== "string" || !/^[1-9]\d{0,3}k?$/.test(raw)) {
    throw invalid(option, "格式非法（如 128k）", raw);
  }
  return raw;
}

export function savedPercent(before, after) {
  return before > 0 ? Math.round(((before - after) / before) * 1000) / 10 : 0;
}

// A/V 压缩共享批量骨架（单文件/文件夹批量）；插件自包含，与 media-image 的 runBatch 同型。
// outputExt(file) 返回该文件输出扩展名；one(input, output) 处理单文件并 return 数据。
export async function runCompressBatch(ctx, args, { exts, defaultDirName, outputExt, one }) {
  if (!args.input) {
    throw cliError("E_MISSING_ARGUMENT", "缺少必填 --input", { option: "--input" });
  }
  let info;
  try {
    info = statSync(args.input);
  } catch {
    throw cliError("E_MISSING_ARGUMENT", `输入不存在：${args.input}`, {
      option: "--input",
      value: args.input,
    });
  }
  if (!info.isFile() && !info.isDirectory()) {
    throw cliError("E_INVALID_OPTION", `输入既不是文件也不是目录：${args.input}`, {
      option: "--input",
      value: args.input,
    });
  }
  const isDirectory = info.isDirectory();

  // A/V 压缩是流式写文件，无法像图片一样先缓冲再比较，原地覆盖有损毁风险，一律拒绝
  const inputAbs = path.resolve(ctx.cwd, args.input);
  const outputDir = isDirectory ? path.resolve(ctx.cwd, args.output ?? defaultDirName) : null;
  if (outputDir !== null && outputDir === inputAbs) {
    throw cliError(
      "E_INVALID_OPTION",
      "输出目录与输入目录相同（压缩不能原地覆盖，请另指定 --output）",
      {
        option: "--output",
        value: args.output,
      },
    );
  }
  // 默认输出目录落在输入目录内时，枚举阶段排除，防止二次运行吃到上次产物
  const excludeUnder = outputDir?.startsWith(`${inputAbs}${path.sep}`) ? outputDir : null;

  const inputs = enumerateInputs(args.input, {
    exts,
    recursive: Boolean(args.recursive),
    excludeUnder,
  });
  if (inputs.length === 0) {
    throw cliError(
      "E_INVALID_OPTION",
      `输入目录中没有可处理的媒体文件（${exts.join(" ")}）：${args.input}`,
      { option: "--input", value: args.input },
    );
  }

  if (!isDirectory) {
    const output = args.output
      ? path.resolve(ctx.cwd, args.output)
      : defaultSidecar(args.input, "min", outputExt(args.input));
    if (path.resolve(output) === inputAbs) {
      throw cliError(
        "E_INVALID_OPTION",
        "输出路径与输入相同（压缩不能原地覆盖，请另指定 --output）",
        {
          option: "--output",
          value: args.output,
        },
      );
    }
    return { path: output, ...(await one(args.input, output)) };
  }

  const results = [];
  const failed = [];
  for (const { path: file, relative } of inputs) {
    const target = path.join(outputDir, relative.replace(/\.[^.]+$/, outputExt(file)));
    try {
      mkdirSync(path.dirname(target), { recursive: true });
      const data = await one(file, target);
      results.push({ path: target, ...data });
      ctx.logger.info(`已处理 ${relative} → ${target}`);
    } catch (err) {
      failed.push({ file, reason: err?.message ?? String(err) });
    }
  }
  if (results.length === 0) {
    throw cliError("E_PROVIDER_ERROR", "全部媒体处理失败", { failed });
  }
  return { outputDir, results, failed, total: inputs.length };
}

// 文件夹模式汇总节省字节（跳过项按原大小计）
export function sumSaved(results) {
  let bytesBefore = 0;
  let bytesAfter = 0;
  for (const r of results) {
    bytesBefore += r.bytesBefore;
    bytesAfter += r.bytesAfter;
  }
  return { bytesBefore, bytesAfter, savedBytes: bytesBefore - bytesAfter };
}
