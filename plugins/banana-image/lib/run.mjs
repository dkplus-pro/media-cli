import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { generateImage } from "./client.mjs";
import { loadConfig, QUALITIES } from "./env.mjs";
import { cliError } from "./errors.mjs";
import { parseSize } from "./size.mjs";

// edits 端点仅接受 image/jpeg、image/png、image/webp
const MIME_BY_EXT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const EXT_BY_FORMAT = { png: "png", jpeg: "jpeg", webp: "webp" };

async function readRefs(refPaths) {
  const refs = [];
  for (const refPath of refPaths) {
    const info = await stat(refPath).catch(() => null);
    if (!info?.isFile()) {
      throw cliError("E_MISSING_ARGUMENT", `参考图不存在：${refPath}`, {
        option: "--ref",
        value: refPath,
      });
    }
    const mime = MIME_BY_EXT[path.extname(refPath).toLowerCase()];
    if (mime === undefined) {
      throw cliError("E_INVALID_OPTION", `参考图格式不支持：${refPath}（仅 jpg/jpeg/png/webp）`, {
        option: "--ref",
        value: refPath,
      });
    }
    refs.push({ data: await readFile(refPath), name: path.basename(refPath), mime });
  }
  return refs;
}

export async function run(ctx, args) {
  if (typeof args.prompt !== "string" || args.prompt.trim() === "") {
    throw cliError("E_MISSING_ARGUMENT", "缺少必填 --prompt", { option: "--prompt" });
  }
  const size = parseSize(args.size ?? "1024x1024");
  // 参考图读取先于配置与网络：本地校验失败不产生任何请求
  const refs = args.ref === undefined ? [] : await readRefs(args.ref);

  const config = loadConfig();
  const quality = args.quality ?? config.quality;
  if (!QUALITIES.includes(quality)) {
    throw cliError("E_INVALID_OPTION", `--quality 仅支持 ${QUALITIES.join("|")}`, {
      option: "--quality",
      value: quality,
    });
  }
  const model = (args.model ?? "").trim() || config.model;

  const result = await generateImage(config, { prompt: args.prompt, size, quality, refs });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const output = path.resolve(
    ctx.cwd,
    args.output ?? `banana-${stamp}.${EXT_BY_FORMAT[config.outputFormat]}`,
  );
  const parent = await stat(path.dirname(output)).catch(() => null);
  if (!parent?.isDirectory()) {
    throw cliError("E_INVALID_OPTION", `输出目录不存在：${path.dirname(output)}`, {
      option: "--output",
      value: output,
    });
  }
  await writeFile(output, result.buf);
  ctx.logger.info(`已写入 ${output}`);

  // 网关可能按自身档位出图：契约以真实像素为准，偏差给结构化警告
  const meta = await sharp(result.buf)
    .metadata()
    .catch(() => ({}));
  const actual =
    typeof meta.width === "number" && typeof meta.height === "number"
      ? `${meta.width}x${meta.height}`
      : undefined;
  if (size !== "auto" && actual !== undefined && actual !== size) {
    ctx.warnings.add({
      code: "E_SIZE_MISMATCH",
      message: `模型未按请求尺寸出图：请求 ${size}，实际 ${actual}`,
      plugin: "banana-image",
    });
  }

  return {
    path: output,
    bytes: result.buf.length,
    format: meta.format ?? config.outputFormat,
    size: actual ?? size,
    requestedSize: size,
    model,
    quality,
    qualityDefault: config.quality,
    ...(result.revisedPrompt !== undefined ? { revisedPrompt: result.revisedPrompt } : {}),
    ...(result.sourceUrl !== undefined ? { sourceUrl: result.sourceUrl } : {}),
  };
}
