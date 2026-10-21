import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { generateImage } from "./client.mjs";
import { loadConfig, MODERATIONS, QUALITIES } from "./env.mjs";
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

// 带 scheme 的入参一律本地拒。理由不是安全而是**可诊断性**：网关对非 http(s) 的字符串不走协议
// 分支、直接当 base64 解码，`file:///etc/passwd` 报的是 `base64 decode image[0]: illegal
// base64 data at input byte 4`，把人引到完全错误的排查方向上。
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// 参考图逐元素判定：http(s) URL 原样交给网关下载，本地文件读成 Buffer 待编码
async function resolveRefs(values) {
  const refs = [];
  for (const value of values) {
    if (isHttpUrl(value)) {
      refs.push({ kind: "url", url: value });
      continue;
    }
    if (SCHEME_RE.test(value)) {
      throw cliError(
        "E_INVALID_OPTION",
        `--ref 只接受本地文件路径或 http(s) URL：${value}（data URI 请改传本地路径，插件会内联）`,
        { option: "--ref", value },
      );
    }
    const info = await stat(value).catch(() => null);
    if (!info?.isFile()) {
      throw cliError("E_MISSING_ARGUMENT", `参考图不存在：${value}`, {
        option: "--ref",
        value,
      });
    }
    const mime = MIME_BY_EXT[path.extname(value).toLowerCase()];
    if (mime === undefined) {
      throw cliError("E_INVALID_OPTION", `参考图格式不支持：${value}（仅 jpg/jpeg/png/webp）`, {
        option: "--ref",
        value,
      });
    }
    refs.push({ kind: "file", data: await readFile(value), name: path.basename(value), mime });
  }
  return refs;
}

export async function run(ctx, args) {
  if (typeof args.prompt !== "string" || args.prompt.trim() === "") {
    throw cliError("E_MISSING_ARGUMENT", "缺少必填 --prompt", { option: "--prompt" });
  }
  const size = parseSize(args.size ?? "1024x1024");
  // 参考图读取先于配置与网络：本地校验失败不产生任何请求
  const refs = args.ref === undefined ? [] : await resolveRefs(args.ref);

  const config = loadConfig();
  const quality = args.quality ?? config.quality;
  if (!QUALITIES.includes(quality)) {
    throw cliError("E_INVALID_OPTION", `--quality 仅支持 ${QUALITIES.join("|")}`, {
      option: "--quality",
      value: quality,
    });
  }
  const model = (args.model ?? "").trim() || config.model;
  const moderation = args.moderation ?? config.moderation;
  if (!MODERATIONS.includes(moderation)) {
    throw cliError("E_INVALID_OPTION", `--moderation 仅支持 ${MODERATIONS.join("|")}`, {
      option: "--moderation",
      value: moderation,
    });
  }

  const result = await generateImage(config, {
    prompt: args.prompt,
    size,
    quality,
    moderation,
    refs,
  });

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
    moderation,
    ...(result.revisedPrompt !== undefined ? { revisedPrompt: result.revisedPrompt } : {}),
    ...(result.sourceUrl !== undefined ? { sourceUrl: result.sourceUrl } : {}),
  };
}
