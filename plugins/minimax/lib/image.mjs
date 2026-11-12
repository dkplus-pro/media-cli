import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { outputPathOf, writeOutput } from "./audio.mjs";
import { clipText, requestJson, scrubKey } from "./client.mjs";
import { DEFAULT_IMAGE_MODEL, loadConfig } from "./config.mjs";
import { cliError } from "./errors.mjs";
import { assertBodyBudget, buildImageBody, parseImageArgs } from "./image-params.mjs";

// minimax-image 主入口：POST /v1/images/generations（纯文生图）或 /v1/images/edits
// （带 --ref）。参数与请求体在 lib/image-params.mjs；本文件负责参考图内联、HTTP 编排、
// 响应取图、真实像素校验与落盘。所有本地校验先于 loadConfig()/fetch（失败不烧额度）。

const SOURCE = "minimax";
const CREATE_PATH = "/v1/images/generations";
const EDIT_PATH = "/v1/images/edits";
export const REF_MAX = 16;
export const MAX_REF_BYTES = 64 * 1024 * 1024;
const REF_MIME = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
};
const REF_MIN_EDGE = 128;
const REF_MAX_EDGE = 8192;
// provider：长边/短边 ≤ 4:1
const REF_MAX_ASPECT = 4;

function optionalText(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

// 本命令的错误码固定 E_PROVIDER_ERROR，details 统一带 source；细节由调用点补充
function providerError(message, details = {}) {
  return cliError("E_PROVIDER_ERROR", message, { source: SOURCE, ...details });
}

export function resolveImageModel(args = {}, config = {}) {
  return optionalText(args.model) ?? optionalText(config.imageModel) ?? DEFAULT_IMAGE_MODEL;
}

function isPassthrough(value) {
  if (/^mm_file:\/\//i.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function refList(values) {
  const raw = values === undefined ? [] : Array.isArray(values) ? values : [values];
  const list = raw.map((item) => String(item).trim()).filter((item) => item !== "");
  if (list.length === 0) {
    throw cliError("E_INVALID_OPTION", "--ref 至少需要 1 项", { option: "--ref" });
  }
  if (list.length > REF_MAX) {
    throw cliError("E_INVALID_OPTION", `--ref 最多 ${REF_MAX} 项，得到 ${list.length} 项`, {
      option: "--ref",
      value: list.length,
      max: REF_MAX,
    });
  }
  return list;
}

// heic/heif 在部分 sharp 构建里解不开：读不到元数据就跳过，不因此拒绝合法文件
async function assertRefShape(buf, value, option) {
  const meta = await sharp(buf)
    .metadata()
    .catch(() => null);
  if (typeof meta?.width !== "number" || typeof meta?.height !== "number") return;
  const { width, height } = meta;
  const outsideEdge =
    width < REF_MIN_EDGE || width > REF_MAX_EDGE || height < REF_MIN_EDGE || height > REF_MAX_EDGE;
  if (outsideEdge) {
    throw cliError(
      "E_INVALID_OPTION",
      `${option} 图片尺寸超出 provider 区间：${value} 是 ${width}x${height}，要求每边 [${REF_MIN_EDGE}, ${REF_MAX_EDGE}] px`,
      { option, value, width, height, minEdge: REF_MIN_EDGE, maxEdge: REF_MAX_EDGE },
    );
  }
  const longSide = Math.max(width, height);
  const shortSide = Math.min(width, height);
  if (longSide > shortSide * REF_MAX_ASPECT) {
    throw cliError(
      "E_INVALID_OPTION",
      `${option} 图片宽高比 ${(longSide / shortSide).toFixed(2)}:1 超出 4:1 上限：${value}（${width}x${height}）`,
      { option, value, width, height, maxAspect: REF_MAX_ASPECT },
    );
  }
}

async function resolveRefOne(value, cwd, option) {
  if (isPassthrough(value)) return { url: value, summary: value, bytes: 0 };
  if (/^data:/i.test(value)) {
    throw cliError(
      "E_INVALID_OPTION",
      `${option} 不接受直接传 data URI：请改传本地文件路径，插件会读成 base64 内联`,
      { option, value: value.slice(0, 64) },
    );
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    throw cliError(
      "E_INVALID_OPTION",
      `${option} 只支持本地文件、http(s) 与 mm_file://：${value}`,
      {
        option,
        value,
      },
    );
  }

  const localPath = path.resolve(cwd, value);
  const info = await stat(localPath).catch(() => null);
  if (!info?.isFile()) {
    throw cliError("E_MISSING_ARGUMENT", `${option} 文件不存在：${value}`, { option, value });
  }
  const mime = REF_MIME[path.extname(localPath).toLowerCase()];
  if (mime === undefined) {
    const allowed = Object.keys(REF_MIME).join("/");
    throw cliError(
      "E_INVALID_OPTION",
      `${option} 图片格式不支持：${value}（provider 只收 ${allowed}）`,
      { option, value, allowed },
    );
  }
  if (info.size > MAX_REF_BYTES) {
    throw cliError(
      "E_INVALID_OPTION",
      `${option} 单文件超过 provider 上限：${value}（${info.size} 字节 > ${MAX_REF_BYTES}；大文件请改传公网 URL 或 mm_file://）`,
      { option, value, bytes: info.size, maxBytes: MAX_REF_BYTES },
    );
  }
  const buf = await readFile(localPath);
  await assertRefShape(buf, value, option);
  return {
    url: `data:${mime};base64,${buf.toString("base64")}`,
    summary: `data:${mime};base64,${buf.length} bytes`,
    bytes: buf.length,
  };
}

// --ref 1..16 项：URL/mm_file 透传，本地文件读成 data URI；先验张数再读盘
export async function resolveImageRefs(values, cwd, option = "--ref") {
  const list = refList(values);
  const resolved = [];
  let inlinedBytes = 0;
  for (const value of list) {
    const item = await resolveRefOne(value, cwd, option);
    inlinedBytes += item.bytes;
    // 超预算立即失败：不把剩下的几十 MB 文件也读进来
    assertBodyBudget(inlinedBytes);
    resolved.push(item);
  }
  return resolved;
}

// 402 在 client.mjs 只摊平成通用 E_PROVIDER_ERROR：生图侧补上 insufficient_balance
async function postImages(config, options) {
  try {
    return await requestJson(config, { ...options, source: SOURCE });
  } catch (err) {
    if (err?.details?.status === 402) {
      const providerMessage =
        typeof err.details.providerMessage === "string" ? err.details.providerMessage : "";
      throw providerError(
        `MiniMax 账户余额不足（HTTP 402）${providerMessage === "" ? "" : `：${providerMessage}`}`,
        { ...err.details, reason: "insufficient_balance" },
      );
    }
    throw err;
  }
}

// 取 data[0]；单项失败（内容安全 1026/1027 等）可能伴随 HTTP 200
function imageItemOf(payload, config) {
  const items = Array.isArray(payload?.data) ? payload.data : [];
  const item = items[0];
  if (item === undefined || item === null) {
    throw providerError("MiniMax 生图响应缺少 data[0]", { reason: "no_image" });
  }
  const error = item.error;
  if (error !== undefined && error !== null) {
    const rawCode = typeof error === "object" ? error.code : undefined;
    const code = Number(rawCode);
    const rawMessage =
      typeof error === "string" ? error : typeof error?.message === "string" ? error.message : "";
    const message = clipText(scrubKey(rawMessage, config.apiKey));
    const safety = code === 1026 || code === 1027;
    throw providerError(
      `MiniMax 生图失败（code ${rawCode ?? "unknown"}）${message === "" ? "" : `：${message}`}`,
      {
        reason: safety ? "content_safety" : "image_failed",
        ...(rawCode === undefined ? {} : { imageErrorCode: rawCode }),
        ...(message === "" ? {} : { providerMessage: message }),
      },
    );
  }
  return item;
}

// 结果 URL 是 24h 过期直链：立即下载且不带 Authorization；b64_json 直接解码
async function downloadImage(config, item, timeoutMs) {
  const url = optionalText(item.url);
  if (url !== undefined) {
    const safeUrl = scrubKey(url, config.apiKey);
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
      const message = clipText(scrubKey(err?.message ?? err, config.apiKey));
      throw providerError(
        timedOut ? `MiniMax 图片下载超时（${timeoutMs}ms）` : `MiniMax 图片下载失败：${message}`,
        { reason: timedOut ? "timeout" : "network", url: safeUrl },
      );
    }
    if (!res.ok) {
      throw providerError(`MiniMax 图片下载失败（HTTP ${res.status}）`, {
        status: res.status,
        url: safeUrl,
      });
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) {
      throw providerError("MiniMax 图片下载结果为空", { reason: "empty_image", url: safeUrl });
    }
    return buf;
  }
  const b64 = optionalText(item.b64_json);
  if (b64 !== undefined) {
    const buf = Buffer.from(b64, "base64");
    if (buf.length === 0) {
      throw providerError("MiniMax 的 b64_json 解码结果为空", { reason: "empty_image" });
    }
    return buf;
  }
  throw providerError("MiniMax 生图响应缺少 url / b64_json", { reason: "no_image" });
}

async function actualSizeOf(buf) {
  const meta = await sharp(buf)
    .metadata()
    .catch(() => null);
  return typeof meta?.width === "number" && typeof meta?.height === "number"
    ? `${meta.width}x${meta.height}`
    : undefined;
}

export async function runImage(ctx, args) {
  // 先完成全部本地校验（含参考图读盘/形状检查），避免白烧额度
  const input = parseImageArgs(args);
  const refs = args.ref === undefined ? undefined : await resolveImageRefs(args.ref, ctx.cwd);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const defaultName = `minimax-image-${stamp}.${input.outputFormat}`;
  // 输出目录预检同样在网络之前
  await outputPathOf(ctx, args.output, defaultName);

  const config = loadConfig();
  const model = resolveImageModel(args, config);
  const payload = await postImages(config, {
    method: "POST",
    path: refs === undefined ? CREATE_PATH : EDIT_PATH,
    body: buildImageBody({ ...input, model }, refs),
    timeoutMs: input.timeoutMs,
  });

  const item = imageItemOf(payload, config);
  const buf = await downloadImage(config, item, input.timeoutMs);
  const output = await writeOutput(ctx, args.output, defaultName, buf);

  // 契约以真实像素为准：显式 WxH 有偏差给结构化警告；auto 直接回真实尺寸
  const actualSize = await actualSizeOf(buf);
  if (input.sizeMode === "explicit" && actualSize !== undefined && actualSize !== input.size) {
    ctx.warnings.add({
      code: "E_SIZE_MISMATCH",
      message: `模型未按请求尺寸出图：请求 ${input.size}，实际 ${actualSize}`,
      plugin: "minimax",
    });
  }
  const revisedPrompt = optionalText(item.revised_prompt);
  const fallbackSize = optionalText(item.size) ?? input.size;

  return {
    path: output,
    bytes: buf.length,
    model,
    size: actualSize ?? fallbackSize,
    ...(revisedPrompt === undefined ? {} : { revisedPrompt }),
    outputFormat: input.outputFormat,
    ...(refs === undefined ? {} : { refs: refs.map((ref) => ref.summary), refCount: refs.length }),
  };
}
