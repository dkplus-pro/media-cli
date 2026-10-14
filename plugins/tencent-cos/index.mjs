import { stat } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_POOL, loadPool, POOL_NAMES } from "./lib/env.mjs";
import { cliError } from "./lib/errors.mjs";
import { uploadObject } from "./lib/upload.mjs";

const KEY_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

const MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  pdf: "application/pdf",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  txt: "text/plain; charset=utf-8",
};

function parseEnv(value) {
  if (!POOL_NAMES.includes(value)) {
    throw cliError("E_INVALID_OPTION", `--env 只能是 ${POOL_NAMES.join(" | ")}，得到：${value}`, {
      option: "--env",
      value,
    });
  }
  return value;
}

// 对象 key 直接进公网 URL，故限定 ASCII 安全字符集，不做二次编码
function sanitizeKey(raw) {
  if (raw.startsWith("/") || raw.includes("..")) {
    throw cliError("E_INVALID_OPTION", `--key 必须是相对对象名（不含 .. 与前导 /）：${raw}`, {
      option: "--key",
      value: raw,
    });
  }
  if (!KEY_RE.test(raw)) {
    throw cliError("E_INVALID_OPTION", `--key 含非法字符（只允许字母数字与 . _ - /）：${raw}`, {
      option: "--key",
      value: raw,
    });
  }
  return raw;
}

function slugFileName(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const stem =
    path
      .basename(filePath, path.extname(filePath))
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "file";
  return { ext, stem };
}

async function tencentCosUpload(ctx, args) {
  if (typeof args.file !== "string" || args.file.trim() === "") {
    throw cliError("E_MISSING_ARGUMENT", "缺少必填 --file", { option: "--file" });
  }
  const filePath = path.resolve(ctx.cwd, args.file);
  const info = await stat(filePath).catch(() => null);
  if (!info) {
    throw cliError("E_MISSING_ARGUMENT", `文件不存在：${filePath}`, {
      option: "--file",
      value: args.file,
    });
  }
  if (!info.isFile()) {
    throw cliError("E_INVALID_OPTION", `--file 必须是单个文件，得到目录：${filePath}`, {
      option: "--file",
      value: args.file,
    });
  }

  const pool = loadPool(args.env === undefined ? undefined : parseEnv(args.env));
  const { ext, stem } = slugFileName(filePath);
  const key =
    args.key === undefined
      ? `${pool.prefix}${stem}-${new Date()
          .toISOString()
          .replace(/[:.]/g, "-")}${ext === "" ? "" : `.${ext}`}`
      : `${pool.prefix}${sanitizeKey(args.key)}`;

  const contentType =
    args.contentType ?? (ext !== "" && MIME[ext] !== undefined ? MIME[ext] : undefined);
  const { etag } = await uploadObject(pool, { key, filePath, contentType });
  const url = `${pool.publicBase}/${key}`;
  ctx.logger.info(`已上传 ${url}`);

  return {
    url,
    key,
    bucket: pool.bucket,
    region: pool.region,
    env: pool.name,
    bytes: info.size,
    ...(contentType === undefined ? {} : { contentType }),
    ...(etag === undefined ? {} : { etag }),
  };
}

export default {
  name: "tencent-cos",
  version: "0.1.0",
  commands: [
    {
      name: "tencent-cos-upload",
      description:
        "腾讯云 COS 上传单个文件并返回公网 URL（prod/test 两池，默认 prod，--env 或 COS_ENV 切换）",
      options: [
        { flags: "--file <path>", description: "待上传的本地文件（必填，单个文件）" },
        {
          flags: "--env <pool>",
          description: `存储环境池：${POOL_NAMES.join(" | ")}（默认 ${DEFAULT_POOL}；COS_ENV 可改默认值，--env 单次覆盖）`,
        },
        {
          flags: "--key <objectKey>",
          description:
            "对象名（可选，默认 <COS_<ENV>_PREFIX><文件名 slug>-<时间戳>.<扩展名>；自动带上前缀）",
        },
        {
          flags: "--content-type <mime>",
          description: "MIME（可选，默认按扩展名推断；无法推断时交给 COS）",
        },
      ],
      handler: tencentCosUpload,
    },
  ],
};
