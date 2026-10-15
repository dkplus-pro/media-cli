import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { cliError } from "./errors.mjs";

// 参考图的两种形态（实测 2026-10-15，Qwen/Qwen-Image-Edit，走 modelscope-image 同一个网关）：
// 1. 公网 https URL —— gen/fast 一直支持；
// 2. `data:image/<mime>;base64,` data URI —— **同样被真实消费**：同一张源图分别以 URL 与
//    data URI 提交，data URI 那次出图的服装、徽记与五官都来自该参考图，不是被静默忽略。
//    → 本地文件不需要先跑 tencent-cos-upload 换 CDN，这是 edit 与 gen/fast 的关键差异。
// 张数上限 4（实测超出即在提交期被拒："image_url count 9 exceeds maximum limit of 4"）。
const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

// 带 scheme 的入参一律本地拒（file://、ftp://、data:…）：不做「猜成本地路径」的臆断
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

// data URI 摘要用。base64 原文绝不能进 stdout：既灌爆输出，也把参考图像素内容带进命令结果
const DATA_URI_RE = /^data:([^;,]+);base64,(.+)$/s;

export function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// 本地文件 → data URI（mime 按扩展名；白名单外的一律本地拒，其余格式对本网关未实测）
export async function toDataUri(localPath, option = "--ref") {
  const info = await stat(localPath).catch(() => null);
  if (!info?.isFile()) {
    throw cliError("E_MISSING_ARGUMENT", `参考图文件不存在：${localPath}`, {
      option,
      value: localPath,
    });
  }
  const mime = MIME_BY_EXT[path.extname(localPath).toLowerCase()];
  if (mime === undefined) {
    throw cliError(
      "E_INVALID_OPTION",
      `参考图格式不支持：${localPath}（仅 ${Object.keys(MIME_BY_EXT).join("/")}；其他扩展名对 ModelScope 网关未实测，不猜）`,
      { option, value: localPath },
    );
  }
  const buf = await readFile(localPath);
  return `data:${mime};base64,${buf.toString("base64")}`;
}

// 单个参考项：http(s) 原样透传，其他 scheme 拒绝，其余按本地路径（相对 ctx.cwd）内联成 data URI
export async function resolveRef(value, option, cwd) {
  if (isHttpUrl(value)) return value;
  // 手工拼的 data URI 也能被网关消费，但把它塞进 argv 既不可读也没法核对来源，
  // 统一要求走本地文件路径（同一份字节，摘要与体积都由插件负责）
  if (/^data:/i.test(value)) {
    throw cliError(
      "E_INVALID_OPTION",
      `${option} 不接受直接传 data URI：请改传本地文件路径，插件会读成 data:image/...;base64, 内联`,
      { option, value: value.slice(0, 64) },
    );
  }
  if (SCHEME_RE.test(value)) {
    throw cliError("E_INVALID_OPTION", `${option} 只支持本地文件或 http(s) URL，得到：${value}`, {
      option,
      value,
    });
  }
  return toDataUri(path.resolve(cwd, value), option);
}

// data URI → `data:<mime>;base64,<N> bytes`（N 为解码后的字节数，比 base64 字符数更直观）；
// 公网 URL 原样回显，所以 gen/fast 的 data.refUrls 语义不变
export function summarizeRef(value) {
  const match = DATA_URI_RE.exec(value);
  if (match === null) return value;
  return `data:${match[1]};base64,${Buffer.from(match[2], "base64").length} bytes`;
}

export function summarizeRefs(values) {
  return values.map(summarizeRef);
}
