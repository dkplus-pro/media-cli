import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { cliError } from "./errors.mjs";

// D20：image 的参考图支持本地文件（内联 data URI，不需要先上传 CDN）；
// 实测公网 HTTPS URL 与 data:image/png;base64, 两种形态都可用（与 payload 体积无关）
const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

export function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// commander 的可变参数在只传一次时也可能给字符串，统一归一成数组
export function splitRefs(value) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((item) => String(item).trim()).filter((item) => item !== "");
}

// 本地预检张数上限：超限根本不该花一次网络请求（§1.1 实测 image 6 / video images 5 / audios 3）
export function assertCount(values, option, max) {
  if (values.length > max) {
    throw cliError(
      "E_INVALID_OPTION",
      `${option} 最多 ${max} 个，得到 ${values.length} 个（provider 实测上限，超出会直接 400）`,
      { option, value: values.length, max },
    );
  }
  return values;
}

// video 素材只收公网 URL（D20：video 链路未实测，不赌本地文件）
export function assertPublicUrls(values, option) {
  for (const value of values) {
    if (!isHttpUrl(value)) {
      throw cliError(
        "E_INVALID_OPTION",
        `${option} 只接受公网 http(s) URL，得到：${value}（本地文件请先跑 tencent-cos-upload 换 URL）`,
        { option, value },
      );
    }
  }
  return values;
}

// image 的 --ref：http(s) 原样透传，其他 scheme 拒绝，无 scheme 当本地文件（相对 ctx.cwd）读成 data URI
export async function resolveRef(value, option, cwd) {
  if (isHttpUrl(value)) return value;
  if (SCHEME_RE.test(value)) {
    throw cliError("E_INVALID_OPTION", `${option} 只支持本地路径或 http(s) URL，得到：${value}`, {
      option,
      value,
    });
  }
  return toDataUri(path.resolve(cwd, value));
}

// 本地文件 → data:<mime>;base64, 内联（上限 6 张，见 commands 侧的 assertCount）
export async function toDataUri(localPath) {
  const info = await stat(localPath).catch(() => null);
  if (!info?.isFile()) {
    throw cliError("E_MISSING_ARGUMENT", `参考图文件不存在：${localPath}`, {
      option: "--ref",
      value: localPath,
    });
  }
  const ext = path.extname(localPath).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (mime === undefined) {
    throw cliError(
      "E_INVALID_OPTION",
      `参考图格式不支持：${localPath}（仅 ${Object.keys(MIME_BY_EXT).join("/")}）`,
      { option: "--ref", value: localPath },
    );
  }
  const buf = await readFile(localPath);
  return `data:${mime};base64,${buf.toString("base64")}`;
}
