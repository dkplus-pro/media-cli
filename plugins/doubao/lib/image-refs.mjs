import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { cliError } from "./errors.mjs";

// doubao-image-gen 的参考图（图生图）。Ark 与文生图共用 /images/generations 端点，
// 只靠请求体多一个 `image` 字段区分，实测形态（2026-10-18，doubao-seedream-4-5-251128）：
// 1. 公网 http(s) URL —— 服务端自己去下载，坏地址报 `Error while downloading ... connection refused`；
// 2. `data:image/<mime>;base64,` —— **被真实消费**：854KB JPEG 内联后出图的主体/构图都跟着参考图，
//    不是静默忽略 → 本地文件不用先上 CDN；
// 3. 以上两者的数组（多参考图）—— 数组元素同样逐个按 data URI 解码（坏 base64 报 `image parse failed`）。
// 张数与格式取自官方「图片生成 API」文档（Seedream 4.5 最多 14 张参考图；单张 ≤30MB；
// 格式 jpeg/png/webp/bmp/tiff/gif/heic/heif），其中 14 张已实测（16 张报
// `number of reference images cannot exceed 14`）；**内联只有 JPEG 实跑过 200**，
// 其余格式是文档口径、未逐一实测。
const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

export const MAX_REFS = 14;
// 官方文档的单张参考图大小上限。超了先本地拒：base64 还要再胀 4/3，别把几十 MB 塞进请求体
export const MAX_REF_BYTES = 30 * 1024 * 1024;

// 带 scheme 的入参一律本地拒（file://、ftp://、data:…）：不做「猜成本地路径」的臆断
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

// data URI 摘要用。base64 原文绝不能进 stdout：既灌爆输出，也把参考图像素带进命令结果
const DATA_URI_RE = /^data:([^;,]+);base64,(.+)$/s;

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// 本地文件 → data URI（mime 按扩展名；白名单外的一律本地拒）
async function toDataUri(localPath) {
  const info = await stat(localPath).catch(() => null);
  if (!info?.isFile()) {
    throw cliError("E_MISSING_ARGUMENT", `参考图文件不存在：${localPath}`, {
      option: "--ref",
      value: localPath,
    });
  }
  if (info.size > MAX_REF_BYTES) {
    throw cliError(
      "E_INVALID_OPTION",
      `参考图超过 provider 单张上限 30MB：${localPath}（${info.size} 字节）`,
      { option: "--ref", value: localPath, bytes: info.size, maxBytes: MAX_REF_BYTES },
    );
  }
  const mime = MIME_BY_EXT[path.extname(localPath).toLowerCase()];
  if (mime === undefined) {
    throw cliError(
      "E_INVALID_OPTION",
      `参考图格式不支持：${localPath}（仅 ${Object.keys(MIME_BY_EXT).join("/")}；其他扩展名对 Ark 未实测，不猜）`,
      { option: "--ref", value: localPath },
    );
  }
  const buf = await readFile(localPath);
  return `data:${mime};base64,${buf.toString("base64")}`;
}

// 单个参考项：http(s) 原样透传，其他 scheme 拒绝，其余按本地路径（相对 ctx.cwd）内联成 data URI
async function resolveRef(value, cwd) {
  if (isHttpUrl(value)) return value;
  // 手工拼的 data URI 也能被 Ark 消费，但塞进 argv 既不可读也没法核对来源，
  // 统一要求走本地文件路径（同一份字节，摘要与体积都由插件负责）
  if (/^data:/i.test(value)) {
    throw cliError(
      "E_INVALID_OPTION",
      `--ref 不接受直接传 data URI：请改传本地文件路径，插件会读成 data:image/...;base64, 内联`,
      { option: "--ref", value: value.slice(0, 64) },
    );
  }
  if (SCHEME_RE.test(value)) {
    throw cliError("E_INVALID_OPTION", `--ref 只支持本地文件或 http(s) URL，得到：${value}`, {
      option: "--ref",
      value,
    });
  }
  return toDataUri(path.resolve(cwd, value));
}

// 空数组 = 文生图（调用方据此决定要不要往请求体里放 image 字段）
export async function resolveRefs(values, cwd) {
  const list = values === undefined ? [] : Array.isArray(values) ? values : [values];
  const trimmed = list.map((v) => String(v).trim()).filter((v) => v !== "");
  if (trimmed.length === 0) return [];
  if (trimmed.length > MAX_REFS) {
    throw cliError(
      "E_INVALID_OPTION",
      `--ref 最多 ${MAX_REFS} 张参考图，得到 ${trimmed.length} 张（provider 实测报 "number of reference images cannot exceed ${MAX_REFS}"）`,
      { option: "--ref", value: trimmed.length, max: MAX_REFS },
    );
  }
  return Promise.all(trimmed.map((v) => resolveRef(v, cwd)));
}

// data URI → `data:<mime>;base64,<N> bytes`（N 为解码后字节数）；URL 原样回显
export function summarizeRef(value) {
  const match = DATA_URI_RE.exec(value);
  if (match === null) return value;
  return `data:${match[1]};base64,${Buffer.from(match[2], "base64").length} bytes`;
}

export function summarizeRefs(values) {
  return values.map(summarizeRef);
}
