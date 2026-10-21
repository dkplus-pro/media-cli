import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { cliError } from "./errors.mjs";

// MiniMax H3 的多模态输入（/v2/video_generation 的 content[]，实测 2026-10-18）。
// 三种场景互斥：t2v（仅 text）/ i2v（first_frame|last_frame）/ r2v（reference_*）。
//
// **为什么张数与配对要在本地拦**：MiniMax 提交期只校验一部分规则，另一些要等任务跑起来才报，
// 于是「HTTP 200 + task_id + 随后 failed」成了常态。实测三条服务端**不拦**的：
//   1. 图片边长/宽高比（1x1 的图提交返回 200，任务里才报 `image size 1x1, expected each side in [256, 5760]`）
//   2. 只给 last_frame 不给 first_frame（文档写「需成对」，实测直接建任务）
//   3. 未知顶层字段（一律静默忽略）
// 而张数上限、帧角色与参考角色混用、text 数量/长度是提交期就 400 的（可免费量边界）。
const MEDIA_SPECS = [
  {
    arg: "firstFrame",
    option: "--first-frame",
    role: "first_frame",
    type: "image_url",
    urlKey: "image_url",
    kind: "image",
    max: 1,
  },
  {
    arg: "lastFrame",
    option: "--last-frame",
    role: "last_frame",
    type: "image_url",
    urlKey: "image_url",
    kind: "image",
    max: 1,
  },
  {
    arg: "refImage",
    option: "--ref-image",
    role: "reference_image",
    type: "image_url",
    urlKey: "image_url",
    kind: "image",
    max: 9,
  },
  {
    arg: "refVideo",
    option: "--ref-video",
    role: "reference_video",
    type: "video_url",
    urlKey: "video_url",
    kind: "video",
    max: 3,
  },
  {
    arg: "refAudio",
    option: "--ref-audio",
    role: "reference_audio",
    type: "audio_url",
    urlKey: "audio_url",
    kind: "audio",
    max: 3,
  },
];

// 官方媒体限制表：图片 6 种格式、视频 mp4/mov、音频 wav/mp3
const MIME_BY_KIND = {
  image: {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".heic": "image/heic",
    ".heif": "image/heif",
  },
  video: { ".mp4": "video/mp4", ".mov": "video/quicktime" },
  audio: { ".wav": "audio/wav", ".mp3": "audio/mpeg" },
};
const LIMITS = {
  image: {
    maxBytes: 30 * 1024 * 1024,
    minEdge: 256,
    maxEdge: 5760,
    minAspect: 0.4,
    maxAspect: 2.5,
  },
  video: { maxBytes: 50 * 1024 * 1024 },
  audio: { maxBytes: 15 * 1024 * 1024 },
};
// 请求体总大小 ≤64MB；base64 放大约 4/3，所以按解码字节数留好余量
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const BASE64_INFLATE = 4 / 3;

// 公网 URL 与 mm_file://{file_id} 原样透传（后者是引用平台已有文件，实测提交期被接受）
function isPassthrough(value) {
  if (/^mm_file:\/\//i.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function toList(value) {
  const raw = value === undefined ? [] : Array.isArray(value) ? value : [value];
  return raw.map((item) => String(item).trim()).filter((item) => item !== "");
}

// 图片边长与宽高比：服务端执行期才校验，这里提前拦。
// heic/heif 在部分 sharp 构建里解不开，读不到元数据就跳过（不因此拒绝一个合法文件）
async function assertImageShape(buf, value, option) {
  const meta = await sharp(buf)
    .metadata()
    .catch(() => null);
  if (typeof meta?.width !== "number" || typeof meta?.height !== "number") return;
  const { minEdge, maxEdge, minAspect, maxAspect } = LIMITS.image;
  const shortSide = Math.min(meta.width, meta.height);
  const longSide = Math.max(meta.width, meta.height);
  const aspect = meta.width / meta.height;
  if (shortSide < minEdge || longSide > maxEdge) {
    throw cliError(
      "E_INVALID_OPTION",
      `${option} 图片尺寸超出 provider 区间：${value} 是 ${meta.width}x${meta.height}，要求每边 [${minEdge}, ${maxEdge}] px（实测提交期不拦、任务里才失败）`,
      { option, value, width: meta.width, height: meta.height, minEdge, maxEdge },
    );
  }
  if (aspect < minAspect || aspect > maxAspect) {
    throw cliError(
      "E_INVALID_OPTION",
      `${option} 图片宽高比 ${aspect.toFixed(3)} 超出 [${minAspect}, ${maxAspect}]：${value}（${meta.width}x${meta.height}）`,
      { option, value, width: meta.width, height: meta.height, aspect, minAspect, maxAspect },
    );
  }
}

async function resolveLocal(value, kind, cwd, option) {
  const localPath = path.resolve(cwd, value);
  const info = await stat(localPath).catch(() => null);
  if (!info?.isFile()) {
    throw cliError("E_MISSING_ARGUMENT", `${option} 文件不存在：${value}`, { option, value });
  }
  const mime = MIME_BY_KIND[kind][path.extname(localPath).toLowerCase()];
  if (mime === undefined) {
    const allowed = Object.keys(MIME_BY_KIND[kind]).join("/");
    throw cliError(
      "E_INVALID_OPTION",
      `${option} 的${kind}格式不支持：${value}（provider 只收 ${allowed}）`,
      { option, value, kind, allowed },
    );
  }
  const maxBytes = LIMITS[kind].maxBytes;
  if (info.size > maxBytes) {
    throw cliError(
      "E_INVALID_OPTION",
      `${option} 单文件超过 provider 上限：${value}（${info.size} 字节 > ${maxBytes}；大文件请改传公网 URL 或 mm_file://）`,
      { option, value, bytes: info.size, maxBytes },
    );
  }
  const buf = await readFile(localPath);
  if (kind === "image") await assertImageShape(buf, value, option);
  return { url: `data:${mime};base64,${buf.toString("base64")}`, bytes: buf.length };
}

async function resolveOne(value, kind, cwd, option) {
  if (isPassthrough(value)) return { url: value, bytes: 0 };
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
  return resolveLocal(value, kind, cwd, option);
}

// data URI → `data:<mime>;base64,<N> bytes`；URL 原样回显（base64 绝不进 stdout）
export function summarizeMedia(url, bytes) {
  if (bytes === 0) return url;
  const mime = /^data:([^;,]+)/.exec(url)?.[1] ?? "media";
  return `data:${mime};base64,${bytes} bytes`;
}

function assertCombination(filled) {
  const hasFrame = filled.firstFrame.length > 0 || filled.lastFrame.length > 0;
  const hasReference =
    filled.refImage.length > 0 || filled.refVideo.length > 0 || filled.refAudio.length > 0;
  if (hasFrame && hasReference) {
    throw cliError(
      "E_INVALID_OPTION",
      "--first-frame/--last-frame（图生视频）与 --ref-image/--ref-video/--ref-audio（多模态参考）互斥，二选一（provider 原文：reference 场景不能混用 first_frame/last_frame）",
      { option: "--ref-image", reason: "frame_and_reference" },
    );
  }
  if (filled.lastFrame.length > 0 && filled.firstFrame.length === 0) {
    throw cliError(
      "E_INVALID_OPTION",
      "--last-frame 必须与 --first-frame 成对使用（文档要求，但 provider 提交期不校验，会白建一个任务）",
      { option: "--last-frame", reason: "last_frame_without_first" },
    );
  }
}

// 场景判定（同步、不读盘）：ratio 的合法取值取决于场景，而 ratio 校验发生在读文件之前
function modeOf(filled) {
  if (filled.firstFrame.length > 0 || filled.lastFrame.length > 0) return "i2v";
  if (filled.refImage.length > 0 || filled.refVideo.length > 0 || filled.refAudio.length > 0) {
    return "r2v";
  }
  return "t2v";
}

function filledOf(args) {
  const filled = {};
  for (const spec of MEDIA_SPECS) filled[spec.arg] = toList(args[spec.arg]);
  return filled;
}

export function detectMediaMode(args = {}) {
  return modeOf(filledOf(args));
}

// 返回 { content, media, mode }：content 不含 text 项（由调用方放最前），顺序固定为
// 首帧 → 尾帧 → 参考图 → 参考视频 → 参考音频，与 prompt 里 <Picture N> 的编号口径一致
export async function resolveVideoMedia(args, cwd) {
  const filled = filledOf(args);
  // 组合与张数先判：别为一个自相矛盾或必然被拒的参数组合去读几十 MB 文件
  assertCombination(filled);
  for (const spec of MEDIA_SPECS) {
    if (filled[spec.arg].length > spec.max) {
      throw cliError(
        "E_INVALID_OPTION",
        `${spec.option} 最多 ${spec.max} 项，得到 ${filled[spec.arg].length} 项（provider 提交期同样会拒）`,
        { option: spec.option, value: filled[spec.arg].length, max: spec.max },
      );
    }
  }
  const content = [];
  const media = {};
  let inlinedBytes = 0;
  for (const spec of MEDIA_SPECS) {
    const values = filled[spec.arg];
    if (values.length === 0) continue;
    const resolved = [];
    for (const value of values) {
      const item = await resolveOne(value, spec.kind, cwd, spec.option);
      inlinedBytes += item.bytes;
      resolved.push(summarizeMedia(item.url, item.bytes));
      content.push({ type: spec.type, [spec.urlKey]: { url: item.url }, role: spec.role });
    }
    media[spec.role] = resolved;
  }
  if (inlinedBytes * BASE64_INFLATE > MAX_BODY_BYTES) {
    throw cliError(
      "E_INVALID_OPTION",
      `内联媒体 base64 后请求体约 ${((inlinedBytes * BASE64_INFLATE) / 1024 / 1024).toFixed(1)}MB，超过 provider 的 64MB 总大小上限：请改传公网 URL 或 mm_file://{file_id}`,
      { option: "--ref-video", inlinedBytes, maxBodyBytes: MAX_BODY_BYTES },
    );
  }
  return { content, media, mode: modeOf(filled) };
}

// minimax-video-regen 的 --base-video：单个 768P 源视频（本地读成 data URI、或 http(s)/mm_file://）。
// 复用视频通道的格式/体积预检，返回 { url, summary, bytes }，summary 只带字节数供 stdout 回执。
export async function resolveBaseVideo(value, cwd, option = "--base-video") {
  const item = await resolveOne(value, "video", cwd, option);
  return { url: item.url, summary: summarizeMedia(item.url, item.bytes), bytes: item.bytes };
}
